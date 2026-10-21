import { Schema } from "effect"
import { Temporal } from "temporal-polyfill/full"
import { LocalDate } from "./planning/common.js"

/**
 * The hand-rolled recurrence engine shared by tasks (this ticket) and, later,
 * events/occasions (FR-CAL-03, `docs/must-have-feature-map.html` §7).
 *
 * ## Why hand-rolled
 *
 * Temporal gives correct Jalali/ISO date arithmetic, leap detection and IANA
 * time-zone handling, but it deliberately has **no** recurrence type: no
 * `RRULE`, no `COUNT`/`UNTIL`, no exceptions. The standard RRULE grammar is
 * Gregorian-first (non-Gregorian needs RFC 7529 `RSCALE`, which libraries do
 * not implement), so a string RRULE parser would be wrong for Tali's
 * Jalali-first month/year rules. `docs/research/temporal-jalali.md` §5–§7
 * settles the structured rule below. There is no `rrule`/date dependency.
 *
 * ## Rule semantics (the contract)
 *
 * - `frequency` + `interval` select the period: every N days/weeks/months/
 *   years from the anchor date.
 * - **Month and year fields are Jalali.** `byMonthDay` means "the Nth day of
 *   the Jalali month" and yearly rules use the anchor's **Jalali** month.
 *   `byDay` is an ISO weekday (1 = Monday … 7 = Sunday), the calendar-neutral
 *   numbering the domain already uses. Weeks are ISO weeks (Monday start),
 *   fixed rather than the user's display week-start preference: a recurrence
 *   rule must not change meaning when a display preference changes.
 * - `weekly` without `byDay` repeats on the anchor's weekday. `monthly`
 *   without `byMonthDay`/`nthWeekday` repeats on the anchor's day of month.
 *   `daily` has no by-fields; `yearly` uses the anchor's Jalali month with an
 *   optional day-of-month override.
 * - Impossible dates **skip** instead of clamping: a monthly rule on day 31
 *   has no occurrence in a 30-day Jalali month, and Esfand 30 (a Jalali leap
 *   day) has no occurrence in a common year. Nothing is silently moved to the
 *   30th/29th, so "the 31st" never becomes "the last day".
 * - `end` is `never`, `count` (number of rule-generated occurrences,
 *   **before** exceptions — RFC 5545's `COUNT` rule) or `until` (an inclusive
 *   local-date bound).
 * - Occurrence exceptions are removed after generation, so a skipped
 *   occurrence does not shift the schedule and cannot extend a `count`.
 * - Expansion is bounded (`MAX_PERIODS`): a rule that can never match (e.g. a
 *   yearly rule on the 31st of a 30-day Jalali month) returns no occurrences
 *   instead of looping forever.
 *
 * Dates are ISO `PlainDate`s (`YYYY-MM-DD`) in the returned arrays; Jalali is
 * a projection used for rule arithmetic, never a persisted field.
 */

// ── Rule schema (docs/domain-model-draft.md §3.3) ────────────────────────

export const RecurrenceFrequency = Schema.Literals([
  "daily",
  "weekly",
  "monthly",
  "yearly"
])
export type RecurrenceFrequency = Schema.Schema.Type<typeof RecurrenceFrequency>

/** Inclusive end bound: `never`, an occurrence `count`, or an ISO date. */
export const RecurrenceEnd = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("never") }),
  Schema.Struct({
    _tag: Schema.Literal("count"),
    count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
  }),
  Schema.Struct({ _tag: Schema.Literal("until"), date: LocalDate })
])
export type RecurrenceEnd = Schema.Schema.Type<typeof RecurrenceEnd>

const IsoWeekday = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 }))
const MonthDay = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 }))
/** `nth` is 1..5 or -1 for "last". */
const Nth = Schema.Int.check(
  Schema.makeFilter<number>((value) => value === -1 || (value >= 1 && value <= 5))
)

