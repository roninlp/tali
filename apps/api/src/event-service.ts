import { Context, Effect, Layer, Option, Schema } from 'effect'
import {
  Event,
  EventConflict,
  EventCreateInput,
  type EventException,
  type EventExceptionId,
  type EventExceptionOverrides,
  EventForbidden,
  type EventId,
  EventListInput,
  EventMutationInput,
  EventNotFound,
  EventOccurrenceDeleteInput,
  EventOccurrenceEditInput,
  EventOccurrenceQuery,
  EventPatch,
  type EventServiceError,
  EventValidationError,
  EventUpdateInput,
  type HouseholdId,
  RecurrenceRule,
  type EventTiming,
  type UserId,
  deleteEventOccurrence,
  eventAnchorDate,
  eventOccurrences,
  isEventOccurrence,
  localDateStartInstant,
  localDayBefore,
  overrideEventOccurrence,
  patchEventSeries,
  splitEventSeries,
  trashEvent,
  truncateEventSeries,
  resolveCreateVisibility,
  uuidV7,
} from '@tali/domain'
import type { EventOccurrence, EventOccurrenceChange } from '@tali/domain'
import {
  type EventQuery,
  EventRepo,
  EventRepoLive,
  type SyncEntityState,
  SyncRepo,
  SyncRepoLive,
} from '@tali/sql'
import { readScoped } from './row-scope.js'
import { casUpdate } from './cas.js'
import { makeSyncKit, type CommitEntry } from './sync-write.js'
import { unchangedExcept } from './patch-compare.js'

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
 * occurrence keys) and never expands them here. Expansion is the pure
 * `eventOccurrences` builder, served over `ListEventOccurrences` and reused by
 * the week/month read models (#43/#62).
 *
 * ## Occurrence edits (ticket #58)
 *
 * `editOccurrence` / `deleteOccurrence` implement the two edit scopes:
 *
 * - **this occurrence** appends (or replaces) one exception on the series row;
 * - **this and following** splits the series — the old row is truncated and a
 *   new row is inserted, **both in one batch**, each with its own feed row and
 *   `applied_mutations` entry, so a retry stays exactly-once.
 *
 * A one-off event has no exceptions: an occurrence edit is a plain series edit
 * and a delete is the shared tombstone.
 */

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
    now?: string,
  ) => Effect.Effect<Event, EventServiceError>
  readonly get: (
    viewer: EventViewer,
    id: Event['id'],
  ) => Effect.Effect<Event, EventServiceError>
  readonly update: (
    viewer: EventViewer,
    input: Schema.Schema.Type<typeof EventUpdateInput>,
    now?: string,
  ) => Effect.Effect<Event, EventServiceError>
  readonly delete: (
    viewer: EventViewer,
    input: Schema.Schema.Type<typeof EventMutationInput>,
    now?: string,
  ) => Effect.Effect<Event, EventServiceError>
  readonly list: (
    viewer: EventViewer,
    input?: Schema.Schema.Type<typeof EventListInput>,
  ) => Effect.Effect<ReadonlyArray<Event>, EventServiceError>
  /** Expand every visible series into a window (`before` exclusive). */
  readonly occurrences: (
    viewer: EventViewer,
    input: Schema.Schema.Type<typeof EventOccurrenceQuery>,
  ) => Effect.Effect<ReadonlyArray<EventOccurrence>, EventServiceError>
  /** "This occurrence" / "this and following" edit. */
  readonly editOccurrence: (
    viewer: EventViewer,
    input: Schema.Schema.Type<typeof EventOccurrenceEditInput>,
    now?: string,
  ) => Effect.Effect<EventOccurrenceChange, EventServiceError>
  /** "This occurrence" / "this and following" delete. */
  readonly deleteOccurrence: (
    viewer: EventViewer,
    input: Schema.Schema.Type<typeof EventOccurrenceDeleteInput>,
    now?: string,
  ) => Effect.Effect<EventOccurrenceChange, EventServiceError>
}

