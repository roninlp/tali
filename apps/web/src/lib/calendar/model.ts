import {
  addJalaliMonths,
  buildMonthReadModel,
  buildWeekReadModel,
  formatJalaliDate,
  formatJalaliMonth,
  jalaliMonthOf,
  localizeDigits,
  toIsoDate,
  toJalaliDate,
  toJalaliDateInZone,
  type CalendarEventSource,
  type CalendarOccasionSource,
  type CalendarTaskSource,
  type Digits,
  type MonthReadModel,
  type Priority,
  type RecurrenceRule,
  type TaskRecurrenceMode,
  type UserPreferences,
  type WeekReadModel,
  type WeekStart
} from "@tali/domain"
import type { MirrorRecord } from "../local-store"
import { eventSourcesFromMirror } from "../events/model"

/**
 * The `/calendar` client model (ticket #43).
 *
 * The browser renders the same domain read models the API serves: the server
 * payload when online, and a projection built from the IndexedDB mirror when
 * offline or while the outbox still holds writes. Reusing the domain builders
 * means the offline week cannot disagree with the online one at a Jalali month
 * edge, a DST change or a recurrence boundary.
 *
 * The mirror only stores the fields a local patch wrote plus whatever sync
 * pulled back, so the source adapter is deliberately lenient — a missing
 * field becomes a benign default rather than a blank day.
 */

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null

const asStatus = (value: unknown): CalendarTaskSource["status"] =>
  value === "doing" || value === "done" ? value : "todo"

const asPriority = (value: unknown): Priority =>
  value === "high" || value === "low" ? value : "medium"

const asRecurrenceMode = (value: unknown): TaskRecurrenceMode | null =>
  value === "onCompletion" || value === "onDueDate" ? value : null

/** Rules are stored as JSON text on the row and object-decoded in the mirror. */
const asRecurrence = (value: unknown): RecurrenceRule | null => {
  let parsed: unknown = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (parsed === null || typeof parsed !== "object") return null
  const candidate = parsed as Record<string, unknown>
  if (typeof candidate.frequency !== "string" || candidate.end === undefined) return null
  return parsed as RecurrenceRule
}

/** One mirrored task row → the structural shape the builders consume. */
export const taskSourceFromMirror = (record: MirrorRecord): CalendarTaskSource => ({
  id: record.entityId,
  title: typeof record.data.title === "string" ? record.data.title : "",
  status: asStatus(record.data.status),
  priority: asPriority(record.data.priority),
  dueDate: asNullableString(record.data.dueDate),
  dueAt: asNullableString(record.data.dueAt),
  recurrence: asRecurrence(record.data.recurrence),
  recurrenceMode: asRecurrenceMode(record.data.recurrenceMode)
})

export const taskSourcesFromMirror = (
  records: ReadonlyArray<MirrorRecord>
): ReadonlyArray<CalendarTaskSource> => records.map(taskSourceFromMirror)

export const weekFromMirror = (input: {
  readonly tasks: ReadonlyArray<MirrorRecord>
  readonly events?: ReadonlyArray<MirrorRecord>
  readonly occasions?: ReadonlyArray<CalendarOccasionSource>
  readonly anchor: string
  readonly weekStart: WeekStart
  readonly timeZone: string
}): WeekReadModel =>
  buildWeekReadModel({
    tasks: taskSourcesFromMirror(input.tasks),
    events: eventSourcesFromMirror(input.events ?? []),
    occasions: input.occasions ?? [],
    anchor: input.anchor,
    weekStart: input.weekStart,
    timeZone: input.timeZone
  })

export const monthFromMirror = (input: {
  readonly tasks: ReadonlyArray<MirrorRecord>
  readonly events?: ReadonlyArray<MirrorRecord>
  readonly occasions?: ReadonlyArray<CalendarOccasionSource>
  readonly anchor: string
  readonly weekStart: WeekStart
  readonly timeZone: string
  readonly day?: string | null
}): MonthReadModel => {
  const { year, month } = jalaliMonthOf(input.anchor)
  return buildMonthReadModel({
    tasks: taskSourcesFromMirror(input.tasks),
    events: eventSourcesFromMirror(input.events ?? []),
    occasions: input.occasions ?? [],
    year,
    month,
    weekStart: input.weekStart,
    timeZone: input.timeZone,
    day: input.day ?? null
  })
}

