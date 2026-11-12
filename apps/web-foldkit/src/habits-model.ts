import { Array, Match, Option, Order, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

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

import { JsonField } from './lib/json-field'
import {
  mirrorCreatedAt,
  mirrorId,
  mirrorMeta,
  mirrorNonEmpty,
  mirrorNullableNonEmpty,
  mirrorTimeZone,
  mirrorVisibility,
} from './lib/mirror-field'

/**
 * Habit read models, ported from `apps/web/src/lib/habits/model.ts`.
 *
 * The mirror is the only read source: habits and their entries render online
 * and offline from the same rows. The streak is always recomputed with the
 * authoritative `habitStreak`, never stored or approximated.
 */

export const HabitFrequency = defineTaggedUnion({
  daily: {},
  weekdays: { days: Schema.Array(Schema.Int) },
  weekly: { times: Schema.Int },
})

export type HabitFrequency = typeof HabitFrequency.Type

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

const asFrequency = Schema.decodeUnknownOption(JsonField(HabitFrequency))

const StoredFrequencyEra = Schema.Struct({
  effectiveFrom: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  frequency: HabitFrequency,
})

const asFrequencyEra = Schema.decodeUnknownOption(StoredFrequencyEra)

const asHistoryItems = Schema.decodeUnknownOption(
  JsonField(Schema.Array(Schema.Json)),
)

const asStatus = Schema.decodeUnknownOption(
  Schema.Literals(['done', 'partial', 'missed']),
)

/** The frequency union from mirrored JSON, with the day set canonicalised. */
const normalizeFrequency = (frequency: HabitFrequency): HabitFrequency =>
  Match.value(frequency).pipe(
    Match.tag('daily', () => HabitFrequency.daily()),
    Match.tag('weekdays', ({ days }) => {
      const valid = Array.sort(
        Array.dedupe(Array.filter(days, day => day >= 1 && day <= 7)),
        Order.Number,
      )

      return Array.isArrayNonEmpty(valid)
        ? HabitFrequency.weekdays({ days: valid })
        : HabitFrequency.daily()
    }),
    Match.tag('weekly', ({ times }) =>
      Number.isInteger(times) && times >= 1 && times <= 7
        ? HabitFrequency.weekly({ times })
        : HabitFrequency.daily(),
    ),
    Match.exhaustive,
  )

const parseHistory = (
  items: ReadonlyArray<Schema.Json>,
  startedOn: string,
  frequency: HabitFrequency,
): ReadonlyArray<HabitFrequencyChange> => {
  const fallback = [
    HabitFrequencyChange.make({ effectiveFrom: startedOn, frequency }),
  ]

  const eras = Array.getSomes(Array.map(items, item => asFrequencyEra(item)))

  const increasing = Array.reduce(
    eras,
    Array.empty<HabitFrequencyChange>(),
    (acc, era) => {
      const previous = Array.last(acc)

      const isNewer = Option.match(previous, {
        onNone: () => true,
        onSome: last => last.effectiveFrom < era.effectiveFrom,
      })

      return isNewer ? [...acc, era] : acc
    },
  )

  return Array.isArrayNonEmpty(increasing) ? increasing : fallback
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
  const timeZone = mirrorTimeZone(record)

  const frequency = Option.match(asFrequency(record.data.frequency), {
    onNone: () => HabitFrequency.daily(),
    onSome: normalizeFrequency,
  })

  const createdAt = mirrorCreatedAt(record)

  const startedOnRaw = mirrorNullableNonEmpty(record, 'startedOn')

  const startedOn =
    startedOnRaw !== null && /^\d{4}-\d{2}-\d{2}$/.test(startedOnRaw)
      ? startedOnRaw
      : localDateOr(createdAt, timeZone, '1970-01-01')

  return HabitRow.make({
    id: mirrorId(record),
    title: mirrorNonEmpty(record, 'title', 'بدون نام'),
    description: mirrorNullableNonEmpty(record, 'description'),
    icon: mirrorNullableNonEmpty(record, 'icon'),
    color: mirrorNullableNonEmpty(record, 'color'),
    frequency,
    frequencyHistory: parseHistory(
      Option.getOrElse(asHistoryItems(record.data.frequencyHistory), () => []),
      startedOn,
      frequency,
    ),
    startedOn,
    reminderTime: mirrorNullableNonEmpty(record, 'reminderTime'),
    timeZone,
    ownerId: mirrorNullableNonEmpty(record, 'ownerId'),
    visibility: mirrorVisibility(record, 'habit'),
    createdAt,
    ...mirrorMeta(record),
  })
}

/** Project a mirrored habit entry (a day's log) into a row. */
export const toHabitEntryRow = (record: MirrorRecord): HabitEntryRow =>
  HabitEntryRow.make({
    id: mirrorId(record),
    habitId: mirrorNonEmpty(record, 'habitId', ''),
    localDate: mirrorNonEmpty(record, 'localDate', '1970-01-01'),
    status: Option.getOrElse(asStatus(record.data.status), () => 'done'),
    timeZone: mirrorTimeZone(record),
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

/** Persian name per ISO weekday; index 0 is Monday, so `isoDay - 1`. */
const WEEKDAY_NAMES = [
  'دوشنبه',
  'سه‌شنبه',
  'چهارشنبه',
  'پنج‌شنبه',
  'جمعه',
  'شنبه',
  'یکشنبه',
]

const weekdayName = (isoDay: number): string => WEEKDAY_NAMES[isoDay - 1] ?? ''

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
  Match.value(weekStart).pipe(
    Match.when('saturday', () => 0),
    Match.when('sunday', () => 1),
    Match.orElse(() => 2),
  )

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
export interface HabitMonth {
  readonly year: number
  readonly month: number
}

export const habitMonthOf = (today: string): HabitMonth => {
  const fields = toJalaliFields(toJalaliDate(today))

  return { year: fields.year, month: fields.month }
}

/** Move one Jalali month, leaving local-date arithmetic to the domain. */
export const shiftHabitMonth = (
  year: number,
  month: number,
  delta: number,
): HabitMonth => {
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
    return HabitFrequency.weekdays({
      days: Array.sort(weekdays, Order.Number),
    })
  }

  if (mode === 'weekly') {
    return HabitFrequency.weekly({ times: timesPerWeek })
  }

  return HabitFrequency.daily()
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
