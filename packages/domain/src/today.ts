import { Schema } from "effect"
import { DashboardSectionOrder } from "./preferences.js"
import { LocalDate, TimeZone } from "./planning/common.js"
import { Note } from "./planning/note.js"
import { Task } from "./planning/task.js"

/**
 * The `GET /today` aggregated read model (ticket #42; FR-VIEW-01).
 *
 * The dashboard asks one question — "what does today look like?" — and the
 * server answers it in one deterministic payload so the client never fans out
 * to four list endpoints just to paint the home screen. Event, reminder and
 * habit sections are part of the shape from day one (`counts`/`empty`) but
 * stay quiet zeros until their Slices land: this contract deliberately does
 * **not** invent those aggregates early.
 *
 * `tasks` is the daily picture, not the whole task list: the viewer's overdue
 * tasks followed by the tasks due today, in the same bucket order as
 * `GetTaskBuckets` (#36). No-date and future tasks are excluded, matching
 * FR-TASK-05 ("no-date tasks excluded from Today").
 *
 * The payload is stable for a given day + data set: it carries no
 * `generatedAt`, so the HTTP edge can hash the encoded body into an ETag and a
 * repeated request with `If-None-Match` is a real 304.
 */

export const TodayCounts = Schema.Struct({
  /** Overdue + due today. */
  tasks: Schema.Int,
  /** The subset of `tasks` that is already past its day. */
  overdue: Schema.Int,
  events: Schema.Int,
  reminders: Schema.Int,
  habits: Schema.Int,
  notes: Schema.Int
})
export type TodayCounts = Schema.Schema.Type<typeof TodayCounts>

/** One flag per dashboard section; the renderer shows the matching empty copy. */
export const TodayEmpty = Schema.Struct({
  tasks: Schema.Boolean,
  events: Schema.Boolean,
  reminders: Schema.Boolean,
  habits: Schema.Boolean,
  notes: Schema.Boolean
})
export type TodayEmpty = Schema.Schema.Type<typeof TodayEmpty>

export const TodayReadModel = Schema.Struct({
  /** The viewer's wall date (`YYYY-MM-DD`) in `timeZone`. */
  today: LocalDate,
  tomorrow: LocalDate,
  timeZone: TimeZone,
  /** The preference order the server computed this payload with. */
  sectionOrder: DashboardSectionOrder,
  /** Overdue first, then due today; live tasks only. */
  tasks: Schema.Array(Task),
  /** Pinned, live, non-archived notes visible to the viewer. */
  notes: Schema.Array(Note),
  counts: TodayCounts,
  empty: TodayEmpty
})
export type TodayReadModel = Schema.Schema.Type<typeof TodayReadModel>
