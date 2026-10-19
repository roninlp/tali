import { Temporal } from "temporal-polyfill/full"
import type { Digits, WeekStart } from "./common.js"
import { DEFAULT_DIGITS, localizeDigits } from "./digits.js"

/**
 * Jalali (Persian / Solar Hijri) date engine — the single date-math location
 * shared by the web and API packages (CC-04, per `docs/research/temporal-jalali.md`).
 *
 * Temporal stores every date as an ISO date and projects it through the
 * `persian` Intl calendar, so conversion, leap years and month lengths are
 * ICU-correct. We deliberately do **not** reimplement Jalali arithmetic and we
 * do not depend on jalaali-js. `temporal-polyfill/full` is a standard-API
 * polyfill (not a date library): it keeps behaviour identical on Node < 26,
 * workerd and browsers without native Temporal, and defers to the native
 * implementation when one exists.
 *
 * Persistence stays locale-agnostic: an instant is an ISO timestamp in UTC, an
 * all-day date is a `PlainDate` plus its IANA timezone. Nothing here stores a
 * Jalali year/month/day as the source of truth.
 */

export const JALALI_CALENDAR = "persian"

/** The household's default zone; a user profile can override it. */
export const DEFAULT_TIME_ZONE = "Asia/Tehran"

export const JALALI_MONTHS = [
  "فروردین",
  "اردیبهشت",
  "خرداد",
  "تیر",
  "مرداد",
  "شهریور",
  "مهر",
  "آبان",
  "آذر",
  "دی",
  "بهمن",
  "اسفند"
] as const

/** Indexed by ISO weekday − 1 (Monday … Sunday). */
export const JALALI_WEEKDAYS = [
  "دوشنبه",
  "سه‌شنبه",
  "چهارشنبه",
  "پنج‌شنبه",
  "جمعه",
  "شنبه",
  "یکشنبه"
] as const

/** Monday-indexed start of a configured week. */
const WEEK_START_INDEX: Record<WeekStart, number> = {
  saturday: 5,
  sunday: 6,
  monday: 0
}

export interface JalaliFields {
  readonly year: number
  readonly month: number
  readonly day: number
}

export type JalaliDateInput = Temporal.PlainDate | string

const withJalaliCalendar = (date: Temporal.PlainDate): Temporal.PlainDate =>
  date.calendarId === JALALI_CALENDAR ? date : date.withCalendar(JALALI_CALENDAR)

/** The ISO weekday (Monday = 1 … Sunday = 7) of a calendar date. */
const isoDayOfWeek = (date: Temporal.PlainDate): number =>
  date.withCalendar("iso8601").dayOfWeek

/** Build a Jalali date from calendar fields (overflow defaults to `constrain`). */
export const jalaliDate = (
  year: number,
  month: number,
  day: number
): Temporal.PlainDate =>
  Temporal.PlainDate.from({ year, month, day, calendar: JALALI_CALENDAR })

/**
 * Convert an ISO date (`YYYY-MM-DD` or a `PlainDate`) to the Jalali calendar.
 * Plain dates keep their wall date; no timezone shift is applied.
 */
export const toJalaliDate = (input: JalaliDateInput): Temporal.PlainDate =>
  withJalaliCalendar(
    typeof input === "string" ? Temporal.PlainDate.from(input) : input
  )

/** Convert a Jalali date (or any calendar date) to its ISO `YYYY-MM-DD` wall date. */
export const toIsoDate = (date: Temporal.PlainDate): string =>
  date.withCalendar("iso8601").toString()

/**
 * Convert an instant (`Date`) to the Jalali wall date in an IANA timezone.
 * Use this for "which day is it for the user" questions, never UTC slicing.
 */
export const toJalaliDateInZone = (
  instant: Date | Temporal.Instant,
  timeZone: string = DEFAULT_TIME_ZONE
): Temporal.PlainDate => {
  const temporalInstant =
    instant instanceof Date
      ? Temporal.Instant.fromEpochMilliseconds(instant.getTime())
      : instant
  return temporalInstant
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .withCalendar(JALALI_CALENDAR)
}

/** Today's Jalali date in an IANA timezone (inject the instant for tests). */
export const todayInTimeZone = (
  timeZone: string = DEFAULT_TIME_ZONE,
  now: Temporal.Instant = Temporal.Now.instant()
): Temporal.PlainDate => toJalaliDateInZone(now, timeZone)

/** The Jalali year/month/day fields of a date. */
export const toJalaliFields = (date: Temporal.PlainDate): JalaliFields => {
  const jalali = withJalaliCalendar(date)
  return { year: jalali.year, month: jalali.month, day: jalali.day }
}

export const isJalaliLeapYear = (year: number): boolean =>
  jalaliDate(year, 12, 1).inLeapYear

export const daysInJalaliMonth = (year: number, month: number): number =>
  jalaliDate(year, month, 1).daysInMonth

export const daysInJalaliYear = (year: number): number =>
  jalaliDate(year, 1, 1).daysInYear

export const startOfJalaliMonth = (date: Temporal.PlainDate): Temporal.PlainDate =>
  withJalaliCalendar(date).with({ day: 1 })

export const endOfJalaliMonth = (date: Temporal.PlainDate): Temporal.PlainDate => {
  const start = startOfJalaliMonth(date)
  return start.with({ day: start.daysInMonth })
}

export const startOfJalaliYear = (date: Temporal.PlainDate): Temporal.PlainDate =>
  withJalaliCalendar(date).with({ month: 1, day: 1 })

export const endOfJalaliYear = (date: Temporal.PlainDate): Temporal.PlainDate => {
  const start = startOfJalaliYear(date)
  return start.with({ month: 12, day: start.with({ month: 12 }).daysInMonth })
}