const has = (data: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(data, key)

/**
 * Merge one local mirror row over its server snapshot row. A mirror patch only
 * carries the fields the action changed (e.g. `{ priority }`), so replacing the
 * source wholesale would blank the title and due date the server supplied.
 */
const mergeSource = (
  base: CalendarTaskSource,
  record: MirrorRecord
): CalendarTaskSource => {
  const data = record.data
  return {
    ...base,
    title: typeof data.title === "string" ? data.title : base.title,
    status: data.status === "doing" || data.status === "done" || data.status === "todo"
      ? data.status
      : base.status,
    priority: data.priority === "high" || data.priority === "medium" || data.priority === "low"
      ? data.priority
      : base.priority,
    dueDate: has(data, "dueDate") ? asNullableString(data.dueDate) : base.dueDate,
    dueAt: has(data, "dueAt") ? asNullableString(data.dueAt) : base.dueAt,
    recurrence: has(data, "recurrence") ? asRecurrence(data.recurrence) : base.recurrence,
    recurrenceMode: has(data, "recurrenceMode")
      ? asRecurrenceMode(data.recurrenceMode)
      : base.recurrenceMode
  }
}

/**
 * Overlay the local writes the server snapshot has not seen yet. Only ids in
 * `overlayIds` (pending outbox rows + this screen's just-written rows) are
 * merged, so an unrelated mirror row can never roll the server back.
 */
export const overlayCalendarSources = (input: {
  readonly base: ReadonlyArray<CalendarTaskSource>
  readonly mirror: ReadonlyArray<MirrorRecord>
  readonly overlayIds: ReadonlySet<string>
}): ReadonlyArray<CalendarTaskSource> => {
  const byId = new Map(input.base.map((task) => [task.id, task] as const))
  const mirrorById = new Map(
    input.mirror.map((record) => [record.entityId, record] as const)
  )
  for (const id of input.overlayIds) {
    const record = mirrorById.get(id)
    if (record === undefined) continue
    const base = byId.get(id)
    byId.set(id, base === undefined ? taskSourceFromMirror(record) : mergeSource(base, record))
  }
  return [...byId.values()]
}

export const weekFromSources = (input: {
  readonly tasks: ReadonlyArray<CalendarTaskSource>
  readonly events?: ReadonlyArray<CalendarEventSource>
  readonly occasions?: ReadonlyArray<CalendarOccasionSource>
  readonly anchor: string
  readonly weekStart: WeekStart
  readonly timeZone: string
}): WeekReadModel =>
  buildWeekReadModel({
    tasks: input.tasks,
    events: input.events ?? [],
    occasions: input.occasions ?? [],
    anchor: input.anchor,
    weekStart: input.weekStart,
    timeZone: input.timeZone
  })

export const monthFromSources = (input: {
  readonly tasks: ReadonlyArray<CalendarTaskSource>
  readonly events?: ReadonlyArray<CalendarEventSource>
  readonly occasions?: ReadonlyArray<CalendarOccasionSource>
  readonly year: number
  readonly month: number
  readonly weekStart: WeekStart
  readonly timeZone: string
  readonly day?: string | null
}): MonthReadModel =>
  buildMonthReadModel({
    tasks: input.tasks,
    events: input.events ?? [],
    occasions: input.occasions ?? [],
    year: input.year,
    month: input.month,
    weekStart: input.weekStart,
    timeZone: input.timeZone,
    day: input.day ?? null
  })

/**
 * Overlay local occasion writes the server snapshot has not seen yet, exactly
 * like the task and event lanes. Occasion rows are few, so the merge is by id
 * over the full set rather than a range query.
 */
export const overlayOccasionSources = (input: {
  readonly base: ReadonlyArray<CalendarOccasionSource>
  readonly mirror: ReadonlyArray<CalendarOccasionSource>
  readonly overlayIds: ReadonlySet<string>
  /** Overlaid ids deleted locally: the server's chip must disappear at once. */
  readonly deletedIds?: ReadonlySet<string>
}): ReadonlyArray<CalendarOccasionSource> => {
  const byId = new Map(input.base.map((occasion) => [occasion.id, occasion] as const))
  const mirrorById = new Map(
    input.mirror.map((occasion) => [occasion.id, occasion] as const)
  )
  for (const id of input.overlayIds) {
    if (input.deletedIds?.has(id) === true) {
      byId.delete(id)
      continue
    }
    const local = mirrorById.get(id)
    if (local === undefined) continue
    byId.set(id, local)
  }
  return [...byId.values()]
}

// ── Display helpers (preference-driven) ──────────────────────────────────

type DisplayPreferences = Pick<UserPreferences, "digits" | "weekStart">

export const dayLabel = (date: string, digits: Digits): string =>
  formatJalaliDate(toJalaliDate(date), { digits, style: "long" })

export const shortDayLabel = (date: string, digits: Digits): string =>
  formatJalaliDate(toJalaliDate(date), { digits, style: "short" })

export const weekTitle = (
  start: string,
  end: string,
  digits: Digits
): string => `${shortDayLabel(start, digits)} – ${shortDayLabel(end, digits)}`

export const monthTitle = (anchor: string, digits: Digits): string => {
  const { year, month } = jalaliMonthOf(anchor)
  return formatJalaliMonth(year, month, digits)
}

export const monthDayLabel = (date: string, digits: Digits): string =>
  formatJalaliDate(toJalaliDate(date), { digits, style: "long" })

export const jalaliDayNumber = (date: string, digits: Digits): string =>
  localizeDigits(toJalaliFieldsDay(date), digits)

const toJalaliFieldsDay = (date: string): number => toJalaliDate(date).day

/** Shift a month anchor by whole Jalali months (calendar-correct at edges). */
export const shiftMonth = (anchor: string, months: number): string =>
  toIsoDate(addJalaliMonths(toJalaliDate(anchor), months))

/** Shift a day by whole calendar days. */
export const shiftDay = (date: string, days: number): string =>
  toIsoDate(toJalaliDate(date).add({ days }))

export const todayIn = (timeZone: string, now: Date = new Date()): string =>
  toIsoDate(toJalaliDateInZone(now, timeZone))

export const PRIORITY_LABELS: Readonly<Record<Priority, string>> = {
  high: "بالا",
  medium: "متوسط",
  low: "پایین"
}

export const emptyWeekCopy = "این هفته هنوز کاری ندارد."
export const emptyDayCopy = "این روز خالی است."

/** A compact count for an ARIA label (`۳ کار`). */
export const taskCountLabel = (count: number, digits: Digits): string =>
  `${localizeDigits(count, digits)} کار`

export type { DisplayPreferences }
