import { Schema } from "effect"
import { Model } from "effect/schema"
import { Visibility } from "../common.js"
import {
  RecurrenceRule,
  TaskRecurrenceMode
} from "../recurrence.js"
import {
  commonItemFields,
  LocalDate,
  Priority,
  ProjectId,
  TagIds,
  TaskId,
  TaskStatus,
  TimeZone,
  TimestampUtc
} from "./common.js"

/**
 * `Task` aggregate (FR-TASK-01/02, docs/domain-model-draft.md §3.5).
 *
 * A task can be created with a title alone; every other field is nullable or
 * has a benign default, so the quick-add path never needs a second round-trip.
 * `status` is the per-entity common-item status: the server stamps
 * `startedAt` when a task enters `doing` and `completedAt` when it reaches
 * `done` (the timestamps are part of the row, not client input).
 *
 * Recurrence is a structured rule (never an RRULE string) stored as JSON:
 * `recurrenceMode` chooses whether the series advances on the fixed due-date
 * schedule (`onDueDate`) or restarts when the work is completed
 * (`onCompletion`). Both are null together, or set together. The server — never
 * a client — generates the next instance on completion (#38); the completed
 * row stays as `done` history.
 */
export class Task extends Model.Class<Task>("Task")({
  ...commonItemFields("task", TaskId),
  title: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.NullOr(Schema.String),
  status: TaskStatus,
  priority: Priority,
  /** Timed due instant (UTC). Mutually exclusive with `dueDate` in the UI. */
  dueAt: Schema.NullOr(TimestampUtc),
  /**
   * All-day due date (`YYYY-MM-DD`) in `timeZone`; denormalized so the server
   * can bucket overdue/today/tomorrow/week without re-deriving the local date.
   */
  dueDate: Schema.NullOr(LocalDate),
  timeZone: TimeZone,
  projectId: Schema.NullOr(ProjectId),
  /** Denormalized tag ids; `item_tags` remains the source of truth. */
  tagIds: TagIds,
  /** Structured recurrence rule; `null` for a one-off task. */
  recurrence: Schema.NullOr(RecurrenceRule),
  /** Only meaningful with `recurrence`; both are cleared together. */
  recurrenceMode: Schema.NullOr(TaskRecurrenceMode),
  /** Server timestamp for the `todo → doing` transition. */
  startedAt: Schema.NullOr(TimestampUtc),
  /** Server timestamp for the `→ done` transition. */
  completedAt: Schema.NullOr(TimestampUtc)
}) {}

/**
 * Title-only create input (FR-TASK-01: "Task can be created with title only").
 * The server fills id, timestamps, version, status defaults and ownership.
 * Omitted fields are simply not patched on insert.
 */
export const TaskCreate = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(TaskStatus),
  priority: Schema.optional(Priority),
  dueAt: Schema.optional(Schema.NullOr(TimestampUtc)),
  dueDate: Schema.optional(Schema.NullOr(LocalDate)),
  timeZone: Schema.optional(TimeZone),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  tagIds: Schema.optional(TagIds),
  recurrence: Schema.optional(Schema.NullOr(RecurrenceRule)),
  /** Defaults to `onDueDate` when a rule is supplied without a mode. */
  recurrenceMode: Schema.optional(Schema.NullOr(TaskRecurrenceMode)),
  visibility: Schema.optional(Visibility)
})
export type TaskCreate = Schema.Schema.Type<typeof TaskCreate>