export interface AddJalaliOptions {
  /** `constrain` (default) clamps Esfand 30 → Esfand 29 in a common year. */
  readonly overflow?: "constrain" | "reject"
}

export const addJalaliDays = (
  date: Temporal.PlainDate,
  days: number
): Temporal.PlainDate => withJalaliCalendar(date).add({ days })

export const addJalaliMonths = (
  date: Temporal.PlainDate,
  months: number,
  options: AddJalaliOptions = {}
): Temporal.PlainDate =>
  withJalaliCalendar(date).add(
    { months },
    { overflow: options.overflow ?? "constrain" }
  )

export const addJalaliYears = (
  date: Temporal.PlainDate,
  years: number,
  options: AddJalaliOptions = {}
): Temporal.PlainDate =>
  withJalaliCalendar(date).add(
    { years },
    { overflow: options.overflow ?? "constrain" }
  )

export const compareJalali = (
  one: Temporal.PlainDate,
  two: Temporal.PlainDate
): number => Temporal.PlainDate.compare(one, two)

export const isSameJalaliMonth = (
  one: Temporal.PlainDate,
  two: Temporal.PlainDate
): boolean => {
  const a = withJalaliCalendar(one)
  const b = withJalaliCalendar(two)
  return a.year === b.year && a.month === b.month
}

/** Offset from `date` back to the start of its configured week. */
const weekStartOffset = (date: Temporal.PlainDate, weekStart: WeekStart): number =>
  (isoDayOfWeek(date) - 1 - WEEK_START_INDEX[weekStart] + 7) % 7

export const startOfJalaliWeek = (
  date: Temporal.PlainDate,
  weekStart: WeekStart = "saturday"
): Temporal.PlainDate =>
  withJalaliCalendar(date).subtract({
    days: weekStartOffset(date, weekStart)
  })

/** The seven days of the week containing `date`, starting on `weekStart`. */
export const jalaliWeek = (
  date: Temporal.PlainDate,
  weekStart: WeekStart = "saturday"
): ReadonlyArray<Temporal.PlainDate> => {
  const start = startOfJalaliWeek(date, weekStart)
  return Array.from({ length: 7 }, (_, index) => start.add({ days: index }))
}

export interface JalaliCalendarDay {
  readonly date: Temporal.PlainDate
  /** False for the leading/trailing days borrowed from adjacent months. */
  readonly inMonth: boolean
}

export interface JalaliCalendarWeek {
  readonly days: ReadonlyArray<JalaliCalendarDay>
}

export interface JalaliMonthGrid {
  readonly year: number
  readonly month: number
  /** First cell (may belong to the previous month). */
  readonly start: Temporal.PlainDate
  /** Last cell (may belong to the next month). */
  readonly end: Temporal.PlainDate
  /** Whole weeks only; 5–6 rows depending on the month. */
  readonly weeks: ReadonlyArray<JalaliCalendarWeek>
}

export interface JalaliMonthGridOptions {
  /** Persian weeks start on Saturday by default (also the domain default). */
  readonly weekStart?: WeekStart
}

/**
 * A calendar-grid helper for a Jalali month: full weeks, with adjacent-month
 * cells marked `inMonth: false` so a picker can grey them out without losing
 * the weekday alignment.
 */
export const jalaliMonthGrid = (
  year: number,
  month: number,
  options: JalaliMonthGridOptions = {}
): JalaliMonthGrid => {
  const weekStart = options.weekStart ?? "saturday"
  const first = jalaliDate(year, month, 1)
  const leading = weekStartOffset(first, weekStart)
  const cellCount = Math.ceil((leading + first.daysInMonth) / 7) * 7
  const start = first.subtract({ days: leading })

  const weeks: JalaliCalendarWeek[] = []
  for (let row = 0; row < cellCount; row += 7) {
    const days: JalaliCalendarDay[] = []
    for (let column = 0; column < 7; column += 1) {
      const date = start.add({ days: row + column })
      days.push({
        date,
        inMonth: date.year === year && date.month === month
      })
    }
    weeks.push({ days })
  }

  return {
    year,
    month,
    start,
    end: start.add({ days: cellCount - 1 }),
    weeks
  }
}

export type JalaliDateFormat = "long" | "medium" | "short" | "numeric"

export interface FormatJalaliDateOptions {
  /** Persian digits by default; `latin` is the opt-out. */
  readonly digits?: Digits
  /** `long` includes the weekday (default). */
  readonly style?: JalaliDateFormat
}

const pad2 = (value: number): string => String(value).padStart(2, "0")

/** Format a Jalali date for display, localized to Persian copy and digits. */
export const formatJalaliDate = (
  date: Temporal.PlainDate,
  options: FormatJalaliDateOptions = {}
): string => {
  const digits = options.digits ?? DEFAULT_DIGITS
  const style = options.style ?? "long"
  const jalali = withJalaliCalendar(date)
  const year = localizeDigits(jalali.year, digits)
  const day = localizeDigits(jalali.day, digits)
  const monthName = JALALI_MONTHS[jalali.month - 1] ?? ""

  switch (style) {
    case "numeric":
      return `${year}/${localizeDigits(pad2(jalali.month), digits)}/${localizeDigits(pad2(jalali.day), digits)}`
    case "short":
      return `${day} ${monthName}`
    case "medium":
      return `${day} ${monthName} ${year}`
    case "long":
    default:
      return `${JALALI_WEEKDAYS[isoDayOfWeek(jalali) - 1]} ${day} ${monthName} ${year}`
  }
}

export const formatJalaliMonth = (
  year: number,
  month: number,
  digits: Digits = DEFAULT_DIGITS
): string =>
  `${JALALI_MONTHS[month - 1] ?? localizeDigits(month, digits)} ${localizeDigits(year, digits)}`
