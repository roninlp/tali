import { Temporal } from "temporal-polyfill/full"
import type { LocalDate } from "./common.js"
import type { HabitEntryStatus, HabitFrequency } from "./habit.js"

/**
 * The habit streak and success-rate algorithm (ticket #65, shipped with #66;
 * FR-HAB-03).
 *
 * Source of truth: `docs/streak-algorithm.md` and
 * `docs/adr/0007-habit-streak-periods.md`. This module is the **only**
 * implementation of those rules — the badge, the rate, the heatmap and any
 * future report must read this result rather than re-derive a count.
 *
 * It is a pure function: no clock, no time zone, no I/O. `today` is a
 * parameter resolved by the caller in the owner's zone, and every other value
 * is a `PlainDate`/local date, so DST, Jalali leap years and a device zone
 * change cannot add, remove or move a day.
 *
 * ## The rules in brief
 *
 * - A period is one expected day (daily / selected weekdays) or one fixed
 *   **Saturday–Friday** week (X times a week). The week is a partition of
 *   local dates, independent of the #35 Week Start preference.
 * - **Credit** (streak and weekly quota): done = 1, partial = 1, missed/blank
 *   = 0. **Weight** (rate): done = 1, partial = 0.5, missed/blank = 0.
 * - A satisfied period extends the run. A **closed** unsatisfied period breaks
 *   it; the **open** period can never break it and adds to it as soon as it is
 *   satisfied.
 * - Each frequency era is judged by the rule in force when its period started.
 *   A unit change closes the run (keeping it in `best`) and starts a new one; a
 *   same-unit threshold change does not interrupt it.
 * - The rate is quota-relative, capped at 100%, for the **current unit** only,
 *   and excludes an unsatisfied open period. When nothing qualifies it is
 *   `null`; the UI shows progress instead of `0%`.
 */

export type StreakUnit = "day" | "week"

/** One era of one frequency. `effectiveFrom` is the era's first period start (era 0: `startedOn`). */
export interface StreakFrequencyEra {
  readonly effectiveFrom: LocalDate
  readonly frequency: HabitFrequency
}

export interface StreakEntry {
  /** The entry's local date — `HabitEntry.localDate` in #63. */
  readonly localDate: LocalDate
  readonly status: HabitEntryStatus
}

export interface StreakInput {
  /** The habit's local creation date — a domain fact, not `createdAt` instant. */
  readonly startedOn: LocalDate
  /**
   * Oldest first, non-overlapping, `effectiveFrom` strictly increasing, never
   * empty. Era 0 is written at creation with `effectiveFrom = startedOn`.
   */
  readonly frequencyHistory: ReadonlyArray<StreakFrequencyEra>
  /** Entries for this habit; order is irrelevant, one row per `localDate`. */
  readonly entries: ReadonlyArray<StreakEntry>
  /** The owner's local today, resolved by the caller (their IANA zone). */
  readonly today: LocalDate
  /** Rate window in local days. The streak itself is all-time and ignores it. */
  readonly windowDays: 7 | 30 | 90
}

export interface StreakPeriod {
  readonly unit: StreakUnit
  readonly start: LocalDate
  /** Inclusive. */
  readonly end: LocalDate
  /** The rule in force when the period started (era at `max(start, startedOn)`). */
  readonly frequency: HabitFrequency
  /** 1 for an expected day, `times` for a week. */
  readonly requirement: number
  /** done + partial, integers (R2). */
  readonly credit: number
  /** done + 0.5 × partial (R3). */
  readonly weighted: number
  readonly satisfied: boolean
  /** Contains `today`. */
  readonly open: boolean
  /** Fully inside the rate window and not predating `startedOn` (R15). */
  readonly inWindow: boolean
}

