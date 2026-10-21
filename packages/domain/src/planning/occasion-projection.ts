import { Schema } from "effect"
import { Temporal } from "temporal-polyfill/full"
import {
  daysInJalaliMonth,
  jalaliDate,
  toIsoDate,
  toJalaliDate,
  toJalaliFields
} from "../jalali.js"
import { LocalDate, OccasionId, TimestampUtc } from "./common.js"
import { ReminderLink } from "./reminder-link.js"

/**
 * Annual projection and advance-reminder calculation for occasions
 * (ticket #59; FR-CAL-02).
 *
 * ## One origin date, projected every Jalali year
 *
 * An occasion stores only its **origin** local date. The annual occurrence is
 * derived by taking the origin's Jalali month/day and rebuilding that calendar
 * date in each requested Jalali year:
 *
 *   origin 1990-04-01 → Jalali 1369-01-12 → every year on 12 Farvardin
 *
 * The Gregorian date therefore moves each year, which is the point: a birthday
 * is "12 Farvardin", not "1 April". Both calendars are returned with every
 * occurrence so the UI can show them side by side without a second conversion.
 *
 * ## Esfand 30 clamps, it does not disappear
 *
 * The shared recurrence engine (#38) deliberately *skips* impossible dates, so
 * a yearly rule never silently becomes "the 29th". An occasion is different: a
 * person born on Esfand 30 has a birthday every year. The projection therefore
 * **clamps** Esfand 30 to Esfand 29 in a common Jalali year (Temporal's
 * `constrain` behaviour) and says so here, so the two yearly semantics never
 * get confused.
 *
 * ## The advance reminder is offset-based
 *
 * `advanceReminderDays` expands to `occurrenceDate − N days` for the occurrence
 * being read; nothing is stored per year. The fire instant is a local morning
 * (09:00) on that due date in the occasion's own zone — `dueDate` is the
 * contract, `fireAt` is the default instant #60 can materialise as a reminder.
 * Ticket #60 owns the `Reminder` row; this module deliberately returns a typed
 * draft (`OccasionAdvanceReminder`) instead of writing a reminder table.
 */

// ── Shapes ───────────────────────────────────────────────────────────────

/** One calendar date in both calendars, for display. */
export const OccasionCalendarDate = Schema.Struct({
  year: Schema.Int,
  month: Schema.Int,
  day: Schema.Int
})
export type OccasionCalendarDate = Schema.Schema.Type<typeof OccasionCalendarDate>

/**
 * One projected occurrence of an occasion.
 *
 * `projected` is always `true`: an occasion never stores occurrence rows, so
 * every occurrence the read model paints is derived from the origin. `date` is
 * the local ISO (Gregorian) wall date; `jalali` is the same day in the Persian
 * calendar.
 */
export const OccasionOccurrence = Schema.Struct({
  /** Unique inside a day: `<occasionId>@<date>`. */
  key: Schema.String,
  id: OccasionId,
  title: Schema.String,
  color: Schema.NullOr(Schema.String),
  /** The projected local date (`YYYY-MM-DD`, Gregorian wall date). */
  date: LocalDate,
  /** The same day in the Jalali calendar. */
  jalali: OccasionCalendarDate,
  /** The same day in the Gregorian calendar. */
  gregorian: OccasionCalendarDate,
  /** The occasion's stored origin date. */
  originDate: LocalDate,
  /** True for a birthday/anniversary; false for a one-off important date. */
  yearly: Schema.Boolean,
  projected: Schema.Boolean,
  /** `occurrenceDate − advanceReminderDays`; `null` when no reminder is set. */
  advanceReminderDate: Schema.NullOr(LocalDate),
  /** The default fire instant on the advance-reminder date. */
  advanceReminderAt: Schema.NullOr(TimestampUtc)
})
export type OccasionOccurrence = Schema.Schema.Type<typeof OccasionOccurrence>

/**
 * A reminder the reminder slice (#60) can materialise for one occurrence.
 *
 * `reminderKey` is stable for `(occasion, occurrence date)` so a re-expansion
 * of the same year produces the same key, which is what lets #60 dedupe a
 * yearly reminder without storing a per-year rule. No reminder row is written
 * here — this is the documented seam.
 */
export const OccasionAdvanceReminder = Schema.Struct({
  occasionId: OccasionId,
  reminderKey: Schema.String,
  title: Schema.String,
  occurrenceDate: LocalDate,
  dueDate: LocalDate,
  fireAt: TimestampUtc,
  advanceDays: Schema.Int,
  link: ReminderLink
})
export type OccasionAdvanceReminder = Schema.Schema.Type<typeof OccasionAdvanceReminder>