const RecurrenceRuleFields = Schema.Struct({
  frequency: RecurrenceFrequency,
  /** Every N periods; 1 is "every day/week/month/year". */
  interval: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** Weekly (and only weekly): selected ISO weekdays. */
  byDay: Schema.optional(Schema.Array(IsoWeekday)),
  /** Monthly/yearly: selected Jalali day-of-month values. */
  byMonthDay: Schema.optional(Schema.Array(MonthDay)),
  /** Monthly/yearly: "second Tuesday", "last Friday" (-1). */
  nthWeekday: Schema.optional(Schema.Struct({ nth: Nth, day: IsoWeekday })),
  end: RecurrenceEnd
})

type RecurrenceRuleFields = Schema.Schema.Type<typeof RecurrenceRuleFields>

const nonEmpty = <A>(values: ReadonlyArray<A> | undefined): boolean =>
  values !== undefined && values.length > 0

/**
 * Cross-field rule validation: the combinators only make sense for some
 * frequencies, and two alternative day selectors cannot both be set. Keeping
 * this on the schema means a sync push or an RPC payload is validated by the
 * same contract as the service.
 */
const validRuleShape = Schema.makeFilter<RecurrenceRuleFields>((rule) => {
  if (rule.frequency === "daily") {
    if (nonEmpty(rule.byDay) || nonEmpty(rule.byMonthDay) || rule.nthWeekday !== undefined) {
      return "a daily rule does not take byDay, byMonthDay or nthWeekday"
    }
    return true
  }
  if (rule.frequency === "weekly") {
    if (nonEmpty(rule.byMonthDay) || rule.nthWeekday !== undefined) {
      return "a weekly rule does not take byMonthDay or nthWeekday"
    }
    return true
  }
  if (nonEmpty(rule.byDay)) {
    return `${rule.frequency} rules use byMonthDay/nthWeekday, not byDay`
  }
  if (nonEmpty(rule.byMonthDay) && rule.nthWeekday !== undefined) {
    return "a rule takes byMonthDay or nthWeekday, not both"
  }
  if (rule.byMonthDay !== undefined && rule.byMonthDay.length === 0) {
    return "byMonthDay cannot be empty"
  }
  if (rule.byDay !== undefined && rule.byDay.length === 0) {
    return "byDay cannot be empty"
  }
  return true
})

export const RecurrenceRule = RecurrenceRuleFields.check(validRuleShape)
export type RecurrenceRule = Schema.Schema.Type<typeof RecurrenceRule>

/** Task-specific: advance on completion, or keep the fixed schedule. */
export const TaskRecurrenceMode = Schema.Literals(["onCompletion", "onDueDate"])
export type TaskRecurrenceMode = Schema.Schema.Type<typeof TaskRecurrenceMode>

// ── Calendar helpers ─────────────────────────────────────────────────────

const JALALI = "persian"
const ISO = "iso8601"

type DateInput = string | Temporal.PlainDate

const asPlainDate = (input: DateInput): Temporal.PlainDate =>
  typeof input === "string" ? Temporal.PlainDate.from(input) : input

const toIso = (date: Temporal.PlainDate): Temporal.PlainDate => date.withCalendar(ISO)
const toJalali = (date: Temporal.PlainDate): Temporal.PlainDate => date.withCalendar(JALALI)

/** ISO weekday 1..7 (Monday..Sunday), independent of the attached calendar. */
export const isoWeekday = (date: Temporal.PlainDate): number => toIso(date).dayOfWeek

const isoWeekStart = (date: Temporal.PlainDate): Temporal.PlainDate =>
  toIso(date).subtract({ days: toIso(date).dayOfWeek - 1 })

const sortedUnique = (values: ReadonlyArray<number>): ReadonlyArray<number> =>
  [...new Set(values)].sort((a, b) => a - b)

// ── Period generators ────────────────────────────────────────────────────
//
// Each generator returns the candidate dates for one period index (0 = the
// anchor's period), already sorted ascending. Periods themselves are strictly
// increasing, so a caller can stop as soon as it passes its upper bound.

const dailyCandidates = (
  anchor: Temporal.PlainDate,
  rule: RecurrenceRule,
  period: number
): ReadonlyArray<Temporal.PlainDate> => [toIso(anchor).add({ days: period * rule.interval })]

