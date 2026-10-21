import {
  DEFAULT_TIME_ZONE,
  formatJalaliDate,
  habitFrequencyHistoryAfter,
  habitStreak,
  jalaliDate,
  jalaliMonthGrid,
  localDateIn,
  localizeDigits,
  sameHabitFrequency,
  toIsoDate,
  toJalaliDate,
  toJalaliFields,
  uuidV7,
  type Digits,
  type HabitEntryStatus,
  type HabitFrequency,
  type HabitFrequencyChange,
  type LocalDate,
  type StreakResult,
  type WeekStart
} from "@tali/domain"
import type { LocalStore, MirrorRecord } from "../local-store"

/**
 * The habits screen's client model (ticket #66; FR-HAB-01/02/03).
 *
 * The mirror is the only read source: habits and their entries render online
 * and offline from the same rows. Writes are the #17 contract — the mirror row
 * and the outbox entry commit in one IndexedDB transaction — and the streak is
 * **always recomputed** with `habitStreak` from the authoritative domain module
 * (`docs/streak-algorithm.md`), never stored or approximated. That is what
 * makes a tap update the badge immediately, a backfilled day grow a streak
 * after the fact, and a correction lower `best` (E5, E6).
 */

export interface HabitRow {
  readonly id: string
  readonly title: string
  readonly description: string | null
  readonly icon: string | null
  readonly color: string | null
  readonly frequency: HabitFrequency
  readonly frequencyHistory: ReadonlyArray<HabitFrequencyChange>
  readonly startedOn: LocalDate
  readonly reminderTime: string | null
  readonly timeZone: string
  readonly visibility: "private" | "shared"
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}

export interface HabitEntryRow {
  readonly id: string
  readonly habitId: string
  readonly localDate: LocalDate
  readonly status: HabitEntryStatus
  readonly timeZone: string
  readonly updatedAt: string
  readonly version: number
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null

const asStringArray = (value: unknown): ReadonlyArray<number> =>
  Array.isArray(value)
    ? value.filter(
      (entry): entry is number => typeof entry === "number" && Number.isInteger(entry)
    )
    : []

/** Decode the frequency union from mirrored JSON; a malformed value reads as daily. */
export const parseHabitFrequency = (value: unknown): HabitFrequency => {
  if (typeof value === "object" && value !== null) {
    const tag = (value as Record<string, unknown>)._tag
    if (tag === "daily") return { _tag: "daily" }
    if (tag === "weekdays") {
      const days = [...new Set(asStringArray((value as Record<string, unknown>).days))]
        .filter((day) => day >= 1 && day <= 7)
        .sort((left, right) => left - right)
      if (days.length > 0) return { _tag: "weekdays", days }
    }
    if (tag === "weekly") {
      const times = (value as Record<string, unknown>).times
      if (typeof times === "number" && Number.isInteger(times) && times >= 1 && times <= 7) {
        return { _tag: "weekly", times }
      }
    }
  }
  return { _tag: "daily" }
}

const parseHistory = (
  value: unknown,
  startedOn: LocalDate,
  frequency: HabitFrequency
): ReadonlyArray<HabitFrequencyChange> => {
  if (Array.isArray(value)) {
    const eras: Array<HabitFrequencyChange> = []
    for (const raw of value) {
      if (typeof raw !== "object" || raw === null) continue
      const record = raw as Record<string, unknown>
      const effectiveFrom = asString(record.effectiveFrom)
      if (effectiveFrom === null || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) continue
      const era: HabitFrequencyChange = {
        effectiveFrom: effectiveFrom as LocalDate,
        frequency: parseHabitFrequency(record.frequency)
      }
      const previous = eras[eras.length - 1]
      if (previous !== undefined && !(era.effectiveFrom > previous.effectiveFrom)) continue
      eras.push(era)
    }
    if (eras.length > 0) return eras
  }
  return [{ effectiveFrom: startedOn, frequency }]
}

const localDateOr = (instant: string | null, timeZone: string, fallback: LocalDate): LocalDate => {
  if (instant === null) return fallback
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
  const startedOn = startedOnRaw !== null && /^\d{4}-\d{2}-\d{2}$/.test(startedOnRaw)
    ? (startedOnRaw as LocalDate)
    : localDateOr(record.data.createdAt as string | null, timeZone, "1970-01-01")
  return {
    id: record.entityId,
    title: asString(record.data.title) ?? "بدون نام",
    description: asString(record.data.description),
    icon: asString(record.data.icon),
    color: asString(record.data.color),
    frequency,
    frequencyHistory: parseHistory(record.data.frequencyHistory, startedOn, frequency),
    startedOn,
    reminderTime: asString(record.data.reminderTime),
    timeZone,
    visibility: record.data.visibility === "private" ? "private" : "shared",
    createdAt,
    updatedAt: record.updatedAt,
    version: record.version
  }
}

const asStatus = (value: unknown): HabitEntryStatus =>
  value === "partial" || value === "missed" ? value : "done"

/** Project a mirrored habit entry (a day's log) into a row. */
export const toHabitEntryRow = (record: MirrorRecord): HabitEntryRow => ({
  id: record.entityId,
  habitId: asString(record.data.habitId) ?? "",
  localDate: (asString(record.data.localDate) ?? "1970-01-01") as LocalDate,
  status: asStatus(record.data.status),
  timeZone: asString(record.data.timeZone) ?? DEFAULT_TIME_ZONE,
  updatedAt: record.updatedAt,
  version: record.version
})

/** Oldest first, then by title — a stable order across optimistic creates. */
export const sortHabitRows = (rows: ReadonlyArray<HabitRow>): ReadonlyArray<HabitRow> =>
  [...rows].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.title.localeCompare(right.title, "fa")
  )

