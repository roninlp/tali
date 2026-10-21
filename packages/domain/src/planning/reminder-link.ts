import { Schema } from "effect"
import { EventId, HabitId, TaskId } from "./common.js"

/**
 * The discriminated link a reminder hangs off (docs/domain-model-draft.md
 * §3.6; settled in #7 as "discriminated union, not nullable FKs").
 *
 * ## Why a union and not nullable foreign keys
 *
 * Nullable FKs (`habitId?`, `taskId?`, `eventId?`) allow the invalid state
 * "linked to two things at once", and every reader has to decide what a row
 * with two ids means. The union makes the link exactly one of: nothing, a
 * habit, a task or an event — so "the reminder fires → mark the linked thing
 * done" (FR-REM-03) is a pattern match, not a pile of null checks.
 *
 * ## Why it lives here
 *
 * The union is defined by the **event** slice (ticket #57) because the event
 * is the first aggregate that needs it: the `event` variant carries the
 * `EventId` brand. The reminder aggregate (#60) consumes the union as-is, so
 * the reminder slice needs no migration and no redefinition.
 */
export const ReminderLink = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("none") }),
  Schema.Struct({ _tag: Schema.Literal("habit"), habitId: HabitId }),
  Schema.Struct({ _tag: Schema.Literal("task"), taskId: TaskId }),
  Schema.Struct({ _tag: Schema.Literal("event"), eventId: EventId })
])
export type ReminderLink = Schema.Schema.Type<typeof ReminderLink>
