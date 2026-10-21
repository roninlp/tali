import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import {
  type HouseholdId,
  type LocalDate,
  Occasion,
  OccasionConflict,
  OccasionCreateInput,
  type OccasionId,
  OccasionMutationInput,
  OccasionNotFound,
  OccasionOccurrenceQuery,
  OccasionPatch,
  OccasionPrepareInput,
  type OccasionServiceError,
  OccasionForbidden,
  OccasionValidationError,
  OccasionUpdateInput,
  Reminder,
  type ReminderServiceError,
  Task,
  type TaskId,
  taskBucketBounds,
  TimeZone,
  type UserId,
  type Visibility,
  occasionAdvanceReminder,
  occasionAdvanceReminderDate,
  occasionAdvanceReminders,
  occasionOccurrences,
  occasionPreparationTaskTitle,
  isOccasionOccurrence,
  localDateStartInstant,
  nextOccasionOccurrence,
  uuidV7
} from "@tali/domain"
import type {
  OccasionAdvanceReminder,
  OccasionDetail as OccasionDetailShape,
  OccasionOccurrence as OccasionOccurrenceShape,
  OccasionPreparation as OccasionPreparationShape,
  OccasionSource
} from "@tali/domain"
import {
  OccasionRepo,
  OccasionRepoLive,
  ReminderRepo,
  ReminderRepoLive,
  type SyncEntityState,
  SyncRepo,
  SyncRepoLive,
  TaskRepo,
  TaskRepoLive
} from "@tali/sql"
import { ReminderService, ReminderServiceLive } from "./reminder-service.js"

/**
 * `OccasionService` — annual important dates (ticket #59; FR-CAL-02).
 *
 * ## Write path
 *
 * Every mutation is exactly one `D1Client.batch()` built from the #34 sync
 * primitives (`writeEntity` + gated `appendFeed` + gated `recordApplied`), so an
 * occasion changed here bumps its version, appends a `change_feed` row and
 * travels on `/sync/pull` exactly like every other aggregate. `clientMutationId`
 * makes a mutation replay-safe; a lost CAS re-reads and reapplies the patch.
 *
 * ## The read side is a projection
 *
 * `occurrences` and `advanceReminders` never write a per-year row. They load the
 * visible occasion rows and hand them to the pure builders in
 * `packages/domain/src/planning/occasion-projection.ts`, which is the same code
 * the offline client runs over its mirror.
 *
 * ## The preparation task is the only cross-aggregate write
 *
 * `prepareTask` writes a real `Task` (so it completes, syncs and appears on
 * `/today` like any task) and links it from the occasion in the same batch. The
 * task insert is gated on the occasion CAS that links it, so a lost CAS cannot
 * leave an orphan task. A second tap returns the existing live task.
 *
 * ## The reminder seam
 *
 * `advanceReminders` returns `OccasionAdvanceReminder` drafts with a stable
 * `reminderKey` and `ReminderLink { _tag: "occasion" }`. It deliberately does
 * **not** create a reminder row: ticket #60 owns the `Reminder` aggregate. #60
 * can poll this read (or expand the same pure builder in its cron sweep) once it
 * lands, with no schema change here.
 */

/** How many CAS retries a service mutation makes before reporting contention. */
const MAX_CAS_ATTEMPTS = 3

export interface OccasionViewer {
  readonly userId: UserId
  readonly householdId: HouseholdId
  /** The viewer's zone: "today" for the next occurrence and a default zone. */
  readonly timeZone: string
}