export const liveHabitRows = (records: ReadonlyArray<MirrorRecord>): ReadonlyArray<HabitRow> =>
  sortHabitRows(records.map(toHabitRow))

export const liveHabitEntryRows = (
  records: ReadonlyArray<MirrorRecord>
): ReadonlyArray<HabitEntryRow> => records.map(toHabitEntryRow)

// ── Local-first writes ───────────────────────────────────────────────────

export interface HabitCreateDraft {
  readonly title: string
  readonly description?: string | null
  readonly icon?: string | null
  readonly color?: string | null
  readonly frequency: HabitFrequency
  readonly reminderTime?: string | null
  readonly timeZone: string
}

/**
 * Create a habit locally: the mirror row and its outbox mutation commit before
 * anything syncs. `startedOn` and era 0 are written now, in the habit's zone,
 * exactly as the service/sync defaults will recompute them, so the streak is
 * correct offline from the first render.
 */
export const createHabitInMirror = async (
  store: LocalStore,
  draft: HabitCreateDraft,
  now: string = new Date().toISOString()
): Promise<string> => {
  const title = draft.title.trim()
  if (title === "") throw new Error("a habit needs a title")
  const id = uuidV7()
  const timeZone = draft.timeZone
  const startedOn = localDateIn(now, timeZone)
  await store.writeLocal({
    entityType: "habit",
    entityId: id,
    op: "upsert",
    patch: {
      id,
      type: "habit",
      title,
      description: draft.description ?? null,
      icon: draft.icon ?? null,
      color: draft.color ?? null,
      frequency: draft.frequency,
      frequencyHistory: [{ effectiveFrom: startedOn, frequency: draft.frequency }],
      startedOn,
      reminderTime: draft.reminderTime ?? null,
      timeZone,
      visibility: "shared",
      createdAt: now
    },
    now
  })
  return id
}

/** Only the editable fields; an omitted field keeps its stored value. */
export interface HabitEditPatch {
  readonly title?: string
  readonly description?: string | null
  readonly icon?: string | null
  readonly color?: string | null
  readonly frequency?: HabitFrequency
  readonly reminderTime?: string | null
}

