import { Schema } from "effect"
import { Visibility } from "../common.js"
import { TaskBucket } from "./buckets.js"
import {
  LocalDate,
  Priority,
  ProjectId,
  TagId,
  TagIds,
  TaskId,
  TaskStatus,
  TimeZone,
  TimestampUtc
} from "./common.js"
import { Task } from "./task.js"

/**
 * TaskService contract (ticket #36; FR-TASK-01/02/05/06).
 *
 * These schemas are the wire/contract layer between the RPC handlers and the
 * service. The service itself is server-authoritative: ids are server-minted
 * unless a client supplies one, and every timestamp/version is stamped by the
 * server. `clientMutationId` is the replay/idempotency key the write path
 * dedupes on (`applied_mutations`), so an RPC retry after a lost response is
 * exactly-once.
 */

// ── Typed errors (`docs/error-model-draft.md` §2) ────────────────────────

/** The task does not exist, or is not visible to this viewer. */
export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()("TaskNotFound", {
  id: TaskId
}) {}

export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()("ProjectNotFound", {
  id: ProjectId
}) {}

export class TagNotFound extends Schema.TaggedError<TagNotFound>()("TagNotFound", {
  id: TagId
}) {}

/** The row exists but this viewer may not read/write it. */
export class TaskForbidden extends Schema.TaggedError<TaskForbidden>()("TaskForbidden", {
  id: Schema.NullOr(Schema.String),
  reason: Schema.Literals(["private", "household", "noHousehold"])
}) {}

/** A lifecycle move that the task's current status cannot make. */
export class TaskInvalidTransition extends Schema.TaggedError<TaskInvalidTransition>()(
  "TaskInvalidTransition",
  {
    id: TaskId,
    from: TaskStatus,
    to: TaskStatus
  }
) {}

/** Field-level validation (bad due instant, foreign project/tag, both due shapes, …). */
export class TaskValidationError extends Schema.TaggedError<TaskValidationError>()(
  "TaskValidationError",
  {
    issues: Schema.Array(
      Schema.Struct({
        field: Schema.String,
        message: Schema.String
      })
    )
  }
) {}

/** A concurrent writer won the version CAS; the caller may retry. */
export class TaskConflict extends Schema.TaggedError<TaskConflict>()("TaskConflict", {
  id: Schema.String
}) {}

/** A completion older than the 7-day retention window can no longer be undone. */
export class TaskNotRestorable extends Schema.TaggedError<TaskNotRestorable>()(
  "TaskNotRestorable",
  {
    id: TaskId,
    completedAt: Schema.String
  }
) {}

export const TaskServiceError = Schema.Union([
  TaskNotFound,
  ProjectNotFound,
  TagNotFound,
  TaskForbidden,
  TaskInvalidTransition,
  TaskValidationError,
  TaskConflict,
  TaskNotRestorable
])
export type TaskServiceError = Schema.Schema.Type<typeof TaskServiceError>

// ── Mutation inputs ──────────────────────────────────────────────────────

/**
 * Patch-style task fields. Every field is optional: omitted fields keep their
 * stored value, which is what makes a fast title-only edit cheap and a
 * field-level conflict merge possible.
 */
export const TaskPatch = Schema.Struct({
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(TaskStatus),
  priority: Schema.optional(Priority),
  dueAt: Schema.optional(Schema.NullOr(TimestampUtc)),
  dueDate: Schema.optional(Schema.NullOr(LocalDate)),
  timeZone: Schema.optional(TimeZone),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  tagIds: Schema.optional(TagIds),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  visibility: Schema.optional(Visibility)
})
export type TaskPatch = Schema.Schema.Type<typeof TaskPatch>

/** Create is title-first; everything else has a benign default. */
export const TaskCreateInput = Schema.Struct({
  /** A client may mint the UUID v7 offline; the server mints one otherwise. */
  id: Schema.optional(TaskId),
  clientMutationId: Schema.String,
  title: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(TaskStatus),
  priority: Schema.optional(Priority),
  dueAt: Schema.optional(Schema.NullOr(TimestampUtc)),
  dueDate: Schema.optional(Schema.NullOr(LocalDate)),
  timeZone: Schema.optional(TimeZone),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  tagIds: Schema.optional(TagIds),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  visibility: Schema.optional(Visibility)
})
export type TaskCreateInput = Schema.Schema.Type<typeof TaskCreateInput>