/** A date window: `from` and `to` are both inclusive local dates. */
export interface OccasionRange {
  readonly from: LocalDate
  readonly to: LocalDate
}

/**
 * The fields both a server `Occasion` and a mirrored row can provide. Keeping
 * the builder structural is what lets the offline client project the IndexedDB
 * mirror with the same code the API uses.
 */
export interface OccasionSource {
  readonly id: string
  readonly title: string
  readonly color: string | null
  readonly originDate: string
  readonly timeZone: string
  readonly yearly: boolean
  readonly advanceReminderDays: number | null
}

// ── Calendar helpers ─────────────────────────────────────────────────────

/** The local hour an advance reminder fires at by default (09:00). */
export const OCCASION_REMINDER_HOUR = 9

/** The default title of the one-tap preparation task. */
export const occasionPreparationTaskTitle = (occasionTitle: string): string =>
  `آماده‌سازی برای ${occasionTitle}`

const plainDate = (date: string): Temporal.PlainDate => Temporal.PlainDate.from(date)

/** A local date the calendar can actually read (`2026-02-30` cannot). */
const isReadableDate = (date: string): boolean => {
  try {
    plainDate(date)
    return true
  } catch {
    return false
  }
}

const jalaliYearOf = (date: string): number => toJalaliDate(date).year

/** The Jalali month/day an occasion repeats on. */
export const occasionMonthDay = (
  occasion: Pick<OccasionSource, "originDate">
): { readonly month: number; readonly day: number } => {
  const jalali = toJalaliFields(toJalaliDate(occasion.originDate))
  return { month: jalali.month, day: jalali.day }
}

/**
 * The occurrence of `occasion` in one Jalali year, as a local ISO date.
 *
 * `null` when the year is before the origin (an occasion never projects
 * backwards) or when `yearly` is false and the year is not the origin's.
 */
export const occasionDateInJalaliYear = (
  occasion: OccasionSource,
  year: number
): LocalDate | null => {
  if (!isReadableDate(occasion.originDate)) return null
  const originJalali = toJalaliDate(occasion.originDate)
  if (year < originJalali.year) return null
  if (!occasion.yearly && year !== originJalali.year) return null

  const { month, day } = occasionMonthDay(occasion)
  // Clamp Esfand 30 → Esfand 29 in a common year (documented above).
  const clampedDay = Math.min(day, daysInJalaliMonth(year, month))
  return toIsoDate(jalaliDate(year, month, clampedDay)) as LocalDate
}

/** The default fire instant for a reminder due on `dueDate`. */
export const occasionReminderInstant = (dueDate: string, timeZone: string): TimestampUtc => {
  const date = plainDate(dueDate)
  return Temporal.ZonedDateTime.from({
    timeZone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour: OCCASION_REMINDER_HOUR,
    minute: 0,
    second: 0,
    millisecond: 0,
    microsecond: 0,
    nanosecond: 0
  })
    .toInstant()
    .toString() as TimestampUtc
}

/** The offset-based advance-reminder date of one occurrence. */
export const occasionAdvanceReminderDate = (
  occasion: Pick<OccasionSource, "advanceReminderDays">,
  occurrenceDate: string
): LocalDate | null =>
  occasion.advanceReminderDays === null
    ? null
    : (plainDate(occurrenceDate).subtract({
      days: occasion.advanceReminderDays
    }).toString() as LocalDate)

/**
 * The reminder draft for one occurrence, or `null` when the occasion has no
 * advance reminder. This is the typed seam the reminder slice consumes.
 */
export const occasionAdvanceReminder = (
  occasion: OccasionSource,
  occurrenceDate: string
): OccasionAdvanceReminder | null => {
  const dueDate = occasionAdvanceReminderDate(occasion, occurrenceDate)
  if (dueDate === null) return null
  return {
    occasionId: occasion.id as OccasionId,
    reminderKey: `${occasion.id}:${occurrenceDate}`,
    title: occasion.title,
    occurrenceDate: occurrenceDate as LocalDate,
    dueDate,
    fireAt: occasionReminderInstant(dueDate, occasion.timeZone),
    advanceDays: occasion.advanceReminderDays ?? 0,
    link: { _tag: "occasion", occasionId: occasion.id as OccasionId }
  } as OccasionAdvanceReminder
}

// ── Projection ───────────────────────────────────────────────────────────

