import { Array, Match, Option, Schema } from 'effect'

import {
  DEFAULT_TIME_ZONE,
  formatJalaliDate,
  habitStreak,
  localDateIn,
  localizeDigits,
  toJalaliDate,
} from '@tali/domain'
import type { Digits, HabitEntryStatus, StreakResult } from '@tali/domain'
import type { MirrorRecord } from '@tali/sync-client'

/**
 * Habit read models, ported from `apps/web/src/lib/habits/model.ts`.
 *
 * The mirror is the only read source: habits and their entries render online
 * and offline from the same rows. The streak is always recomputed with the
 * authoritative `habitStreak`, never stored or approximated.
 */

export const HabitFrequency = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('daily') }),
  Schema.Struct({
    _tag: Schema.Literal('weekdays'),
    days: Schema.Array(Schema.Int),
  }),
  Schema.Struct({
    _tag: Schema.Literal('weekly'),
    times: Schema.Int,
  }),
])
export type HabitFrequency = typeof HabitFrequency.Type

const dailyFrequency = (): HabitFrequency => ({ _tag: 'daily' })

export const HabitFrequencyChange = Schema.Struct({
  effectiveFrom: Schema.String,
  frequency: HabitFrequency,
})
export type HabitFrequencyChange = typeof HabitFrequencyChange.Type

export const HabitRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  frequency: HabitFrequency,
  frequencyHistory: Schema.Array(HabitFrequencyChange),
  startedOn: Schema.String,
  reminderTime: Schema.NullOr(Schema.String),
  timeZone: Schema.String,
  visibility: Schema.Literals(['private', 'shared']),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  version: Schema.Int,
})
export type HabitRow = typeof HabitRow.Type

export const HabitEntryRow = Schema.Struct({
  id: Schema.String,
  habitId: Schema.String,
  localDate: Schema.String,
  status: Schema.Literals(['done', 'partial', 'missed']),
  timeZone: Schema.String,
  updatedAt: Schema.String,
  version: Schema.Int,
})
export type HabitEntryRow = typeof HabitEntryRow.Type

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

const weekdayNumbers = (value: unknown): ReadonlyArray<number> =>
  Array.isArray(value)
    ? Array.filter(
        value,
        (entry): entry is number =>
          typeof entry === 'number' && Number.isInteger(entry),
      )
    : []

/** Decode the frequency union from mirrored JSON; a malformed value reads as daily. */
export const parseHabitFrequency = (value: unknown): HabitFrequency => {
  if (typeof value !== 'object' || value === null) {
    return dailyFrequency()
  }

  const tag = Reflect.get(value, '_tag')

  if (tag === 'weekdays') {
    const days = [
      ...new Set(
        Array.filter(
          weekdayNumbers(Reflect.get(value, 'days')),
          day => day >= 1 && day <= 7,
        ),
      ),
    ].sort((left, right) => left - right)

    if (days.length > 0) {
      return { _tag: 'weekdays', days }
    }
  }

  if (tag === 'weekly') {
    const times = Reflect.get(value, 'times')
    if (
      typeof times === 'number' &&
      Number.isInteger(times) &&
      times >= 1 &&
      times <= 7
    ) {
      return { _tag: 'weekly', times }
    }
  }

  return dailyFrequency()
}

const parseHistory = (
  value: unknown,
  startedOn: string,
  frequency: HabitFrequency,
): ReadonlyArray<HabitFrequencyChange> => {
  const fallback = [
    HabitFrequencyChange.make({ effectiveFrom: startedOn, frequency }),
  ]

  if (!Array.isArray(value)) {
    return fallback
  }

  const seed: Array<HabitFrequencyChange> = []
  const eras = Array.reduce(value, seed, (acc, raw) => {
    if (typeof raw !== 'object' || raw === null) {
      return acc
    }

    const effectiveFrom = asString(Reflect.get(raw, 'effectiveFrom'))
    if (effectiveFrom === null || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      return acc
    }

    const previous = Array.last(acc)
    if (Option.exists(previous, era => era.effectiveFrom >= effectiveFrom)) {
      return acc
    }

    return [
      ...acc,
      HabitFrequencyChange.make({
        effectiveFrom,
        frequency: parseHabitFrequency(Reflect.get(raw, 'frequency')),
      }),
    ]
  })

  return Array.isArrayNonEmpty(eras) ? eras : fallback
}

const localDateOr = (
  instant: string | null,
  timeZone: string,
  fallback: string,
): string => {
  if (instant === null) {
    return fallback
  }

  try {
    return localDateIn(instant, timeZone)
  } catch {
    return fallback
  }
}