const weeklyCandidates = (
  anchor: Temporal.PlainDate,
  rule: RecurrenceRule,
  period: number
): ReadonlyArray<Temporal.PlainDate> => {
  const block = isoWeekStart(anchor).add({ days: period * rule.interval * 7 })
  const days = sortedUnique(rule.byDay ?? [isoWeekday(anchor)])
  return days.map((day) => block.add({ days: day - 1 }))
}

/** Days selected inside one Jalali month (for monthly/yearly rules). */
const monthDays = (
  rule: RecurrenceRule,
  month: Temporal.PlainDate,
  fallbackDay: number
): ReadonlyArray<number> => {
  const daysInMonth = month.daysInMonth
  if (nonEmpty(rule.byMonthDay)) {
    return sortedUnique(rule.byMonthDay!).filter((day) => day <= daysInMonth)
  }
  if (rule.nthWeekday !== undefined) {
    const { nth, day } = rule.nthWeekday
    if (nth === -1) {
      const lastWeekday = isoWeekday(month.with({ day: daysInMonth }))
      return [daysInMonth - ((lastWeekday - day + 7) % 7)]
    }
    const firstWeekday = isoWeekday(month.with({ day: 1 }))
    const candidate = 1 + ((day - firstWeekday + 7) % 7) + (nth - 1) * 7
    return candidate <= daysInMonth ? [candidate] : []
  }
  return fallbackDay <= daysInMonth ? [fallbackDay] : []
}

const monthlyCandidates = (
  anchor: Temporal.PlainDate,
  rule: RecurrenceRule,
  period: number
): ReadonlyArray<Temporal.PlainDate> => {
  const jalali = toJalali(anchor)
  const month = jalali.with({ day: 1 }).add({ months: period * rule.interval })
  return monthDays(rule, month, jalali.day).map((day) =>
    toIso(month.with({ day }))
  )
}

const yearlyCandidates = (
  anchor: Temporal.PlainDate,
  rule: RecurrenceRule,
  period: number
): ReadonlyArray<Temporal.PlainDate> => {
  const jalali = toJalali(anchor)
  const year = jalali.with({ month: 1, day: 1 }).add({ years: period * rule.interval })
  const month = year.with({ month: jalali.month })
  return monthDays(rule, month, jalali.day).map((day) =>
    toIso(month.with({ day }))
  )
}

const periodCandidates = (
  rule: RecurrenceRule,
  anchor: Temporal.PlainDate,
  period: number
): ReadonlyArray<Temporal.PlainDate> => {
  switch (rule.frequency) {
    case "daily":
      return dailyCandidates(anchor, rule, period)
    case "weekly":
      return weeklyCandidates(anchor, rule, period)
    case "monthly":
      return monthlyCandidates(anchor, rule, period)
    case "yearly":
      return yearlyCandidates(anchor, rule, period)
  }
}

/** The first calendar date of a period, used for early upper-bound exits. */
const periodStart = (
  rule: RecurrenceRule,
  anchor: Temporal.PlainDate,
  period: number
): Temporal.PlainDate => {
  const jalali = toJalali(anchor)
  switch (rule.frequency) {
    case "daily":
      return toIso(anchor).add({ days: period * rule.interval })
    case "weekly":
      return isoWeekStart(anchor).add({ days: period * rule.interval * 7 })
    case "monthly":
      return jalali.with({ day: 1 }).add({ months: period * rule.interval })
    case "yearly":
      return jalali.with({ month: 1, day: 1 }).add({ years: period * rule.interval })
  }
}

// ── Expansion ────────────────────────────────────────────────────────────

/**
 * A hard ceiling on periods (`~55 years` of days, `~1600 years` of months).
 * It is a safety valve for rules that can never match, not a product limit:
 * every realistic rule ends long before it.
 */
export const MAX_PERIODS = 20_000

/** Default and maximum number of occurrences one expansion may return. */
export const MAX_OCCURRENCES = 1_000

export interface ExpandOptions {
  /** Inclusive lower bound; earlier occurrences are skipped (but still counted). */
  readonly from?: DateInput
  /** Inclusive upper bound; generation stops after it. */
  readonly to?: DateInput
  /** Maximum occurrences to return (default/cap `MAX_OCCURRENCES`). */
  readonly limit?: number
  /** Occurrence dates to omit (`YYYY-MM-DD`). */
  readonly exceptions?: ReadonlyArray<LocalDate>
}

