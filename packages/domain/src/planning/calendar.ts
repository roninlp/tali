import { Schema } from "effect"
import { Temporal } from "temporal-polyfill/full"
import { WeekStart } from "../common.js"
import {
  jalaliMonthGrid,
  jalaliWeek,
  toIsoDate,
  toJalaliDate,
  toJalaliDateInZone
} from "../jalali.js"
import {
  occurrenceDates,
  RecurrenceRule,
  TaskRecurrenceMode
} from "../recurrence.js"
import {
  LocalDate,
  Priority,
  TaskId,
  TaskStatus,
  TimeZone
} from "./common.js"

/**
 * Week and month read models (ticket #43; FR-VIEW-02/03).
 *
 * The calendar is a *projection* of the task aggregate, not a second store.
 * One pure builder serves both the API (`GET /week`, `GET /month`) and the
 * offline client (the IndexedDB mirror), so the same rows always paint the
 * same week and month — online or off, before or after a sync ack.
 *
 * ## Recurring tasks are expanded, never materialised
 *
 * A recurring task is one real row (#38). The server creates the next instance
 * only when the series is completed, so a future week has no rows for its
 * future occurrences. The read model expands the **shared** recurrence engine
 * (`expandOccurrences`) over the requested range and marks every generated
 * occurrence `projected: true`. Projected items are read-only: the client must
 * not write them, complete them, or queue them; only the real row is mutated.
 * When the real instance is completed the server spawns its successor exactly
 * as before, and the projection stops including the old anchor.
 *
 * `onCompletion` series are deliberately **not** projected: their next date
 * depends on when the work actually happens, so showing one in advance would
 * invent a schedule. Only the current live instance appears.
 *
 * ## Ranges and calendars
 *
 * A week is seven Jalali wall dates starting at the user's configured week
 * start (#35). A month is a Jalali month grid with whole weeks, including the
 * leading/trailing cells borrowed from adjacent months (`inMonth: false`).
 * Both are calendar-date ranges; timed tasks are placed by their local date in
 * the viewer's IANA zone, so a DST transition cannot move an item to another
 * day. Date arithmetic stays in `jalali.ts`/Temporal — this module never
 * reimplements Jalali month lengths or week starts.
 *
 * Event, reminder and habit lanes are part of the shape from day one
 * (`counts`/`empty`), but stay zero/quiet until their slices land. The month
 * model reserves the same shape for the Slice 4 habit trend strip.
 */

// ── Read-model schemas ───────────────────────────────────────────────────

export const CalendarLaneCounts = Schema.Struct({
  tasks: Schema.Int,
  events: Schema.Int,
  reminders: Schema.Int,
  habits: Schema.Int
})
export type CalendarLaneCounts = Schema.Schema.Type<typeof CalendarLaneCounts>

export const CalendarLaneEmpty = Schema.Struct({
  tasks: Schema.Boolean,
  events: Schema.Boolean,
  reminders: Schema.Boolean,
  habits: Schema.Boolean
})
export type CalendarLaneEmpty = Schema.Schema.Type<typeof CalendarLaneEmpty>

/**
 * One task on one calendar day.
 *
 * `key` is unique inside a day: the task id for the real row, and
 * `id@YYYY-MM-DD` for a projected repeat (the same task can appear on several
 * days of a week). `projected` is the read-only flag; the UI never renders a
 * write control for it.
 */
export const CalendarTaskItem = Schema.Struct({
  key: Schema.String,
  id: TaskId,
  title: Schema.String,
  status: TaskStatus,
  priority: Priority,
  date: LocalDate,
  projected: Schema.Boolean,
  /** True when the item belongs to a recurring series (projected or real). */
  recurring: Schema.Boolean
})
export type CalendarTaskItem = Schema.Schema.Type<typeof CalendarTaskItem>

/**
 * The live task rows the read model was projected from. Shipping the source
 * rows (not just the per-day items) is what lets the client overlay an unsent
 * local patch on the server's snapshot and re-run the same builders — so a
 * priority/move/quick-add stays visible without dropping server-only rows or
 * inventing a second aggregation.
 */
export const CalendarSourceTask = Schema.Struct({
  id: TaskId,
  title: Schema.String,
  status: TaskStatus,
  priority: Priority,
  dueDate: Schema.NullOr(LocalDate),
  dueAt: Schema.NullOr(Schema.String),
  recurrence: Schema.NullOr(RecurrenceRule),
  recurrenceMode: Schema.NullOr(TaskRecurrenceMode)
})
export type CalendarSourceTask = Schema.Schema.Type<typeof CalendarSourceTask>