/** Project a mirrored habit row into the shape the screens understand. */
export const toHabitRow = (record: MirrorRecord): HabitRow => {
  const timeZone = asString(record.data.timeZone) ?? DEFAULT_TIME_ZONE
  const frequency = parseHabitFrequency(record.data.frequency)
  const createdAt = asString(record.data.createdAt) ?? record.updatedAt
  const startedOnRaw = asString(record.data.startedOn)
  const startedOn =
    startedOnRaw !== null && /^\d{4}-\d{2}-\d{2}$/.test(startedOnRaw)
      ? startedOnRaw
      : localDateOr(createdAt, timeZone, '1970-01-01')

  return HabitRow.make({
    id: record.entityId,
    title: asString(record.data.title) ?? 'بدون نام',
    description: asString(record.data.description),
    icon: asString(record.data.icon),
    color: asString(record.data.color),
    frequency,
    frequencyHistory: parseHistory(
      record.data.frequencyHistory,
      startedOn,
      frequency,
    ),
    startedOn,
    reminderTime: asString(record.data.reminderTime),
    timeZone,
    visibility: record.data.visibility === 'private' ? 'private' : 'shared',
    createdAt,
    updatedAt: record.updatedAt,
    version: record.version,
  })
}

const asStatus = (value: unknown): HabitEntryStatus =>
  value === 'partial' || value === 'missed' ? value : 'done'

/** Project a mirrored habit entry (a day's log) into a row. */
export const toHabitEntryRow = (record: MirrorRecord): HabitEntryRow =>
  HabitEntryRow.make({
    id: record.entityId,
    habitId: asString(record.data.habitId) ?? '',
    localDate: asString(record.data.localDate) ?? '1970-01-01',
    status: asStatus(record.data.status),
    timeZone: asString(record.data.timeZone) ?? DEFAULT_TIME_ZONE,
    updatedAt: record.updatedAt,
    version: record.version,
  })

/**
 * Oldest first, then by title — a stable order across optimistic creates.
 */
const compareText = (left: string, right: string): -1 | 0 | 1 =>
  left < right ? -1 : left > right ? 1 : 0

export const sortHabitRows = (
  rows: ReadonlyArray<HabitRow>,
): ReadonlyArray<HabitRow> =>
  [...rows].sort((left, right) => {
    const byCreated = compareText(left.createdAt, right.createdAt)
    return byCreated !== 0 ? byCreated : compareText(left.title, right.title)
  })

// ── Streak and rate projection ───────────────────────────────────────────

export type HabitWindowDays = 7 | 30 | 90

export const HABIT_WINDOW_DAYS: ReadonlyArray<HabitWindowDays> = [7, 30, 90]

/**
 * The habit's streak/rate result from the mirror's current rows.
 *
 * Recomputed on every call, on purpose: backfills and corrections make both
 * the streak and `best` non-monotonic, so a cache would disagree with the
 * entries it claims to describe.
 */
export const habitStatsFor = (
  habit: HabitRow,
  entries: ReadonlyArray<HabitEntryRow>,
  today: string,
  windowDays: HabitWindowDays,
): StreakResult =>
  habitStreak({
    startedOn: habit.startedOn,
    frequencyHistory: habit.frequencyHistory,
    entries: Array.map(
      Array.filter(entries, entry => entry.habitId === habit.id),
      entry => ({ localDate: entry.localDate, status: entry.status }),
    ),
    today,
    windowDays,
  })

/** Today's entry for a habit, or `undefined` when the day is still blank. */
export const habitEntryOn = (
  entries: ReadonlyArray<HabitEntryRow>,
  habitId: string,
  localDate: string,
): HabitEntryRow | undefined =>
  Array.findFirst(
    entries,
    entry => entry.habitId === habitId && entry.localDate === localDate,
  ).pipe(Option.getOrUndefined)

// ── Copy (Persian, digits-aware) ─────────────────────────────────────────

const PERSIAN_WEEKDAY_ORDER: ReadonlyArray<number> = [6, 7, 1, 2, 3, 4, 5]

const WEEKDAY_NAMES: Readonly<Record<number, string>> = {
  1: 'دوشنبه',
  2: 'سه‌شنبه',
  3: 'چهارشنبه',
  4: 'پنج‌شنبه',
  5: 'جمعه',
  6: 'شنبه',
  7: 'یکشنبه',
}

const weekdayName = (isoDay: number): string => WEEKDAY_NAMES[isoDay] ?? ''