/**
 * Apply an edit locally. A frequency change appends the same era boundary the
 * server would compute (`habitFrequencyHistoryAfter`, #63) so the optimistic
 * streak judges past periods by the rule that opened them instead of rewriting
 * history at the new frequency.
 */
export const updateHabitInMirror = async (
  store: LocalStore,
  habit: HabitRow,
  patch: HabitEditPatch,
  now: string = new Date().toISOString()
): Promise<void> => {
  const local: Record<string, unknown> = {}
  if (patch.title !== undefined) {
    const title = patch.title.trim()
    if (title === "") throw new Error("a habit needs a title")
    local.title = title
  }
  if (patch.description !== undefined) local.description = patch.description
  if (patch.icon !== undefined) local.icon = patch.icon
  if (patch.color !== undefined) local.color = patch.color
  if (patch.reminderTime !== undefined) local.reminderTime = patch.reminderTime
  if (patch.frequency !== undefined && !sameHabitFrequency(patch.frequency, habit.frequency)) {
    local.frequency = patch.frequency
    local.frequencyHistory = habitFrequencyHistoryAfter({
      history: habit.frequencyHistory,
      frequency: patch.frequency,
      changeDate: localDateIn(now, habit.timeZone)
    })
  }
  await store.writeLocal({
    entityType: "habit",
    entityId: habit.id,
    op: "upsert",
    patch: local,
    now
  })
}

/** Soft delete — the row and its entries stay, so undo returns the same habit. */
export const deleteHabitInMirror = async (
  store: LocalStore,
  id: string,
  now: string = new Date().toISOString()
): Promise<void> => {
  await store.writeLocal({
    entityType: "habit",
    entityId: id,
    op: "delete",
    patch: {},
    now
  })
}

/**
 * Undo a soft delete in place.
 *
 * This queues a local-first empty-patch upsert so the habit returns before any
 * network. `/sync/push` deliberately keeps tombstone-wins, so the engine
 * repairs that queued undo through the explicit `RestoreHabit` mutation (#63),
 * exactly as it repairs a queued habit tap (#64).
 */
export const restoreHabitInMirror = async (
  store: LocalStore,
  id: string,
  now: string = new Date().toISOString()
): Promise<void> => {
  await store.writeLocal({
    entityType: "habit",
    entityId: id,
    op: "upsert",
    patch: {},
    deletedAt: null,
    now
  })
}

// ── Streak and rate projection ───────────────────────────────────────────

export type HabitWindowDays = 7 | 30 | 90

export const HABIT_WINDOW_DAYS: ReadonlyArray<HabitWindowDays> = [7, 30, 90]

/**
 * The habit's streak/rate result from the mirror's current rows.
 *
 * Recomputed on every call, on purpose: backfills and corrections make both
 * the streak and `best` non-monotonic (E5, E6), so a cache would disagree with
 * the entries it claims to describe.
 */
export const habitStatsFor = (
  habit: HabitRow,
  entries: ReadonlyArray<HabitEntryRow>,
  today: LocalDate,
  windowDays: HabitWindowDays
): StreakResult =>
  habitStreak({
    startedOn: habit.startedOn,
    frequencyHistory: habit.frequencyHistory,
    entries: entries
      .filter((entry) => entry.habitId === habit.id)
      .map((entry) => ({ localDate: entry.localDate, status: entry.status })),
    today,
    windowDays
  })

/** Today's entry for a habit, or `undefined` when the day is still blank. */
export const habitEntryOn = (
  entries: ReadonlyArray<HabitEntryRow>,
  habitId: string,
  localDate: LocalDate
): HabitEntryRow | undefined =>
  entries.find((entry) => entry.habitId === habitId && entry.localDate === localDate)

// ── Copy (Persian, digits-aware) ─────────────────────────────────────────

const PERSIAN_WEEKDAY_ORDER: ReadonlyArray<number> = [6, 7, 1, 2, 3, 4, 5]

const weekdayName = (isoDay: number): string => {
  const names: Readonly<Record<number, string>> = {
    1: "دوشنبه",
    2: "سه‌شنبه",
    3: "چهارشنبه",
    4: "پنج‌شنبه",
    5: "جمعه",
    6: "شنبه",
    7: "یکشنبه"
  }
  return names[isoDay] ?? ""
}