export interface StreakResult {
  readonly current: {
    /** Unit of the last applicable period; era 0's unit when there is none. */
    readonly unit: StreakUnit
    /** 0 when the current run is empty. */
    readonly count: number
    /** First day of the run, never before `startedOn`. */
    readonly since: LocalDate | null
  }
  /** The open period, for "2 of 3 this week" copy; null on a rest day or before `startedOn`. */
  readonly open: StreakPeriod | null
  readonly best: { readonly days: number; readonly weeks: number }
  /** 0..1, unrounded; null when no period qualifies (R16). */
  readonly rate: number | null
  /** Applicable periods, oldest first, including the open one. */
  readonly periods: ReadonlyArray<StreakPeriod>
  /** One entry per era boundary whose unit changed. */
  readonly unitChanges: ReadonlyArray<{
    readonly on: LocalDate
    readonly from: StreakUnit
    readonly to: StreakUnit
  }>
}

/** The counting unit of a frequency. */
export const streakUnitOf = (frequency: HabitFrequency): StreakUnit =>
  frequency._tag === "weekly" ? "week" : "day"

const SATURDAY = 6
const FRIDAY = 5

const addDays = (date: LocalDate, days: number): LocalDate =>
  Temporal.PlainDate.from(date).add({ days }).toString() as LocalDate

const dayOfWeek = (date: LocalDate): number => Temporal.PlainDate.from(date).dayOfWeek

/** The Saturday on or before `date` (the fixed counting week, R6). */
const saturdayOnOrBefore = (date: LocalDate): LocalDate =>
  addDays(date, -((dayOfWeek(date) - SATURDAY + 7) % 7))

/**
 * The Friday that closes the counting week whose first day is `start`.
 *
 * For a well-formed weekly era `start` is a Saturday and this is five days
 * later. A malformed (gapped) era can start mid-week; the period then runs to
 * that week's Friday instead of producing a backwards range.
 */
const countingWeekEnd = (start: LocalDate): LocalDate =>
  addDays(start, 6 - ((dayOfWeek(start) - SATURDAY + 7) % 7))

const CREDIT: Readonly<Record<HabitEntryStatus, number>> = {
  done: 1,
  partial: 1,
  missed: 0
}

const WEIGHT: Readonly<Record<HabitEntryStatus, number>> = {
  done: 1,
  partial: 0.5,
  missed: 0
}

const assertFrequency = (frequency: HabitFrequency): void => {
  switch (frequency._tag) {
    case "daily":
      return
    case "weekdays": {
      if (!Array.isArray(frequency.days) || frequency.days.length === 0) {
        throw new Error("habit streak: a weekdays frequency needs at least one day")
      }
      const seen = new Set<number>()
      for (const day of frequency.days) {
        if (!Number.isInteger(day) || day < 1 || day > 7) {
          throw new Error("habit streak: a weekday must be an integer in 1..7")
        }
        if (seen.has(day)) {
          throw new Error("habit streak: a weekdays frequency must not repeat a day")
        }
        seen.add(day)
      }
      return
    }
    case "weekly":
      if (
        !Number.isInteger(frequency.times) ||
        frequency.times < 1 ||
        frequency.times > 7
      ) {
        throw new Error("habit streak: weekly times must be an integer in 1..7")
      }
      return
    default:
      throw new Error("habit streak: unknown frequency")
  }
}

const weekdaySet = (frequency: HabitFrequency): ReadonlySet<number> | null =>
  frequency._tag === "weekdays" ? new Set(frequency.days) : null

/** Is `date` an expected day under a **day-unit** frequency? */
const isExpectedDay = (frequency: HabitFrequency, date: LocalDate): boolean => {
  if (frequency._tag === "daily") return true
  if (frequency._tag === "weekdays") return weekdaySet(frequency)!.has(dayOfWeek(date))
  return false
}

const requirementOf = (frequency: HabitFrequency): number =>
  frequency._tag === "weekly" ? frequency.times : 1

/**
 * The era in force on `date`: the last era whose boundary is at or before it.
 * Era 0 is the fallback for a date before the first boundary (only possible on
 * malformed input), so the result is total.
 */
const eraIndexAt = (
  eras: ReadonlyArray<StreakFrequencyEra>,
  date: LocalDate
): number => {
  let index = 0
  for (let cursor = 1; cursor < eras.length; cursor += 1) {
    if (eras[cursor]!.effectiveFrom <= date) index = cursor
    else break
  }
  return index
}