export interface OccasionServiceApi {
  readonly create: (
    viewer: OccasionViewer,
    input: Schema.Schema.Type<typeof OccasionCreateInput>,
    now?: string
  ) => Effect.Effect<Occasion, OccasionServiceError>
  readonly get: (
    viewer: OccasionViewer,
    id: OccasionId,
    now?: string
  ) => Effect.Effect<OccasionDetailShape, OccasionServiceError>
  readonly update: (
    viewer: OccasionViewer,
    input: Schema.Schema.Type<typeof OccasionUpdateInput>,
    now?: string
  ) => Effect.Effect<Occasion, OccasionServiceError>
  readonly delete: (
    viewer: OccasionViewer,
    input: Schema.Schema.Type<typeof OccasionMutationInput>,
    now?: string
  ) => Effect.Effect<Occasion, OccasionServiceError>
  readonly list: (
    viewer: OccasionViewer
  ) => Effect.Effect<ReadonlyArray<Occasion>, OccasionServiceError>
  /** Project the visible occasions onto an inclusive local-date window. */
  readonly occurrences: (
    viewer: OccasionViewer,
    input: Schema.Schema.Type<typeof OccasionOccurrenceQuery>
  ) => Effect.Effect<ReadonlyArray<OccasionOccurrenceShape>, OccasionServiceError>
  /** Advance reminders due inside the window (the #60 seam, not persisted). */
  readonly advanceReminders: (
    viewer: OccasionViewer,
    input: Schema.Schema.Type<typeof OccasionOccurrenceQuery>
  ) => Effect.Effect<ReadonlyArray<OccasionAdvanceReminder>, OccasionServiceError>
  /**
   * Materialise the due advance reminders into real `Reminder` rows (#60).
   *
   * One row per `(occasion, occurrence)`, linked with `ReminderLink._tag =
   * "occasion"` and fired at the occurrence minus the offset, 09:00 local in the
   * occasion's zone. Idempotent: an existing row for the same link + fire
   * instant is returned rather than duplicated, and a tombstoned one is left
   * deleted.
   */
  readonly materialiseReminders: (
    viewer: OccasionViewer,
    input: Schema.Schema.Type<typeof OccasionOccurrenceQuery>
  ) => Effect.Effect<ReadonlyArray<Reminder>, OccasionServiceError | ReminderServiceError>
  /** One-tap "prepare gift" task creation (idempotent for a live link). */
  readonly prepareTask: (
    viewer: OccasionViewer,
    input: Schema.Schema.Type<typeof OccasionPrepareInput>,
    now?: string
  ) => Effect.Effect<OccasionPreparationShape, OccasionServiceError>
}

const invalid = (
  field: string,
  message: string
): Effect.Effect<never, OccasionValidationError> =>
  Effect.fail(new OccasionValidationError({ issues: [{ field, message }] }))

const validLocalDate = (value: string): boolean => {
  try {
    localDateStartInstant(value, "UTC")
    return true
  } catch {
    return false
  }
}

/**
 * A malformed IANA zone must be a typed validation failure, not a schema defect
 * that 500s the RPC: the registry's `validate` would otherwise throw while
 * encoding the row (the same guard the habit service applies).
 */
const decodeTimeZone = (timeZone: string): Effect.Effect<string, OccasionValidationError> => {
  const decoded = Schema.decodeUnknownOption(TimeZone)(timeZone)
  return Option.isNone(decoded)
    ? invalid("timeZone", "the time zone must be a valid IANA identifier")
    : Effect.succeed(decoded.value)
}

