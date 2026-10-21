import { Context, Effect, Layer, Option, Schema } from "effect"
import type { Statement } from "effect/sql"
import {
  EventRepo,
  EventRepoLive,
  OccasionRepo,
  OccasionRepoLive,
  type SyncEntityState,
  ReminderDispatchRepo,
  ReminderDispatchRepoLive,
  ReminderRepo,
  ReminderRepoLive,
  TaskRepo,
  TaskRepoLive,
  SyncRepo,
  SyncRepoLive
} from "@tali/sql"
import {
  type DispatchResponse,
  Event,
  type EventId,
  type HouseholdId,
  type PushOutcome,
  Reminder,
  ReminderConflict,
  ReminderDispatch,
  type ReminderCreateInput,
  ReminderDispatchNotFound,
  ReminderForbidden,
  type ReminderId,
  type ReminderInboxItem,
  type ReminderInboxQuery,
  ReminderNotFound,
  type ReminderPatch,
  type ReminderRepeat,
  type ReminderResponseResult,
  type ReminderRespondInput,
  type ReminderServiceError,
  type ReminderUpdateInput,
  ReminderValidationError,
  type ReminderMutationInput,
  type SyncEntityType,
  Task,
  type TaskId,
  type UserId,
  type Visibility,
  allDayReminderInstant,
  isOnTime,
  reminderDeliverAt,
  reminderFireAt,
  reminderNextFireAfter,
  reminderNextFireAfterNow,
  reminderTierFor,
  snoozeInstant,
  uuidV7
} from "@tali/domain"

/**
 * `ReminderService` — create, edit, silence, delete, and the response log
 * (ticket #60; FR-REM-01/03, ADR-0005).
 *
 * ## Write path
 *
 * Every mutation is exactly one `D1Client.batch()` built from the #34 sync
 * primitives (`writeEntity` + gated `appendFeed` + gated `recordApplied`), so a
 * reminder changed here bumps `version`, appends a `change_feed` row, and is
 * visible to `/sync/pull`. The reminder's registry `index` hook joins the same
 * batch to expire any dispatch already owed when the row is silenced or
 * deleted, so a held push cannot survive the owner's change of mind.
 *
 * ## Scheduling is derived, never guessed
 *
 * `tier` is derived from `kind` (medication → critical). `fireAt` is derived
 * from the repeat and the linked item:
 *
 * - a `once` task/event reminder fires at the item's instant minus
 *   `offsetMinutes` (an all-day item's instant is 09:00 local);
 * - a pattern reminder fires at the first occurrence at/after `now`.
 *
 * ## Policy runs at claim
 *
 * This service does **not** apply quiet hours. It stores `fireAt` and
 * `silencedUntil`; `reminderDeliverAt` (pure, in the domain package) is what
 * the #61 sweep calls to turn a fire into a `deliverAt`.
 *
 * ## The ledger
 *
 * `respond` writes the answer and, for `done`, the link effect in the same
 * batch: a task is completed exactly once (with the #38 recurrence successor),
 * an event is log-only, and a habit link is a documented seam until #63/#64.
 * A snooze inserts exactly one child row (unique on `parent_dispatch_id`) and
 * leaves the series' `fireAt` untouched — snooze is this-occurrence-only.
 */

/** How many CAS retries a service mutation makes before reporting contention. */
const MAX_CAS_ATTEMPTS = 3

export interface ReminderViewer {
  readonly userId: UserId
  readonly householdId: HouseholdId
  /** Preferences time zone, falling back to the profile zone at the RPC edge. */
  readonly timeZone: string
}