export const CalendarDayView = Schema.Struct({
  date: LocalDate,
  tasks: Schema.Array(CalendarTaskItem),
  counts: CalendarLaneCounts,
  empty: CalendarLaneEmpty
})
export type CalendarDayView = Schema.Schema.Type<typeof CalendarDayView>

export const WeekReadModel = Schema.Struct({
  /** First and last of the seven days (inclusive). */
  start: LocalDate,
  end: LocalDate,
  timeZone: TimeZone,
  weekStart: WeekStart,
  days: Schema.Array(CalendarDayView),
  totals: CalendarLaneCounts,
  empty: CalendarLaneEmpty,
  /** The live rows this week was projected from (for local-first overlays). */
  tasks: Schema.Array(CalendarSourceTask)
})
export type WeekReadModel = Schema.Schema.Type<typeof WeekReadModel>

/**
 * One month-grid cell. Busy marks are driven by the number of active tasks
 * (real + projected); `busyLevel` is the 0–3 dot scale the UI paints, while
 * `tasks` stays available to assistive technology and to a future tooltip.
 */
export const MonthDaySummary = Schema.Struct({
  date: LocalDate,
  inMonth: Schema.Boolean,
  isBusy: Schema.Boolean,
  tasks: Schema.Int,
  busyLevel: Schema.Int,
  counts: CalendarLaneCounts
})
export type MonthDaySummary = Schema.Schema.Type<typeof MonthDaySummary>

export const MonthReadModel = Schema.Struct({
  /** Jalali year/month the grid is anchored to. */
  year: Schema.Int,
  month: Schema.Int,
  start: LocalDate,
  end: LocalDate,
  timeZone: TimeZone,
  weekStart: WeekStart,
  days: Schema.Array(MonthDaySummary),
  totals: Schema.Struct({
    busyDays: Schema.Int,
    tasks: Schema.Int
  }),
  /** The live rows this month was projected from (for local-first overlays). */
  tasks: Schema.Array(CalendarSourceTask),
  /** Drill-down for the requested day; `null` when none was asked for. */
  day: Schema.NullOr(CalendarDayView)
})
export type MonthReadModel = Schema.Schema.Type<typeof MonthReadModel>

// ── Inputs ───────────────────────────────────────────────────────────────

/**
 * The fields both a server `Task` and a mirrored row can provide. Keeping the
 * builder on this structural shape is what lets the offline client reuse it
 * without hydrating a full aggregate (the mirror may hold a partial patch).
 */
export interface CalendarTaskSource {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  readonly priority: Priority
  readonly dueDate: string | null
  readonly dueAt: string | null
  readonly recurrence: RecurrenceRule | null
  readonly recurrenceMode: TaskRecurrenceMode | null
}

export interface CalendarRange {
  /** Inclusive first day. */
  readonly start: LocalDate
  /** Inclusive last day. */
  readonly end: LocalDate
  /** Exclusive upper bound (`end + 1 day`). */
  readonly endExclusive: LocalDate
}

// ── Calendar ranges ──────────────────────────────────────────────────────

const asLocalDate = (value: string | Temporal.PlainDate): LocalDate =>
  (typeof value === "string" ? toIsoDate(toJalaliDate(value)) : toIsoDate(value)) as LocalDate

/** The seven days of `anchor`'s configured week, in display order. */
export const weekDates = (
  anchor: string | Temporal.PlainDate,
  weekStart: WeekStart
): ReadonlyArray<LocalDate> =>
  jalaliWeek(toJalaliDate(anchor), weekStart).map((date) =>
    toIsoDate(date)
  ) as ReadonlyArray<LocalDate>

export const weekRange = (
  anchor: string | Temporal.PlainDate,
  weekStart: WeekStart
): CalendarRange => {
  const days = weekDates(anchor, weekStart)
  return {
    start: days[0]!,
    end: days[days.length - 1]!,
    endExclusive: toIsoDate(
      Temporal.PlainDate.from(days[days.length - 1]!).add({ days: 1 })
    ) as LocalDate
  }
}

/** The single-day range a month drill-down is projected over. */
export const singleDayRange = (date: string | Temporal.PlainDate): CalendarRange => {
  const day = asLocalDate(date)
  return {
    start: day,
    end: day,
    endExclusive: toIsoDate(
      Temporal.PlainDate.from(day).add({ days: 1 })
    ) as LocalDate
  }
}

export interface JalaliMonthKey {
  readonly year: number
  readonly month: number
}

/** The Jalali year/month containing `anchor`. */
export const jalaliMonthOf = (
  anchor: string | Temporal.PlainDate
): JalaliMonthKey => {
  const jalali = toJalaliDate(anchor)
  return { year: jalali.year, month: jalali.month }
}