/** «هر روز» / «شنبه، دوشنبه، چهارشنبه» / «۳ بار در هفته». */
export const habitFrequencyLabel = (
  frequency: HabitFrequency,
  digits: Digits = "persian"
): string => {
  if (frequency._tag === "daily") return "هر روز"
  if (frequency._tag === "weekly") {
    return `${localizeDigits(frequency.times, digits)} بار در هفته`
  }
  const selected = [...frequency.days].sort(
    (left, right) =>
      PERSIAN_WEEKDAY_ORDER.indexOf(left) - PERSIAN_WEEKDAY_ORDER.indexOf(right)
  )
  return selected.map(weekdayName).join("، ")
}

/** A Jalali date range, e.g. «۲۵ مهر – ۱ آبان» for the fixed counting week. */
export const formatDateRange = (
  start: LocalDate,
  end: LocalDate,
  digits: Digits = "persian"
): string =>
  `${formatJalaliDate(toJalaliDate(start), { digits, style: "short" })} – ${
    formatJalaliDate(toJalaliDate(end), { digits, style: "short" })
  }`

export const habitStreakLabel = (result: StreakResult, digits: Digits = "persian"): string => {
  if (result.current.count === 0) return "بدون زنجیره"
  const unit = result.current.unit === "week" ? "هفته" : "روز"
  return `${localizeDigits(result.current.count, digits)} ${unit} پیاپی`
}

export const habitBestLabel = (result: StreakResult, digits: Digits = "persian"): string => {
  const best =
    result.current.unit === "week" ? result.best.weeks : result.best.days
  const unit = result.current.unit === "week" ? "هفته" : "روز"
  return best === 0
    ? "بهترین: —"
    : `بهترین: ${localizeDigits(best, digits)} ${unit}`
}

/** Progress of the open period, e.g. «۲ از ۳ این هفته». */
export const habitOpenProgressLabel = (
  result: StreakResult,
  digits: Digits = "persian"
): string | null => {
  const open = result.open
  if (open === null || open.satisfied) return null
  const suffix = open.unit === "week" ? "این هفته" : "امروز"
  return `${localizeDigits(open.credit, digits)} از ${localizeDigits(open.requirement, digits)} ${suffix}`
}

export interface HabitRateCopy {
  readonly kind: "rate" | "progress" | "none"
  readonly label: string
}

/**
 * The rate line.
 *
 * A `null` rate is never rendered as `0%`: a week-unit habit whose only week is
 * the unfinished open one shows its progress instead (E13), and a day-unit
 * habit with no qualifying expected day falls back to today's progress.
 */
export const habitRateCopy = (
  result: StreakResult,
  digits: Digits = "persian"
): HabitRateCopy => {
  if (result.rate !== null) {
    const percent = Math.round(result.rate * 100)
    return { kind: "rate", label: `${localizeDigits(percent, digits)}٪` }
  }
  const progress = habitOpenProgressLabel(result, digits)
  if (progress !== null) return { kind: "progress", label: progress }
  if (result.open !== null) {
    // A satisfied open period can still be outside the rate (the mid-week
    // opening week, E9); show its progress rather than an invented percentage.
    const suffix = result.open.unit === "week" ? "این هفته" : "امروز"
    return {
      kind: "progress",
      label: `${localizeDigits(result.open.credit, digits)} از ${
        localizeDigits(result.open.requirement, digits)
      } ${suffix}`
    }
  }
  return { kind: "none", label: "بدون داده در این بازه" }
}

/**
 * The counting period a week-unit result is judged over. Shown on the stats row
 * so the fixed Saturday–Friday turn stays visible even when the display Week
 * Start is Sunday or Monday (ADR-0007).
 */
export const habitCountingPeriodLabel = (
  result: StreakResult,
  digits: Digits = "persian"
): string | null =>
  result.current.unit === "week" && result.open !== null
    ? formatDateRange(result.open.start, result.open.end, digits)
    : null