export interface ReminderServiceApi {
  readonly create: (
    viewer: ReminderViewer,
    input: Schema.Schema.Type<typeof ReminderCreateInput>,
    now?: string
  ) => Effect.Effect<Reminder, ReminderServiceError>
  readonly get: (
    viewer: ReminderViewer,
    id: ReminderId
  ) => Effect.Effect<Reminder, ReminderServiceError>
  readonly update: (
    viewer: ReminderViewer,
    input: Schema.Schema.Type<typeof ReminderUpdateInput>,
    now?: string
  ) => Effect.Effect<Reminder, ReminderServiceError>
  readonly delete: (
    viewer: ReminderViewer,
    input: Schema.Schema.Type<typeof ReminderMutationInput>,
    now?: string
  ) => Effect.Effect<Reminder, ReminderServiceError>
  readonly list: (
    viewer: ReminderViewer,
    input?: { readonly includeDeleted?: boolean }
  ) => Effect.Effect<ReadonlyArray<Reminder>, ReminderServiceError>
  /** The owner's unanswered dispatches (`history` asks for the rolled-off view). */
  readonly inbox: (
    viewer: ReminderViewer,
    query?: Schema.Schema.Type<typeof ReminderInboxQuery>,
    now?: string
  ) => Effect.Effect<ReadonlyArray<ReminderInboxItem>, ReminderServiceError>
  /**
   * Claim one due fire and write its dispatch row (#61 calls this from the
   * sweep; the cron itself is not built here). Returns the claimed dispatch, or
   * `None` when the fire was silenced, already claimed, or its series moved.
   */
  readonly claim: (input: {
    readonly reminderId: ReminderId
    readonly scheduledFor: string
    /** The owner's preferences zone; quiet hours are evaluated in it. */
    readonly ownerTimeZone: string
    readonly now?: string
  }) => Effect.Effect<Option.Option<ReminderDispatch>, ReminderServiceError>
  /**
   * Claim every due fire in **one** D1 batch (ADR-0005 §3/§9).
   *
   * This is what the sweep calls: `listDueFires` already returns the fields the
   * policy needs (`tier`, `silencedUntil`, `repeat`, `timeZone`), so the tick
   * costs two statements per fire in one batch instead of a read + batch +
   * read per fire — the difference between fitting and blowing D1's Free-plan
   * 50-queries-per-invocation ceiling on a busy minute.
   *
   * The return is the number of fires planned, not inserts that won: the
   * unique key is the mutex (a loser writes nothing and its CAS cannot advance),
   * and the owed read is what decides delivery. `claim` keeps the exact
   * per-reminder `Option` for callers that need to know.
   */
  readonly claimMany: (input: {
    readonly fires: ReadonlyArray<{
      readonly reminderId: ReminderId
      readonly scheduledFor: string
      /** The ledger row's owner: the reminder's owner, from the due read. */
      readonly ownerId: UserId
      readonly ownerTimeZone: string
      readonly tier: Reminder["tier"]
      readonly repeat: ReminderRepeat
      readonly timeZone: string
      readonly silencedUntil: string | null
    }>
    readonly now?: string
  }) => Effect.Effect<number, ReminderServiceError>
  /** Done / Snooze / Dismiss, with the link effect in the same batch. */
  readonly respond: (
    viewer: ReminderViewer,
    input: Schema.Schema.Type<typeof ReminderRespondInput>,
    now?: string
  ) => Effect.Effect<ReminderResponseResult, ReminderServiceError>
}

const invalid = (
  field: string,
  message: string
): Effect.Effect<never, ReminderValidationError> =>
  Effect.fail(new ReminderValidationError({ issues: [{ field, message }] }))

const validInstant = (value: string): boolean => Number.isFinite(Date.parse(value))

/** Store instants in canonical UTC so the scheduler's TEXT comparisons order. */
const normalizeInstant = (value: string): string => new Date(value).toISOString()

const inferTier = (kind: Reminder["kind"]) => reminderTierFor(kind)

/** The instant a linked item wants to be reminded about, or `null` if it has none. */
const linkedInstantOf = (linked: Task | Event): string | null => {
  if (linked.type === "task") {
    if (linked.dueAt !== null && validInstant(linked.dueAt)) return normalizeInstant(linked.dueAt)
    if (linked.dueDate !== null) return allDayReminderInstant(linked.dueDate, linked.timeZone)
    return null
  }
  return linked.timing._tag === "timed"
    ? normalizeInstant(linked.timing.start)
    : allDayReminderInstant(linked.timing.date, linked.timeZone)
}