export class OccasionService extends Context.Service<OccasionService>()("OccasionService", {
  make: Effect.gen(function*() {
    const occasions = yield* OccasionRepo
    const tasks = yield* TaskRepo
    const sync = yield* SyncRepo
    const reminders = yield* ReminderService
    const reminderRepo = yield* ReminderRepo
    const sql = yield* SqlClient.SqlClient

    const definition = (entityType: "occasion" | "task") => {
      const def = sync.definition(entityType)
      if (def === undefined) {
        throw new Error(`sync entity type is not registered: ${entityType}`)
      }
      return def
    }

    /** The registry's strict shape, shared with the sync push. */
    const occasionState = (occasion: Occasion): SyncEntityState => ({
      entityType: "occasion",
      entityId: occasion.id,
      householdId: occasion.householdId,
      ownerId: occasion.ownerId,
      visibility: occasion.visibility,
      version: occasion.version,
      updatedAt: occasion.updatedAt,
      deletedAt: occasion.deletedAt,
      data: definition("occasion").validate(
        { ...occasion } as Record<string, unknown>,
        {
          version: occasion.version,
          updatedAt: occasion.updatedAt,
          deletedAt: occasion.deletedAt
        }
      )
    })

    const taskState = (task: Task): SyncEntityState => ({
      entityType: "task",
      entityId: task.id,
      householdId: task.householdId,
      ownerId: task.ownerId,
      visibility: task.visibility,
      version: task.version,
      updatedAt: task.updatedAt,
      deletedAt: task.deletedAt,
      data: definition("task").validate(
        { ...task } as Record<string, unknown>,
        { version: task.version, updatedAt: task.updatedAt, deletedAt: task.deletedAt }
      )
    })

    const appliedMutation = (viewer: OccasionViewer, clientMutationId: string) =>
      Effect.gen(function*() {
        const applied = yield* sync
          .findApplied({
            householdId: viewer.householdId,
            clientMutationIds: [clientMutationId]
          })
          .pipe(Effect.orDie)
        return Option.fromUndefinedOr(applied.get(clientMutationId))
      })

    const reusedMutationId = (
      row: { readonly entityType: string; readonly entityId: string },
      expected: { readonly entityType: string; readonly id?: string }
    ): boolean =>
      row.entityType !== expected.entityType ||
      (expected.id !== undefined && row.entityId !== expected.id)

    const reusedMutationIdError = (id: string) =>
      invalid("clientMutationId", "this mutation id was already applied to a different change")

    /**
     * One occasion mutation: the CAS entity write, its gated feed append and
     * its gated ledger row, in one D1 batch. Returns whether the ledger recorded
     * the mutation, i.e. the CAS won.
     */
    const commitOccasion = (input: {
      readonly viewer: OccasionViewer
      readonly state: SyncEntityState
      readonly expectedVersion: number | null
      readonly clientMutationId: string
      readonly now: string
      readonly op?: "upsert" | "delete"
    }): Effect.Effect<boolean, OccasionServiceError> =>
      Effect.gen(function*() {
        const prior = yield* appliedMutation(input.viewer, input.clientMutationId)
        if (Option.isSome(prior)) {
          if (
            reusedMutationId(prior.value, {
              entityType: "occasion",
              id: input.state.entityId
            })
          ) {
            return yield* reusedMutationIdError(input.state.entityId)
          }
          return true
        }

        const statements = [
          sync.writeEntity({
            state: input.state,
            expectedVersion: input.expectedVersion
          }),
          sync.appendFeed({
            householdId: input.viewer.householdId,
            entityType: "occasion",
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
            entityType: "occasion",
            entityId: input.state.entityId,
            version: input.state.version,
            createdAt: input.now
          })
        ]
        yield* sync.commit(statements).pipe(Effect.orDie)

        const applied = yield* appliedMutation(input.viewer, input.clientMutationId)
        return Option.isSome(applied)
      })

    const readOccasion = (
      viewer: OccasionViewer,
      id: OccasionId,
      includeTrashed: boolean
    ): Effect.Effect<Occasion, OccasionServiceError> =>
      Effect.gen(function*() {
        const found = yield* occasions.findById(id).pipe(Effect.orDie)
        if (Option.isNone(found)) {
          return yield* Effect.fail(new OccasionNotFound({ id }))
        }
        const occasion = found.value
        if (occasion.householdId !== viewer.householdId) {
          return yield* Effect.fail(new OccasionForbidden({ id, reason: "household" }))
        }
        if (occasion.visibility === "private" && occasion.ownerId !== viewer.userId) {
          return yield* Effect.fail(new OccasionForbidden({ id, reason: "private" }))
        }
        if (!includeTrashed && occasion.deletedAt !== null) {
          return yield* Effect.fail(new OccasionNotFound({ id }))
        }
        return occasion
      })

    /** Today in the viewer's zone, as a local date. */
    const todayOf = (viewer: OccasionViewer, now: string): LocalDate =>
      taskBucketBounds(viewer.timeZone, now).today

    const visibleOccasions = (
      viewer: OccasionViewer
    ): Effect.Effect<ReadonlyArray<Occasion>, OccasionServiceError> =>
      occasions.listVisible({
        householdId: viewer.householdId,
        userId: viewer.userId
      }).pipe(Effect.orDie)

    /** The same rows in the structural shape the pure projection accepts. */
    const visibleSources = (
      viewer: OccasionViewer
    ): Effect.Effect<ReadonlyArray<OccasionSource>, OccasionServiceError> =>
      Effect.map(visibleOccasions(viewer), (rows) => rows)

    const validateRange = (
      input: Schema.Schema.Type<typeof OccasionOccurrenceQuery>
    ): Effect.Effect<void, OccasionValidationError> =>
      Effect.gen(function*() {
        if (!validLocalDate(input.from)) {
          return yield* invalid("from", "the window needs a real calendar date")
        }
        if (!validLocalDate(input.to)) {
          return yield* invalid("to", "the window needs a real calendar date")
        }
        if (input.to < input.from) {
          return yield* invalid("to", "the window ends before it starts")
        }
      })

    const create = (
      viewer: OccasionViewer,
      input: Schema.Schema.Type<typeof OccasionCreateInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Occasion, OccasionServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* appliedMutation(viewer, input.clientMutationId)
        if (Option.isSome(replayed)) {
          if (
            reusedMutationId(replayed.value, { entityType: "occasion", id: input.id })
          ) {
            return yield* reusedMutationIdError(input.id ?? replayed.value.entityId)
          }
          return yield* readOccasion(
            viewer,
            replayed.value.entityId as OccasionId,
            true
          )
        }

        if (input.title.trim().length === 0) {
          return yield* invalid("title", "an occasion needs a title")
        }
        if (!validLocalDate(input.originDate)) {
          return yield* invalid("originDate", "the origin date must be a real calendar date")
        }
        const timeZone = yield* decodeTimeZone(input.timeZone ?? viewer.timeZone)

        const occasion = new Occasion({
          id: (input.id ?? uuidV7()) as Occasion["id"],
          type: "occasion",
          title: input.title,
          originDate: input.originDate,
          timeZone: timeZone as TimeZone,
          yearly: input.yearly ?? true,
          advanceReminderDays: input.advanceReminderDays ?? null,
          preparationTaskId: null,
          ownerId: viewer.userId,
          householdId: viewer.householdId,
          visibility: (input.visibility ?? "shared") as Visibility,
          color: input.color ?? null,
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null
        })

        const applied = yield* commitOccasion({
          viewer,
          state: occasionState(occasion),
          expectedVersion: null,
          clientMutationId: input.clientMutationId,
          now
        })
        if (!applied) {
          return yield* Effect.fail(new OccasionConflict({ id: occasion.id }))
        }
        return occasion
      })

    const detail = (
      viewer: OccasionViewer,
      id: OccasionId,
      now: string = new Date().toISOString()
    ): Effect.Effect<OccasionDetailShape, OccasionServiceError> =>
      Effect.gen(function*() {
        const occasion = yield* readOccasion(viewer, id, false)
        const next = nextOccasionOccurrence(occasion, todayOf(viewer, now))
        return {
          occasion,
          next,
          nextReminder:
            next === null ? null : occasionAdvanceReminder(occasion, next.date)
        }
      })

    const patchOccasion = (
      current: Occasion,
      patch: Schema.Schema.Type<typeof OccasionPatch>,
      now: string
    ): Effect.Effect<Occasion, OccasionServiceError> =>
      Effect.gen(function*() {
        if (patch.title !== undefined && patch.title.trim().length === 0) {
          return yield* invalid("title", "an occasion needs a title")
        }
        if (patch.originDate !== undefined && !validLocalDate(patch.originDate)) {
          return yield* invalid("originDate", "the origin date must be a real calendar date")
        }
        const timeZone = yield* decodeTimeZone(patch.timeZone ?? current.timeZone)
        return new Occasion({
          ...current,
          title: patch.title ?? current.title,
          originDate: patch.originDate ?? current.originDate,
          timeZone: timeZone as TimeZone,
          yearly: patch.yearly ?? current.yearly,
          advanceReminderDays:
            patch.advanceReminderDays === undefined
              ? current.advanceReminderDays
              : patch.advanceReminderDays,
          color: patch.color === undefined ? current.color : patch.color,
          visibility: patch.visibility ?? current.visibility,
          version: current.version + 1,
          updatedAt: now
        })
      })

    const sameOccasion = (a: Occasion, b: Occasion): boolean =>
      a.title === b.title &&
      a.originDate === b.originDate &&
      a.timeZone === b.timeZone &&
      a.yearly === b.yearly &&
      a.advanceReminderDays === b.advanceReminderDays &&
      a.color === b.color &&
      a.visibility === b.visibility &&
      a.preparationTaskId === b.preparationTaskId

    const update = (
      viewer: OccasionViewer,
      input: Schema.Schema.Type<typeof OccasionUpdateInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Occasion, OccasionServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* appliedMutation(viewer, input.clientMutationId)
        if (Option.isSome(replayed)) {
          if (reusedMutationId(replayed.value, { entityType: "occasion", id: input.id })) {
            return yield* reusedMutationIdError(input.id)
          }
          return yield* readOccasion(viewer, input.id, true)
        }

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* readOccasion(viewer, input.id, false)
          const next = yield* patchOccasion(current, input.patch, now)
          if (sameOccasion(current, next)) return current
          const applied = yield* commitOccasion({
            viewer,
            state: occasionState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now
          })
          if (applied) return next
        }
        return yield* Effect.fail(new OccasionConflict({ id: input.id }))
      })

    const deleteOccasion = (
      viewer: OccasionViewer,
      input: Schema.Schema.Type<typeof OccasionMutationInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Occasion, OccasionServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* appliedMutation(viewer, input.clientMutationId)
        if (Option.isSome(replayed)) {
          if (reusedMutationId(replayed.value, { entityType: "occasion", id: input.id })) {
            return yield* reusedMutationIdError(input.id)
          }
          return yield* readOccasion(viewer, input.id, true)
        }

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* readOccasion(viewer, input.id, false)
          const next = new Occasion({
            ...current,
            deletedAt: now,
            version: current.version + 1,
            updatedAt: now
          })
          const applied = yield* commitOccasion({
            viewer,
            state: occasionState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now,
            op: "delete"
          })
          if (applied) return next
        }
        return yield* Effect.fail(new OccasionConflict({ id: input.id }))
      })

    const list = (
      viewer: OccasionViewer
    ): Effect.Effect<ReadonlyArray<Occasion>, OccasionServiceError> =>
      visibleOccasions(viewer)

    const occurrences = (
      viewer: OccasionViewer,
      input: Schema.Schema.Type<typeof OccasionOccurrenceQuery>
    ): Effect.Effect<ReadonlyArray<OccasionOccurrenceShape>, OccasionServiceError> =>
      Effect.gen(function*() {
        yield* validateRange(input)
        const rows = yield* visibleSources(viewer)
        return occasionOccurrences({ occasions: rows, range: input })
      })

    const advanceReminders = (
      viewer: OccasionViewer,
      input: Schema.Schema.Type<typeof OccasionOccurrenceQuery>
    ): Effect.Effect<ReadonlyArray<OccasionAdvanceReminder>, OccasionServiceError> =>
      Effect.gen(function*() {
        yield* validateRange(input)
        const rows = yield* visibleSources(viewer)
        return occasionAdvanceReminders({ occasions: rows, range: input })
      })

    /**
     * Turn the due advance reminders into real reminder rows.
     *
     * The write goes through `ReminderService.create`, so the reminder lands on
     * the #34 one-batch version/feed/ledger path and travels on `/sync/pull` to
     * the other household member exactly like any other reminder.
     *
     * Idempotency is a lookup by the flattened link plus the exact fire instant
     * (a tombstone counts, so a deleted reminder is not resurrected), backed by
     * the deterministic `clientMutationId` that makes a retried create replay.
     * No unique index: the lookup is the durable key, and the ledger alone
     * cannot be the guard because `applied_mutations` is pruned after 90 days.
     */
    const materialiseReminders = (
      viewer: OccasionViewer,
      input: Schema.Schema.Type<typeof OccasionOccurrenceQuery>
    ): Effect.Effect<ReadonlyArray<Reminder>, OccasionServiceError | ReminderServiceError> =>
      Effect.gen(function*() {
        yield* validateRange(input)
        const rows = yield* visibleOccasions(viewer)
        const drafts = occasionAdvanceReminders({ occasions: rows, range: input })
        const byId = new Map(rows.map((row) => [row.id as string, row]))
        const materialised: Array<Reminder> = []
        for (const draft of drafts) {
          // The stored instant is canonical UTC with milliseconds; the pure
          // projection emits Temporal's shorter form, so normalise before the
          // lookup or every call would miss and fall through to create.
          const fireAt = new Date(draft.fireAt).toISOString()
          const existing = yield* reminderRepo.findOccasionByFireAt({
            householdId: viewer.householdId,
            occasionId: draft.occasionId,
            fireAt
          }).pipe(Effect.orDie)
          if (Option.isSome(existing)) {
            // A tombstone means the owner removed this occurrence's reminder.
            if (existing.value.deletedAt === null) materialised.push(existing.value)
            continue
          }
          const source = byId.get(draft.occasionId)
          const created = yield* reminders.create(viewer, {
            clientMutationId: `occasion-advance:${draft.reminderKey}`,
            title: draft.title,
            kind: "general",
            repeat: { _tag: "once" },
            fireAt: draft.fireAt,
            offsetMinutes: draft.advanceDays * 24 * 60,
            link: draft.link,
            timeZone: draft.timeZone,
            visibility: source?.visibility ?? "shared"
          })
          materialised.push(created)
        }
        return materialised
      })

    /**
     * Replay guard for preparation: the ledger row names the task this
     * mutation created. The occasion is re-read (its link may have been
     * replaced by a later preparation), so the response is current state.
     */
    const replayPreparation = (
      viewer: OccasionViewer,
      input: Schema.Schema.Type<typeof OccasionPrepareInput>
    ): Effect.Effect<Option.Option<OccasionPreparationShape>, OccasionServiceError> =>
      Effect.gen(function*() {
        const row = yield* appliedMutation(viewer, input.clientMutationId)
        if (Option.isNone(row)) return Option.none()
        if (reusedMutationId(row.value, { entityType: "task" })) {
          return yield* reusedMutationIdError(row.value.entityId)
        }
        const occasion = yield* readOccasion(viewer, input.id, true)
        const taskId = (occasion.preparationTaskId ?? row.value.entityId) as TaskId
        const found = yield* tasks.findById(taskId).pipe(Effect.orDie)
        if (Option.isNone(found)) {
          // The linked task was hard-purged; treat it as absent so the caller
          // can prepare again instead of failing the retry forever.
          return Option.none()
        }
        return Option.some({
          occasion,
          task: found.value,
          created: false
        })
      })

    const prepareTask = (
      viewer: OccasionViewer,
      input: Schema.Schema.Type<typeof OccasionPrepareInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<OccasionPreparationShape, OccasionServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayPreparation(viewer, input)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* readOccasion(viewer, input.id, false)

          // A live preparation task is the idempotent answer to a second tap.
          if (current.preparationTaskId !== null) {
            const linked = yield* tasks.findById(current.preparationTaskId).pipe(Effect.orDie)
            if (Option.isSome(linked) && linked.value.deletedAt === null) {
              return { occasion: current, task: linked.value, created: false }
            }
          }

          const occurrenceDate =
            input.occurrenceDate ??
            nextOccasionOccurrence(current, todayOf(viewer, now))?.date
          if (occurrenceDate === undefined) {
            return yield* invalid(
              "occurrenceDate",
              "this occasion has no upcoming occurrence to prepare for"
            )
          }
          if (!validLocalDate(occurrenceDate)) {
            return yield* invalid("occurrenceDate", "the occurrence must be a real calendar date")
          }
          if (!isOccasionOccurrence(current, occurrenceDate)) {
            return yield* invalid(
              "occurrenceDate",
              "the preparation date is not an occurrence of this occasion"
            )
          }

          const dueDate =
            input.dueDate ??
            occasionAdvanceReminderDate(current, occurrenceDate) ??
            (occurrenceDate as LocalDate)
          if (!validLocalDate(dueDate)) {
            return yield* invalid("dueDate", "the task due date must be a real calendar date")
          }

          const title = (input.title ?? occasionPreparationTaskTitle(current.title)).trim()
          if (title === "") {
            return yield* invalid("title", "a preparation task needs a title")
          }

          const task = new Task({
            id: uuidV7() as TaskId,
            type: "task" as const,
            title,
            description: null,
            status: "todo" as const,
            priority: "medium" as const,
            dueAt: null,
            dueDate,
            timeZone: current.timeZone,
            projectId: null,
            tagIds: [],
            color: current.color,
            recurrence: null,
            recurrenceMode: null,
            startedAt: null,
            completedAt: null,
            ownerId: viewer.userId,
            householdId: viewer.householdId,
            visibility: current.visibility,
            createdAt: now,
            updatedAt: now,
            version: 1,
            deletedAt: null
          })
          const next = new Occasion({
            ...current,
            preparationTaskId: task.id,
            version: current.version + 1,
            updatedAt: now
          })

          // The replay guard above already returned the ledger's task. Reaching
          // here with the mutation recorded means that task was hard-purged;
          // refuse rather than replacing a recorded mutation with a new row.
          const prior = yield* appliedMutation(viewer, input.clientMutationId)
          if (Option.isSome(prior)) {
            if (reusedMutationId(prior.value, { entityType: "task" })) {
              return yield* reusedMutationIdError(prior.value.entityId)
            }
            return yield* invalid(
              "clientMutationId",
              "this mutation already prepared a task that no longer exists"
            )
          }

          const statements = [
            // 1. The occasion CAS that links the new task.
            sync.writeEntity({
              state: occasionState(next),
              expectedVersion: current.version
            }),
            sync.appendFeed({
              householdId: viewer.householdId,
              entityType: "occasion",
              entityId: next.id,
              op: "upsert",
              version: next.version,
              updatedAt: next.updatedAt,
              ownerId: next.ownerId,
              visibility: next.visibility
            }),
            // 2. The task insert, gated on the occasion reaching exactly the
            //    version/link this batch wrote. A lost CAS inserts nothing.
            tasks.insertStatementGated(
              task,
              sql`EXISTS (
                SELECT 1 FROM occasions
                WHERE id = ${next.id}
                  AND version = ${next.version}
                  AND preparation_task_id = ${task.id}
                  AND deleted_at IS NULL
              )`
            ),
            sync.appendFeed({
              householdId: viewer.householdId,
              entityType: "task",
              entityId: task.id,
              op: "upsert",
              version: task.version,
              updatedAt: task.updatedAt,
              ownerId: task.ownerId,
              visibility: task.visibility
            }),
            sync.recordApplied({
              clientMutationId: input.clientMutationId,
              householdId: viewer.householdId,
              entityType: "task",
              entityId: task.id,
              version: task.version,
              createdAt: now
            })
          ]
          yield* sync.commit(statements).pipe(Effect.orDie)

          const applied = yield* appliedMutation(viewer, input.clientMutationId)
          if (Option.isSome(applied)) {
            return { occasion: next, task, created: true }
          }
          // The CAS lost: re-read and try again with a fresh occurrence/task.
        }
        return yield* Effect.fail(new OccasionConflict({ id: input.id }))
      })

    return {
      create,
      get: detail,
      update,
      delete: deleteOccasion,
      list,
      occurrences,
      advanceReminders,
      materialiseReminders,
      prepareTask
    } as const
  })
}) {}

export const OccasionServiceLive = Layer.effect(OccasionService, OccasionService.make).pipe(
  Layer.provide(OccasionRepoLive),
  Layer.provide(TaskRepoLive),
  Layer.provide(ReminderRepoLive),
  Layer.provide(ReminderServiceLive),
  Layer.provide(SyncRepoLive)
)
