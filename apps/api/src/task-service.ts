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
  type TaskSort,
  TaskUpdateInput,
  TaskValidationError,
  type UserId,
  localDateStartInstant,
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
  a.startedAt === b.startedAt &&
  a.completedAt === b.completedAt &&
  a.tagIds.length === b.tagIds.length &&
  a.tagIds.every((tagId, index) => tagId === b.tagIds[index])

const sameTags = (a: ReadonlyArray<TagId>, b: ReadonlyArray<TagId>): boolean =>
  a.length === b.length && a.every((tagId, index) => tagId === b[index])

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
    }) =>
      Effect.gen(function*() {
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

        yield* sync.commit(statements)
        const applied = yield* sync
          .findApplied({
            householdId: input.viewer.householdId,
            clientMutationIds: [input.clientMutationId]
          })
          .pipe(Effect.orDie)
        return applied.has(input.clientMutationId)
      })

    /** Task/project commits: repository failures are unexpected defects. */
    const commitPlanningEntity = (
      input: Parameters<typeof commitEntity>[0]
    ): Effect.Effect<boolean> => commitEntity(input).pipe(Effect.orDie)

    /** Replay guard: the same mutation id already committed (lost response). */
    const replayOf = (
      viewer: TaskViewer,
      clientMutationId: string
    ): Effect.Effect<Option.Option<Task>, TaskServiceError> =>
      Effect.gen(function*() {
        const applied = yield* sync
          .findApplied({
            householdId: viewer.householdId,
            clientMutationIds: [clientMutationId]
          })
          .pipe(Effect.orDie)
        if (!applied.has(clientMutationId)) return Option.none()
        const row = applied.get(clientMutationId)!
        if (row.entityType !== "task") return Option.none()
        const current = yield* tasks.findById(row.entityId as Task["id"]).pipe(Effect.orDie)
        if (Option.isNone(current) || current.value.deletedAt !== null) {
          return yield* Effect.fail(new TaskNotFound({ id: row.entityId as Task["id"] }))
        }
        return Option.some(current.value)
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
      Effect.gen(function*() {
        const result: Array<Tag> = []
        for (const tagId of tagIds) {
          const found = yield* tags.findById(tagId).pipe(Effect.orDie)
          if (Option.isNone(found) || found.value.deletedAt !== null) {
            return yield* invalid("tagIds", `tag does not exist: ${tagId}`)
          }
          const tag = found.value
          if (tag.householdId !== viewer.householdId) {
            return yield* invalid("tagIds", `tag is not in this household: ${tagId}`)
          }
          if (tag.visibility === "private" && tag.ownerId !== viewer.userId) {
            return yield* invalid("tagIds", `tag is private: ${tagId}`)
          }
          result.push(tag)
        }
        return result
      })

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
        const replayed = yield* replayOf(viewer, input.clientMutationId)
        if (Option.isSome(replayed)) return replayed.value

        const dueAt = input.dueAt === undefined || input.dueAt === null
          ? null
          : normalizeInstant(input.dueAt)
        const dueDate = input.dueDate ?? null
        yield* validateDue(dueAt, dueDate)
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
        const replayed = yield* replayOf(viewer, input.clientMutationId)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* loadTask(viewer, input.id)
          const next = yield* patchTask(viewer, current, input.patch, now)
          if (sameTaskFields(current, next)) return current
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

    const move = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskMoveInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Task, TaskServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayOf(viewer, input.clientMutationId)
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
        const replayed = yield* replayOf(viewer, input.clientMutationId)
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
        const replayed = yield* replayOf(viewer, input.clientMutationId)
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

    const undo = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskMutationInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Task, TaskServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayOf(viewer, input.clientMutationId)
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

        const overdueDates = yield* tasks
          .listDueDateRange({ ...scope, before: bounds.today })
          .pipe(Effect.orDie)
        const overdueInstants = yield* tasks
          .listDueInstantRange({ ...scope, before: bounds.todayStart })
          .pipe(Effect.orDie)
        const upcomingDates = yield* tasks
          .listDueDateRange({
            ...scope,
            from: bounds.today,
            before: bounds.weekAfter
          })
          .pipe(Effect.orDie)
        const upcomingInstants = yield* tasks
          .listDueInstantRange({
            ...scope,
            from: bounds.todayStart,
            before: bounds.weekEndExclusive
          })
          .pipe(Effect.orDie)
        const noDate = yield* tasks.listNoDue(scope).pipe(Effect.orDie)

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
        const replayed = yield* sync
          .findApplied({
            householdId: viewer.householdId,
            clientMutationIds: [input.clientMutationId]
          })
          .pipe(Effect.orDie)
        if (replayed.has(input.clientMutationId)) {
          const id = replayed.get(input.clientMutationId)!.entityId as ProjectId
          const found = yield* projects.findById(id).pipe(Effect.orDie)
          if (Option.isNone(found)) return yield* Effect.fail(new TaskConflict({ id }))
          return found.value
        }

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
        const replayed = yield* sync
          .findApplied({
            householdId: viewer.householdId,
            clientMutationIds: [input.clientMutationId]
          })
          .pipe(Effect.orDie)
        if (replayed.has(input.clientMutationId)) {
          const found = yield* projects.findById(input.id).pipe(Effect.orDie)
          if (Option.isNone(found)) return yield* Effect.fail(new TaskConflict({ id: input.id }))
          return found.value
        }

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
        const replayed = yield* sync
          .findApplied({
            householdId: viewer.householdId,
            clientMutationIds: [input.clientMutationId]
          })
          .pipe(Effect.orDie)
        if (replayed.has(input.clientMutationId)) {
          const id = replayed.get(input.clientMutationId)!.entityId as TagId
          const found = yield* tags.findById(id).pipe(Effect.orDie)
          if (Option.isNone(found)) return yield* Effect.fail(new TaskConflict({ id }))
          return found.value
        }

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
        const replayed = yield* sync
          .findApplied({
            householdId: viewer.householdId,
            clientMutationIds: [input.clientMutationId]
          })
          .pipe(Effect.orDie)
        if (replayed.has(input.clientMutationId)) {
          const found = yield* tags.findById(input.id).pipe(Effect.orDie)
          if (Option.isNone(found)) return yield* Effect.fail(new TaskConflict({ id: input.id }))
          return found.value
        }

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