const invalid = (
  field: string,
  message: string,
): Effect.Effect<never, EventValidationError> =>
  Effect.fail(new EventValidationError({ issues: [{ field, message }] }))

const validInstant = (value: string): boolean =>
  Number.isFinite(Date.parse(value))

const validLocalDate = (value: string): boolean => {
  try {
    localDateStartInstant(value, 'UTC')
    return true
  } catch {
    return false
  }
}

/** Store instants in canonical UTC so `start_at` TEXT range queries are ordered. */
const normalizeInstant = (value: string): string =>
  new Date(value).toISOString()

export class EventService extends Context.Service<EventService>()(
  'EventService',
  {
    make: Effect.gen(function* () {
      const events = yield* EventRepo
      const sync = yield* SyncRepo

      const kit = makeSyncKit<EventServiceError>({ sync, invalid })

      /**
       * Turn a validated aggregate into the registry's trusted write state. The
       * registration's `validate` boundary is the same one the sync push uses,
       * so a service write can never put a shape on the wire that a pull would
       * reject.
       */
      const eventState = (event: Event): SyncEntityState =>
        kit.stateOf('event', event)

      const appliedMutation = (viewer: EventViewer, clientMutationId: string) =>
        kit.appliedMutation(viewer.householdId, clientMutationId)

      /**
       * Read one event with the standard scope rules. A tombstone reads as
       * "gone" unless the caller asks for it (the replay guard does).
       */
      const readEvent = (
        viewer: EventViewer,
        id: EventId,
        includeTrashed: boolean,
      ): Effect.Effect<Event, EventServiceError> =>
        readScoped({
          viewer,
          id,
          find: events.findById,
          includeTrashed,
          trash: 'last',
          onViolation: violation =>
            violation === 'notFound' || violation === 'trashed'
              ? new EventNotFound({ id })
              : new EventForbidden({ id, reason: violation }),
        })

      /** Replay guard: the same mutation id already committed (lost response). */
      const replayEvent = (
        viewer: EventViewer,
        clientMutationId: string,
        expectedId?: EventId,
      ): Effect.Effect<Option.Option<Event>, EventServiceError> =>
        Effect.gen(function* () {
          const row = yield* appliedMutation(viewer, clientMutationId)
          if (Option.isNone(row)) return Option.none()
          if (
            kit.reusedMutationId(row.value, {
              entityType: 'event',
              id: expectedId,
            })
          ) {
            return yield* kit.reusedMutationIdError(
              expectedId ?? row.value.entityId,
            )
          }
          // Same household/owner rules as any other read: a mutation id may
          // never hand back another member's private row.
          const current = yield* readEvent(
            viewer,
            row.value.entityId as EventId,
            true,
          )
          return Option.some(current)
        })

      /** Decode + cross-field validate a rule against the one shared contract. */
      const decodeRule = (
        rule: RecurrenceRule,
      ): Effect.Effect<RecurrenceRule, EventValidationError> => {
        const decoded = Schema.decodeOption(RecurrenceRule)(rule)
        return Option.isNone(decoded)
          ? invalid('recurrence', 'recurrence rule is not valid')
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
        timing: EventTiming,
      ): Effect.Effect<EventTiming, EventValidationError> =>
        Effect.gen(function* () {
          if (timing._tag === 'timed') {
            if (!validInstant(timing.start) || !validInstant(timing.end)) {
              return yield* invalid(
                'timing',
                'a timed event needs ISO-8601 instants',
              )
            }
            const start = normalizeInstant(timing.start)
            const end = normalizeInstant(timing.end)
            if (Date.parse(end) < Date.parse(start)) {
              return yield* invalid(
                'timing',
                'an event cannot end before it starts',
              )
            }
            return { _tag: 'timed', start, end } as const
          }
          if (!validLocalDate(timing.date)) {
            return yield* invalid(
              'timing',
              'an all-day event needs a real calendar date',
            )
          }
          return { _tag: 'allDay', date: timing.date } as const
        })

      /**
       * The exception list.
       *
       * Every occurrence key must be a real local date and unique inside the
       * event: two exceptions for the same occurrence would make the expansion
       * ambiguous. The overrides themselves are validated by the event schema.
       */
      const validateExceptions = (
        exceptions: ReadonlyArray<EventException>,
      ): Effect.Effect<ReadonlyArray<EventException>, EventValidationError> =>
        Effect.gen(function* () {
          const seen = new Set<string>()
          for (const exception of exceptions) {
            if (!validLocalDate(exception.instanceId)) {
              return yield* invalid(
                'exceptions',
                'an exception must point at a real occurrence date',
              )
            }
            if (seen.has(exception.instanceId)) {
              return yield* invalid(
                'exceptions',
                'two exceptions cannot target the same occurrence',
              )
            }
            seen.add(exception.instanceId)
          }
          return exceptions
        })

      const create = (
        viewer: EventViewer,
        input: Schema.Schema.Type<typeof EventCreateInput>,
        now: string = new Date().toISOString(),
      ): Effect.Effect<Event, EventServiceError> =>
        Effect.gen(function* () {
          const replayed = yield* replayEvent(
            viewer,
            input.clientMutationId,
            input.id,
          )
          if (Option.isSome(replayed)) return replayed.value

          if (input.title.trim().length === 0) {
            return yield* invalid('title', 'an event needs a title')
          }
          const timing = yield* validateTiming(input.timing)
          const recurrence =
            input.recurrence === undefined || input.recurrence === null
              ? null
              : yield* decodeRule(input.recurrence)
          const exceptions = yield* validateExceptions(input.exceptions ?? [])

          const event = new Event({
            id: (input.id ?? uuidV7()) as Event['id'],
            type: 'event',
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
            visibility: resolveCreateVisibility('event', input.visibility),
            color: input.color ?? null,
            createdAt: now,
            updatedAt: now,
            version: 1,
            deletedAt: null,
          })

          const applied = yield* kit.commitOne({
            householdId: viewer.householdId,
            state: eventState(event),
            expectedVersion: null,
            clientMutationId: input.clientMutationId,
            now,
          })
          if (!applied) {
            return yield* new EventConflict({ id: event.id })
          }
          return event
        })

      const get = (
        viewer: EventViewer,
        id: Event['id'],
      ): Effect.Effect<Event, EventServiceError> => readEvent(viewer, id, false)

      /** Apply a patch to a row. The timing is replaced as one unit. */
      const patchEvent = (
        viewer: EventViewer,
        current: Event,
        patch: Schema.Schema.Type<typeof EventPatch>,
        now: string,
      ): Effect.Effect<Event, EventServiceError> =>
        Effect.gen(function* () {
          if (patch.title !== undefined && patch.title.trim().length === 0) {
            return yield* invalid('title', 'an event needs a title')
          }
          // Shared means co-edit; un-sharing is the owner's alone (ADR-0011).
          if (
            patch.visibility === 'private' &&
            current.ownerId !== viewer.userId
          ) {
            return yield* invalid(
              'visibility',
              'only the event owner can make it private',
            )
          }
          const timing =
            patch.timing === undefined
              ? current.timing
              : yield* validateTiming(patch.timing)
          const recurrence =
            patch.recurrence === undefined
              ? current.recurrence
              : patch.recurrence === null
                ? null
                : yield* decodeRule(patch.recurrence)
          const exceptions =
            patch.exceptions === undefined
              ? current.exceptions
              : yield* validateExceptions(patch.exceptions)

          // Every field is picked explicitly: a patch that omits a field must
          // keep the stored value, and a spread would write `undefined` over it.
          return new Event({
            ...current,
            title: patch.title ?? current.title,
            description:
              patch.description === undefined
                ? current.description
                : patch.description,
            location:
              patch.location === undefined ? current.location : patch.location,
            category:
              patch.category === undefined ? current.category : patch.category,
            color: patch.color === undefined ? current.color : patch.color,
            people: patch.people ?? current.people,
            timing,
            timeZone: patch.timeZone ?? current.timeZone,
            recurrence,
            exceptions,
            occasionId:
              patch.occasionId === undefined
                ? current.occasionId
                : patch.occasionId,
            visibility: patch.visibility ?? current.visibility,
            version: current.version + 1,
            updatedAt: now,
          })
        })

      const update = (
        viewer: EventViewer,
        input: Schema.Schema.Type<typeof EventUpdateInput>,
        now: string = new Date().toISOString(),
      ): Effect.Effect<Event, EventServiceError> =>
        Effect.gen(function* () {
          const replayed = yield* replayEvent(
            viewer,
            input.clientMutationId,
            input.id,
          )
          if (Option.isSome(replayed)) return replayed.value

          return yield* casUpdate({
            read: readEvent(viewer, input.id, false),
            plan: current =>
              Effect.gen(function* () {
                const next = yield* patchEvent(
                  viewer,
                  current,
                  input.patch,
                  now,
                )
                // `patchEvent` only writes fields the patch can name (timing,
                // recurrence and exceptions are derived from their own patch
                // field), so the patch is the complete no-op test.
                return unchangedExcept(current, next, input.patch) ? null : next
              }),
            write: (current, next) =>
              kit.commitOne({
                householdId: viewer.householdId,
                state: eventState(next),
                expectedVersion: current.version,
                clientMutationId: input.clientMutationId,
                now,
              }),
            conflict: () => new EventConflict({ id: input.id }),
          })
        })

      /**
       * Soft delete: the row stays with a `deletedAt` tombstone (the shared
       * 30-day trash contract) and the feed records a `delete` op, so the other
       * member's device drops it too.
       */
      const deleteEvent = (
        viewer: EventViewer,
        input: Schema.Schema.Type<typeof EventMutationInput>,
        now: string = new Date().toISOString(),
      ): Effect.Effect<Event, EventServiceError> =>
        Effect.gen(function* () {
          const replayed = yield* replayEvent(
            viewer,
            input.clientMutationId,
            input.id,
          )
          if (Option.isSome(replayed)) return replayed.value

          return yield* casUpdate({
            read: readEvent(viewer, input.id, false),
            plan: current =>
              Effect.succeed(
                new Event({
                  ...current,
                  deletedAt: now,
                  version: current.version + 1,
                  updatedAt: now,
                }),
              ),
            write: (current, next) =>
              kit.commitOne({
                householdId: viewer.householdId,
                state: eventState(next),
                expectedVersion: current.version,
                clientMutationId: input.clientMutationId,
                now,
                op: 'delete',
              }),
            conflict: () => new EventConflict({ id: input.id }),
          })
        })

      /**
       * A local date range as the repository query: an instant range for timed
       * rows and a date range for all-day ones, both bounded in the viewer's
       * zone so a DST transition cannot move an event to another day.
       */
      const rangeQuery = (
        viewer: EventViewer,
        from?: string,
        before?: string,
      ): EventQuery => {
        const query: { -readonly [K in keyof EventQuery]: EventQuery[K] } = {
          householdId: viewer.householdId,
          userId: viewer.userId,
        }
        if (from !== undefined) {
          query.dateFrom = from
          query.instantFrom = localDateStartInstant(from, viewer.timeZone)
        }
        if (before !== undefined) {
          query.dateBefore = before
          query.instantBefore = localDateStartInstant(before, viewer.timeZone)
        }
        return query
      }

      const list = (
        viewer: EventViewer,
        input?: Schema.Schema.Type<typeof EventListInput>,
      ): Effect.Effect<ReadonlyArray<Event>, EventServiceError> =>
        Effect.gen(function* () {
          const scope = {
            householdId: viewer.householdId,
            userId: viewer.userId,
          }
          if (input?.from === undefined && input?.before === undefined) {
            return yield* events.listVisible(scope)
          }
          return yield* events.listInRange(
            rangeQuery(viewer, input.from, input.before),
          )
        }).pipe(Effect.orDie)

      /**
       * Expand every visible series into `[from, before)`.
       *
       * Two indexed reads — the rows whose anchor falls inside the window and
       * the live recurring rows (whose anchor may be months earlier) — are merged
       * by id and handed to the shared pure builder, which uses the #38 engine
       * and marks generated occurrences read-only. `before` is exclusive, like
       * every other query input; the builder's `to` is inclusive.
       */
      const occurrences = (
        viewer: EventViewer,
        input: Schema.Schema.Type<typeof EventOccurrenceQuery>,
      ): Effect.Effect<ReadonlyArray<EventOccurrence>, EventServiceError> =>
        Effect.gen(function* () {
          if (!validLocalDate(input.from) || !validLocalDate(input.before)) {
            return yield* invalid(
              'from',
              'the occurrence window needs real calendar dates',
            )
          }
          if (input.before <= input.from) {
            return []
          }
          const scope = {
            householdId: viewer.householdId,
            userId: viewer.userId,
          }
          const inRange = yield* events
            .listInRange(rangeQuery(viewer, input.from, input.before))
            .pipe(Effect.orDie)
          const recurring = yield* events
            .listRecurringLive(scope)
            .pipe(Effect.orDie)
          const byId = new Map<string, Event>()
          for (const event of [...inRange, ...recurring])
            byId.set(event.id, event)
          return eventOccurrences({
            events: [...byId.values()],
            from: input.from,
            to: localDayBefore(input.before),
            timeZone: viewer.timeZone,
          })
        })

      /**
       * Validate the occurrence-level overrides: at least one field, a non-empty
       * title, and the timing union checked exactly like a series timing (so an
       * override can never smuggle in "an instant and an all-day date").
       */
      const validateOverrides = (
        overrides: EventExceptionOverrides,
      ): Effect.Effect<EventExceptionOverrides, EventValidationError> =>
        Effect.gen(function* () {
          const changed =
            overrides.title !== undefined ||
            overrides.description !== undefined ||
            overrides.location !== undefined ||
            overrides.color !== undefined ||
            overrides.timing !== undefined ||
            overrides.timeZone !== undefined
          if (!changed) {
            return yield* invalid(
              'overrides',
              'an occurrence edit must change at least one field',
            )
          }
          if (
            overrides.title !== undefined &&
            overrides.title.trim().length === 0
          ) {
            return yield* invalid('title', 'an event needs a title')
          }
          if (overrides.timing !== undefined) {
            const timing = yield* validateTiming(overrides.timing)
            return { ...overrides, timing }
          }
          return overrides
        })

      /**
       * Resolve one occurrence edit against the stored row.
       *
       * Returns `null` for a no-op, otherwise the row(s) to write. The split path
       * needs `followingId`/`followingMutationId` because it writes a second row;
       * everything else stays on the same row.
       */
      const applyOccurrenceEdit = (
        current: Event,
        input: Schema.Schema.Type<typeof EventOccurrenceEditInput>,
        now: string,
      ): Effect.Effect<EventOccurrenceChange | null, EventServiceError> =>
        Effect.gen(function* () {
          if (!validLocalDate(input.instanceId)) {
            return yield* invalid(
              'instanceId',
              'an occurrence needs a real calendar date',
            )
          }
          const overrides = yield* validateOverrides(input.overrides)
          const anchor = eventAnchorDate(current)

          if (current.recurrence === null) {
            // A one-off event has no series to drift from: the edit is the event.
            if (input.instanceId !== anchor) {
              return yield* invalid(
                'instanceId',
                'a one-off event has only its own occurrence',
              )
            }
            return {
              series: patchEventSeries(current, overrides, now),
              following: null,
            }
          }

          if (!isEventOccurrence(current, input.instanceId)) {
            return yield* invalid(
              'instanceId',
              'instanceId is not an occurrence of this series',
            )
          }

          // A split cannot start from an occurrence that was deleted: the new
          // series would begin with a hole it never had.
          const stored = current.exceptions.find(
            exception => exception.instanceId === input.instanceId,
          )
          if (
            input.scope === 'thisAndFollowing' &&
            stored?.action === 'delete'
          ) {
            return yield* invalid(
              'instanceId',
              'a series cannot start at a deleted occurrence',
            )
          }

          // Splitting at the first occurrence leaves nothing before it, so
          // "this and following" is a whole-series edit: the rule keeps running
          // and every later occurrence takes the new values.
          if (
            input.scope === 'thisAndFollowing' &&
            input.instanceId === anchor
          ) {
            return {
              series: patchEventSeries(current, overrides, now),
              following: null,
            }
          }

          // "This occurrence" is one exception on the row, at the anchor too: the
          // series (and every other occurrence) stays exactly as it was.
          if (input.scope === 'thisOccurrence') {
            return {
              series: overrideEventOccurrence({
                event: current,
                instanceId: input.instanceId,
                overrides,
                exceptionId: (input.exceptionId ??
                  uuidV7()) as EventExceptionId,
                now,
              }),
              following: null,
            }
          }

          if (
            input.followingId === undefined ||
            input.followingMutationId === undefined
          ) {
            return yield* invalid(
              'followingId',
              'this and following needs a new series id and mutation id',
            )
          }
          const split = splitEventSeries({
            event: current,
            instanceId: input.instanceId,
            overrides,
            followingId: input.followingId,
            now,
          })
          if (split === null) {
            return yield* invalid(
              'instanceId',
              'the series cannot be split here',
            )
          }
          return { series: split.previous, following: split.following }
        })

      /** Replay guard for an occurrence edit (the split has two ledger rows). */
      const replayOccurrenceChange = (
        viewer: EventViewer,
        input: {
          readonly id: EventId
          readonly clientMutationId: string
          readonly followingId?: EventId
          readonly followingMutationId?: string
        },
      ): Effect.Effect<
        Option.Option<EventOccurrenceChange>,
        EventServiceError
      > =>
        Effect.gen(function* () {
          const row = yield* appliedMutation(viewer, input.clientMutationId)
          if (Option.isNone(row)) return Option.none()
          if (
            kit.reusedMutationId(row.value, {
              entityType: 'event',
              id: input.id,
            })
          ) {
            return yield* kit.reusedMutationIdError(input.id)
          }
          const series = yield* readEvent(
            viewer,
            row.value.entityId as EventId,
            true,
          )
          let following: Event | null = null
          if (input.followingMutationId !== undefined) {
            const tail = yield* appliedMutation(
              viewer,
              input.followingMutationId,
            )
            if (Option.isSome(tail)) {
              if (
                kit.reusedMutationId(tail.value, {
                  entityType: 'event',
                  id: input.followingId,
                })
              ) {
                return yield* kit.reusedMutationIdError(tail.value.entityId)
              }
              following = yield* readEvent(
                viewer,
                tail.value.entityId as EventId,
                true,
              )
            }
          }
          return Option.some({ series, following })
        })

      const editOccurrence = (
        viewer: EventViewer,
        input: Schema.Schema.Type<typeof EventOccurrenceEditInput>,
        now: string = new Date().toISOString(),
      ): Effect.Effect<EventOccurrenceChange, EventServiceError> =>
        Effect.gen(function* () {
          const replayed = yield* replayOccurrenceChange(viewer, input)
          if (Option.isSome(replayed)) return replayed.value

          // A split inserts its new half under a client-minted id. An id that is
          // already a row would be swallowed by the insert's `ON CONFLICT DO
          // NOTHING` while the old row is still truncated in the same batch —
          // the series would lose its future with no continuation. Refuse before
          // writing anything.
          if (
            input.scope === 'thisAndFollowing' &&
            input.followingId !== undefined
          ) {
            if (input.followingId === input.id) {
              return yield* invalid(
                'followingId',
                'the new series needs its own id',
              )
            }
            const taken = yield* events
              .findById(input.followingId)
              .pipe(Effect.orDie)
            if (Option.isSome(taken)) {
              return yield* invalid(
                'followingId',
                'this series id is already in use',
              )
            }
          }

          return yield* casUpdate({
            // A row read yields "this occurrence, no tail yet"; the plan decides
            // whether there is a change at all.
            read: readEvent(viewer, input.id, false).pipe(
              Effect.map((current): EventOccurrenceChange => ({
                series: current,
                following: null,
              })),
            ),
            plan: current => applyOccurrenceEdit(current.series, input, now),
            write: (current, next) =>
              Effect.gen(function* () {
                const entries: Array<CommitEntry> = [
                  {
                    state: eventState(next.series),
                    expectedVersion: current.series.version,
                    clientMutationId: input.clientMutationId,
                    op: 'upsert',
                  },
                ]
                if (next.following !== null) {
                  const following = next.following
                  if (input.followingMutationId === undefined) {
                    return yield* invalid(
                      'followingMutationId',
                      'a split needs a replay key for the new series',
                    )
                  }
                  entries.push({
                    state: eventState(following),
                    expectedVersion: null,
                    clientMutationId: input.followingMutationId,
                    op: 'upsert',
                    // The tail is only written when the old row is exactly the
                    // truncated row this batch wrote: a lost CAS — including one
                    // a competing writer masks with the same next version — must
                    // not leave two live halves.
                    insert: () =>
                      events.insertStatementGated(following, next.series),
                  })
                }
                const applied = yield* kit.commitEntries({
                  householdId: viewer.householdId,
                  entries,
                  now,
                })
                // A `none` row is written but never recorded, so it is not part
                // of the "did everything land" count.
                const ledgered = entries.filter(
                  entry => entry.ledger !== 'none',
                ).length
                return applied.size === ledgered
              }),
            conflict: () => new EventConflict({ id: input.id }),
          })
        })

      const deleteOccurrence = (
        viewer: EventViewer,
        input: Schema.Schema.Type<typeof EventOccurrenceDeleteInput>,
        now: string = new Date().toISOString(),
      ): Effect.Effect<EventOccurrenceChange, EventServiceError> =>
        Effect.gen(function* () {
          const replayed = yield* replayOccurrenceChange(viewer, input)
          if (Option.isSome(replayed)) return replayed.value

          if (!validLocalDate(input.instanceId)) {
            return yield* invalid(
              'instanceId',
              'an occurrence needs a real calendar date',
            )
          }

          return yield* casUpdate({
            // A row read yields "this occurrence, no tail yet"; the plan picks
            // the tombstone or the truncated series.
            read: readEvent(viewer, input.id, false).pipe(
              Effect.map((current): EventOccurrenceChange => ({
                series: current,
                following: null,
              })),
            ),
            plan: current =>
              Effect.gen(function* () {
                const event = current.series
                const anchor = eventAnchorDate(event)
                let next: Event

                if (event.recurrence === null) {
                  if (input.instanceId !== anchor) {
                    return yield* invalid(
                      'instanceId',
                      'a one-off event has only its own occurrence',
                    )
                  }
                  next = trashEvent(event, now)
                } else if (!isEventOccurrence(event, input.instanceId)) {
                  return yield* invalid(
                    'instanceId',
                    'instanceId is not an occurrence of this series',
                  )
                } else if (input.scope === 'thisAndFollowing') {
                  next = truncateEventSeries({
                    event,
                    instanceId: input.instanceId,
                    now,
                  })
                } else {
                  next = deleteEventOccurrence({
                    event,
                    instanceId: input.instanceId,
                    exceptionId: (input.exceptionId ??
                      uuidV7()) as EventExceptionId,
                    now,
                  })
                }

                return { series: next, following: null }
              }),
            write: (current, next) =>
              kit.commitOne({
                householdId: viewer.householdId,
                state: eventState(next.series),
                expectedVersion: current.series.version,
                clientMutationId: input.clientMutationId,
                now,
                op: next.series.deletedAt === null ? 'upsert' : 'delete',
              }),
            conflict: () => new EventConflict({ id: input.id }),
          })
        })

      return {
        create,
        get,
        update,
        delete: deleteEvent,
        list,
        occurrences,
        editOccurrence,
        deleteOccurrence,
      } as const
    }),
  },
) {}

export const EventServiceLive = Layer.effect(
  EventService,
  EventService.make,
).pipe(Layer.provide(EventRepoLive), Layer.provide(SyncRepoLive))
