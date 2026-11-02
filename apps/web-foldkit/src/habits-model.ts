import { Array, Match, Option, Order, Schema } from 'effect'

import {
  DEFAULT_TIME_ZONE,
  formatJalaliDate,
  habitStreak,
  jalaliDate,
  jalaliMonthGrid,
  localDateIn,
  localDateInOption,
  localizeDigits,
  toIsoDate,
  toJalaliDate,
  toJalaliFields,
} from '@tali/domain'
import type {
  Digits,
  HabitEntryStatus,
  StreakResult,
  WeekStart,
} from '@tali/domain'
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
  ownerId: Schema.NullOr(Schema.String),
  visibility: Schema.Literals(['private', 'shared']),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  version: Schema.Int,
  hasSyncError: Schema.Boolean,
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
    ownerId:
      typeof record.data.ownerId === 'string' ? record.data.ownerId : null,
    visibility: record.data.visibility === 'private' ? 'private' : 'shared',
    createdAt,
    updatedAt: record.updatedAt,
    version: record.version,
    hasSyncError: record.syncError !== undefined,
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

export const HabitWindowDays = Schema.Literals([7, 30, 90])
export type HabitWindowDays = typeof HabitWindowDays.Type

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

// ── Monthly heatmap ──────────────────────────────────────────────────────

export interface HabitHeatCell {
  readonly date: string
  readonly inMonth: boolean
  readonly day: number
  /** The raw entry status; `null` is a blank day, never a verdict. */
  readonly status: HabitEntryStatus | null
}

export interface HabitHeatmapMonth {
  readonly year: number
  readonly month: number
  readonly label: string
  readonly weekdayLabels: ReadonlyArray<string>
  readonly weeks: ReadonlyArray<ReadonlyArray<HabitHeatCell>>
}

const weekStartOffset = (weekStart: WeekStart): number =>
  weekStart === 'saturday' ? 0 : weekStart === 'sunday' ? 1 : 2

const statusOn = (
  entries: ReadonlyArray<HabitEntryRow>,
  habitId: string,
  date: string,
): HabitEntryStatus | null =>
  Option.match(
    Array.findFirst(
      entries,
      entry => entry.habitId === habitId && entry.localDate === date,
    ),
    {
      onNone: () => null,
      onSome: entry => entry.status,
    },
  )

/**
 * One Jalali month of raw entry statuses for one habit.
 *
 * The heatmap paints what was logged (done / partial / missed / blank) and
 * never re-derives weights or quotas, so it cannot disagree with
 * `habitStreak` by construction. A blank cell and a `missed` cell stay
 * different colours: the streak treats blank as "not a done" and missed as an
 * explicit answer, and the screen must not collapse them.
 */
export const habitHeatmapMonth = (input: {
  readonly habitId: string
  readonly entries: ReadonlyArray<HabitEntryRow>
  readonly year: number
  readonly month: number
  readonly digits?: Digits
  /** Display alignment only; the counting week stays Saturday–Friday. */
  readonly weekStart?: WeekStart
}): HabitHeatmapMonth => {
  const digits = input.digits ?? 'persian'
  const weekStart = input.weekStart ?? 'saturday'
  const grid = jalaliMonthGrid(input.year, input.month, { weekStart })
  const offset = weekStartOffset(weekStart)
  const weekdayLabels = Array.makeBy(7, index =>
    weekdayName(PERSIAN_WEEKDAY_ORDER[(offset + index) % 7] ?? 6),
  )

  return {
    year: grid.year,
    month: grid.month,
    label: formatJalaliDate(jalaliDate(grid.year, grid.month, 1), {
      digits,
      style: 'medium',
    }),
    weekdayLabels,
    weeks: Array.map(grid.weeks, week =>
      Array.map(week.days, day => {
        const date = toIsoDate(day.date)

        return {
          date,
          inMonth: day.inMonth,
          day: toJalaliFields(day.date).day,
          status: statusOn(input.entries, input.habitId, date),
        }
      }),
    ),
  }
}

/** The Jalali year/month containing a local date (the heatmap's first bucket). */
export const habitMonthOf = (
  today: string,
): Readonly<{
  year: number
  month: number
}> => {
  const fields = toJalaliFields(toJalaliDate(today))

  return { year: fields.year, month: fields.month }
}