const maxDate = (left: LocalDate, right: LocalDate): LocalDate =>
  left > right ? left : right

const minDate = (left: LocalDate, right: LocalDate): LocalDate =>
  left < right ? left : right

const EMPTY_RESULT = (unit: StreakUnit): StreakResult => ({
  current: { unit, count: 0, since: null },
  open: null,
  best: { days: 0, weeks: 0 },
  rate: null,
  periods: [],
  unitChanges: []
})

/**
 * Evaluate the habit's streak, best streak and rate over the requested window.
 *
 * Total over every input #63 can produce; malformed eras/frequencies/statuses
 * throw a plain `Error` (a programming defect, not a user error, per §4.3).
 */
export const habitStreak = (input: StreakInput): StreakResult => {
  const eras = input.frequencyHistory
  if (eras.length === 0) throw new Error("habit streak: the frequency history is empty")
  for (let index = 0; index < eras.length; index += 1) {
    assertFrequency(eras[index]!.frequency)
    if (index > 0 && !(eras[index]!.effectiveFrom > eras[index - 1]!.effectiveFrom)) {
      throw new Error("habit streak: frequency eras must have strictly increasing dates")
    }
  }

  const unitChanges: Array<{ on: LocalDate; from: StreakUnit; to: StreakUnit }> = []
  for (let index = 1; index < eras.length; index += 1) {
    const from = streakUnitOf(eras[index - 1]!.frequency)
    const to = streakUnitOf(eras[index]!.frequency)
    if (from !== to) unitChanges.push({ on: eras[index]!.effectiveFrom, from, to })
  }

  const startedOn = input.startedOn
  const today = input.today
  const firstUnit = streakUnitOf(eras[0]!.frequency)

  // The function never looks before the habit began (R11/§4.2), and a device
  // clock behind `startedOn` has no period to report at all.
  if (today < startedOn) return EMPTY_RESULT(firstUnit)

  // One entry per local date. A duplicate is a contract violation (§4.3);
  // order-independence is what matters, so the map simply holds one answer.
  const entries = new Map<LocalDate, HabitEntryStatus>()
  for (const entry of input.entries) {
    if (entry.localDate < startedOn || entry.localDate > today) continue
    if (entry.status !== "done" && entry.status !== "partial" && entry.status !== "missed") {
      throw new Error("habit streak: unknown habit entry status")
    }
    entries.set(entry.localDate, entry.status)
  }

  const windowStart = addDays(today, -(input.windowDays - 1))
  const periods: Array<StreakPeriod> = []

  let run = 0
  let runStart: LocalDate | null = null
  let bestDays = 0
  let bestWeeks = 0
  let lastEraIndex = -1
  let lastUnit: StreakUnit | undefined

  let cursor: LocalDate = startedOn
  let firstPeriod = true

  while (cursor <= today) {
    const eraIndex = eraIndexAt(eras, maxDate(cursor, startedOn))
    const era = eras[eraIndex]!
    const unit = streakUnitOf(era.frequency)

    if (unit === "day") {
      // Every day is stepped over; only expected days are periods, so a rest
      // day is transparent (R5) and never breaks or extends a run.
      const day = cursor
      cursor = addDays(cursor, 1)
      if (!isExpectedDay(era.frequency, day)) continue

      const start = day
      const end = day
      const open = day === today
      const frequency = era.frequency
      const requirement = requirementOf(frequency)
      const weighted = WEIGHT[entries.get(day) ?? "missed"] ?? 0
      const credit = entries.has(day) ? CREDIT[entries.get(day)!]! : 0
      const satisfied = credit >= requirement
      const inWindow = start >= windowStart && end <= today && start >= startedOn
      const period: StreakPeriod = {
        unit,
        start,
        end,
        frequency,
        requirement,
        credit,
        weighted,
        satisfied,
        open,
        inWindow
      }
      periods.push(period)

      if (lastEraIndex >= 0 && eraIndex > lastEraIndex && lastUnit !== unit) {
        run = 0
        runStart = null
      }
      if (satisfied) {
        run += 1
        if (runStart === null) runStart = start
        bestDays = Math.max(bestDays, run)
      } else if (!open) {
        run = 0
        runStart = null
      }

      lastEraIndex = eraIndex
      lastUnit = unit
      firstPeriod = false
      continue
    }

    // Week unit. The opening week is the one containing `startedOn`, even
    // though its Saturday precedes it (R11); later eras are guaranteed to
    // open on a Saturday by #63, so the cursor is already a period start.
    const start = firstPeriod && eraIndex === 0 ? saturdayOnOrBefore(startedOn) : cursor
    const end = countingWeekEnd(start)
    cursor = addDays(end, 1)

    const frequency = era.frequency
    const requirement = requirementOf(frequency)
    const from = maxDate(start, startedOn)
    const to = minDate(end, today)
    let credit = 0
    let weighted = 0
    if (from <= to) {
      for (let day = from; day <= to; day = addDays(day, 1)) {
        const status = entries.get(day)
        if (status === undefined) continue
        credit += CREDIT[status]!
        weighted += WEIGHT[status]!
      }
    }
    const open = start <= today && today <= end
    const satisfied = credit >= requirement
    const inWindow = start >= windowStart && end <= today && start >= startedOn
    const period: StreakPeriod = {
      unit,
      start,
      end,
      frequency,
      requirement,
      credit,
      weighted,
      satisfied,
      open,
      inWindow
    }
    periods.push(period)

    if (lastEraIndex >= 0 && eraIndex > lastEraIndex && lastUnit !== unit) {
      run = 0
      runStart = null
    }
    if (satisfied) {
      run += 1
      if (runStart === null) runStart = start
      bestWeeks = Math.max(bestWeeks, run)
    } else if (!open) {
      run = 0
      runStart = null
    }

    lastEraIndex = eraIndex
    lastUnit = unit
    firstPeriod = false
  }

  const currentUnit = periods.length > 0 ? periods[periods.length - 1]!.unit : firstUnit
  const openPeriod = periods.find((period) => period.open) ?? null

  // ── Success rate (§5.5) ────────────────────────────────────────────────
  //
  // The rate is for the current unit only. A closed period must be fully
  // inside the window; the open period counts only once it is satisfied, so an
  // unfinished today/open week is outside the denominator (R13).
  const qualifies = (period: StreakPeriod): boolean =>
    period.unit === currentUnit &&
    ((!period.open && period.inWindow) ||
      // The open period may count before it has ended, but never before the
      // habit existed: the mid-week opening week is excluded, not averaged in
      // at a disadvantage (§5.5, E9).
      (period.open && period.satisfied && period.start >= startedOn))

  let rate: number | null = null
  if (currentUnit === "day") {
    const included = periods.filter(
      (period) => period.unit === "day" && qualifies(period)
    )
    const denominator = included.length
    if (denominator > 0) {
      let numerator = included.reduce((total, period) => total + period.weighted, 0)
      // A rest-day entry is bonus weight, never a denominator place (E12).
      for (
        let day = maxDate(windowStart, startedOn);
        day <= today;
        day = addDays(day, 1)
      ) {
        const status = entries.get(day)
        if (status === undefined) continue
        const era = eras[eraIndexAt(eras, day)]!
        if (streakUnitOf(era.frequency) !== "day") continue
        if (isExpectedDay(era.frequency, day)) continue
        numerator += WEIGHT[status]!
      }
      rate = Math.min(1, numerator / denominator)
    }
  } else {
    // `currentUnit === "week"` means the last applicable period is a week, so
    // every week period has a `times` requirement.
    const included = periods.filter(
      (period) => period.unit === "week" && qualifies(period)
    )
    if (included.length > 0) {
      const total = included.reduce(
        (sum, period) => sum + Math.min(1, period.weighted / period.requirement),
        0
      )
      rate = total / included.length
    }
  }

  return {
    current: {
      unit: currentUnit,
      count: run,
      since:
        runStart === null || run === 0 ? null : maxDate(runStart, startedOn)
    },
    open: openPeriod,
    best: { days: bestDays, weeks: bestWeeks },
    rate,
    periods,
    unitChanges
  }
}
