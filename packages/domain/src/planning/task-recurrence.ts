import { Temporal } from "temporal-polyfill/full"
import {
  nextOccurrence,
  type RecurrenceRule,
  type TaskRecurrenceMode
} from "../recurrence.js"
import type { LocalDate } from "./common.js"

/**
 * Task recurrence computation (FR-TASK-04, ticket #38).
 *
 * The shared engine (`recurrence.ts`) is calendar-only; this module turns its
 * next occurrence into the next task's due fields. It is pure and shared, so
 * the API service and any read-only client projection derive the same date.
 *
 * ## Modes
 *
 * - `onDueDate`: the series keeps its schedule. The next due date is the first
 *   occurrence strictly after the completed instance's due date.
 * - `onCompletion`: the series restarts from when the work actually happened.
 *   The rule grid is anchored on `max(today, current due date)` in the item's
 *   time zone, so "every 3 days" completed today is due three days later, and
 *   completing early never drags the next turn backwards.
 *
 * ## All-day vs timed
 *
 * - All-day tasks keep a `YYYY-MM-DD` due date and no instant.
 * - Timed tasks keep the same **local wall-clock time** in the item's zone and
 *   the new local date, then convert back to a UTC instant. Across a DST
 *   transition the instant shifts by an hour while the wall time stays put.
 *   A nonexistent local time (spring-forward gap) moves forward by the gap
 *   (`compatible` disambiguation), matching how a clock behaves.
 *
 * ## Bounded rules
 *
 * `onDueDate` keeps one anchor (the instance's due date), so `count` and
 * `until` eventually end the series. `onCompletion` deliberately re-anchors on
 * each completion, which means `count` is evaluated afresh per instance and
 * cannot be used to cap the whole series; use `until` for a hard end date on a
 * completion-based rule.
 *
 * The completed instance is not mutated beyond its done status: it stays as
 * history, with its original due date and rule, and the next instance is a new
 * task row.
 */

export interface NextRecurrenceDueInput {
  readonly rule: RecurrenceRule
  readonly mode: TaskRecurrenceMode
  readonly dueDate: string | null
  readonly dueAt: string | null
  readonly timeZone: string
  /** Server completion instant (ISO UTC). */
  readonly completedAt: string
}

export interface NextRecurrenceDue {
  /** Set for all-day tasks; `null` for timed tasks. */
  readonly dueDate: LocalDate | null
  /** Set for timed tasks; `null` for all-day tasks. */
  readonly dueAt: string | null
}

const localDateOf = (instant: string, timeZone: string): Temporal.PlainDate =>
  Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDate()

const later = (
  one: Temporal.PlainDate,
  two: Temporal.PlainDate
): Temporal.PlainDate => (Temporal.PlainDate.compare(one, two) >= 0 ? one : two)

/**
 * The next due fields for a completed recurring task, or `null` when the rule
 * has no further occurrence (a `count`/`until` bound was reached).
 */
export const nextRecurrenceDue = (
  input: NextRecurrenceDueInput
): NextRecurrenceDue | null => {
  const completedLocal = localDateOf(input.completedAt, input.timeZone)
  const dueLocal =
    input.dueDate !== null
      ? Temporal.PlainDate.from(input.dueDate)
      : input.dueAt !== null
      ? localDateOf(input.dueAt, input.timeZone)
      : null
  // `onCompletion` restarts the rule grid on the completion day (never earlier
  // than the current due day, so completing early cannot move work backwards).
  // `onDueDate` keeps the original grid and simply advances one step.
  const anchor =
    input.mode === "onCompletion"
      ? later(completedLocal, dueLocal ?? completedLocal)
      : dueLocal ?? completedLocal

  const next = nextOccurrence(input.rule, anchor, anchor)
  if (next === null) return null

  if (input.dueAt !== null) {
    // Preserve the item's local time of day; `compatible` shifts a
    // nonexistent spring-forward wall time forward instead of throwing.
    const localTime = Temporal.Instant.from(input.dueAt)
      .toZonedDateTimeISO(input.timeZone)
      .toPlainTime()
    const instant = next
      .toPlainDateTime(localTime)
      .toZonedDateTime(input.timeZone, { disambiguation: "compatible" })
      .toInstant()
    return {
      dueDate: null,
      // Canonical `.000Z` shape, so `due_at` TEXT range queries stay ordered.
      dueAt: new Date(instant.epochMilliseconds).toISOString()
    }
  }

  return { dueDate: next.toString() as LocalDate, dueAt: null }
}
