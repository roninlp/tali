import { Context, Effect, Layer, Option, Schema } from 'effect'
import {
  COMPLETED_TASK_RETENTION_MS,
  type HouseholdId,
  type LocalDate,
  type WeekStart,
  Project,
  type ProjectId,
  ProjectCreateInput,
  ProjectNotFound,
  ProjectRenameInput,
  type Priority,
  RecurrenceRule,
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
  type TaskStatus,
  TaskUpdateInput,
  TaskValidationError,
  type UserId,
  localDateStartInstant,
  resolveCreateVisibility,
  successorTask,
  uuidV7,
} from '@tali/domain'
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
  type TaskQuery,
} from '@tali/sql'
import { readScoped } from './row-scope.js'
import { casUpdate } from './cas.js'
import { makeSyncKit, type CommitEntry } from './sync-write.js'
import { loadAssignableTags } from './tag-guard.js'
import { unchangedExcept } from './patch-compare.js'
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
export { COMPLETED_TASK_RETENTION_MS }

export interface TaskViewer {
  readonly userId: UserId
  readonly householdId: HouseholdId
  /** Preferences time zone, falling back to the profile zone at the RPC edge. */
  readonly timeZone: string
  /** The display week start, used by the Capture prompt (ADR-0012 §8). */
  readonly weekStart?: WeekStart
  /** Global checked-item default, adopted by a new list (#39). */
  readonly defaultCheckedPlacement?: 'inPlace' | 'bottom'
}

export interface TaskServiceApi {
  readonly create: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TaskCreateInput>,
    now?: string,
  ) => Effect.Effect<Task, TaskServiceError>
  readonly get: (
    viewer: TaskViewer,
    id: Task['id'],
  ) => Effect.Effect<Task, TaskServiceError>
  readonly update: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TaskUpdateInput>,
    now?: string,
  ) => Effect.Effect<Task, TaskServiceError>
  readonly move: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TaskMoveInput>,
    now?: string,
  ) => Effect.Effect<Task, TaskServiceError>
  readonly start: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TaskMutationInput>,
    now?: string,
  ) => Effect.Effect<Task, TaskServiceError>
  readonly complete: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TaskMutationInput>,
    now?: string,
  ) => Effect.Effect<Task, TaskServiceError>
  readonly undo: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TaskMutationInput>,
    now?: string,
  ) => Effect.Effect<Task, TaskServiceError>
  readonly list: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TaskListInput>,
    now?: string,
  ) => Effect.Effect<ReadonlyArray<Task>, TaskServiceError>
  readonly buckets: (
    viewer: TaskViewer,
    now?: string,
  ) => Effect.Effect<TaskBuckets, TaskServiceError>
  readonly createProject: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof ProjectCreateInput>,
    now?: string,
  ) => Effect.Effect<Project, TaskServiceError>
  readonly renameProject: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof ProjectRenameInput>,
    now?: string,
  ) => Effect.Effect<Project, TaskServiceError>
  readonly listProjects: (
    viewer: TaskViewer,
  ) => Effect.Effect<ReadonlyArray<Project>, TaskServiceError>
  readonly createTag: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TagCreateInput>,
    now?: string,
  ) => Effect.Effect<Tag, TaskServiceError>
  readonly renameTag: (
    viewer: TaskViewer,
    input: Schema.Schema.Type<typeof TagRenameInput>,
    now?: string,
  ) => Effect.Effect<Tag, TaskServiceError>
  readonly listTags: (
    viewer: TaskViewer,
  ) => Effect.Effect<ReadonlyArray<Tag>, TaskServiceError>
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

const compareTasks = (a: Task, b: Task): number =>
  priorityRank[a.priority] - priorityRank[b.priority] ||
  (a.dueDate ?? '9999-99-99').localeCompare(b.dueDate ?? '9999-99-99') ||
  (a.dueAt ?? '9999-99-99T99:99:99.999Z').localeCompare(
    b.dueAt ?? '9999-99-99T99:99:99.999Z',
  ) ||
  a.id.localeCompare(b.id)

const invalid = (
  field: string,
  message: string,
): Effect.Effect<never, TaskValidationError> =>
  Effect.fail(new TaskValidationError({ issues: [{ field, message }] }))

const isDone = (task: Task): boolean => task.status === 'done'

/** The cutoff a read/undo uses for the 7-day completed-task window. */
const completionCutoff = (now: string): string =>
  new Date(Date.parse(now) - COMPLETED_TASK_RETENTION_MS).toISOString()

const validInstant = (value: string): boolean =>
  Number.isFinite(Date.parse(value))

/** Store instants in canonical UTC so `due_at` TEXT range queries are ordered. */
const normalizeInstant = (value: string): string =>
  new Date(value).toISOString()