/** The whole-week range covered by a Jalali month grid. */
export const monthRange = (
  year: number,
  month: number,
  weekStart: WeekStart
): CalendarRange & { readonly days: ReadonlyArray<{ readonly date: LocalDate; readonly inMonth: boolean }> } => {
  const grid = jalaliMonthGrid(year, month, { weekStart })
  const days = grid.weeks.flatMap((week) =>
    week.days.map((day) => ({
      date: toIsoDate(day.date) as LocalDate,
      inMonth: day.inMonth
    }))
  )
  return {
    start: days[0]!.date,
    end: days[days.length - 1]!.date,
    endExclusive: toIsoDate(grid.end.add({ days: 1 })) as LocalDate,
    days
  }
}

// ── Occurrence expansion ─────────────────────────────────────────────────

const localDateOfInstant = (instant: string, timeZone: string): string | null => {
  const millis = Date.parse(instant)
  if (!Number.isFinite(millis)) return null
  return toIsoDate(toJalaliDateInZone(new Date(millis), timeZone))
}

const priorityRank: Record<Priority, number> = { high: 0, medium: 1, low: 2 }

const compareItems = (a: CalendarTaskItem, b: CalendarTaskItem): number =>
  priorityRank[a.priority] - priorityRank[b.priority] ||
  a.title.localeCompare(b.title, "fa") ||
  a.key.localeCompare(b.key)

const item = (
  source: CalendarTaskSource,
  date: LocalDate,
  projected: boolean
): CalendarTaskItem => ({
  key: projected ? `${source.id}@${date}` : source.id,
  id: source.id as TaskId,
  title: source.title,
  status: source.status,
  priority: source.priority,
  date,
  projected,
  recurring: source.recurrence !== null
})

const inRange = (date: string, range: CalendarRange): boolean =>
  date >= range.start && date <= range.end

/**
 * Project every live task onto the calendar range.
 *
 * - The real row lands on its own due day when that day is in range.
 * - A recurring row additionally contributes generated occurrences within the
 *   range, except the anchor day the real row already covers. `onCompletion`
 *   series are not projected (their next date is unknown until completion).
 * - Done rows are dropped: a calendar shows the work still to plan.
 */
export const taskOccurrences = (input: {
  readonly tasks: ReadonlyArray<CalendarTaskSource>
  readonly range: CalendarRange
  readonly timeZone: string
}): ReadonlyArray<CalendarTaskItem> => {
  const occurrences: Array<CalendarTaskItem> = []
  const seen = new Set<string>()
  // A duplicated row in the source (e.g. a range query plus the recurring
  // query returning the same task) must not paint twice.
  const byId = new Map<string, CalendarTaskSource>()
  for (const task of input.tasks) byId.set(task.id, task)

  for (const task of byId.values()) {
    if (task.status === "done") continue
    const dueDate = task.dueDate ?? (
      task.dueAt === null ? null : localDateOfInstant(task.dueAt, input.timeZone)
    )
    if (dueDate === null) continue

    if (inRange(dueDate, input.range)) {
      const real = item(task, dueDate as LocalDate, false)
      if (!seen.has(real.key)) {
        seen.add(real.key)
        occurrences.push(real)
      }
    }

    if (
      task.recurrence === null ||
      (task.recurrenceMode ?? "onDueDate") === "onCompletion"
    ) {
      continue
    }

    const projected = occurrenceDates(task.recurrence, dueDate, {
      from: input.range.start,
      to: input.range.end
    })
    for (const date of projected) {
      if (date === dueDate) continue
      const next = item(task, date, true)
      if (seen.has(next.key)) continue
      seen.add(next.key)
      occurrences.push(next)
    }
  }

  return occurrences.sort(
    (a, b) => a.date.localeCompare(b.date) || compareItems(a, b)
  )
}

// ── Day views ────────────────────────────────────────────────────────────

const EMPTY_COUNTS: CalendarLaneCounts = {
  tasks: 0,
  events: 0,
  reminders: 0,
  habits: 0
}

const emptyFlags = (tasks: number): CalendarLaneEmpty => ({
  tasks: tasks === 0,
  // Quiet until Slices 3–4 supply real aggregates.
  events: true,
  reminders: true,
  habits: true
})

const dayViewFrom = (
  date: LocalDate,
  items: ReadonlyArray<CalendarTaskItem>
): CalendarDayView => ({
  date,
  tasks: items,
  counts: { ...EMPTY_COUNTS, tasks: items.length },
  empty: emptyFlags(items.length)
})

