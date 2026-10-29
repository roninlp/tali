import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  type HouseholdId,
  type LocalDate,
  Project,
  type ProjectId,
  ProjectCreateInput,
  ProjectNotFound,
  ProjectRenameInput,
  type Priority,
  RecurrenceRule,
  type SyncEntityType,
  Tag,
  type TagId,
  TagCreateInput,
  TagNotFound,
  TagRenameInput,
  Task,
  type TaskBucket,
  taskBucketBounds,
  taskBucketOf,
  TaskConflict,
  TaskCreateInput,
  TaskForbidden,
  TaskInvalidTransition,
  TaskListInput,
  TaskMoveInput,
  TaskMutationInput,
  TaskNotFound,
  TaskNotRestorable,
  type TaskPatch,
  type TaskRecurrenceMode,
  type TaskSort,
  TaskUpdateInput,
  TaskValidationError,
  type UserId,
  localDateStartInstant,
  successorTask,
  uuidV7,
  type Visibility
} from "@tali/domain"
import {
  ProjectRepo,
  ProjectRepoLive,
  SyncRepo,
  SyncRepoLive,
  type SyncEntityState,
  TagRepo,
  TagRepoLive,
  TaskRepo,
  TaskRepoLive,
  type TaskQuery
} from "@tali/sql"
import { loadAssignableTags } from "./tag-guard.js"
/**
 * `TaskService` — create, patch, organise, bucket, complete/undo (ticket #36;
 * FR-TASK-01/02/05/06).
 *
 * ## Write path
 *
 * Every mutation is exactly one `D1Client.batch()` built from the #34 sync
 * primitives (`writeEntity` + gated `appendFeed` + gated `recordApplied`),
 * with any `item_tags` statements appended *after* the ledger statement.
 * Reusing those primitives means the service path and the sync-push path share
 * one version/feed implementation: a row changed here bumps `version`,
 * appends a `change_feed` row, and is visible to `/sync/pull`.
 *
 * `clientMutationId` makes a mutation replay-safe. A retry after a lost
 * response finds the id in `applied_mutations` and returns the current row
 * instead of applying twice. A lost version CAS (another writer landed between
 * our read and our batch) writes nothing; the service re-reads and reapplies
 * the same patch, so a field is never silently dropped.
 *
 * ## Buckets
 *
 * `buckets()` computes zoned day boundaries once via `taskBucketBounds` and
 * reads all-day rows by `due_date`, timed rows by `due_at`, and undated rows
 * separately. "Today" is the viewer's wall date, so DST and Jalali month edges
 * are display-calendar concerns only; no-date tasks never enter Today.
 *
 * ## Recurrence (FR-TASK-04, #38)
 *
 * The server alone generates the next instance; a client never does. When a
 * recurring task transitions into `done` (through `complete` or an `update`
 * that sets the status), the successor is built from the just-completed row
 * and inserted in the *same* D1 batch as the completion, with its own feed and
 * ledger rows. The insert is gated on the parent reaching `done` at the version
 * the service read, and a partial unique index on `recurrence_parent_id` means
 * one instance can have at most one successor ever — so a replayed completion,
 * a second device's completion, or an undo-then-recomplete cannot duplicate
 * it. The completed instance remains as done history with its original due
 * fields and rule.
 *
 * `onDueDate` keeps the schedule (advance one occurrence from the instance's
 * due date). `onCompletion` restarts the rule grid on the completion day, so
 * an overdue task does not immediately produce another overdue one. A bounded
 * rule that has ended produces no successor.
 */

/** FR-TASK-06: completed tasks stay visible/restorable for seven days. */
export const COMPLETED_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** How many CAS retries a service mutation makes before reporting contention. */
const MAX_CAS_ATTEMPTS = 3

export interface TaskViewer {
  readonly userId: UserId
  readonly householdId: HouseholdId
  /** Preferences time zone, falling back to the profile zone at the RPC edge. */
  readonly timeZone: string
  /** Global checked-item default, adopted by a new list (#39). */
  readonly defaultCheckedPlacement?: "inPlace" | "bottom"
}

export interface TaskServiceApi {
  readonly create: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TaskCreateInput>,
    now?: string
  ) => Effect.Effect<Task, TaskServiceError>
  readonly get: (viewer: TaskViewer, id: Task["id"]) => Effect.Effect<Task, TaskServiceError>
  readonly update: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TaskUpdateInput>,
    now?: string
  ) => Effect.Effect<Task, TaskServiceError>
  readonly move: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TaskMoveInput>,
    now?: string
  ) => Effect.Effect<Task, TaskServiceError>
  readonly start: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TaskMutationInput>,
    now?: string
  ) => Effect.Effect<Task, TaskServiceError>
  readonly complete: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TaskMutationInput>,
    now?: string
  ) => Effect.Effect<Task, TaskServiceError>
  readonly undo: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TaskMutationInput>,
    now?: string
  ) => Effect.Effect<Task, TaskServiceError>
  readonly list: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TaskListInput>,
    now?: string
  ) => Effect.Effect<ReadonlyArray<Task>, TaskServiceError>
  readonly buckets: (
    viewer: TaskViewer,
    now?: string
  ) => Effect.Effect<TaskBuckets, TaskServiceError>
  readonly createProject: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof ProjectCreateInput>,
    now?: string
  ) => Effect.Effect<Project, TaskServiceError>
  readonly renameProject: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof ProjectRenameInput>,
    now?: string
  ) => Effect.Effect<Project, TaskServiceError>
  readonly listProjects: (
    viewer: TaskViewer
  ) => Effect.Effect<ReadonlyArray<Project>, TaskServiceError>
  readonly createTag: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TagCreateInput>,
    now?: string
  ) => Effect.Effect<Tag, TaskServiceError>
  readonly renameTag: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TagRenameInput>,
    now?: string
  ) => Effect.Effect<Tag, TaskServiceError>
  readonly listTags: (viewer: TaskViewer) => Effect.Effect<ReadonlyArray<Tag>, TaskServiceError>
}