const validLocalDate = (value: string): boolean => {
  try {
    localDateStartInstant(value, 'UTC')
    return true
  } catch {
    return false
  }
}

const sameTags = (a: ReadonlyArray<TagId>, b: ReadonlyArray<TagId>): boolean =>
  a.length === b.length && a.every((tagId, index) => tagId === b[index])

/** Decode + cross-field validate a rule against the one shared contract. */
const decodeRule = (
  rule: RecurrenceRule,
): Effect.Effect<RecurrenceRule, TaskValidationError> => {
  const decoded = Schema.decodeOption(RecurrenceRule)(rule)
  return Option.isNone(decoded)
    ? invalid('recurrence', 'recurrence rule is not valid')
    : Effect.succeed(decoded.value)
}

export class TaskService extends Context.Service<TaskService>()('TaskService', {
  make: Effect.gen(function* () {
    const tasks = yield* TaskRepo
    const projects = yield* ProjectRepo
    const tags = yield* TagRepo
    const sync = yield* SyncRepo

    const kit = makeSyncKit<TaskServiceError>({ sync, invalid })

    /**
     * Turn a validated aggregate into the registry's trusted write state. The
     * registration's `validate` boundary is the same one the sync push uses,
     * so a service write can never put a shape on the wire that a pull would
     * reject.
     */
    const taskState = (task: Task): SyncEntityState => kit.stateOf('task', task)

    const projectState = (project: Project): SyncEntityState =>
      kit.stateOf('project', project)

    const tagState = (tag: Tag): SyncEntityState => kit.stateOf('tag', tag)

    /**
     * The ledger row for one mutation id, if this household already applied it.
     * Household-scoped exactly like the sync push (`findApplied`).
     */
    const appliedMutation = (viewer: TaskViewer, clientMutationId: string) =>
      kit.appliedMutation(viewer.householdId, clientMutationId)

    /**
     * One entity mutation: the CAS entity write, gated feed append, gated
     * ledger row, tag-join statements and the #38 recurrence successor — one D1
     * batch. Returns whether this `clientMutationId` is now recorded, i.e. the
     * CAS won.
     *
     * The batch failure stays typed here (rather than a defect) because the tag
     * mutations map a `UNIQUE` violation onto a field error; every other caller
     * goes through `commitPlanningEntity`, which dies on it.
     */
    const commitEntity = (input: {
      readonly viewer: TaskViewer
      readonly state: SyncEntityState
      readonly expectedVersion: number | null
      readonly clientMutationId: string
      readonly now: string
      readonly op?: 'upsert' | 'delete'
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
        readonly parentId: Task['id']
      }
    }) => {
      const tagChanges = input.tagChanges
      const spawn = input.spawn
      const entries: Array<CommitEntry> = [
        {
          state: input.state,
          expectedVersion: input.expectedVersion,
          clientMutationId: input.clientMutationId,
          op: input.op,
          extra:
            tagChanges === undefined ||
            sameTags(tagChanges.previous, tagChanges.next)
              ? undefined
              : state => [
                  tasks.detachTagsIfVersion({
                    taskId: state.entityId,
                    version: state.version,
                    updatedAt: state.updatedAt,
                  }),
                  ...tagChanges.next.map(tagId =>
                    tasks.attachTagIfVersion({
                      taskId: state.entityId,
                      tagId,
                      householdId: input.viewer.householdId,
                      createdAt: input.now,
                      version: state.version,
                      updatedAt: state.updatedAt,
                    }),
                  ),
                ],
        },
      ]
      if (spawn !== undefined) {
        const child = kit.stateOf('task', spawn.task)
        entries.push({
          state: child,
          expectedVersion: null,
          // Insert is gated on the parent's new version + done status; the
          // feed/ledger rows are gated on that insert (`changes()`), and the
          // partial unique index on recurrence_parent_id makes it exactly-once.
          insert: () =>
            tasks.insertRecurrenceChildStatement({
              task: spawn.task,
              parentId: spawn.parentId,
              parentVersion: input.state.version,
            }),
          clientMutationId: `recurrence:${spawn.parentId}`,
          ledger: 'derived',
          extra: () =>
            spawn.task.tagIds.map(tagId =>
              tasks.attachTagIfVersion({
                taskId: spawn.task.id,
                tagId,
                householdId: input.viewer.householdId,
                createdAt: input.now,
                version: spawn.task.version,
                updatedAt: spawn.task.updatedAt,
              }),
            ),
        })
      }
      return Effect.map(
        kit.tryCommitEntries({
          householdId: input.viewer.householdId,
          entries,
          now: input.now,
        }),
        applied => applied.has(input.clientMutationId),
      )
    }

    /**
     * Task/project commits: repository failures are unexpected defects, while
     * the service's own typed failures (a reused mutation id) propagate.
     */
    const commitPlanningEntity = (
      input: Parameters<typeof commitEntity>[0],
    ): Effect.Effect<boolean, TaskServiceError> =>
      commitEntity(input).pipe(
        Effect.catchTag('SqlError', error => Effect.die(error)),
      )

    /** Replay guard: the same mutation id already committed (lost response). */
    const replayOf = (
      viewer: TaskViewer,
      clientMutationId: string,
      expectedId?: Task['id'],
    ): Effect.Effect<Option.Option<Task>, TaskServiceError> =>
      Effect.gen(function* () {
        const row = yield* appliedMutation(viewer, clientMutationId)
        if (Option.isNone(row)) return Option.none()
        if (
          kit.reusedMutationId(row.value, {
            entityType: 'task',
            id: expectedId,
          })
        ) {
          return yield* kit.reusedMutationIdError(
            expectedId ?? row.value.entityId,
          )
        }
        // Same household/owner rules as any other read: a mutation id must
        // never hand back another member's private row.
        const current = yield* loadTask(
          viewer,
          row.value.entityId as Task['id'],
        )
        return Option.some(current)
      })

    const loadTask = (
      viewer: TaskViewer,
      id: Task['id'],
    ): Effect.Effect<Task, TaskServiceError> =>
      readScoped({
        viewer,
        id,
        find: tasks.findById,
        // A tombstone reads as missing before the household/owner checks: the
        // replay guard never asks for a trashed task.
        trash: 'first',
        onViolation: violation =>
          violation === 'notFound' || violation === 'trashed'
            ? new TaskNotFound({ id })
            : new TaskForbidden({ id, reason: violation }),
      })

    /**
     * Replay guard for project/tag mutations — same rules as `replayOf`: the
     * key must belong to the same aggregate and row, and the row must still be
     * visible to the caller (a mutation id may not reveal a private row).
     */
    const replayProject = (
      viewer: TaskViewer,
      clientMutationId: string,
      expectedId?: Project['id'],
    ): Effect.Effect<Option.Option<Project>, TaskServiceError> =>
      Effect.gen(function* () {
        const row = yield* appliedMutation(viewer, clientMutationId)
        if (Option.isNone(row)) return Option.none()
        if (
          kit.reusedMutationId(row.value, {
            entityType: 'project',
            id: expectedId,
          })
        ) {
          return yield* kit.reusedMutationIdError(
            expectedId ?? row.value.entityId,
          )
        }
        const id = row.value.entityId as Project['id']
        const found = yield* projects.findById(id).pipe(Effect.orDie)
        if (Option.isNone(found) || found.value.deletedAt !== null) {
          return yield* new ProjectNotFound({ id })
        }
        const project = found.value
        if (project.householdId !== viewer.householdId) {
          return yield* new TaskForbidden({ id, reason: 'household' })
        }
        if (
          project.visibility === 'private' &&
          project.ownerId !== viewer.userId
        ) {
          return yield* new TaskForbidden({ id, reason: 'private' })
        }
        return Option.some(project)
      })

    const replayTag = (
      viewer: TaskViewer,
      clientMutationId: string,
      expectedId?: Tag['id'],
    ): Effect.Effect<Option.Option<Tag>, TaskServiceError> =>
      Effect.gen(function* () {
        const row = yield* appliedMutation(viewer, clientMutationId)
        if (Option.isNone(row)) return Option.none()
        if (
          kit.reusedMutationId(row.value, { entityType: 'tag', id: expectedId })
        ) {
          return yield* kit.reusedMutationIdError(
            expectedId ?? row.value.entityId,
          )
        }
        const id = row.value.entityId as Tag['id']
        const found = yield* tags.findById(id).pipe(Effect.orDie)
        if (Option.isNone(found) || found.value.deletedAt !== null) {
          return yield* new TagNotFound({ id })
        }
        const tag = found.value
        if (tag.householdId !== viewer.householdId) {
          return yield* new TaskForbidden({ id, reason: 'household' })
        }
        if (tag.visibility === 'private' && tag.ownerId !== viewer.userId) {
          return yield* new TaskForbidden({ id, reason: 'private' })
        }
        return Option.some(tag)
      })

    const requireProject = (
      viewer: TaskViewer,
      projectId: ProjectId,
    ): Effect.Effect<Project, TaskValidationError> =>
      Effect.gen(function* () {
        const found = yield* projects.findById(projectId).pipe(Effect.orDie)
        if (Option.isNone(found) || found.value.deletedAt !== null) {
          return yield* invalid('projectId', 'project does not exist')
        }
        const project = found.value
        if (project.householdId !== viewer.householdId) {
          return yield* invalid('projectId', 'project is not in this household')
        }
        if (
          project.visibility === 'private' &&
          project.ownerId !== viewer.userId
        ) {
          return yield* invalid('projectId', 'project is private')
        }
        return project
      })

    const requireTags = (
      viewer: TaskViewer,
      tagIds: ReadonlyArray<TagId>,
    ): Effect.Effect<ReadonlyArray<Tag>, TaskValidationError> =>
      loadAssignableTags(tags, viewer, tagIds).pipe(
        Effect.mapError(issue => new TaskValidationError({ issues: [issue] })),
      )

    const validateDue = (dueAt: string | null, dueDate: string | null) =>
      Effect.gen(function* () {
        if (dueAt !== null && dueDate !== null) {
          return yield* invalid(
            'dueAt',
            'a task has either a due instant or an all-day due date',
          )
        }
        if (dueAt !== null && !validInstant(dueAt)) {
          return yield* invalid(
            'dueAt',
            'due instant must be an ISO-8601 UTC timestamp',
          )
        }
        if (dueDate !== null && !validLocalDate(dueDate)) {
          return yield* invalid(
            'dueDate',
            'due date must be a real calendar date',
          )
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
      now: string,
    ): Effect.Effect<Task, TaskServiceError> =>
      Effect.gen(function* () {
        // Shared means co-edit; un-sharing is the owner's alone (ADR-0011). A
        // partner must not be able to lock the author out of their own row.
        if (
          patch.visibility === 'private' &&
          current.ownerId !== viewer.userId
        ) {
          return yield* invalid(
            'visibility',
            'only the task owner can make it private',
          )
        }
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
                : (current.recurrenceMode ?? 'onDueDate')
            if (recurrenceMode === null) {
              return yield* invalid(
                'recurrenceMode',
                'a recurrence rule needs a mode',
              )
            }
          }
        } else if (patch.recurrenceMode !== undefined) {
          if (patch.recurrenceMode === null) {
            if (recurrence !== null) {
              return yield* invalid(
                'recurrenceMode',
                'clear the recurrence rule to stop repeating',
              )
            }
          } else if (recurrence === null) {
            return yield* invalid(
              'recurrenceMode',
              'a recurrence mode requires a recurrence rule',
            )
          } else {
            recurrenceMode = patch.recurrenceMode
          }
        }
        if (recurrence !== null && recurrenceMode === null)
          recurrenceMode = 'onDueDate'
        if (
          recurrence !== null &&
          recurrenceMode === 'onDueDate' &&
          dueAt === null &&
          dueDate === null
        ) {
          return yield* invalid(
            'dueDate',
            'an on-due-date recurrence needs a due date',
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
          if (current.status === 'todo' && patch.status === 'doing') {
            status = 'doing'
            startedAt = current.startedAt ?? now
          } else if (current.status === 'todo' && patch.status === 'done') {
            status = 'done'
            completedAt = now
          } else if (current.status === 'doing' && patch.status === 'done') {
            status = 'done'
            completedAt = now
          } else {
            return yield* new TaskInvalidTransition({
              id: current.id,
              from: current.status,
              to: patch.status,
            })
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
          updatedAt: now,
        })
      })

    const create = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskCreateInput>,
      now: string = new Date().toISOString(),
    ): Effect.Effect<Task, TaskServiceError> =>
      Effect.gen(function* () {
        const replayed = yield* replayOf(
          viewer,
          input.clientMutationId,
          input.id,
        )
        if (Option.isSome(replayed)) return replayed.value

        const dueAt =
          input.dueAt === undefined || input.dueAt === null
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
            'recurrenceMode',
            'a recurrence mode requires a recurrence rule',
          )
        }
        const recurrence =
          input.recurrence === undefined || input.recurrence === null
            ? null
            : yield* decodeRule(input.recurrence)
        const recurrenceMode: TaskRecurrenceMode | null =
          recurrence === null ? null : (input.recurrenceMode ?? 'onDueDate')
        if (
          recurrence !== null &&
          recurrenceMode === 'onDueDate' &&
          dueAt === null &&
          dueDate === null
        ) {
          return yield* invalid(
            'dueDate',
            'an on-due-date recurrence needs a due date',
          )
        }
        if (input.projectId !== undefined && input.projectId !== null) {
          yield* requireProject(viewer, input.projectId)
        }
        if (input.tagIds !== undefined) {
          yield* requireTags(viewer, input.tagIds)
        }

        const status = input.status ?? 'todo'
        const task = new Task({
          id: (input.id ?? uuidV7()) as Task['id'],
          type: 'task',
          title: input.title,
          description: input.description ?? null,
          ownerId: viewer.userId,
          householdId: viewer.householdId,
          visibility: resolveCreateVisibility('task', input.visibility),
          color: input.color ?? null,
          status,
          priority: (input.priority ?? 'medium') as Priority,
          dueAt,
          dueDate,
          timeZone: input.timeZone ?? viewer.timeZone,
          projectId: input.projectId ?? null,
          tagIds: input.tagIds ?? [],
          recurrence,
          recurrenceMode,
          startedAt: status === 'doing' ? now : null,
          completedAt: status === 'done' ? now : null,
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null,
        })

        const applied = yield* commitPlanningEntity({
          viewer,
          state: taskState(task),
          expectedVersion: null,
          clientMutationId: input.clientMutationId,
          now,
          tagChanges: { previous: [], next: task.tagIds },
        })
        if (!applied) {
          return yield* new TaskConflict({ id: task.id })
        }
        return task
      })

    const get = (
      viewer: TaskViewer,
      id: Task['id'],
    ): Effect.Effect<Task, TaskServiceError> => loadTask(viewer, id)

    const update = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskUpdateInput>,
      now: string = new Date().toISOString(),
    ): Effect.Effect<Task, TaskServiceError> =>
      Effect.gen(function* () {
        const replayed = yield* replayOf(
          viewer,
          input.clientMutationId,
          input.id,
        )
        if (Option.isSome(replayed)) return replayed.value

        return yield* casUpdate({
          read: loadTask(viewer, input.id),
          plan: current =>
            Effect.gen(function* () {
              const next = yield* patchTask(viewer, current, input.patch, now)
              // `patchTask` only writes patch fields (status stamps the two
              // transition timestamps, due fields are normalized, recurrence
              // implies its mode), so the patch is the complete no-op test.
              return unchangedExcept(current, next, input.patch) ? null : next
            }),
          write: (current, next) =>
            Effect.gen(function* () {
              // `update({ status: "done" })` is a completion too, so it must
              // spawn the same single successor as `complete()`.
              const spawnTask =
                current.status !== 'done' && next.status === 'done'
                  ? successorOf(next, now)
                  : null
              return yield* commitPlanningEntity({
                viewer,
                state: taskState(next),
                expectedVersion: current.version,
                clientMutationId: input.clientMutationId,
                now,
                tagChanges: { previous: current.tagIds, next: next.tagIds },
                spawn:
                  spawnTask === null
                    ? undefined
                    : { task: spawnTask, parentId: current.id },
              })
            }),
          conflict: () => new TaskConflict({ id: input.id }),
        })
      })

    const move = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskMoveInput>,
      now: string = new Date().toISOString(),
    ): Effect.Effect<Task, TaskServiceError> =>
      Effect.gen(function* () {
        const replayed = yield* replayOf(
          viewer,
          input.clientMutationId,
          input.id,
        )
        if (Option.isSome(replayed)) return replayed.value
        if (input.dueDate !== null && !validLocalDate(input.dueDate)) {
          return yield* invalid(
            'dueDate',
            'due date must be a real calendar date',
          )
        }

        return yield* casUpdate({
          read: loadTask(viewer, input.id),
          plan: current =>
            Effect.succeed(
              current.dueDate === input.dueDate && current.dueAt === null
                ? null
                : new Task({
                    ...current,
                    dueAt: null,
                    dueDate: input.dueDate,
                    timeZone: input.timeZone ?? viewer.timeZone,
                    version: current.version + 1,
                    updatedAt: now,
                  }),
            ),
          write: (current, next) =>
            commitPlanningEntity({
              viewer,
              state: taskState(next),
              expectedVersion: current.version,
              clientMutationId: input.clientMutationId,
              now,
              tagChanges: { previous: current.tagIds, next: next.tagIds },
            }),
          conflict: () => new TaskConflict({ id: input.id }),
        })
      })

    /**
     * The shell the three status transitions share: replay guard, re-read,
     * one status move under CAS, and the planning commit with its tag ceiling.
     * They differ only in what counts as an idempotent no-op, which rows they
     * refuse, the fields they stamp, and whether completion owns a recurrence
     * successor.
     */
    const transitionTask = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskMutationInput>,
      now: string,
      transition: {
        /** The status the request moves the row to, named in a refusal. */
        readonly to: TaskStatus
        /** Statuses the row must be in; omitted when any row may move. */
        readonly from?: ReadonlyArray<TaskStatus>
        /** A row that already satisfies the request is the answer, not a write. */
        readonly settled?: (current: Task) => boolean
        /** Further refusals, checked against the same fresh row. */
        readonly refuse?: (
          current: Task,
        ) => Effect.Effect<void, TaskServiceError>
        /** The row to write; the version bump and `updatedAt` belong here. */
        readonly stamp: (current: Task) => Task
        /** The recurrence successor to insert in the same batch, if any. */
        readonly successor?: (next: Task) => Task | null
      },
    ): Effect.Effect<Task, TaskServiceError> =>
      Effect.gen(function* () {
        const replayed = yield* replayOf(
          viewer,
          input.clientMutationId,
          input.id,
        )
        if (Option.isSome(replayed)) return replayed.value

        return yield* casUpdate({
          read: loadTask(viewer, input.id),
          plan: current =>
            Effect.gen(function* () {
              if (transition.settled?.(current) === true) return null
              if (
                transition.from !== undefined &&
                !transition.from.includes(current.status)
              ) {
                return yield* new TaskInvalidTransition({
                  id: current.id,
                  from: current.status,
                  to: transition.to,
                })
              }
              if (transition.refuse !== undefined) {
                yield* transition.refuse(current)
              }
              return transition.stamp(current)
            }),
          write: (current, next) =>
            Effect.gen(function* () {
              const spawn = transition.successor?.(next) ?? null
              return yield* commitPlanningEntity({
                viewer,
                state: taskState(next),
                expectedVersion: current.version,
                clientMutationId: input.clientMutationId,
                now,
                tagChanges: { previous: current.tagIds, next: next.tagIds },
                spawn:
                  spawn === null
                    ? undefined
                    : { task: spawn, parentId: current.id },
              })
            }),
          conflict: () => new TaskConflict({ id: input.id }),
        })
      })

    const start = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskMutationInput>,
      now: string = new Date().toISOString(),
    ): Effect.Effect<Task, TaskServiceError> =>
      transitionTask(viewer, input, now, {
        to: 'doing',
        from: ['todo'],
        settled: current => current.status === 'doing',
        stamp: current =>
          new Task({
            ...current,
            status: 'doing',
            startedAt: current.startedAt ?? now,
            completedAt: null,
            version: current.version + 1,
            updatedAt: now,
          }),
      })

    const complete = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskMutationInput>,
      now: string = new Date().toISOString(),
    ): Effect.Effect<Task, TaskServiceError> =>
      transitionTask(viewer, input, now, {
        to: 'done',
        // Idempotent: completing an already-done task writes nothing.
        settled: isDone,
        stamp: current =>
          new Task({
            ...current,
            status: 'done',
            completedAt: now,
            version: current.version + 1,
            updatedAt: now,
          }),
        // The successor is computed from the instance being completed (its
        // rule and due anchor), never from the client. A bounded rule that has
        // run out produces no successor.
        successor: next => successorOf(next, now),
      })

    const undo = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskMutationInput>,
      now: string = new Date().toISOString(),
    ): Effect.Effect<Task, TaskServiceError> =>
      transitionTask(viewer, input, now, {
        to: 'todo',
        from: ['done'],
        refuse: current =>
          current.completedAt !== null &&
          Date.parse(current.completedAt) < Date.parse(completionCutoff(now))
            ? Effect.fail(
                new TaskNotRestorable({
                  id: current.id,
                  completedAt: current.completedAt,
                }),
              )
            : Effect.void,
        // No completion snapshot is needed: completion never moves the due
        // fields, and `startedAt` tells us whether the prior state was `doing`
        // or `todo`. The original due date is therefore intact.
        stamp: current =>
          new Task({
            ...current,
            status: current.startedAt !== null ? 'doing' : 'todo',
            completedAt: null,
            version: current.version + 1,
            updatedAt: now,
          }),
      })

    const list = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TaskListInput>,
      now: string = new Date().toISOString(),
    ): Effect.Effect<ReadonlyArray<Task>, TaskServiceError> =>
      Effect.gen(function* () {
        const filter = input.filter ?? {}
        const sort: TaskSort = input.sort ?? { by: 'dueDate', direction: 'asc' }
        const bounds = taskBucketBounds(viewer.timeZone, now)
        const query: {
          -readonly [K in keyof TaskQuery]: TaskQuery[K]
        } = {
          householdId: viewer.householdId,
          userId: viewer.userId,
          includeArchived: filter.includeArchived === true,
          completionCutoff: completionCutoff(now),
          sort,
        }
        if (filter.projectId !== undefined) query.projectId = filter.projectId
        if (filter.tagIds !== undefined) query.tagIds = filter.tagIds
        if (filter.priority !== undefined) query.priority = filter.priority
        if (filter.status !== undefined) query.status = filter.status
        if (filter.dueFrom !== undefined) {
          query.dueDateFrom = filter.dueFrom
          query.dueInstantFrom = localDateStartInstant(
            filter.dueFrom,
            viewer.timeZone,
          )
        }
        if (filter.dueBefore !== undefined) {
          query.dueDateBefore = filter.dueBefore
          query.dueInstantBefore = localDateStartInstant(
            filter.dueBefore,
            viewer.timeZone,
          )
        }

        if (filter.bucket !== undefined) {
          switch (filter.bucket) {
            case 'overdue':
              query.dueDateBefore = bounds.today
              query.dueInstantBefore = bounds.todayStart
              break
            case 'today':
              query.dueDateFrom = bounds.today
              query.dueDateBefore = bounds.tomorrow
              query.dueInstantFrom = bounds.todayStart
              query.dueInstantBefore = bounds.tomorrowStart
              break
            case 'tomorrow':
              query.dueDateFrom = bounds.tomorrow
              query.dueDateBefore = bounds.dayAfterTomorrow
              query.dueInstantFrom = bounds.tomorrowStart
              query.dueInstantBefore = bounds.dayAfterTomorrowStart
              break
            case 'thisWeek':
              query.dueDateFrom = bounds.dayAfterTomorrow
              query.dueDateBefore = bounds.weekAfter
              query.dueInstantFrom = bounds.dayAfterTomorrowStart
              query.dueInstantBefore = bounds.weekEndExclusive
              break
            case 'noDate':
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
      now: string = new Date().toISOString(),
    ): Effect.Effect<TaskBuckets, TaskServiceError> =>
      Effect.gen(function* () {
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
          noDate,
        ] = yield* Effect.all(
          [
            tasks.listDueDateRange({ ...scope, before: bounds.today }),
            tasks.listDueInstantRange({ ...scope, before: bounds.todayStart }),
            tasks.listDueDateRange({
              ...scope,
              from: bounds.today,
              before: bounds.weekAfter,
            }),
            tasks.listDueInstantRange({
              ...scope,
              from: bounds.todayStart,
              before: bounds.weekEndExclusive,
            }),
            tasks.listNoDue(scope),
          ],
          { concurrency: 4 },
        ).pipe(Effect.orDie)

        const grouped: Record<TaskBucket, Array<Task>> = {
          overdue: [],
          today: [],
          tomorrow: [],
          thisWeek: [],
          noDate: [],
        }
        const seen = new Set<string>()
        for (const task of [
          ...overdueDates,
          ...overdueInstants,
          ...upcomingDates,
          ...upcomingInstants,
          ...noDate,
        ]) {
          // A malformed row with both due shapes could appear in two ranges;
          // the bucket view must still show it once.
          if (seen.has(task.id)) continue
          seen.add(task.id)
          const bucket = taskBucketOf(task, bounds)
          if (bucket !== 'later' && bucket !== 'done')
            grouped[bucket].push(task)
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
          noDate: grouped.noDate,
        }
      })

    // ── Projects ──────────────────────────────────────────────────────────

    const createProject = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof ProjectCreateInput>,
      now: string = new Date().toISOString(),
    ): Effect.Effect<Project, TaskServiceError> =>
      Effect.gen(function* () {
        const replayed = yield* replayProject(
          viewer,
          input.clientMutationId,
          input.id,
        )
        if (Option.isSome(replayed)) return replayed.value

        const project = new Project({
          id: (input.id ?? uuidV7()) as ProjectId,
          type: 'project',
          title: input.title,
          ownerId: viewer.userId,
          householdId: viewer.householdId,
          visibility: resolveCreateVisibility('project'),
          color: input.color ?? null,
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null,
        })
        const applied = yield* commitPlanningEntity({
          viewer,
          state: projectState(project),
          expectedVersion: null,
          clientMutationId: input.clientMutationId,
          now,
        })
        if (!applied) return yield* new TaskConflict({ id: project.id })
        return project
      })

    const renameProject = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof ProjectRenameInput>,
      now: string = new Date().toISOString(),
    ): Effect.Effect<Project, TaskServiceError> =>
      Effect.gen(function* () {
        const replayed = yield* replayProject(
          viewer,
          input.clientMutationId,
          input.id,
        )
        if (Option.isSome(replayed)) return replayed.value

        return yield* casUpdate<Project, TaskServiceError>({
          // Scope is part of the read: a row this viewer may not rename never
          // becomes a CAS candidate.
          read: Effect.gen(function* () {
            const found = yield* projects.findById(input.id).pipe(Effect.orDie)
            if (Option.isNone(found) || found.value.deletedAt !== null) {
              return yield* new ProjectNotFound({ id: input.id })
            }
            const current = found.value
            if (current.householdId !== viewer.householdId) {
              return yield* new TaskForbidden({
                id: input.id,
                reason: 'household',
              })
            }
            if (
              current.visibility === 'private' &&
              current.ownerId !== viewer.userId
            ) {
              return yield* new TaskForbidden({
                id: input.id,
                reason: 'private',
              })
            }
            return current
          }),
          plan: current =>
            Effect.succeed(
              current.title === input.title
                ? null
                : new Project({
                    ...current,
                    title: input.title,
                    version: current.version + 1,
                    updatedAt: now,
                  }),
            ),
          write: (current, next) =>
            commitPlanningEntity({
              viewer,
              state: projectState(next),
              expectedVersion: current.version,
              clientMutationId: input.clientMutationId,
              now,
            }),
          conflict: () => new TaskConflict({ id: input.id }),
        })
      })

    const listProjects = (
      viewer: TaskViewer,
    ): Effect.Effect<ReadonlyArray<Project>, TaskServiceError> =>
      projects
        .listVisible({ householdId: viewer.householdId, userId: viewer.userId })
        .pipe(Effect.orDie)

    // ── Tags ─────────────────────────────────────────────────────────────

    const createTag = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TagCreateInput>,
      now: string = new Date().toISOString(),
    ): Effect.Effect<Tag, TaskServiceError> =>
      Effect.gen(function* () {
        const replayed = yield* replayTag(
          viewer,
          input.clientMutationId,
          input.id,
        )
        if (Option.isSome(replayed)) return replayed.value

        const existing = yield* tags
          .findLiveByName({ householdId: viewer.householdId, name: input.name })
          .pipe(Effect.orDie)
        if (Option.isSome(existing)) {
          return yield* invalid('name', 'a tag with this name already exists')
        }

        const tag = new Tag({
          id: (input.id ?? uuidV7()) as TagId,
          type: 'tag',
          name: input.name,
          ownerId: viewer.userId,
          householdId: viewer.householdId,
          visibility: resolveCreateVisibility('tag'),
          color: input.color ?? null,
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null,
        })

        const applied = yield* commitEntity({
          viewer,
          state: tagState(tag),
          expectedVersion: null,
          clientMutationId: input.clientMutationId,
          now,
        }).pipe(
          Effect.catchTag('SqlError', error =>
            String(error).includes('UNIQUE constraint failed')
              ? invalid('name', 'a tag with this name already exists')
              : Effect.die(error),
          ),
        )
        if (!applied) {
          // The insert is `ON CONFLICT DO NOTHING`, so a unique-name race
          // surfaces as a no-op rather than a SqlError.
          const raced = yield* tags
            .findLiveByName({
              householdId: viewer.householdId,
              name: input.name,
            })
            .pipe(Effect.orDie)
          if (Option.isSome(raced)) {
            return yield* invalid('name', 'a tag with this name already exists')
          }
          return yield* new TaskConflict({ id: tag.id })
        }
        return tag
      })

    const renameTag = (
      viewer: TaskViewer,
      input: Schema.Schema.Type<typeof TagRenameInput>,
      now: string = new Date().toISOString(),
    ): Effect.Effect<Tag, TaskServiceError> =>
      Effect.gen(function* () {
        const replayed = yield* replayTag(
          viewer,
          input.clientMutationId,
          input.id,
        )
        if (Option.isSome(replayed)) return replayed.value

        return yield* casUpdate<Tag, TaskServiceError>({
          // Scope is part of the read: a row this viewer may not rename never
          // becomes a CAS candidate.
          read: Effect.gen(function* () {
            const found = yield* tags.findById(input.id).pipe(Effect.orDie)
            if (Option.isNone(found) || found.value.deletedAt !== null) {
              return yield* new TagNotFound({ id: input.id })
            }
            const current = found.value
            if (current.householdId !== viewer.householdId) {
              return yield* new TaskForbidden({
                id: input.id,
                reason: 'household',
              })
            }
            if (
              current.visibility === 'private' &&
              current.ownerId !== viewer.userId
            ) {
              return yield* new TaskForbidden({
                id: input.id,
                reason: 'private',
              })
            }
            return current
          }),
          plan: current =>
            Effect.gen(function* () {
              if (current.name === input.name) return null
              const conflicting = yield* tags
                .findLiveByName({
                  householdId: viewer.householdId,
                  name: input.name,
                })
                .pipe(Effect.orDie)
              if (
                Option.isSome(conflicting) &&
                conflicting.value.id !== current.id
              ) {
                return yield* invalid(
                  'name',
                  'a tag with this name already exists',
                )
              }
              return new Tag({
                ...current,
                name: input.name,
                version: current.version + 1,
                updatedAt: now,
              })
            }),
          write: (current, next) =>
            commitEntity({
              viewer,
              state: tagState(next),
              expectedVersion: current.version,
              clientMutationId: input.clientMutationId,
              now,
            }).pipe(
              Effect.catchTag('SqlError', error =>
                String(error).includes('UNIQUE constraint failed')
                  ? invalid('name', 'a tag with this name already exists')
                  : Effect.die(error),
              ),
            ),
          conflict: () => new TaskConflict({ id: input.id }),
        })
      })

    const listTags = (
      viewer: TaskViewer,
    ): Effect.Effect<ReadonlyArray<Tag>, TaskServiceError> =>
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
      listTags,
    } as const
  }),
}) {}

export const TaskServiceLive = Layer.effect(TaskService, TaskService.make).pipe(
  Layer.provide(TaskRepoLive),
  Layer.provide(ProjectRepoLive),
  Layer.provide(TagRepoLive),
  Layer.provide(SyncRepoLive),
)