const itemsByDate = (
  occurrences: ReadonlyArray<CalendarTaskItem>
): ReadonlyMap<string, ReadonlyArray<CalendarTaskItem>> => {
  const map = new Map<string, Array<CalendarTaskItem>>()
  for (const occurrence of occurrences) {
    const bucket = map.get(occurrence.date)
    if (bucket === undefined) map.set(occurrence.date, [occurrence])
    else bucket.push(occurrence)
  }
  return map
}

/** Deduped source rows, in the wire shape the client overlays. */
const sourceRows = (
  tasks: ReadonlyArray<CalendarTaskSource>
): ReadonlyArray<CalendarSourceTask> => {
  const byId = new Map<string, CalendarTaskSource>()
  for (const task of tasks) byId.set(task.id, task)
  return [...byId.values()].map((task) => ({
    id: task.id as TaskId,
    title: task.title,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate as LocalDate | null,
    dueAt: task.dueAt,
    recurrence: task.recurrence,
    recurrenceMode: task.recurrenceMode
  }))
}

const addCounts = (
  total: CalendarLaneCounts,
  day: CalendarLaneCounts
): CalendarLaneCounts => ({
  tasks: total.tasks + day.tasks,
  events: total.events + day.events,
  reminders: total.reminders + day.reminders,
  habits: total.habits + day.habits
})

/**
 * Busy level for the month grid's subtle mark: one dot for a light day, two
 * for a full one, three for a heavy one. The count is still in the payload.
 */
export const busyLevelOf = (tasks: number): number =>
  tasks <= 0 ? 0 : tasks <= 2 ? 1 : tasks <= 5 ? 2 : 3

// ── Builders ─────────────────────────────────────────────────────────────

export interface BuildWeekInput {
  readonly tasks: ReadonlyArray<CalendarTaskSource>
  /** Any date in the week; defaults to the range's own start. */
  readonly anchor: string | Temporal.PlainDate
  readonly weekStart: WeekStart
  readonly timeZone: string
}

/** Build the seven-day read model from any set of live task rows. */
export const buildWeekReadModel = (input: BuildWeekInput): WeekReadModel => {
  const range = weekRange(input.anchor, input.weekStart)
  const occurrences = taskOccurrences({
    tasks: input.tasks,
    range,
    timeZone: input.timeZone
  })
  const grouped = itemsByDate(occurrences)
  const days = weekDates(input.anchor, input.weekStart).map((date) =>
    dayViewFrom(date, grouped.get(date) ?? [])
  )
  const totals = days.reduce(
    (sum, day) => addCounts(sum, day.counts),
    EMPTY_COUNTS
  )
  return {
    start: range.start,
    end: range.end,
    timeZone: input.timeZone,
    weekStart: input.weekStart,
    days,
    totals,
    empty: emptyFlags(totals.tasks),
    tasks: sourceRows(input.tasks)
  }
}

export interface BuildMonthInput {
  readonly tasks: ReadonlyArray<CalendarTaskSource>
  readonly year: number
  readonly month: number
  readonly weekStart: WeekStart
  readonly timeZone: string
  /** Optional drill-down day; any local date, not necessarily in the month. */
  readonly day?: string | null
}

/** Build a Jalali month grid plus an optional day drill-down. */
export const buildMonthReadModel = (input: BuildMonthInput): MonthReadModel => {
  const range = monthRange(input.year, input.month, input.weekStart)
  const occurrences = taskOccurrences({
    tasks: input.tasks,
    range,
    timeZone: input.timeZone
  })
  const grouped = itemsByDate(occurrences)
  const days: Array<MonthDaySummary> = range.days.map((cell) => {
    const tasks = grouped.get(cell.date)?.length ?? 0
    const counts = { ...EMPTY_COUNTS, tasks }
    return {
      date: cell.date,
      inMonth: cell.inMonth,
      isBusy: tasks > 0,
      tasks,
      busyLevel: busyLevelOf(tasks),
      counts
    }
  })

  const inMonthDays = days.filter((day) => day.inMonth)
  const totals = {
    busyDays: inMonthDays.filter((day) => day.isBusy).length,
    tasks: inMonthDays.reduce((sum, day) => sum + day.tasks, 0)
  }

  let day: CalendarDayView | null = null
  if (input.day !== undefined && input.day !== null && input.day !== "") {
    const drillRange = singleDayRange(input.day)
    day = dayViewFrom(
      drillRange.start,
      taskOccurrences({
        tasks: input.tasks,
        range: drillRange,
        timeZone: input.timeZone
      })
    )
  }

  return {
    year: input.year,
    month: input.month,
    start: range.start,
    end: range.end,
    timeZone: input.timeZone,
    weekStart: input.weekStart,
    days,
    totals,
    tasks: sourceRows(input.tasks),
    day
  }
}