const minDate = (a: Temporal.PlainDate, b: Temporal.PlainDate): Temporal.PlainDate =>
  Temporal.PlainDate.compare(a, b) <= 0 ? a : b

/**
 * Expand a rule anchored at `start` (`dtstart`) into occurrence dates.
 *
 * The anchor is the first candidate period; candidates before it in that
 * period (e.g. earlier `byMonthDay` values) are dropped. `count` counts
 * generated candidates before exceptions, matching RFC 5545.
 */
export const expandOccurrences = (
  rule: RecurrenceRule,
  start: DateInput,
  options: ExpandOptions = {}
): ReadonlyArray<Temporal.PlainDate> => {
  const anchor = toIso(asPlainDate(start))
  const from = options.from === undefined ? undefined : toIso(asPlainDate(options.from))
  const to = options.to === undefined ? undefined : toIso(asPlainDate(options.to))
  const until =
    rule.end._tag === "until" ? toIso(asPlainDate(rule.end.date)) : undefined
  const upper = to !== undefined && until !== undefined ? minDate(to, until) : to ?? until
  const limit = Math.min(Math.max(options.limit ?? MAX_OCCURRENCES, 1), MAX_OCCURRENCES)
  const exceptions = new Set<string>(options.exceptions ?? [])
  const occurrences: Array<Temporal.PlainDate> = []
  const countBound = rule.end._tag === "count" ? rule.end.count : undefined
  let counted = 0

  for (let period = 0; period < MAX_PERIODS; period += 1) {
    if (upper !== undefined && Temporal.PlainDate.compare(periodStart(rule, anchor, period), upper) > 0) {
      return occurrences
    }
    const candidates = periodCandidates(rule, anchor, period)
    if (candidates.length === 0) {
      // Nothing this period. For a sparse yearly rule this is normal (Esfand
      // 30 in a common year, or the 31st of a 30-day month); the period loop
      // still advances, and `MAX_PERIODS` bounds a rule that never matches.
      continue
    }

    let advancedPastUpper = false
    for (const candidate of candidates) {
      if (Temporal.PlainDate.compare(candidate, anchor) < 0) continue
      counted += 1
      if (countBound !== undefined && counted > countBound) return occurrences
      if (upper !== undefined && Temporal.PlainDate.compare(candidate, upper) > 0) {
        // Candidates within a period are sorted and periods are increasing,
        // so nothing later can be inside the bound.
        advancedPastUpper = true
        break
      }
      if (from !== undefined && Temporal.PlainDate.compare(candidate, from) < 0) continue
      if (exceptions.has(candidate.toString())) continue
      occurrences.push(candidate)
      if (occurrences.length >= limit) return occurrences
    }
    if (advancedPastUpper) return occurrences
    if (countBound !== undefined && counted >= countBound) return occurrences
  }
  return occurrences
}

/** The local dates of `expandOccurrences` as `YYYY-MM-DD` strings. */
export const occurrenceDates = (
  rule: RecurrenceRule,
  start: DateInput,
  options: ExpandOptions = {}
): ReadonlyArray<LocalDate> =>
  expandOccurrences(rule, start, options).map((date) => date.toString() as LocalDate)

export interface NextOccurrenceOptions {
  /** Occurrence dates to omit. */
  readonly exceptions?: ReadonlyArray<LocalDate>
}

/**
 * The first occurrence strictly after `after` (or `null` when the rule has
 * ended). `count`/`until` are still evaluated from the anchor, so a bounded
 * series cannot be extended by asking for a later occurrence.
 */
export const nextOccurrence = (
  rule: RecurrenceRule,
  start: DateInput,
  after: DateInput,
  options: NextOccurrenceOptions = {}
): Temporal.PlainDate | null => {
  const from = toIso(asPlainDate(after)).add({ days: 1 })
  const next = expandOccurrences(rule, start, {
    from,
    limit: 1,
    exceptions: options.exceptions
  })
  return next[0] ?? null
}