export type TaskServiceError =
  | TaskNotFound
  | ProjectNotFound
  | TagNotFound
  | TaskForbidden
  | TaskInvalidTransition
  | TaskValidationError
  | TaskConflict
  | TaskNotRestorable

export interface TaskBuckets {
  readonly timeZone: string
  readonly today: LocalDate
  readonly tomorrow: LocalDate
  readonly weekEnd: LocalDate
  readonly overdue: ReadonlyArray<Task>
  readonly todayTasks: ReadonlyArray<Task>
  readonly tomorrowTasks: ReadonlyArray<Task>
  readonly thisWeek: ReadonlyArray<Task>
  readonly noDate: ReadonlyArray<Task>
}

const priorityRank: Record<Priority, number> = { high: 0, medium: 1, low: 2 }
const statusRank: Record<Task["status"], number> = { todo: 0, doing: 1, done: 2 }

const compareTasks = (a: Task, b: Task): number =>
  priorityRank[a.priority] - priorityRank[b.priority] ||
  (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99") ||
  (a.dueAt ?? "9999-99-99T99:99:99.999Z").localeCompare(
    b.dueAt ?? "9999-99-99T99:99:99.999Z"
  ) ||
  a.id.localeCompare(b.id)

const invalid = (field: string, message: string): Effect.Effect<never, TaskValidationError> =>
  Effect.fail(new TaskValidationError({ issues: [{ field, message }] }))

const isDone = (task: Task): boolean => task.status === "done"

/** The cutoff a read/undo uses for the 7-day completed-task window. */
const completionCutoff = (now: string): string =>
  new Date(Date.parse(now) - COMPLETED_TASK_RETENTION_MS).toISOString()

const validInstant = (value: string): boolean => Number.isFinite(Date.parse(value))

/** Store instants in canonical UTC so `due_at` TEXT range queries are ordered. */
const normalizeInstant = (value: string): string => new Date(value).toISOString()

const validLocalDate = (value: string): boolean => {
  try {
    localDateStartInstant(value, "UTC")
    return true
  } catch {
    return false
  }
}

const sameTaskFields = (a: Task, b: Task): boolean =>
  a.title === b.title &&
  a.description === b.description &&
  a.status === b.status &&
  a.priority === b.priority &&
  a.dueAt === b.dueAt &&
  a.dueDate === b.dueDate &&
  a.timeZone === b.timeZone &&
  a.projectId === b.projectId &&
  a.visibility === b.visibility &&
  a.color === b.color &&
  a.recurrenceMode === b.recurrenceMode &&
  sameRecurrence(a.recurrence, b.recurrence) &&
  a.startedAt === b.startedAt &&
  a.completedAt === b.completedAt &&
  a.tagIds.length === b.tagIds.length &&
  a.tagIds.every((tagId, index) => tagId === b.tagIds[index])

const sameTags = (a: ReadonlyArray<TagId>, b: ReadonlyArray<TagId>): boolean =>
  a.length === b.length && a.every((tagId, index) => tagId === b[index])

/**
 * Canonical comparison for a stored rule vs a patched one. Rules arrive as
 * plain structs, and object key order is not meaningful, so compare the fields
 * the engine actually reads.
 */
const sameRecurrence = (a: RecurrenceRule | null, b: RecurrenceRule | null): boolean => {
  if (a === null || b === null) return a === b
  const key = (rule: RecurrenceRule): string =>
    JSON.stringify([
      rule.frequency,
      rule.interval,
      rule.byDay ?? null,
      rule.byMonthDay ?? null,
      rule.nthWeekday === undefined
        ? null
        : [rule.nthWeekday.nth, rule.nthWeekday.day],
      rule.end._tag === "count"
        ? ["count", rule.end.count]
        : rule.end._tag === "until"
        ? ["until", rule.end.date]
        : ["never"]
    ])
  return key(a) === key(b)
}

/** Decode + cross-field validate a rule against the one shared contract. */
const decodeRule = (
  rule: RecurrenceRule
): Effect.Effect<RecurrenceRule, TaskValidationError> => {
  const decoded = Schema.decodeUnknownOption(RecurrenceRule)(rule)
  return Option.isNone(decoded)
    ? invalid("recurrence", "recurrence rule is not valid")
    : Effect.succeed(decoded.value)
}

export class TaskService extends Context.Service<TaskService>()("TaskService", {
  make: Effect.gen(function*() {
    const tasks = yield* TaskRepo
    const projects = yield* ProjectRepo
    const tags = yield* TagRepo
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
    const taskState = (task: Task): SyncEntityState => {
      const def = definition("task")
      return {
        entityType: "task",
        entityId: task.id,
        householdId: task.householdId,
        ownerId: task.ownerId,
        visibility: task.visibility,
        version: task.version,
        updatedAt: task.updatedAt,
        deletedAt: task.deletedAt,
        data: def.validate(
          { ...task } as Record<string, unknown>,
          { version: task.version, updatedAt: task.updatedAt, deletedAt: task.deletedAt }
        )
      }
    }

    const projectState = (project: Project): SyncEntityState => {
      const def = definition("project")
      return {
        entityType: "project",
        entityId: project.id,
        householdId: project.householdId,
        ownerId: project.ownerId,
        visibility: project.visibility,
        version: project.version,
        updatedAt: project.updatedAt,
        deletedAt: project.deletedAt,
        data: def.validate(
          { ...project } as Record<string, unknown>,
          { version: project.version, updatedAt: project.updatedAt, deletedAt: project.deletedAt }
        )
      }
    }

    const tagState = (tag: Tag): SyncEntityState => {
      const def = definition("tag")
      return {
        entityType: "tag",
        entityId: tag.id,
        householdId: tag.householdId,
        ownerId: tag.ownerId,
        visibility: tag.visibility,
        version: tag.version,
        updatedAt: tag.updatedAt,
        deletedAt: tag.deletedAt,
        data: def.validate(
          { ...tag } as Record<string, unknown>,
          { version: tag.version, updatedAt: tag.updatedAt, deletedAt: tag.deletedAt }
        )
      }
    }

    /**
     * The ledger row for one mutation id, if this household already applied it.
     * Household-scoped exactly like the sync push (`findApplied`).
     */
    const appliedMutation = (viewer: TaskViewer, clientMutationId: string) =>
      Effect.gen(function*() {
        const applied = yield* sync
          .findApplied({
            householdId: viewer.householdId,
            clientMutationIds: [clientMutationId]
          })
          .pipe(Effect.orDie)
        return Option.fromUndefinedOr(applied.get(clientMutationId))
      })

    /**
     * Has this mutation id already been spent on a *different* change? Reusing
     * an id across rows or aggregates silently disables the replay guard, so it
     * is rejected as a validation error rather than written.
     */
    const reusedMutationId = (
      row: { readonly entityType: SyncEntityType; readonly entityId: string },
      expected: { readonly entityType: SyncEntityType; readonly id?: string }
    ): boolean =>
      row.entityType !== expected.entityType ||
      (expected.id !== undefined && row.entityId !== expected.id)

    const reusedMutationIdError = (id: string) =>
      invalid("clientMutationId", "this mutation id was already applied to a different change")

    /**
     * One entity mutation: the CAS entity write, gated feed append, gated
     * ledger row, then any tag-join statements — one D1 batch. Returns whether
     * this `clientMutationId` is now recorded, i.e. the CAS won.
     */
    const commitEntity = (input: {
      readonly viewer: TaskViewer
      readonly state: SyncEntityState
      readonly expectedVersion: number | null
      readonly clientMutationId: string
      readonly now: string
      readonly op?: "upsert" | "delete"
      readonly tagChanges?: {
        readonly previous: ReadonlyArray<TagId>
        readonly next: ReadonlyArray<TagId>
      }
      /**
       * The next occurrence of a completed recurring task (#38). Its insert,
       * feed row and spawn ledger row join the parent's batch, gated on the
       * parent reaching `done` at this version, so exactly one successor
       * exists and a replay writes nothing.
       */
      readonly spawn?: {
        readonly task: Task
        readonly parentId: Task["id"]
      }
    }) =>
      Effect.gen(function*() {
        // A mutation id is one mutation for its whole retention window. If the
        // ledger already maps it to a different row/aggregate, `recordApplied`
        // below would be an `INSERT OR IGNORE` no-op: the write would land with
        // no replay guard (so a retry applies it twice) and `applied` would
        // report success even when the CAS lost. Refuse before writing.
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

        const statements = [
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
        ]

        if (
          input.tagChanges !== undefined &&
          !sameTags(input.tagChanges.previous, input.tagChanges.next)
        ) {
          statements.push(
            tasks.detachTagsIfVersion({
              taskId: input.state.entityId,
              version: input.state.version,
              updatedAt: input.state.updatedAt
            }),
            ...input.tagChanges.next.map((tagId) =>
              tasks.attachTagIfVersion({
                taskId: input.state.entityId,
                tagId,
                householdId: input.viewer.householdId,
                createdAt: input.now,
                version: input.state.version,
                updatedAt: input.state.updatedAt
              })
            )
          )
        }

        if (input.spawn !== undefined) {
          const child = input.spawn.task
          const parentId = input.spawn.parentId
          // Insert is gated on the parent's new version + done status; the
          // feed/ledger rows are gated on that insert (`changes()`), and the
          // partial unique index on recurrence_parent_id makes it exactly-once.
          statements.push(
            tasks.insertRecurrenceChildStatement({
              task: child,
              parentId,
              parentVersion: input.state.version
            }),
            sync.appendFeed({
              householdId: input.viewer.householdId,
              entityType: "task",
              entityId: child.id,
              op: "upsert",
              version: child.version,
              updatedAt: child.updatedAt,
              ownerId: child.ownerId,
              visibility: child.visibility
            }),
            sync.recordApplied({
              clientMutationId: `recurrence:${parentId}`,
              householdId: input.viewer.householdId,
              entityType: "task",
              entityId: child.id,
              version: child.version,
              createdAt: input.now
            }),
            ...child.tagIds.map((tagId) =>
              tasks.attachTagIfVersion({
                taskId: child.id,
                tagId,
                householdId: input.viewer.householdId,
                createdAt: input.now,
                version: child.version,
                updatedAt: child.updatedAt
              })
            )
          )
        }

        yield* sync.commit(statements)
        const applied = yield* sync
          .findApplied({
            householdId: input.viewer.householdId,
            clientMutationIds: [input.clientMutationId]
          })
          .pipe(Effect.orDie)
        return applied.has(input.clientMutationId)
      })

    /**
     * Task/project commits: repository failures are unexpected defects, while
     * the service's own typed failures (a reused mutation id) propagate.
     */
    const commitPlanningEntity = (
      input: Parameters<typeof commitEntity>[0]
    ): Effect.Effect<boolean, TaskServiceError> =>
      commitEntity(input).pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))

    /** Replay guard: the same mutation id already committed (lost response). */
    const replayOf = (
      viewer: TaskViewer,
      clientMutationId: string,
      expectedId?: Task["id"]
    ): Effect.Effect<Option.Option<Task>, TaskServiceError> =>
      Effect.gen(function*() {
        const row = yield* appliedMutation(viewer, clientMutationId)
        if (Option.isNone(row)) return Option.none()
        if (reusedMutationId(row.value, { entityType: "task", id: expectedId })) {
          return yield* reusedMutationIdError(expectedId ?? row.value.entityId)
        }
        // Same household/owner rules as any other read: a mutation id must
        // never hand back another member's private row.
        const current = yield* loadTask(viewer, row.value.entityId as Task["id"])
        return Option.some(current)
      })

    const loadTask = (viewer: TaskViewer, id: Task["id"]): Effect.Effect<Task, TaskServiceError> =>
      Effect.gen(function*() {
        const found = yield* tasks.findById(id).pipe(Effect.orDie)
        if (Option.isNone(found) || found.value.deletedAt !== null) {
          return yield* Effect.fail(new TaskNotFound({ id }))
        }
        const task = found.value
        if (task.householdId !== viewer.householdId) {
          return yield* Effect.fail(new TaskForbidden({ id, reason: "household" }))
        }
        if (task.visibility === "private" && task.ownerId !== viewer.userId) {
          return yield* Effect.fail(new TaskForbidden({ id, reason: "private" }))
        }
        return task
      })

    /**
     * Replay guard for project/tag mutations — same rules as `replayOf`: the
     * key must belong to the same aggregate and row, and the row must still be
     * visible to the caller (a mutation id may not reveal a private row).
     */
    const replayProject = (
      viewer: TaskViewer,
      clientMutationId: string,
      expectedId?: Project["id"]
    ): Effect.Effect<Option.Option<Project>, TaskServiceError> =>
      Effect.gen(function*() {
        const row = yield* appliedMutation(viewer, clientMutationId)
        if (Option.isNone(row)) return Option.none()
        if (reusedMutationId(row.value, { entityType: "project", id: expectedId })) {
          return yield* reusedMutationIdError(expectedId ?? row.value.entityId)
        }
        const id = row.value.entityId as Project["id"]
        const found = yield* projects.findById(id).pipe(Effect.orDie)
        if (Option.isNone(found) || found.value.deletedAt !== null) {
          return yield* Effect.fail(new ProjectNotFound({ id }))
        }
        const project = found.value
        if (project.householdId !== viewer.householdId) {
          return yield* Effect.fail(new TaskForbidden({ id, reason: "household" }))
        }
        if (project.visibility === "private" && project.ownerId !== viewer.userId) {
          return yield* Effect.fail(new TaskForbidden({ id, reason: "private" }))
        }
        return Option.some(project)
      })

    const replayTag = (
      viewer: TaskViewer,
      clientMutationId: string,
      expectedId?: Tag["id"]
    ): Effect.Effect<Option.Option<Tag>, TaskServiceError> =>
      Effect.gen(function*() {
        const row = yield* appliedMutation(viewer, clientMutationId)
        if (Option.isNone(row)) return Option.none()
        if (reusedMutationId(row.value, { entityType: "tag", id: expectedId })) {
          return yield* reusedMutationIdError(expectedId ?? row.value.entityId)
        }
        const id = row.value.entityId as Tag["id"]
        const found = yield* tags.findById(id).pipe(Effect.orDie)
        if (Option.isNone(found) || found.value.deletedAt !== null) {
          return yield* Effect.fail(new TagNotFound({ id }))
        }
        const tag = found.value
        if (tag.householdId !== viewer.householdId) {
          return yield* Effect.fail(new TaskForbidden({ id, reason: "household" }))
        }
        if (tag.visibility === "private" && tag.ownerId !== viewer.userId) {
          return yield* Effect.fail(new TaskForbidden({ id, reason: "private" }))
        }
        return Option.some(tag)
      })

    const requireProject = (
      viewer: TaskViewer,
      projectId: ProjectId
    ): Effect.Effect<Project, TaskValidationError> =>
      Effect.gen(function*() {
        const found = yield* projects.findById(projectId).pipe(Effect.orDie)
        if (Option.isNone(found) || found.value.deletedAt !== null) {
          return yield* invalid("projectId", "project does not exist")
        }
        const project = found.value
        if (project.householdId !== viewer.householdId) {
          return yield* invalid("projectId", "project is not in this household")
        }
        if (project.visibility === "private" && project.ownerId !== viewer.userId) {
          return yield* invalid("projectId", "project is private")
        }
        return project
      })

    const requireTags = (
      viewer: TaskViewer,
      tagIds: ReadonlyArray<TagId>
    ): Effect.Effect<ReadonlyArray<Tag>, TaskValidationError> =>
      loadAssignableTags(tags, viewer, tagIds).pipe(
        Effect.mapError((issue) => new TaskValidationError({ issues: [issue] }))
      )

    const validateDue = (dueAt: string | null, dueDate: string | null) =>
      Effect.gen(function*() {
        if (dueAt !== null && dueDate !== null) {
          return yield* invalid("dueAt", "a task has either a due instant or an all-day due date")
        }
        if (dueAt !== null && !validInstant(dueAt)) {
          return yield* invalid("dueAt", "due instant must be an ISO-8601 UTC timestamp")
        }
        if (dueDate !== null && !validLocalDate(dueDate)) {
          return yield* invalid("dueDate", "due date must be a real calendar date")
        }
      })

    /**
     * The next instance of a just-completed recurring task, or `null` when the
     * rule has ended. The builder is shared with the sync push path so an
     * offline completion lands the exact same successor row.
     */
    const successorOf = successorTask

    /** Apply a patch to a row, including the status transition rules. */
    const patchTask = (
      viewer: TaskViewer,
      current: Task,
      patch: TaskPatch,
      now: string
    ): Effect.Effect<Task, TaskServiceError> =>
      Effect.gen(function*() {
        let dueAt = current.dueAt
        let dueDate = current.dueDate
        if (patch.dueAt !== undefined && patch.dueAt !== null) {
          dueAt = normalizeInstant(patch.dueAt)
          dueDate = null
        } else if (patch.dueDate !== undefined && patch.dueDate !== null) {
          dueDate = patch.dueDate
          dueAt = null
        } else {
          if (patch.dueAt !== undefined) dueAt = null
          if (patch.dueDate !== undefined) dueDate = null
        }
        yield* validateDue(dueAt, dueDate)

        // Recurrence rule + mode move as one unit. A rule without a mode
        // defaults to the fixed schedule; clearing the rule clears the mode.
        let recurrence = current.recurrence
        let recurrenceMode = current.recurrenceMode
        if (patch.recurrence !== undefined) {
          if (patch.recurrence === null) {
            recurrence = null
            recurrenceMode = null
          } else {
            recurrence = yield* decodeRule(patch.recurrence)
            recurrenceMode =
              patch.recurrenceMode !== undefined
                ? patch.recurrenceMode
                : current.recurrenceMode ?? "onDueDate"
            if (recurrenceMode === null) {
              return yield* invalid("recurrenceMode", "a recurrence rule needs a mode")
            }
          }
        } else if (patch.recurrenceMode !== undefined) {
          if (patch.recurrenceMode === null) {
            if (recurrence !== null) {
              return yield* invalid(
                "recurrenceMode",
                "clear the recurrence rule to stop repeating"
              )
            }
          } else if (recurrence === null) {
            return yield* invalid(
              "recurrenceMode",
              "a recurrence mode requires a recurrence rule"
            )
          } else {
            recurrenceMode = patch.recurrenceMode
          }
        }
        if (recurrence !== null && recurrenceMode === null) recurrenceMode = "onDueDate"
        if (
          recurrence !== null &&
          recurrenceMode === "onDueDate" &&
          dueAt === null &&
          dueDate === null
        ) {
          return yield* invalid(
            "dueDate",
            "an on-due-date recurrence needs a due date"
          )
        }

        if (patch.projectId !== undefined && patch.projectId !== null) {
          yield* requireProject(viewer, patch.projectId)
        }
        if (patch.tagIds !== undefined) {
          yield* requireTags(viewer, patch.tagIds)
        }

        let status = current.status
        let startedAt = current.startedAt
        let completedAt = current.completedAt
        if (patch.status !== undefined && patch.status !== current.status) {
          if (current.status === "todo" && patch.status === "doing") {
            status = "doing"
            startedAt = current.startedAt ?? now
          } else if (current.status === "todo" && patch.status === "done") {
            status = "done"
            completedAt = now
          } else if (current.status === "doing" && patch.status === "done") {
            status = "done"
            completedAt = now
          } else {
            return yield* Effect.fail(
              new TaskInvalidTransition({
                id: current.id,
                from: current.status,
                to: patch.status
              })
            )
          }
        }

        return new Task({
          ...current,
          ...patch,
          status,
          startedAt,
          completedAt,
          dueAt,
          dueDate,
          timeZone: patch.timeZone ?? current.timeZone,
          recurrence,
          recurrenceMode,
          version: current.version + 1,
          updatedAt: now
        })
      })

    const create = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskCreateInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Task, TaskServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayOf(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        const dueAt = input.dueAt === undefined || input.dueAt === null
          ? null
          : normalizeInstant(input.dueAt)
        const dueDate = input.dueDate ?? null
        yield* validateDue(dueAt, dueDate)
        if (
          input.recurrenceMode !== undefined &&
          input.recurrenceMode !== null &&
          (input.recurrence === undefined || input.recurrence === null)
        ) {
          return yield* invalid(
            "recurrenceMode",
            "a recurrence mode requires a recurrence rule"
          )
        }
        const recurrence =
          input.recurrence === undefined || input.recurrence === null
            ? null
            : yield* decodeRule(input.recurrence)
        const recurrenceMode: TaskRecurrenceMode | null =
          recurrence === null ? null : input.recurrenceMode ?? "onDueDate"
        if (
          recurrence !== null &&
          recurrenceMode === "onDueDate" &&
          dueAt === null &&
          dueDate === null
        ) {
          return yield* invalid(
            "dueDate",
            "an on-due-date recurrence needs a due date"
          )
        }
        if (input.projectId !== undefined && input.projectId !== null) {
          yield* requireProject(viewer, input.projectId)
        }
        if (input.tagIds !== undefined) {
          yield* requireTags(viewer, input.tagIds)
        }

        const status = input.status ?? "todo"
        const task = new Task({
          id: (input.id ?? uuidV7()) as Task["id"],
          type: "task",
          title: input.title,
          description: input.description ?? null,
          ownerId: viewer.userId,
          householdId: viewer.householdId,
          visibility: (input.visibility ?? "shared") as Visibility,
          color: input.color ?? null,
          status,
          priority: (input.priority ?? "medium") as Priority,
          dueAt,
          dueDate,
          timeZone: input.timeZone ?? viewer.timeZone,
          projectId: input.projectId ?? null,
          tagIds: input.tagIds ?? [],
          recurrence,
          recurrenceMode,
          startedAt: status === "doing" ? now : null,
          completedAt: status === "done" ? now : null,
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null
        })

        const applied = yield* commitPlanningEntity({
          viewer,
          state: taskState(task),
          expectedVersion: null,
          clientMutationId: input.clientMutationId,
          now,
          tagChanges: { previous: [], next: task.tagIds }
        })
        if (!applied) {
          return yield* Effect.fail(new TaskConflict({ id: task.id }))
        }
        return task
      })

    const get = (viewer: TaskViewer, id: Task["id"]): Effect.Effect<Task, TaskServiceError> =>
      loadTask(viewer, id)

    const update = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskUpdateInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Task, TaskServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayOf(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* loadTask(viewer, input.id)
          const next = yield* patchTask(viewer, current, input.patch, now)
          if (sameTaskFields(current, next)) return current
          // `update({ status: "done" })` is a completion too, so it must spawn
          // the same single successor as `complete()`.
          const spawnTask =
            current.status !== "done" && next.status === "done"
              ? successorOf(next, now)
              : null
          const applied = yield* commitPlanningEntity({
            viewer,
            state: taskState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now,
            tagChanges: { previous: current.tagIds, next: next.tagIds },
            spawn: spawnTask === null
              ? undefined
              : { task: spawnTask, parentId: current.id }
          })
          if (applied) return next
        }
        return yield* Effect.fail(new TaskConflict({ id: input.id }))
      })

    const move = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskMoveInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Task, TaskServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayOf(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value
        if (input.dueDate !== null && !validLocalDate(input.dueDate)) {
          return yield* invalid("dueDate", "due date must be a real calendar date")
        }

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* loadTask(viewer, input.id)
          if (current.dueDate === input.dueDate && current.dueAt === null) return current
          const next = new Task({
            ...current,
            dueAt: null,
            dueDate: input.dueDate,
            timeZone: input.timeZone ?? viewer.timeZone,
            version: current.version + 1,
            updatedAt: now
          })
          const applied = yield* commitPlanningEntity({
            viewer,
            state: taskState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now,
            tagChanges: { previous: current.tagIds, next: next.tagIds }
          })
          if (applied) return next
        }
        return yield* Effect.fail(new TaskConflict({ id: input.id }))
      })

    const start = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskMutationInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Task, TaskServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayOf(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* loadTask(viewer, input.id)
          if (current.status === "doing") return current
          if (current.status !== "todo") {
            return yield* Effect.fail(
              new TaskInvalidTransition({ id: current.id, from: current.status, to: "doing" })
            )
          }
          const next = new Task({
            ...current,
            status: "doing",
            startedAt: current.startedAt ?? now,
            completedAt: null,
            version: current.version + 1,
            updatedAt: now
          })
          const applied = yield* commitPlanningEntity({
            viewer,
            state: taskState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now,
            tagChanges: { previous: current.tagIds, next: next.tagIds }
          })
          if (applied) return next
        }
        return yield* Effect.fail(new TaskConflict({ id: input.id }))
      })

    const complete = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskMutationInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Task, TaskServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayOf(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* loadTask(viewer, input.id)
          // Idempotent: completing an already-done task writes nothing.
          if (isDone(current)) return current
          const next = new Task({
            ...current,
            status: "done",
            completedAt: now,
            version: current.version + 1,
            updatedAt: now
          })
          // The successor is computed from the instance being completed (its
          // rule and due anchor), never from the client. A bounded rule that
          // has run out produces no successor.
          const spawnTask = successorOf(next, now)
          const applied = yield* commitPlanningEntity({
            viewer,
            state: taskState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now,
            tagChanges: { previous: current.tagIds, next: next.tagIds },
            spawn: spawnTask === null
              ? undefined
              : { task: spawnTask, parentId: current.id }
          })
          if (applied) return next
        }
        return yield* Effect.fail(new TaskConflict({ id: input.id }))
      })

    const undo = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskMutationInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Task, TaskServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayOf(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* loadTask(viewer, input.id)
          if (!isDone(current)) {
            return yield* Effect.fail(
              new TaskInvalidTransition({ id: current.id, from: current.status, to: "todo" })
            )
          }
          if (
            current.completedAt !== null &&
            Date.parse(current.completedAt) < Date.parse(completionCutoff(now))
          ) {
            return yield* Effect.fail(
              new TaskNotRestorable({ id: current.id, completedAt: current.completedAt })
            )
          }
          // No completion snapshot is needed: completion never moves the due
          // fields, and `startedAt` tells us whether the prior state was
          // `doing` or `todo`. The original due date is therefore intact.
          const priorStatus = current.startedAt !== null ? "doing" : "todo"
          const next = new Task({
            ...current,
            status: priorStatus,
            completedAt: null,
            version: current.version + 1,
            updatedAt: now
          })
          const applied = yield* commitPlanningEntity({
            viewer,
            state: taskState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now,
            tagChanges: { previous: current.tagIds, next: next.tagIds }
          })
          if (applied) return next
        }
        return yield* Effect.fail(new TaskConflict({ id: input.id }))
      })

    const list = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskListInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<ReadonlyArray<Task>, TaskServiceError> =>
      Effect.gen(function*() {
        const filter = input.filter ?? {}
        const sort: TaskSort = input.sort ?? { by: "dueDate", direction: "asc" }
        const bounds = taskBucketBounds(viewer.timeZone, now)
        const query: {
          -readonly [K in keyof TaskQuery]: TaskQuery[K]
        } = {
          householdId: viewer.householdId,
          userId: viewer.userId,
          includeArchived: filter.includeArchived === true,
          completionCutoff: completionCutoff(now),
          sort
        }
        if (filter.projectId !== undefined) query.projectId = filter.projectId
        if (filter.tagIds !== undefined) query.tagIds = filter.tagIds
        if (filter.priority !== undefined) query.priority = filter.priority
        if (filter.status !== undefined) query.status = filter.status
        if (filter.dueFrom !== undefined) {
          query.dueDateFrom = filter.dueFrom
          query.dueInstantFrom = localDateStartInstant(filter.dueFrom, viewer.timeZone)
        }
        if (filter.dueBefore !== undefined) {
          query.dueDateBefore = filter.dueBefore
          query.dueInstantBefore = localDateStartInstant(filter.dueBefore, viewer.timeZone)
        }

        if (filter.bucket !== undefined) {
          switch (filter.bucket) {
            case "overdue":
              query.dueDateBefore = bounds.today
              query.dueInstantBefore = bounds.todayStart
              break
            case "today":
              query.dueDateFrom = bounds.today
              query.dueDateBefore = bounds.tomorrow
              query.dueInstantFrom = bounds.todayStart
              query.dueInstantBefore = bounds.tomorrowStart
              break
            case "tomorrow":
              query.dueDateFrom = bounds.tomorrow
              query.dueDateBefore = bounds.dayAfterTomorrow
              query.dueInstantFrom = bounds.tomorrowStart
              query.dueInstantBefore = bounds.dayAfterTomorrowStart
              break
            case "thisWeek":
              query.dueDateFrom = bounds.dayAfterTomorrow
              query.dueDateBefore = bounds.weekAfter
              query.dueInstantFrom = bounds.dayAfterTomorrowStart
              query.dueInstantBefore = bounds.weekEndExclusive
              break
            case "noDate":
              query.noDue = true
              break
          }
          // A bucket is the active-work view: `buckets()` never puts a
          // completed task in one, so the filter must not either. A caller
          // that explicitly asks for a status (e.g. `done`) still gets it.
          if (filter.status === undefined) query.excludeDone = true
        }

        return yield* tasks.listFiltered(query).pipe(Effect.orDie)
      })

    const buckets = (
      viewer: TaskViewer,
      now: string = new Date().toISOString()
    ): Effect.Effect<TaskBuckets, TaskServiceError> =>
      Effect.gen(function*() {
        const bounds = taskBucketBounds(viewer.timeZone, now)
        const scope = { householdId: viewer.householdId, userId: viewer.userId }

        // The five range reads are independent: none feeds another's bounds.
        // Fan them out at concurrency 4 (Workers allows ~6 simultaneous
        // outgoing connections per request, so 4 leaves headroom) instead of
        // paying five sequential D1 round trips. Result order stays the same
        // and the de-dup/sort below is unchanged.
        const [
          overdueDates,
          overdueInstants,
          upcomingDates,
          upcomingInstants,
          noDate
        ] = yield* Effect.all(
          [
            tasks.listDueDateRange({ ...scope, before: bounds.today }),
            tasks.listDueInstantRange({ ...scope, before: bounds.todayStart }),
            tasks.listDueDateRange({
              ...scope,
              from: bounds.today,
              before: bounds.weekAfter
            }),
            tasks.listDueInstantRange({
              ...scope,
              from: bounds.todayStart,
              before: bounds.weekEndExclusive
            }),
            tasks.listNoDue(scope)
          ],
          { concurrency: 4 }
        ).pipe(Effect.orDie)

        const grouped: Record<TaskBucket, Array<Task>> = {
          overdue: [],
          today: [],
          tomorrow: [],
          thisWeek: [],
          noDate: []
        }
        const seen = new Set<string>()
        for (const task of [
          ...overdueDates,
          ...overdueInstants,
          ...upcomingDates,
          ...upcomingInstants,
          ...noDate
        ]) {
          // A malformed row with both due shapes could appear in two ranges;
          // the bucket view must still show it once.
          if (seen.has(task.id)) continue
          seen.add(task.id)
          const bucket = taskBucketOf(task, bounds)
          if (bucket !== "later" && bucket !== "done") grouped[bucket].push(task)
        }
        for (const key of Object.keys(grouped) as Array<TaskBucket>) {
          grouped[key].sort(compareTasks)
        }

        return {
          timeZone: viewer.timeZone,
          today: bounds.today,
          tomorrow: bounds.tomorrow,
          weekEnd: bounds.weekEnd,
          overdue: grouped.overdue,
          todayTasks: grouped.today,
          tomorrowTasks: grouped.tomorrow,
          thisWeek: grouped.thisWeek,
          noDate: grouped.noDate
        }
      })

    // ── Projects ──────────────────────────────────────────────────────────

    const createProject = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof ProjectCreateInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Project, TaskServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayProject(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        const project = new Project({
          id: (input.id ?? uuidV7()) as ProjectId,
          type: "project",
          title: input.title,
          ownerId: viewer.userId,
          householdId: viewer.householdId,
          visibility: (input.visibility ?? "shared") as Visibility,
          color: input.color ?? null,
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null
        })
        const applied = yield* commitPlanningEntity({
          viewer,
          state: projectState(project),
          expectedVersion: null,
          clientMutationId: input.clientMutationId,
          now
        })
        if (!applied) return yield* Effect.fail(new TaskConflict({ id: project.id }))
        return project
      })

    const renameProject = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof ProjectRenameInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Project, TaskServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayProject(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const found = yield* projects.findById(input.id).pipe(Effect.orDie)
          if (Option.isNone(found) || found.value.deletedAt !== null) {
            return yield* Effect.fail(new ProjectNotFound({ id: input.id }))
          }
          const current = found.value
          if (current.householdId !== viewer.householdId) {
            return yield* Effect.fail(new TaskForbidden({ id: input.id, reason: "household" }))
          }
          if (current.visibility === "private" && current.ownerId !== viewer.userId) {
            return yield* Effect.fail(new TaskForbidden({ id: input.id, reason: "private" }))
          }
          if (current.title === input.title) return current
          const next = new Project({
            ...current,
            title: input.title,
            version: current.version + 1,
            updatedAt: now
          })
          const applied = yield* commitPlanningEntity({
            viewer,
            state: projectState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now
          })
          if (applied) return next
        }
        return yield* Effect.fail(new TaskConflict({ id: input.id }))
      })

    const listProjects = (
      viewer: TaskViewer
    ): Effect.Effect<ReadonlyArray<Project>, TaskServiceError> =>
      projects
        .listVisible({ householdId: viewer.householdId, userId: viewer.userId })
        .pipe(Effect.orDie)

    // ── Tags ─────────────────────────────────────────────────────────────

    const createTag = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TagCreateInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Tag, TaskServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayTag(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        const existing = yield* tags
          .findLiveByName({ householdId: viewer.householdId, name: input.name })
          .pipe(Effect.orDie)
        if (Option.isSome(existing)) {
          return yield* invalid("name", "a tag with this name already exists")
        }

        const tag = new Tag({
          id: (input.id ?? uuidV7()) as TagId,
          type: "tag",
          name: input.name,
          ownerId: viewer.userId,
          householdId: viewer.householdId,
          visibility: (input.visibility ?? "shared") as Visibility,
          color: input.color ?? null,
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null
        })

        const applied = yield* commitEntity({
          viewer,
          state: tagState(tag),
          expectedVersion: null,
          clientMutationId: input.clientMutationId,
          now
        }).pipe(
          Effect.catchTag("SqlError", (error) =>
            String(error).includes("UNIQUE constraint failed")
              ? invalid("name", "a tag with this name already exists")
              : Effect.die(error)
          )
        )
        if (!applied) {
          // The insert is `ON CONFLICT DO NOTHING`, so a unique-name race
          // surfaces as a no-op rather than a SqlError.
          const raced = yield* tags
            .findLiveByName({ householdId: viewer.householdId, name: input.name })
            .pipe(Effect.orDie)
          if (Option.isSome(raced)) {
            return yield* invalid("name", "a tag with this name already exists")
          }
          return yield* Effect.fail(new TaskConflict({ id: tag.id }))
        }
        return tag
      })

    const renameTag = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TagRenameInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Tag, TaskServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayTag(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const found = yield* tags.findById(input.id).pipe(Effect.orDie)
          if (Option.isNone(found) || found.value.deletedAt !== null) {
            return yield* Effect.fail(new TagNotFound({ id: input.id }))
          }
          const current = found.value
          if (current.householdId !== viewer.householdId) {
            return yield* Effect.fail(new TaskForbidden({ id: input.id, reason: "household" }))
          }
          if (current.visibility === "private" && current.ownerId !== viewer.userId) {
            return yield* Effect.fail(new TaskForbidden({ id: input.id, reason: "private" }))
          }
          if (current.name === input.name) return current
          const conflicting = yield* tags
            .findLiveByName({ householdId: viewer.householdId, name: input.name })
            .pipe(Effect.orDie)
          if (Option.isSome(conflicting) && conflicting.value.id !== current.id) {
            return yield* invalid("name", "a tag with this name already exists")
          }
          const next = new Tag({
            ...current,
            name: input.name,
            version: current.version + 1,
            updatedAt: now
          })
          const applied = yield* commitEntity({
            viewer,
            state: tagState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now
          }).pipe(
            Effect.catchTag("SqlError", (error) =>
              String(error).includes("UNIQUE constraint failed")
                ? invalid("name", "a tag with this name already exists")
                : Effect.die(error)
            )
          )
          if (applied) return next
        }
        return yield* Effect.fail(new TaskConflict({ id: input.id }))
      })

    const listTags = (viewer: TaskViewer): Effect.Effect<ReadonlyArray<Tag>, TaskServiceError> =>
      tags
        .listVisible({ householdId: viewer.householdId, userId: viewer.userId })
        .pipe(Effect.orDie)

    return {
      create,
      get,
      update,
      move,
      start,
      complete,
      undo,
      list,
      buckets,
      createProject,
      renameProject,
      listProjects,
      createTag,
      renameTag,
      listTags
    } as const
  })
}) {}

export const TaskServiceLive = Layer.effect(TaskService, TaskService.make).pipe(
  Layer.provide(TaskRepoLive),
  Layer.provide(ProjectRepoLive),
  Layer.provide(TagRepoLive),
  Layer.provide(SyncRepoLive)
)