export class ReminderService extends Context.Service<ReminderService>()("ReminderService", {
  make: Effect.gen(function*() {
    const reminders = yield* ReminderRepo
    const dispatches = yield* ReminderDispatchRepo
    const tasks = yield* TaskRepo
    const events = yield* EventRepo
    const occasions = yield* OccasionRepo
    const sync = yield* SyncRepo

    const definition = (entityType: SyncEntityType) => {
      const def = sync.definition(entityType)
      if (def === undefined) {
        throw new Error(`sync entity type is not registered: ${entityType}`)
      }
      return def
    }

    /** Turn a validated aggregate into the registry's trusted write state. */
    const reminderState = (reminder: Reminder): SyncEntityState => {
      const def = definition("reminder")
      return {
        entityType: "reminder",
        entityId: reminder.id,
        householdId: reminder.householdId,
        ownerId: reminder.ownerId,
        visibility: reminder.visibility,
        version: reminder.version,
        updatedAt: reminder.updatedAt,
        deletedAt: reminder.deletedAt,
        data: def.validate(
          { ...reminder } as Record<string, unknown>,
          {
            version: reminder.version,
            updatedAt: reminder.updatedAt,
            deletedAt: reminder.deletedAt
          }
        )
      }
    }

    const appliedMutation = (viewer: ReminderViewer, clientMutationId: string) =>
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
      expectedId?: string
    ): boolean =>
      row.entityType !== "reminder" ||
      (expectedId !== undefined && row.entityId !== expectedId)

    const reusedMutationIdError = (id: string) =>
      invalid("clientMutationId", "this mutation id was already applied to a different change")

    /** Read one reminder with the standard scope rules. */
    const readReminder = (
      viewer: ReminderViewer,
      id: ReminderId,
      includeTrashed: boolean
    ): Effect.Effect<Reminder, ReminderServiceError> =>
      Effect.gen(function*() {
        const found = yield* reminders.findById(id).pipe(Effect.orDie)
        if (Option.isNone(found)) {
          return yield* Effect.fail(new ReminderNotFound({ id }))
        }
        const reminder = found.value
        if (reminder.householdId !== viewer.householdId) {
          return yield* Effect.fail(new ReminderForbidden({ id, reason: "household" }))
        }
        if (reminder.visibility === "private" && reminder.ownerId !== viewer.userId) {
          return yield* Effect.fail(new ReminderForbidden({ id, reason: "private" }))
        }
        if (!includeTrashed && reminder.deletedAt !== null) {
          return yield* Effect.fail(new ReminderNotFound({ id }))
        }
        return reminder
      })

    /** Replay guard: the same mutation id already committed (lost response). */
    const replayReminder = (
      viewer: ReminderViewer,
      clientMutationId: string,
      expectedId?: ReminderId
    ): Effect.Effect<Option.Option<Reminder>, ReminderServiceError> =>
      Effect.gen(function*() {
        const row = yield* appliedMutation(viewer, clientMutationId)
        if (Option.isNone(row)) return Option.none()
        if (reusedMutationId(row.value, expectedId)) {
          return yield* reusedMutationIdError(expectedId ?? row.value.entityId)
        }
        const current = yield* readReminder(viewer, row.value.entityId as ReminderId, true)
        return Option.some(current)
      })

    /**
     * Resolve a reminder's link target and scheduling instant.
     *
     * The link is checked for household/private visibility, so a reminder can
     * never point across households or at another member's private row. A
     * `habit` link is accepted but has no schedulable instant yet (the habit
     * aggregate is #63/#64): a `once` habit reminder must carry its own fireAt.
     */
    const resolveLink = (
      viewer: ReminderViewer,
      link: Reminder["link"]
    ): Effect.Effect<string | null, ReminderServiceError> =>
      Effect.gen(function*() {
        switch (link._tag) {
          case "task": {
            const found = yield* tasks.findById(link.taskId as TaskId).pipe(Effect.orDie)
            if (Option.isNone(found) || found.value.deletedAt !== null) {
              return yield* invalid("link", "the linked task no longer exists")
            }
            const task = found.value
            if (task.householdId !== viewer.householdId) {
              return yield* Effect.fail(new ReminderForbidden({ id: task.id, reason: "household" }))
            }
            if (task.visibility === "private" && task.ownerId !== viewer.userId) {
              return yield* Effect.fail(new ReminderForbidden({ id: task.id, reason: "private" }))
            }
            return linkedInstantOf(task)
          }
          case "event": {
            const found = yield* events.findById(link.eventId as EventId).pipe(Effect.orDie)
            if (Option.isNone(found) || found.value.deletedAt !== null) {
              return yield* invalid("link", "the linked event no longer exists")
            }
            const event = found.value
            if (event.householdId !== viewer.householdId) {
              return yield* Effect.fail(new ReminderForbidden({ id: event.id, reason: "household" }))
            }
            if (event.visibility === "private" && event.ownerId !== viewer.userId) {
              return yield* Effect.fail(new ReminderForbidden({ id: event.id, reason: "private" }))
            }
            return linkedInstantOf(event)
          }
          case "habit":
            return null
          case "occasion": {
            const found = yield* occasions.findById(link.occasionId).pipe(Effect.orDie)
            if (Option.isNone(found) || found.value.deletedAt !== null) {
              return yield* invalid("link", "the linked occasion no longer exists")
            }
            const occasion = found.value
            if (occasion.householdId !== viewer.householdId) {
              return yield* Effect.fail(
                new ReminderForbidden({ id: occasion.id, reason: "household" })
              )
            }
            if (occasion.visibility === "private" && occasion.ownerId !== viewer.userId) {
              return yield* Effect.fail(
                new ReminderForbidden({ id: occasion.id, reason: "private" })
              )
            }
            // An occasion's advance instant is a projection of the occurrence,
            // not one stored instant, so there is no link-derived default: the
            // materialiser supplies an explicit `fireAt`, and a hand-created
            // `once` occasion reminder must do the same.
            return null
          }
          default:
            return null
        }
      })

    /**
     * Advance `fireAt` past a silence: a pattern resumes at its first
     * occurrence after the silence; a one-off that was inside the silence fires
     * at the silence's end rather than vanishing.
     */
    const advancePastSilence = (
      repeat: ReminderRepeat,
      fireAt: string,
      timeZone: string,
      silencedUntil: string
    ): string => {
      // The fire already sits after the silence: nothing to move.
      if (Date.parse(fireAt) > Date.parse(silencedUntil)) return fireAt
      if (repeat._tag === "once") return silencedUntil
      return reminderNextFireAfter(repeat, timeZone, silencedUntil) ?? fireAt
    }

    /** Decode + cross-field validate a repeat union against the shared contract. */
    const decodeRepeat = (
      repeat: ReminderRepeat
    ): Effect.Effect<ReminderRepeat, ReminderValidationError> => {
      const decoded = Schema.decodeUnknownOption(
        Schema.Union([
          Schema.Struct({ _tag: Schema.Literal("once") }),
          Schema.Struct({
            _tag: Schema.Literal("daily"),
            time: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/))
          }),
          Schema.Struct({
            _tag: Schema.Literal("weekly"),
            days: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 })))
              .check(Schema.isMinLength(1)),
            time: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/))
          }),
          Schema.Struct({
            _tag: Schema.Literal("interval"),
            hours: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
          })
        ])
      )(repeat)
      return Option.isNone(decoded)
        ? invalid("repeat", "the repeat pattern is not valid")
        : Effect.succeed(decoded.value)
    }

    /** The fire instant for a create/patch, after link resolution. */
    const deriveFireAt = (input: {
      readonly repeat: ReminderRepeat
      readonly timeZone: string
      readonly offsetMinutes: number
      readonly explicitFireAt: string | null | undefined
      readonly linkInstant: string | null
      readonly now: string
    }): Effect.Effect<string, ReminderServiceError> =>
      Effect.gen(function*() {
        const fireAt = reminderFireAt({
          repeat: input.repeat,
          timeZone: input.timeZone,
          now: input.now,
          offsetMinutes: input.offsetMinutes,
          explicitFireAt: input.explicitFireAt ?? null,
          linkInstant: input.linkInstant
        })
        if (fireAt === null) {
          return yield* invalid(
            "fireAt",
            input.repeat._tag === "once"
              ? "a one-off reminder needs a fire time or a linked item with a date"
              : "the repeat pattern has no next occurrence"
          )
        }
        return normalizeInstant(fireAt)
      })

    interface CommitEntry {
      readonly state: SyncEntityState
      readonly expectedVersion: number | null
      readonly clientMutationId: string
      readonly op?: "upsert" | "delete"
    }

    /** One batch: entity write, gated feed, gated ledger, gated index hook. */
    const commitEntries = (input: {
      readonly viewer: ReminderViewer
      readonly entries: ReadonlyArray<CommitEntry>
      readonly now: string
    }): Effect.Effect<boolean, ReminderServiceError> =>
      Effect.gen(function*() {
        if (input.entries.length === 0) return true
        const ids = input.entries.map((entry) => entry.clientMutationId)
        const prior = yield* sync
          .findApplied({
            householdId: input.viewer.householdId,
            clientMutationIds: ids
          })
          .pipe(Effect.orDie)
        for (const entry of input.entries) {
          const row = Option.fromUndefinedOr(prior.get(entry.clientMutationId))
          if (Option.isSome(row) && reusedMutationId(row.value, entry.state.entityId)) {
            return yield* reusedMutationIdError(entry.state.entityId)
          }
        }

        const statements = input.entries.flatMap((entry) => [
          sync.writeEntity({ state: entry.state, expectedVersion: entry.expectedVersion }),
          sync.appendFeed({
            householdId: input.viewer.householdId,
            entityType: entry.state.entityType,
            entityId: entry.state.entityId,
            op: entry.op ?? "upsert",
            version: entry.state.version,
            updatedAt: entry.state.updatedAt,
            ownerId: entry.state.ownerId,
            visibility: entry.state.visibility
          }),
          sync.recordApplied({
            clientMutationId: entry.clientMutationId,
            householdId: input.viewer.householdId,
            entityType: entry.state.entityType,
            entityId: entry.state.entityId,
            version: entry.state.version,
            createdAt: input.now
          }),
          ...sync.indexStatements(entry.state)
        ])
        yield* sync.commit(statements).pipe(Effect.orDie)

        const applied = yield* sync
          .findApplied({
            householdId: input.viewer.householdId,
            clientMutationIds: ids
          })
          .pipe(Effect.orDie)
        return ids.every((id) => applied.has(id))
      })

    const commitReminder = (input: {
      readonly viewer: ReminderViewer
      readonly state: SyncEntityState
      readonly expectedVersion: number | null
      readonly clientMutationId: string
      readonly now: string
      readonly op?: "upsert" | "delete"
    }): Effect.Effect<boolean, ReminderServiceError> =>
      commitEntries({
        viewer: input.viewer,
        now: input.now,
        entries: [
          {
            state: input.state,
            expectedVersion: input.expectedVersion,
            clientMutationId: input.clientMutationId,
            op: input.op
          }
        ]
      })

    const create = (
      viewer: ReminderViewer,
      input: Schema.Schema.Type<typeof ReminderCreateInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Reminder, ReminderServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayReminder(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value
        if (input.title.trim().length === 0) {
          return yield* invalid("title", "a reminder needs a title")
        }

        const repeat = yield* decodeRepeat(input.repeat)
        const link = input.link ?? { _tag: "none" } as const
        const timeZone = input.timeZone ?? viewer.timeZone
        const offsetMinutes = input.offsetMinutes ?? 0
        const linkInstant = yield* resolveLink(viewer, link)
        const fireAt = yield* deriveFireAt({
          repeat,
          timeZone,
          offsetMinutes,
          explicitFireAt: input.fireAt ?? null,
          linkInstant,
          now
        })
        const silencedUntil = input.silencedUntil === null || input.silencedUntil === undefined
          ? null
          : normalizeInstant(input.silencedUntil)
        const effectiveFireAt = silencedUntil === null
          ? fireAt
          : advancePastSilence(repeat, fireAt, timeZone, silencedUntil)

        const reminder = new Reminder({
          id: (input.id ?? uuidV7()) as Reminder["id"],
          type: "reminder",
          title: input.title,
          note: input.note ?? null,
          kind: input.kind,
          tier: inferTier(input.kind),
          repeat,
          fireAt: effectiveFireAt,
          offsetMinutes,
          link,
          silencedUntil,
          timeZone,
          ownerId: viewer.userId,
          householdId: viewer.householdId,
          visibility: (input.visibility ?? "shared") as Visibility,
          color: input.color ?? null,
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null
        })

        const applied = yield* commitReminder({
          viewer,
          state: reminderState(reminder),
          expectedVersion: null,
          clientMutationId: input.clientMutationId,
          now
        })
        if (!applied) {
          return yield* Effect.fail(new ReminderConflict({ id: reminder.id }))
        }
        return reminder
      })

    const get = (
      viewer: ReminderViewer,
      id: ReminderId
    ): Effect.Effect<Reminder, ReminderServiceError> => readReminder(viewer, id, false)

    /**
     * Apply a patch. A scheduling change (repeat, link, offset, zone or an
     * explicit fireAt) re-derives `fireAt`; a title/note/colour edit keeps the
     * current one, so it cannot undo a claim that already advanced the series.
     */
    const patchReminder = (
      viewer: ReminderViewer,
      current: Reminder,
      patch: Schema.Schema.Type<typeof ReminderPatch>,
      now: string
    ): Effect.Effect<Reminder, ReminderServiceError> =>
      Effect.gen(function*() {
        if (patch.title !== undefined && patch.title.trim().length === 0) {
          return yield* invalid("title", "a reminder needs a title")
        }
        const repeat = patch.repeat === undefined ? current.repeat : yield* decodeRepeat(patch.repeat)
        const link = patch.link ?? current.link
        const timeZone = patch.timeZone ?? current.timeZone
        const offsetMinutes = patch.offsetMinutes ?? current.offsetMinutes
        const kind = patch.kind ?? current.kind
        const silencedUntil = patch.silencedUntil === undefined
          ? current.silencedUntil
          : patch.silencedUntil === null
          ? null
          : normalizeInstant(patch.silencedUntil)

        const linkChanged = patch.link !== undefined && JSON.stringify(link) !== JSON.stringify(current.link)
        const scheduleChanged =
          linkChanged ||
          patch.repeat !== undefined ||
          patch.offsetMinutes !== undefined ||
          patch.timeZone !== undefined ||
          patch.fireAt !== undefined

        let fireAt = current.fireAt
        if (scheduleChanged) {
          const linkInstant = yield* resolveLink(viewer, link)
          fireAt = yield* deriveFireAt({
            repeat,
            timeZone,
            offsetMinutes,
            explicitFireAt: patch.fireAt,
            linkInstant,
            now
          })
        }
        if (silencedUntil !== null && silencedUntil !== current.silencedUntil) {
          fireAt = advancePastSilence(repeat, fireAt, timeZone, silencedUntil)
        }

        return new Reminder({
          ...current,
          title: patch.title ?? current.title,
          note: patch.note === undefined ? current.note : patch.note,
          kind,
          tier: inferTier(kind),
          repeat,
          fireAt,
          offsetMinutes,
          link,
          silencedUntil,
          timeZone,
          color: patch.color === undefined ? current.color : patch.color,
          visibility: patch.visibility ?? current.visibility,
          version: current.version + 1,
          updatedAt: now
        })
      })

    /** Are two reminders equal in every field the service owns? */
    const sameReminder = (a: Reminder, b: Reminder): boolean =>
      a.title === b.title &&
      a.note === b.note &&
      a.kind === b.kind &&
      a.tier === b.tier &&
      a.repeat._tag === b.repeat._tag &&
      JSON.stringify(a.repeat) === JSON.stringify(b.repeat) &&
      a.fireAt === b.fireAt &&
      a.offsetMinutes === b.offsetMinutes &&
      JSON.stringify(a.link) === JSON.stringify(b.link) &&
      a.silencedUntil === b.silencedUntil &&
      a.timeZone === b.timeZone &&
      a.color === b.color &&
      a.visibility === b.visibility

    const update = (
      viewer: ReminderViewer,
      input: Schema.Schema.Type<typeof ReminderUpdateInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Reminder, ReminderServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayReminder(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* readReminder(viewer, input.id, false)
          const next = yield* patchReminder(viewer, current, input.patch, now)
          if (sameReminder(current, next)) return current
          const applied = yield* commitReminder({
            viewer,
            state: reminderState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now
          })
          if (applied) return next
        }
        return yield* Effect.fail(new ReminderConflict({ id: input.id }))
      })

    /** Soft delete: tombstone + the registry hook expires any owed dispatch. */
    const remove = (
      viewer: ReminderViewer,
      input: Schema.Schema.Type<typeof ReminderMutationInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Reminder, ReminderServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayReminder(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* readReminder(viewer, input.id, false)
          const next = new Reminder({
            ...current,
            deletedAt: now,
            version: current.version + 1,
            updatedAt: now
          })
          const applied = yield* commitReminder({
            viewer,
            state: reminderState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now,
            op: "delete"
          })
          if (applied) return next
        }
        return yield* Effect.fail(new ReminderConflict({ id: input.id }))
      })

    const list = (
      viewer: ReminderViewer,
      input?: { readonly includeDeleted?: boolean }
    ): Effect.Effect<ReadonlyArray<Reminder>, ReminderServiceError> =>
      reminders.listVisible({
        householdId: viewer.householdId,
        userId: viewer.userId,
        includeDeleted: input?.includeDeleted
      }).pipe(Effect.orDie)

    const inbox = (
      viewer: ReminderViewer,
      query?: Schema.Schema.Type<typeof ReminderInboxQuery>,
      now: string = new Date().toISOString()
    ): Effect.Effect<ReadonlyArray<ReminderInboxItem>, ReminderServiceError> =>
      dispatches.listInbox({
        userId: viewer.userId,
        now,
        history: query?.history,
        limit: query?.limit
      }).pipe(Effect.orDie)

    /**
     * Complete a linked task in the response batch.
     *
     * Reuses the same task registry write/feed/ledger primitives as
     * `TaskService.complete` and the #34 sync path, including the #38
     * recurrence successor, so a reminder-completed task behaves exactly like
     * one completed from the task screen. The update is a CAS on the task's
     * version; a lost CAS (another device completed it first) is a no-op and
     * the reminder answer still lands.
     */
    const taskCompletionStatements = (
      viewer: ReminderViewer,
      taskId: TaskId,
      dispatchId: string,
      now: string
    ) =>
      Effect.gen(function*() {
        const found = yield* tasks.findById(taskId).pipe(Effect.orDie)
        if (Option.isNone(found)) return []
        const task = found.value
        if (task.householdId !== viewer.householdId) return []
        if (task.visibility === "private" && task.ownerId !== viewer.userId) return []
        if (task.deletedAt !== null || task.status === "done") return []

        const next = new Task({
          ...task,
          status: "done",
          completedAt: task.completedAt ?? now,
          version: task.version + 1,
          updatedAt: now
        })
        const taskDefinition = definition("task")
        const state = (value: Task): SyncEntityState => ({
          entityType: "task",
          entityId: value.id,
          householdId: value.householdId,
          ownerId: value.ownerId,
          visibility: value.visibility,
          version: value.version,
          updatedAt: value.updatedAt,
          deletedAt: value.deletedAt,
          data: taskDefinition.validate(
            { ...value } as Record<string, unknown>,
            { version: value.version, updatedAt: value.updatedAt, deletedAt: value.deletedAt }
          )
        })
        const nextState = state(next)
        const statements = [
          sync.writeEntity({ state: nextState, expectedVersion: task.version }),
          sync.appendFeed({
            householdId: viewer.householdId,
            entityType: "task",
            entityId: next.id,
            op: "upsert",
            version: next.version,
            updatedAt: next.updatedAt,
            ownerId: next.ownerId,
            visibility: next.visibility
          }),
          sync.recordApplied({
            clientMutationId: `reminder-done:${dispatchId}`,
            householdId: viewer.householdId,
            entityType: "task",
            entityId: next.id,
            version: next.version,
            createdAt: now
          })
        ]
        const spawn = taskDefinition.spawn?.({ previous: state(task), next: nextState, now })
        if (spawn !== undefined) {
          statements.push(
            spawn.insert(spawn.state),
            sync.appendFeed({
              householdId: viewer.householdId,
              entityType: spawn.state.entityType,
              entityId: spawn.state.entityId,
              op: "upsert",
              version: spawn.state.version,
              updatedAt: spawn.state.updatedAt,
              ownerId: spawn.state.ownerId,
              visibility: spawn.state.visibility
            }),
            sync.recordApplied({
              clientMutationId: `recurrence:${spawn.parentId}`,
              householdId: viewer.householdId,
              entityType: spawn.state.entityType,
              entityId: spawn.state.entityId,
              version: spawn.state.version,
              createdAt: now
            }),
            ...(spawn.joins?.(spawn.state) ?? [])
          )
        }
        return statements
      })

    /**
     * Claim a due fire (ADR-0005 §3): policy at claim, then one atomic batch
     * that inserts the ledger row and advances `fire_at` behind the same
     * unique-key gate. The push/outcome half of the sweep is #61's.
     */
    const claim = (input: {
      readonly reminderId: ReminderId
      readonly scheduledFor: string
      readonly ownerTimeZone: string
      readonly now?: string
    }): Effect.Effect<Option.Option<ReminderDispatch>, ReminderServiceError> =>
      Effect.gen(function*() {
        const now = input.now ?? new Date().toISOString()
        const found = yield* reminders.findById(input.reminderId).pipe(Effect.orDie)
        if (Option.isNone(found)) return Option.none()
        const reminder = found.value
        if (reminder.deletedAt !== null || reminder.fireAt !== input.scheduledFor) {
          return Option.none()
        }

        const plan = reminderDeliverAt(reminder, input.ownerTimeZone, input.scheduledFor)
        if (plan._tag === "suppress") {
          // Silence is not a hold: no dispatch, the series advances past the
          // silence. A one-off moves to the silence's end.
          const silencedUntil = reminder.silencedUntil ?? input.scheduledFor
          const next = advancePastSilence(
            reminder.repeat,
            input.scheduledFor,
            reminder.timeZone,
            silencedUntil
          )
          if (next !== input.scheduledFor) {
            yield* sync.commit([
              dispatches.advanceSuppressedStatement({
                reminderId: reminder.id,
                from: input.scheduledFor,
                to: next
              })
            ]).pipe(Effect.orDie)
          }
          return Option.none()
        }

        const dispatch = new ReminderDispatch({
          id: uuidV7() as ReminderDispatch["id"],
          reminderId: reminder.id,
          userId: reminder.ownerId,
          scheduledFor: input.scheduledFor,
          deliverAt: plan.deliverAt,
          rootScheduledFor: input.scheduledFor,
          origin: "schedule",
          pushOutcome: "pending" as PushOutcome,
          attempts: 0,
          lastAttemptAt: null,
          parentDispatchId: null,
          response: null,
          respondedAt: null,
          snoozedUntil: null,
          createdAt: now
        })
        const next = reminderNextFireAfterNow(
          reminder.repeat,
          reminder.timeZone,
          input.scheduledFor,
          now
        )

        yield* sync.commit([
          dispatches.claimInsertStatement(dispatch),
          ...(next === null
            ? []
            : [dispatches.advanceFireAtStatement({
              reminderId: reminder.id,
              from: input.scheduledFor,
              to: next
            })])
        ]).pipe(Effect.orDie)

        // The unique key is the mutex: if an overlapping tick won, our INSERT
        // wrote nothing and the read returns None.
        return yield* dispatches.findById(dispatch.id).pipe(Effect.orDie)
      })

    /**
     * Claim a tick's whole due list in one batch (ADR-0005 §3, §9).
     *
     * The fields come from `listDueFires`, which is the same row the policy
     * would read — so this does not re-read the reminder per fire. Statements
     * per fire: the claim INSERT plus, when the series continues, the CAS
     * advance. A silenced fire writes only the advance. All of them ride one
     * `sync.commit`, which is what keeps a ten-fire minute inside D1's Free-plan
     * query ceiling.
     */
    const claimMany = (input: {
      readonly fires: ReadonlyArray<{
        readonly reminderId: ReminderId
        readonly scheduledFor: string
        readonly ownerId: UserId
        readonly ownerTimeZone: string
        readonly tier: Reminder["tier"]
        readonly repeat: ReminderRepeat
        readonly timeZone: string
        readonly silencedUntil: string | null
      }>
      readonly now?: string
    }): Effect.Effect<number, ReminderServiceError> =>
      Effect.gen(function*() {
        const now = input.now ?? new Date().toISOString()
        const statements: Array<Statement.Statement<unknown>> = []
        let planned = 0

        for (const fire of input.fires) {
          if (!validInstant(fire.scheduledFor)) continue
          const plan = reminderDeliverAt(fire, fire.ownerTimeZone, fire.scheduledFor)
          if (plan._tag === "suppress") {
            const silencedUntil = fire.silencedUntil ?? fire.scheduledFor
            const next = advancePastSilence(
              fire.repeat,
              fire.scheduledFor,
              fire.timeZone,
              silencedUntil
            )
            if (next !== fire.scheduledFor) {
              statements.push(
                dispatches.advanceSuppressedStatement({
                  reminderId: fire.reminderId,
                  from: fire.scheduledFor,
                  to: next
                })
              )
            }
            continue
          }

          const dispatch = new ReminderDispatch({
            id: uuidV7() as ReminderDispatch["id"],
            reminderId: fire.reminderId,
            userId: fire.ownerId,
            scheduledFor: fire.scheduledFor,
            deliverAt: plan.deliverAt,
            rootScheduledFor: fire.scheduledFor,
            origin: "schedule",
            pushOutcome: "pending" as PushOutcome,
            attempts: 0,
            lastAttemptAt: null,
            parentDispatchId: null,
            response: null,
            respondedAt: null,
            snoozedUntil: null,
            createdAt: now
          })
          const next = reminderNextFireAfterNow(
            fire.repeat,
            fire.timeZone,
            fire.scheduledFor,
            now
          )
          statements.push(dispatches.claimInsertStatement(dispatch))
          if (next !== null) {
            statements.push(
              dispatches.advanceFireAtStatement({
                reminderId: fire.reminderId,
                from: fire.scheduledFor,
                to: next
              })
            )
          }
          planned += 1
        }

        yield* sync.commit(statements).pipe(Effect.orDie)
        return planned
      })

    const respond = (
      viewer: ReminderViewer,
      input: Schema.Schema.Type<typeof ReminderRespondInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<ReminderResponseResult, ReminderServiceError> =>
      Effect.gen(function*() {
        const found = yield* dispatches.findById(input.dispatchId).pipe(Effect.orDie)
        if (Option.isNone(found) || found.value.userId !== viewer.userId) {
          return yield* Effect.fail(new ReminderDispatchNotFound({ id: input.dispatchId }))
        }
        const current = found.value
        // A double tap is a no-op: return the stored answer, not a new one.
        if (current.response !== null) {
          return { dispatch: current, child: null, onTime: isOnTime(current) }
        }

        let snoozedUntil: string | null = null
        if (input.response === "snooze") {
          if (input.snoozeMinutes === undefined) {
            return yield* invalid("snoozeMinutes", "a snooze needs a number of minutes")
          }
          const target = snoozeInstant(now, input.snoozeMinutes)
          if (target === null) {
            return yield* invalid(
              "snoozeMinutes",
              "a snooze must be one of 5, 10, 15, 30 or 60 minutes"
            )
          }
          snoozedUntil = target
        }

        const reminder = yield* readReminder(viewer, current.reminderId, true)
        const child: ReminderDispatch | null = snoozedUntil === null
          ? null
          : new ReminderDispatch({
            id: uuidV7() as ReminderDispatch["id"],
            reminderId: current.reminderId,
            userId: viewer.userId,
            scheduledFor: snoozedUntil,
            deliverAt: snoozedUntil,
            rootScheduledFor: current.rootScheduledFor,
            origin: `snooze:${current.id}`,
            pushOutcome: "pending" as PushOutcome,
            attempts: 0,
            lastAttemptAt: null,
            parentDispatchId: current.id,
            response: null,
            respondedAt: null,
            snoozedUntil: null,
            createdAt: now
          })

        const linkStatements = input.response === "done" && reminder.link._tag === "task"
          ? yield* taskCompletionStatements(viewer, reminder.link.taskId as TaskId, current.id, now)
          : []

        yield* sync.commit([
          dispatches.respondStatement({
            dispatchId: current.id,
            response: input.response as DispatchResponse,
            respondedAt: now,
            snoozedUntil
          }),
          ...linkStatements,
          ...(child === null ? [] : [dispatches.insertSnoozeChildStatement(child)])
        ]).pipe(Effect.orDie)

        const after = yield* dispatches.findById(current.id).pipe(Effect.orDie)
        const dispatch = Option.getOrElse(after, () => current)
        const storedChild = child === null
          ? Option.none<ReminderDispatch>()
          : yield* dispatches.findSnoozeChild(current.id).pipe(Effect.orDie)
        return {
          dispatch,
          child: Option.getOrElse(storedChild, () => null),
          onTime: isOnTime(dispatch)
        }
      })

    return {
      create,
      get,
      update,
      delete: remove,
      list,
      inbox,
      claim,
      claimMany,
      respond
    } as const
  })
}) {}

export const ReminderServiceLive = Layer.effect(ReminderService, ReminderService.make).pipe(
  Layer.provide(ReminderRepoLive),
  Layer.provide(ReminderDispatchRepoLive),
  Layer.provide(TaskRepoLive),
  Layer.provide(EventRepoLive),
  Layer.provide(OccasionRepoLive),
  Layer.provide(SyncRepoLive)
)