/** «هر روز» / «شنبه، دوشنبه، چهارشنبه» / «۳ بار در هفته». */
export const habitFrequencyLabel = (
  frequency: HabitFrequency,
  digits: Digits = 'persian',
): string =>
  Match.value(frequency).pipe(
    Match.tag('daily', () => 'هر روز'),
    Match.tag(
      'weekly',
      ({ times }) => `${localizeDigits(times, digits)} بار در هفته`,
    ),
    Match.tag('weekdays', ({ days }) =>
      Array.map(
        [...days].sort((left, right) => {
          const leftIndex = PERSIAN_WEEKDAY_ORDER.indexOf(left)
          const rightIndex = PERSIAN_WEEKDAY_ORDER.indexOf(right)
          return leftIndex < rightIndex ? -1 : leftIndex > rightIndex ? 1 : 0
        }),
        weekdayName,
      ).join('، '),
    ),
    Match.exhaustive,
  )

/** A Jalali date range, e.g. «۲۵ مهر – ۱ آبان» for the fixed counting week. */
export const formatDateRange = (
  start: string,
  end: string,
  digits: Digits = 'persian',
): string =>
  `${formatJalaliDate(toJalaliDate(start), { digits, style: 'short' })} – ${formatJalaliDate(
    toJalaliDate(end),
    { digits, style: 'short' },
  )}`

export const habitStreakLabel = (
  result: StreakResult,
  digits: Digits = 'persian',
): string => {
  if (result.current.count === 0) {
    return 'بدون زنجیره'
  }

  const unit = result.current.unit === 'week' ? 'هفته' : 'روز'

  return `${localizeDigits(result.current.count, digits)} ${unit} پیاپی`
}

export const habitBestLabel = (
  result: StreakResult,
  digits: Digits = 'persian',
): string => {
  const best =
    result.current.unit === 'week' ? result.best.weeks : result.best.days
  const unit = result.current.unit === 'week' ? 'هفته' : 'روز'

  return best === 0
    ? 'بهترین: —'
    : `بهترین: ${localizeDigits(best, digits)} ${unit}`
}

/** Progress of the open period, e.g. «۲ از ۳ این هفته». */
export const habitOpenProgressLabel = (
  result: StreakResult,
  digits: Digits = 'persian',
): string | null => {
  const open = result.open

  if (open === null || open.satisfied) {
    return null
  }

  const suffix = open.unit === 'week' ? 'این هفته' : 'امروز'

  return `${localizeDigits(open.credit, digits)} از ${localizeDigits(
    open.requirement,
    digits,
  )} ${suffix}`
}

/**
 * The streak badge copy. The badge always names the unit, and an open period
 * that is not yet satisfied carries its progress too.
 */
export const habitBadgeLabel = (
  result: StreakResult,
  digits: Digits = 'persian',
): string => {
  const streak = habitStreakLabel(result, digits)
  const progress = habitOpenProgressLabel(result, digits)

  return progress === null ? streak : `${streak} · ${progress}`
}

export interface HabitRateCopy {
  readonly kind: 'rate' | 'progress' | 'none'
  readonly label: string
}

/**
 * The rate line.
 *
 * A `null` rate is never rendered as `0%`: a week-unit habit whose only week is
 * the unfinished open one shows its progress instead, and a day-unit habit
 * with no qualifying expected day falls back to today's progress.
 */
export const habitRateCopy = (
  result: StreakResult,
  digits: Digits = 'persian',
): HabitRateCopy => {
  if (result.rate !== null) {
    const percent = Math.round(result.rate * 100)
    return { kind: 'rate', label: `${localizeDigits(percent, digits)}٪` }
  }

  const progress = habitOpenProgressLabel(result, digits)
  if (progress !== null) {
    return { kind: 'progress', label: progress }
  }

  if (result.open !== null) {
    const suffix = result.open.unit === 'week' ? 'این هفته' : 'امروز'
    return {
      kind: 'progress',
      label: `${localizeDigits(result.open.credit, digits)} از ${localizeDigits(
        result.open.requirement,
        digits,
      )} ${suffix}`,
    }
  }

  return { kind: 'none', label: 'بدون داده در این بازه' }
}

/**
 * The counting period a week-unit result is judged over, shown so the fixed
 * Saturday–Friday turn stays visible with another display week start.
 */
export const habitCountingPeriodLabel = (
  result: StreakResult,
  digits: Digits = 'persian',
): string | null =>
  result.current.unit === 'week' && result.open !== null
    ? formatDateRange(result.open.start, result.open.end, digits)
    : null

export const habitStatusLabel = (status: HabitEntryStatus | null): string => {
  switch (status) {
    case 'done':
      return 'انجام شد'
    case 'partial':
      return 'نیمه'
    case 'missed':
      return 'از دست رفت'
    case null:
      return 'ثبت نشده'
  }
}

export const habitStatusIcon = (status: HabitEntryStatus | null): string => {
  switch (status) {
    case 'done':
      return '✓'
    case 'partial':
      return '◐'
    case 'missed':
      return '✕'
    case null:
      return '○'
  }
}
