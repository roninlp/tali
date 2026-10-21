import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  Event,
  EventConflict,
  EventCreateInput,
  type EventException,
  EventForbidden,
  type EventId,
  EventListInput,
  EventMutationInput,
  EventNotFound,
  EventPatch,
  type EventServiceError,
  EventValidationError,
  EventUpdateInput,
  type HouseholdId,
  RecurrenceRule,
  type SyncEntityType,
  type EventTiming,
  type UserId,
  type Visibility,
  localDateStartInstant,
  uuidV7
} from "@tali/domain"
import {
  type EventQuery,
  EventRepo,
  EventRepoLive,
  type SyncEntityState,
  SyncRepo,
  SyncRepoLive
} from "@tali/sql"

/**
 * `EventService` — create, edit, delete (ticket #57; FR-CAL-01).
 *
 * ## Write path
 *
 * Every mutation is exactly one `D1Client.batch()` built from the #34 sync
 * primitives (`writeEntity` + gated `appendFeed` + gated `recordApplied`).
 * Reusing those primitives means the service path and the sync-push path
 * share one version/feed implementation: an event changed here bumps
 * `version`, appends a `change_feed` row, and is visible to `/sync/pull`.
 *
 * `clientMutationId` makes a mutation replay-safe. A retry after a lost
 * response finds the id in `applied_mutations` and returns the current row
 * instead of applying twice. A lost version CAS (another writer landed
 * between our read and our batch) writes nothing; the service re-reads and
 * reapplies the same patch, so a field is never silently dropped.
 *
 * ## Timing is one unit
 *
 * An event is either timed (two instants) or all-day (one local date in the
 * event's zone). The service never accepts both and never stores a half
 * event: a patch that changes the shape replaces the whole `timing` union,
 * and the D1 columns follow it (`start_at`/`end_at` **or** `all_day_date`).
 *
 * The **zone** is per event, like a task's due date: it is stored with the
 * row, it defaults to the owner's profile zone at creation, and it makes the
 * all-day date unambiguous. Changing the device's zone never moves a stored
 * event (FR-CAL-07).
 *
 * ## Recurrence and exceptions
 *
 * The rule and the exception list are stored as they are handed in — the
 * service validates their *shape* (the shared `RecurrenceRule` schema, unique
 * occurrence keys) but never expands them. The expansion engine, the
 * "this occurrence only" edit and the "this and following" split are ticket
 * #58; the shape they work on is already here, so that ticket needs no
 * migration.
 */

/** How many CAS retries a service mutation makes before reporting contention. */
const MAX_CAS_ATTEMPTS = 3

export interface EventViewer {
  readonly userId: UserId
  readonly householdId: HouseholdId
  /** The viewer's zone: the default zone of a new event. */
  readonly timeZone: string
}

export interface EventServiceApi {
  readonly create: (
    viewer: EventViewer,
    input: Schema.Schema.Type<typeof EventCreateInput>,
    now?: string
  ) => Effect.Effect<Event, EventServiceError>
  readonly get: (viewer: EventViewer, id: Event["id"]) => Effect.Effect<Event, EventServiceError>
  readonly update: (
    viewer: EventViewer,
    input: Schema.Schema.Type<typeof EventUpdateInput>,
    now?: string
  ) => Effect.Effect<Event, EventServiceError>
  readonly delete: (
    viewer: EventViewer,
    input: Schema.Schema.Type<typeof EventMutationInput>,
    now?: string
  ) => Effect.Effect<Event, EventServiceError>
  readonly list: (
    viewer: EventViewer,
    input?: Schema.Schema.Type<typeof EventListInput>
  ) => Effect.Effect<ReadonlyArray<Event>, EventServiceError>
}

const invalid = (field: string, message: string): Effect.Effect<never, EventValidationError> =>
  Effect.fail(new EventValidationError({ issues: [{ field, message }] }))

const validInstant = (value: string): boolean => Number.isFinite(Date.parse(value))

const validLocalDate = (value: string): boolean => {
  try {
    localDateStartInstant(value, "UTC")
    return true
  } catch {
    return false
  }
}

/** Store instants in canonical UTC so `start_at` TEXT range queries are ordered. */
const normalizeInstant = (value: string): string => new Date(value).toISOString()