export const habitStatusLabel = (status: HabitEntryStatus | null): string => {
  switch (status) {
    case "done":
      return "انجام شد"
    case "partial":
      return "نیمه"
    case "missed":
      return "از دست رفت"
    case null:
      return "ثبت نشده"
  }
}

export const habitStatusIcon = (status: HabitEntryStatus | null): string => {
  switch (status) {
    case "done":
      return "✓"
    case "partial":
      return "◐"
    case "missed":
      return "✕"
    case null:
      return "○"
  }
}

// ── Monthly heatmap ──────────────────────────────────────────────────────

export interface HabitHeatCell {
  readonly date: LocalDate
  readonly inMonth: boolean
  readonly day: number
  /** The raw entry status; `null` is a blank day (never a verdict inside an open period). */
  readonly status: HabitEntryStatus | null
}

export interface HabitHeatmapMonth {
  readonly year: number
  readonly month: number
  readonly label: string
  readonly weekdayLabels: ReadonlyArray<string>
  readonly weeks: ReadonlyArray<ReadonlyArray<HabitHeatCell>>
}

/**
 * One Jalali month of raw entry statuses for one habit.
 *
 * The heatmap paints what was logged (done / partial / missed / blank) and
 * never re-derives weights or quotas, so it cannot disagree with `habitStreak`
 * by construction. A blank cell and a `missed` cell are deliberately different
 * colours: the algorithm treats blank as "not a done" and missed as an explicit
 * answer, and the screen must not collapse them.
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
  const digits = input.digits ?? "persian"
  const weekStart = input.weekStart ?? "saturday"
  const statuses = new Map<string, HabitEntryStatus>()
  for (const entry of input.entries) {
    if (entry.habitId !== input.habitId) continue
    statuses.set(entry.localDate, entry.status)
  }
  const grid = jalaliMonthGrid(input.year, input.month, { weekStart })
  const offset =
    weekStart === "saturday" ? 0 : weekStart === "sunday" ? 1 : 2
  const weekdayLabels = Array.from({ length: 7 }, (_, index) =>
    weekdayName(PERSIAN_WEEKDAY_ORDER[(offset + index) % 7]!)
  )
  return {
    year: grid.year,
    month: grid.month,
    label: formatJalaliDate(jalaliDate(grid.year, grid.month, 1), {
      digits,
      style: "medium"
    }),
    weekdayLabels,
    weeks: grid.weeks.map((week) =>
      week.days.map((day): HabitHeatCell => {
        const date = toIsoDate(day.date) as LocalDate
        return {
          date,
          inMonth: day.inMonth,
          day: toJalaliFields(day.date).day,
          status: statuses.get(date) ?? null
        }
      })
    )
  }
}

/** The Jalali year/month containing a local date (the heatmap's initial bucket). */
export const habitMonthOf = (today: LocalDate): { year: number; month: number } => {
  const fields = toJalaliFields(toJalaliDate(today))
  return { year: fields.year, month: fields.month }
}

/** Move one Jalali month, without touching the local-date arithmetic anywhere else. */
export const shiftHabitMonth = (
  year: number,
  month: number,
  delta: number
): { year: number; month: number } => {
  const zero = month - 1 + delta
  return {
    year: year + Math.floor(zero / 12),
    month: ((zero % 12) + 12) % 12 + 1
  }
}

// ── Form presets ─────────────────────────────────────────────────────────

export const HABIT_COLORS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "#2f5fe0", label: "آبی" },
  { value: "#0f9d8f", label: "سبزآبی" },
  { value: "#2e9d57", label: "سبز" },
  { value: "#d9822b", label: "نارنجی" },
  { value: "#c94f7c", label: "صورتی" },
  { value: "#7a5af8", label: "بنفش" }
]

export const HABIT_ICONS: ReadonlyArray<string> = ["📚", "🏃", "💧", "🧘", "💊", "🌱", "✍️", "🛏️"]
