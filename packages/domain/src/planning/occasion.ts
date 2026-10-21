import { Schema } from "effect"
import { Model } from "effect/schema"
import { commonItemFields, LocalDate, OccasionId, TaskId, TimeZone } from "./common.js"

/**
 * `Occasion` aggregate (ticket #59; FR-CAL-02).
 *
 * An occasion is a personal date that comes back every year without being
 * re-entered: a birthday, an anniversary, a memorial. It is deliberately not an
 * event — an event happens at an instant and may span days; an occasion is a
 * *calendar date* with no time of day and no stored occurrences.
 *
 * ## The origin date is the only stored date
 *
 * `originDate` is a local `YYYY-MM-DD` plus the occasion's own IANA zone,
 * exactly like an all-day event's date. Nothing else about the schedule is
 * persisted: the annual occurrence is derived by projecting the **Jalali**
 * month/day of the origin into each requested Jalali year
 * (`occasion-projection.ts`). That is what makes "the 12th of Farvardin" stay
 * the 12th of Farvardin while the Gregorian date drifts from year to year.
 *
 * ## The yearly marker
 *
 * `yearly` defaults to `true` (the birthday/anniversary case). Setting it to
 * `false` keeps a one-off important date (a wedding day being planned, a
 * memorial that does not repeat) on its origin date only. It is a marker on
 * the same aggregate rather than a second aggregate and rather than a
 * `RecurrenceRule`: an occasion has no interval, no count and no end.
 *
 * ## The advance reminder is an offset, not a stored series
 *
 * `advanceReminderDays` is the offset the #13 policy expands by date
 * ("remind me 7 days before"). It is never materialised per year: the
 * projection computes `occurrence - advanceReminderDays` for the occurrence
 * being read. The reminder aggregate itself is ticket #60; this slice exposes
 * a typed seam (`OccasionAdvanceReminder`) instead of taking a reminder table.
 *
 * ## The preparation task
 *
 * `preparationTaskId` is the optional link to the "prepare gift" task created
 * from an occasion in one tap. It is a normal task row (owned by the task
 * aggregate, so it syncs and completes like any other task); the occasion
 * only remembers which task it prepared for this year. The link is
 * deliberately nullable and unenforced: an offline client may create the task
 * before the server sees the occasion, and a deleted task leaves a harmless
 * stale id that the next preparation replaces.
 */
export class Occasion extends Model.Class<Occasion>("Occasion")({
  ...commonItemFields("occasion", OccasionId),
  /**
   * The occasion's name ("تولد مامان"). The model checks the shape only; the
   * service enforces a non-empty title, because a delete-only sync push
   * inserts a tombstone whose title is empty by construction.
   */
  title: Schema.String,
  /** The first/original local date (`YYYY-MM-DD`) of the occasion. */
  originDate: LocalDate,
  /** The zone the origin date and the advance-reminder fire are read in. */
  timeZone: TimeZone,
  /** `true` = a birthday/anniversary that repeats every Jalali year. */
  yearly: Schema.Boolean,
  /** Days before the occurrence to remind; `null` = no advance reminder. */
  advanceReminderDays: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 365 }))
  ),
  /** The optional "prepare gift" task created from this occasion. */
  preparationTaskId: Schema.NullOr(TaskId)
}) {}