export class EventService extends Context.Service<EventService>()("EventService", {
  make: Effect.gen(function*() {
    const events = yield* EventRepo
    const sync = yield* SyncRepo

    const definition = (entityType: SyncEntityType) => {
      const def = sync.definition(entityType)
      if (def === undefined) {
        throw new Error(`sync entity type is not registered: ${entityType}`)
      }
      return def
    }

    /**
     * Turn a validated aggregate into the registry's trusted write state. The
     * registration's `validate` boundary is the same one the sync push uses,
     * so a service write can never put a shape on the wire that a pull would
     * reject.
     */
    const eventState = (event: Event): SyncEntityState => {
      const def = definition("event")
      return {
        entityType: "event",
        entityId: event.id,
        householdId: event.householdId,
        ownerId: event.ownerId,
        visibility: event.visibility,
        version: event.version,
        updatedAt: event.updatedAt,
        deletedAt: event.deletedAt,
        data: def.validate(
          { ...event } as Record<string, unknown>,
          { version: event.version, updatedAt: event.updatedAt, deletedAt: event.deletedAt }
        )
      }
    }

    const appliedMutation = (viewer: EventViewer, clientMutationId: string) =>
      Effect.gen(function*() {
        const applied = yield* sync
          .findApplied({
            householdId: viewer.householdId,
            clientMutationIds: [clientMutationId]
          })
          .pipe(Effect.orDie)
        return Option.fromUndefinedOr(applied.get(clientMutationId))
      })

    /** A mutation id may not be reused for a different row or aggregate. */
    const reusedMutationId = (
      row: { readonly entityType: SyncEntityType; readonly entityId: string },
      expected: { readonly entityType: SyncEntityType; readonly id?: string }
    ): boolean =>
      row.entityType !== expected.entityType ||
      (expected.id !== undefined && row.entityId !== expected.id)

    const reusedMutationIdError = (id: string) =>
      invalid("clientMutationId", "this mutation id was already applied to a different change")

    /**
     * One event mutation: the CAS entity write, the gated feed append and the
     * gated ledger row — one D1 batch. Returns whether this `clientMutationId`
     * is now recorded, i.e. the CAS won.
     */
    const commitEvent = (input: {
      readonly viewer: EventViewer
      readonly state: SyncEntityState
      readonly expectedVersion: number | null
      readonly clientMutationId: string
      readonly now: string
      readonly op?: "upsert" | "delete"
    }): Effect.Effect<boolean, EventServiceError> =>
      Effect.gen(function*() {
        // A mutation id is one mutation for its whole retention window. If the
        // ledger already maps it to a different row/aggregate, `recordApplied`
        // below would be an `INSERT OR IGNORE` no-op: the write would land with
        // no replay guard. Refuse before writing.
        const prior = yield* appliedMutation(input.viewer, input.clientMutationId)
        if (
          Option.isSome(prior) &&
          reusedMutationId(prior.value, {
            entityType: input.state.entityType,
            id: input.state.entityId
          })
        ) {
          return yield* reusedMutationIdError(input.state.entityId)
        }

        yield* sync.commit([
          sync.writeEntity({ state: input.state, expectedVersion: input.expectedVersion }),
          sync.appendFeed({
            householdId: input.viewer.householdId,
            entityType: input.state.entityType,
            entityId: input.state.entityId,
            op: input.op ?? "upsert",
            version: input.state.version,
            updatedAt: input.state.updatedAt,
            ownerId: input.state.ownerId,
            visibility: input.state.visibility
          }),
          sync.recordApplied({
            clientMutationId: input.clientMutationId,
            householdId: input.viewer.householdId,
            entityType: input.state.entityType,
            entityId: input.state.entityId,
            version: input.state.version,
            createdAt: input.now
          })
        ]).pipe(Effect.orDie)

        const applied = yield* sync
          .findApplied({
            householdId: input.viewer.householdId,
            clientMutationIds: [input.clientMutationId]
          })
          .pipe(Effect.orDie)
        return applied.has(input.clientMutationId)
      })

    /**
     * Read one event with the standard scope rules. A tombstone reads as
     * "gone" unless the caller asks for it (the replay guard does).
     */
    const readEvent = (
      viewer: EventViewer,
      id: EventId,
      includeTrashed: boolean
    ): Effect.Effect<Event, EventServiceError> =>
      Effect.gen(function*() {
        const found = yield* events.findById(id).pipe(Effect.orDie)
        if (Option.isNone(found)) {
          return yield* Effect.fail(new EventNotFound({ id }))
        }
        const event = found.value
        if (event.householdId !== viewer.householdId) {
          return yield* Effect.fail(new EventForbidden({ id, reason: "household" }))
        }
        if (event.visibility === "private" && event.ownerId !== viewer.userId) {
          return yield* Effect.fail(new EventForbidden({ id, reason: "private" }))
        }
        if (!includeTrashed && event.deletedAt !== null) {
          return yield* Effect.fail(new EventNotFound({ id }))
        }
        return event
      })

    /** Replay guard: the same mutation id already committed (lost response). */
    const replayEvent = (
      viewer: EventViewer,
      clientMutationId: string,
      expectedId?: EventId
    ): Effect.Effect<Option.Option<Event>, EventServiceError> =>
      Effect.gen(function*() {
        const row = yield* appliedMutation(viewer, clientMutationId)
        if (Option.isNone(row)) return Option.none()
        if (reusedMutationId(row.value, { entityType: "event", id: expectedId })) {
          return yield* reusedMutationIdError(expectedId ?? row.value.entityId)
        }
        // Same household/owner rules as any other read: a mutation id may
        // never hand back another member's private row.
        const current = yield* readEvent(viewer, row.value.entityId as EventId, true)
        return Option.some(current)
      })

    /** Decode + cross-field validate a rule against the one shared contract. */
    const decodeRule = (
      rule: RecurrenceRule
    ): Effect.Effect<RecurrenceRule, EventValidationError> => {
      const decoded = Schema.decodeUnknownOption(RecurrenceRule)(rule)
      return Option.isNone(decoded)
        ? invalid("recurrence", "recurrence rule is not valid")
        : Effect.succeed(decoded.value)
    }

    /**
     * The timing union, validated.
     *
     * A timed event needs two real instants and must not end before it
     * starts; an all-day event needs a real local date. The zone lives on the
     * event, so it is not part of the union.
     */
    const validateTiming = (
      timing: EventTiming
    ): Effect.Effect<EventTiming, EventValidationError> =>
      Effect.gen(function*() {
        if (timing._tag === "timed") {
          if (!validInstant(timing.start) || !validInstant(timing.end)) {
            return yield* invalid("timing", "a timed event needs ISO-8601 instants")
          }
          const start = normalizeInstant(timing.start)
          const end = normalizeInstant(timing.end)
          if (Date.parse(end) < Date.parse(start)) {
            return yield* invalid("timing", "an event cannot end before it starts")
          }
          return { _tag: "timed", start, end } as const
        }
        if (!validLocalDate(timing.date)) {
          return yield* invalid("timing", "an all-day event needs a real calendar date")
        }
        return { _tag: "allDay", date: timing.date } as const
      })

    /**
     * The exception list.
     *
     * Every occurrence key must be a real local date and unique inside the
     * event: two exceptions for the same occurrence would make the expansion
     * ambiguous. The overrides themselves are validated by the event schema.
     */
    const validateExceptions = (
      exceptions: ReadonlyArray<EventException>
    ): Effect.Effect<ReadonlyArray<EventException>, EventValidationError> =>
      Effect.gen(function*() {
        const seen = new Set<string>()
        for (const exception of exceptions) {
          if (!validLocalDate(exception.instanceId)) {
            return yield* invalid(
              "exceptions",
              "an exception must point at a real occurrence date"
            )
          }
          if (seen.has(exception.instanceId)) {
            return yield* invalid(
              "exceptions",
              "two exceptions cannot target the same occurrence"
            )
          }
          seen.add(exception.instanceId)
        }
        return exceptions
      })

    const create = (
      viewer: EventViewer,
      input: Schema.Schema.Type<typeof EventCreateInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Event, EventServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayEvent(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        if (input.title.trim().length === 0) {
          return yield* invalid("title", "an event needs a title")
        }
        const timing = yield* validateTiming(input.timing)
        const recurrence =
          input.recurrence === undefined || input.recurrence === null
            ? null
            : yield* decodeRule(input.recurrence)
        const exceptions = yield* validateExceptions(input.exceptions ?? [])

        const event = new Event({
          id: (input.id ?? uuidV7()) as Event["id"],
          type: "event",
          title: input.title,
          description: input.description ?? null,
          location: input.location ?? null,
          category: input.category ?? null,
          people: input.people ?? [],
          timing,
          timeZone: input.timeZone ?? viewer.timeZone,
          recurrence,
          exceptions,
          occasionId: input.occasionId ?? null,
          ownerId: viewer.userId,
          householdId: viewer.householdId,
          visibility: (input.visibility ?? "shared") as Visibility,
          color: input.color ?? null,
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null
        })

        const applied = yield* commitEvent({
          viewer,
          state: eventState(event),
          expectedVersion: null,
          clientMutationId: input.clientMutationId,
          now
        })
        if (!applied) {
          return yield* Effect.fail(new EventConflict({ id: event.id }))
        }
        return event
      })

    const get = (viewer: EventViewer, id: Event["id"]): Effect.Effect<Event, EventServiceError> =>
      readEvent(viewer, id, false)

    /** Apply a patch to a row. The timing is replaced as one unit. */
    const patchEvent = (
      current: Event,
      patch: Schema.Schema.Type<typeof EventPatch>,
      now: string
    ): Effect.Effect<Event, EventServiceError> =>
      Effect.gen(function*() {
        if (patch.title !== undefined && patch.title.trim().length === 0) {
          return yield* invalid("title", "an event needs a title")
        }
        const timing = patch.timing === undefined
          ? current.timing
          : yield* validateTiming(patch.timing)
        const recurrence = patch.recurrence === undefined
          ? current.recurrence
          : patch.recurrence === null
          ? null
          : yield* decodeRule(patch.recurrence)
        const exceptions = patch.exceptions === undefined
          ? current.exceptions
          : yield* validateExceptions(patch.exceptions)

        // Every field is picked explicitly: a patch that omits a field must
        // keep the stored value, and a spread would write `undefined` over it.
        return new Event({
          ...current,
          title: patch.title ?? current.title,
          description: patch.description === undefined ? current.description : patch.description,
          location: patch.location === undefined ? current.location : patch.location,
          category: patch.category === undefined ? current.category : patch.category,
          color: patch.color === undefined ? current.color : patch.color,
          people: patch.people ?? current.people,
          timing,
          timeZone: patch.timeZone ?? current.timeZone,
          recurrence,
          exceptions,
          occasionId: patch.occasionId === undefined ? current.occasionId : patch.occasionId,
          visibility: patch.visibility ?? current.visibility,
          version: current.version + 1,
          updatedAt: now
        })
      })

    /** Are two events equal in every field the service owns? */
    const sameEvent = (a: Event, b: Event): boolean =>
      a.title === b.title &&
      a.description === b.description &&
      a.location === b.location &&
      a.category === b.category &&
      a.color === b.color &&
      a.timeZone === b.timeZone &&
      a.visibility === b.visibility &&
      a.occasionId === b.occasionId &&
      JSON.stringify(a.people) === JSON.stringify(b.people) &&
      JSON.stringify(a.timing) === JSON.stringify(b.timing) &&
      JSON.stringify(a.recurrence) === JSON.stringify(b.recurrence) &&
      JSON.stringify(a.exceptions) === JSON.stringify(b.exceptions)

    const update = (
      viewer: EventViewer,
      input: Schema.Schema.Type<typeof EventUpdateInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Event, EventServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayEvent(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* readEvent(viewer, input.id, false)
          const next = yield* patchEvent(current, input.patch, now)
          if (sameEvent(current, next)) return current
          const applied = yield* commitEvent({
            viewer,
            state: eventState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now
          })
          if (applied) return next
        }
        return yield* Effect.fail(new EventConflict({ id: input.id }))
      })

    /**
     * Soft delete: the row stays with a `deletedAt` tombstone (the shared
     * 30-day trash contract) and the feed records a `delete` op, so the other
     * member's device drops it too.
     */
    const deleteEvent = (
      viewer: EventViewer,
      input: Schema.Schema.Type<typeof EventMutationInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Event, EventServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayEvent(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* readEvent(viewer, input.id, false)
          const next = new Event({
            ...current,
            deletedAt: now,
            version: current.version + 1,
            updatedAt: now
          })
          const applied = yield* commitEvent({
            viewer,
            state: eventState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now,
            op: "delete"
          })
          if (applied) return next
        }
        return yield* Effect.fail(new EventConflict({ id: input.id }))
      })

    const list = (
      viewer: EventViewer,
      input?: Schema.Schema.Type<typeof EventListInput>
    ): Effect.Effect<ReadonlyArray<Event>, EventServiceError> =>
      Effect.gen(function*() {
        const scope = { householdId: viewer.householdId, userId: viewer.userId }
        if (input?.from === undefined && input?.before === undefined) {
          return yield* events.listVisible(scope).pipe(Effect.orDie)
        }
        // A local date range is an instant range for a timed event and a date
        // range for an all-day one. Both bounds are computed in the viewer's
        // zone, so a DST transition cannot move an event to another day.
        const query: {
          -readonly [K in keyof EventQuery]: EventQuery[K]
        } = { ...scope }
        if (input?.from !== undefined) {
          query.dateFrom = input.from
          query.instantFrom = localDateStartInstant(input.from, viewer.timeZone)
        }
        if (input?.before !== undefined) {
          query.dateBefore = input.before
          query.instantBefore = localDateStartInstant(input.before, viewer.timeZone)
        }
        return yield* events.listInRange(query).pipe(Effect.orDie)
      })

    return {
      create,
      get,
      update,
      delete: deleteEvent,
      list
    } as const
  })
}) {}

export const EventServiceLive = Layer.effect(EventService, EventService.make).pipe(
  Layer.provide(EventRepoLive),
  Layer.provide(SyncRepoLive)
)