export const TaskUpdateInput = Schema.Struct({
  id: TaskId,
  clientMutationId: Schema.String,
  /** The version the client last saw; informational for the service CAS. */
  baseVersion: Schema.optional(Schema.Int),
  patch: TaskPatch
})
export type TaskUpdateInput = Schema.Schema.Type<typeof TaskUpdateInput>

/** `moveTask` changes the due day (and clears a timed due instant). */
export const TaskMoveInput = Schema.Struct({
  id: TaskId,
  clientMutationId: Schema.String,
  dueDate: Schema.NullOr(LocalDate),
  timeZone: Schema.optional(TimeZone)
})
export type TaskMoveInput = Schema.Schema.Type<typeof TaskMoveInput>

/** Start/complete/undo all carry only the row id plus the replay key. */
export const TaskMutationInput = Schema.Struct({
  id: TaskId,
  clientMutationId: Schema.String
})
export type TaskMutationInput = Schema.Schema.Type<typeof TaskMutationInput>

// ── Query inputs ─────────────────────────────────────────────────────────

export const TaskSortField = Schema.Literals([
  "dueDate",
  "priority",
  "status",
  "createdAt",
  "updatedAt",
  "title"
])
export type TaskSortField = Schema.Schema.Type<typeof TaskSortField>

export const SortDirection = Schema.Literals(["asc", "desc"])
export type SortDirection = Schema.Schema.Type<typeof SortDirection>

export const TaskSort = Schema.Struct({
  by: TaskSortField,
  direction: SortDirection
})
export type TaskSort = Schema.Schema.Type<typeof TaskSort>

export const DEFAULT_TASK_SORT: TaskSort = { by: "dueDate", direction: "asc" }

export const TaskFilter = Schema.Struct({
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  tagIds: Schema.optional(TagIds),
  priority: Schema.optional(Priority),
  status: Schema.optional(TaskStatus),
  /** Inclusive local-date lower bound (`YYYY-MM-DD`, viewer's zone). */
  dueFrom: Schema.optional(LocalDate),
  /** Exclusive local-date upper bound (`YYYY-MM-DD`, viewer's zone). */
  dueBefore: Schema.optional(LocalDate),
  /** A quick preset; mutually exclusive with the explicit due bounds. */
  bucket: Schema.optional(TaskBucket),
  /** Completed tasks are retained 7 days; this includes older archived rows. */
  includeArchived: Schema.optional(Schema.Boolean)
})
export type TaskFilter = Schema.Schema.Type<typeof TaskFilter>

export const TaskListInput = Schema.Struct({
  filter: Schema.optional(TaskFilter),
  sort: Schema.optional(TaskSort)
})
export type TaskListInput = Schema.Schema.Type<typeof TaskListInput>

/** The Today screen's five buckets, all computed in the viewer's zone. */
export const TaskBuckets = Schema.Struct({
  timeZone: Schema.String,
  today: LocalDate,
  tomorrow: LocalDate,
  weekEnd: LocalDate,
  overdue: Schema.Array(Task),
  todayTasks: Schema.Array(Task),
  tomorrowTasks: Schema.Array(Task),
  thisWeek: Schema.Array(Task),
  noDate: Schema.Array(Task)
})
export type TaskBuckets = Schema.Schema.Type<typeof TaskBuckets>

// ── Project / tag inputs (FR-TASK-02) ────────────────────────────────────

export const ProjectCreateInput = Schema.Struct({
  id: Schema.optional(ProjectId),
  clientMutationId: Schema.String,
  title: Schema.String.check(Schema.isMinLength(1)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  visibility: Schema.optional(Visibility)
})
export type ProjectCreateInput = Schema.Schema.Type<typeof ProjectCreateInput>

export const ProjectRenameInput = Schema.Struct({
  id: ProjectId,
  clientMutationId: Schema.String,
  title: Schema.String.check(Schema.isMinLength(1))
})
export type ProjectRenameInput = Schema.Schema.Type<typeof ProjectRenameInput>

export const TagCreateInput = Schema.Struct({
  id: Schema.optional(TagId),
  clientMutationId: Schema.String,
  name: Schema.String.check(Schema.isMinLength(1)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  visibility: Schema.optional(Visibility)
})
export type TagCreateInput = Schema.Schema.Type<typeof TagCreateInput>

export const TagRenameInput = Schema.Struct({
  id: TagId,
  clientMutationId: Schema.String,
  name: Schema.String.check(Schema.isMinLength(1))
})
export type TagRenameInput = Schema.Schema.Type<typeof TagRenameInput>