/** Move one Jalali month, leaving local-date arithmetic to the domain. */
export const shiftHabitMonth = (
  year: number,
  month: number,
  delta: number,
): Readonly<{ year: number; month: number }> => {
  const zero = month - 1 + delta

  return {
    year: year + Math.floor(zero / 12),
    month: (((zero % 12) + 12) % 12) + 1,
  }
}

// ── Form presets and drafts ──────────────────────────────────────────────

export const HabitFrequencyMode = Schema.Literals([
  'daily',
  'weekdays',
  'weekly',
])
export type HabitFrequencyMode = typeof HabitFrequencyMode.Type

export const HABIT_COLORS: ReadonlyArray<
  Readonly<{ value: string; label: string }>
> = [
  { value: '#2f5fe0', label: 'آبی' },
  { value: '#0f9d8f', label: 'سبزآبی' },
  { value: '#2e9d57', label: 'سبز' },
  { value: '#d9822b', label: 'نارنجی' },
  { value: '#c94f7c', label: 'صورتی' },
  { value: '#7a5af8', label: 'بنفش' },
]

export const HABIT_ICONS: ReadonlyArray<string> = [
  '📚',
  '🏃',
  '💧',
  '🧘',
  '💊',
  '🌱',
  '✍️',
  '🛏️',
]

/** The default icon and colour the create form starts from. */
export const DEFAULT_HABIT_ICON = '🌱'
export const DEFAULT_HABIT_COLOR = HABIT_COLORS[0]?.value ?? '#2f5fe0'
export const DEFAULT_HABIT_WEEKDAYS: ReadonlyArray<number> = [6, 1, 3]
export const DEFAULT_HABIT_TIMES = 3

/** The icon picker offers a stored custom icon alongside the presets. */
export const habitIconChoices = (icon: string): ReadonlyArray<string> =>
  Array.contains(HABIT_ICONS, icon) ? HABIT_ICONS : [icon, ...HABIT_ICONS]

/** The submitted frequency: weekdays sorted, so the era hash is stable. */
export const habitFrequencyDraft = (
  mode: HabitFrequencyMode,
  weekdays: ReadonlyArray<number>,
  timesPerWeek: number,
): HabitFrequency => {
  if (mode === 'weekdays') {
    return {
      _tag: 'weekdays',
      days: Array.sort(weekdays, Order.Number),
    }
  }

  if (mode === 'weekly') {
    return { _tag: 'weekly', times: timesPerWeek }
  }

  return { _tag: 'daily' }
}

/**
 * Toggle one weekday, never emptying the selection: "never on any day" is a
 * deleted habit, not a frequency.
 */
export const toggleHabitWeekday = (
  weekdays: ReadonlyArray<number>,
  day: number,
): ReadonlyArray<number> => {
  if (!Array.contains(weekdays, day)) {
    return [...weekdays, day]
  }

  const rest = Array.filter(weekdays, value => value !== day)

  return Array.isArrayNonEmpty(rest) ? rest : weekdays
}

export const clampHabitTimes = (times: number): number =>
  Math.max(1, Math.min(7, times))

// ── Pending and clock helpers ────────────────────────────────────────────

const PENDING_HABIT_PREFIX = 'habit\u0000'

/** Ids of the habits with an unsent outbox entry. */
export const pendingHabitIds = (
  keys: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  Array.flatMap(keys, key =>
    key.startsWith(PENDING_HABIT_PREFIX)
      ? [key.slice(PENDING_HABIT_PREFIX.length)]
      : [],
  )

/** The user's zone, or the house default when the preference is unusable. */
export const habitTimeZone = (timeZone: string): string =>
  localDateInOption('1970-01-01T00:00:00.000Z', timeZone) === null
    ? DEFAULT_TIME_ZONE
    : timeZone

/** Today's wall date in the user's zone, recomputed from the ticking clock. */
export const habitToday = (now: number, timeZone: string): string => {
  const instant = new Date(now).toISOString()

  return (
    localDateInOption(instant, habitTimeZone(timeZone)) ??
    localDateInOption(instant, DEFAULT_TIME_ZONE) ??
    instant.slice(0, 10)
  )
}