const occurrenceOf = (
  occasion: OccasionSource,
  date: LocalDate
): OccasionOccurrence => {
  const jalali = toJalaliFields(toJalaliDate(date))
  const gregorian = plainDate(date).withCalendar("iso8601")
  const reminderDate = occasionAdvanceReminderDate(occasion, date)
  return {
    key: `${occasion.id}@${date}`,
    id: occasion.id as OccasionId,
    title: occasion.title,
    color: occasion.color,
    date,
    jalali: { year: jalali.year, month: jalali.month, day: jalali.day },
    gregorian: {
      year: gregorian.year,
      month: gregorian.month,
      day: gregorian.day
    },
    originDate: occasion.originDate as LocalDate,
    yearly: occasion.yearly,
    projected: true,
    advanceReminderDate: reminderDate,
    advanceReminderAt:
      reminderDate === null
        ? null
        : occasionReminderInstant(reminderDate, occasion.timeZone)
  } as OccasionOccurrence
}

/**
 * Project every occasion onto `[from, to]` (both inclusive).
 *
 * Duplicated rows (a mirror plus an overlay) are deduped by id. An unreadable
 * source date is skipped rather than throwing: the read model must not fail a
 * whole month because one mirrored row is malformed.
 */
export const occasionOccurrences = (input: {
  readonly occasions: ReadonlyArray<OccasionSource>
  readonly range: OccasionRange
}): ReadonlyArray<OccasionOccurrence> => {
  const { from, to } = input.range
  if (!isReadableDate(from) || !isReadableDate(to) || to < from) return []

  const firstYear = jalaliYearOf(from)
  const lastYear = jalaliYearOf(to)
  const occurrences: Array<OccasionOccurrence> = []
  const seen = new Set<string>()
  const byId = new Map<string, OccasionSource>()
  for (const occasion of input.occasions) byId.set(occasion.id, occasion)

  for (const occasion of byId.values()) {
    if (!isReadableDate(occasion.originDate)) continue
    for (let year = firstYear; year <= lastYear; year += 1) {
      const date = occasionDateInJalaliYear(occasion, year)
      if (date === null || date < from || date > to) continue
      const key = `${occasion.id}@${date}`
      if (seen.has(key)) continue
      seen.add(key)
      occurrences.push(occurrenceOf(occasion, date))
    }
  }

  return occurrences.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.title.localeCompare(b.title, "fa") ||
      a.key.localeCompare(b.key)
  )
}

/**
 * The first occurrence on or after `from` (or `null` when a one-off occasion
 * has already passed). A yearly occasion always has one within the next
 * ~366 days, so a bounded projection is enough.
 */
export const nextOccasionOccurrence = (
  occasion: OccasionSource,
  from: string
): OccasionOccurrence | null => {
  if (!isReadableDate(from)) return null
  const to = plainDate(from).add({ days: 400 }).toString() as LocalDate
  const window = occasionOccurrences({
    occasions: [occasion],
    range: { from: from as LocalDate, to }
  })
  return window[0] ?? null
}

/** True when `date` is an occurrence of this occasion. */
export const isOccasionOccurrence = (occasion: OccasionSource, date: string): boolean =>
  isReadableDate(date) &&
  occasionOccurrences({
    occasions: [occasion],
    range: { from: date as LocalDate, to: date as LocalDate }
  }).length > 0

/**
 * Advance reminders whose **due date** falls inside `[from, to]`.
 *
 * Occurrences are projected far enough past `to` to cover the offset (an
 * occurrence up to a year after the window can owe a reminder inside it).
 * Sorted by fire instant, then by the stable reminder key.
 */
export const occasionAdvanceReminders = (input: {
  readonly occasions: ReadonlyArray<OccasionSource>
  readonly range: OccasionRange
}): ReadonlyArray<OccasionAdvanceReminder> => {
  const { from, to } = input.range
  if (!isReadableDate(from) || !isReadableDate(to) || to < from) return []

  const reminders: Array<OccasionAdvanceReminder> = []
  const seen = new Set<string>()
  const byId = new Map<string, OccasionSource>()
  for (const occasion of input.occasions) byId.set(occasion.id, occasion)

  for (const occasion of byId.values()) {
    const advance = occasion.advanceReminderDays
    if (advance === null || !isReadableDate(occasion.originDate)) continue
    const occurrenceTo = plainDate(to).add({ days: advance }).toString() as LocalDate
    const occurrences = occasionOccurrences({
      occasions: [occasion],
      range: { from: from as LocalDate, to: occurrenceTo }
    })
    for (const occurrence of occurrences) {
      const reminder = occasionAdvanceReminder(occasion, occurrence.date)
      if (reminder === null) continue
      if (reminder.dueDate < from || reminder.dueDate > to) continue
      if (seen.has(reminder.reminderKey)) continue
      seen.add(reminder.reminderKey)
      reminders.push(reminder)
    }
  }

  return reminders.sort(
    (a, b) => a.fireAt.localeCompare(b.fireAt) || a.reminderKey.localeCompare(b.reminderKey)
  )
}
