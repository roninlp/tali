import { Schema } from "effect"
import { Temporal } from "temporal-polyfill/full"
import type { LocalDate, TaskStatus } from "./common.js"

/**
 * Due-date buckets for the Today screen (FR-TASK-05, ticket #36).
 *
 * Bucketing is a *local-calendar* question: "today" is the user's wall date in
 * their IANA zone, never the server's UTC date. All-day tasks carry a
 * `YYYY-MM-DD` wall date (and the zone it was written in); timed tasks carry a
 * UTC instant. Both are placed with the same boundary set so a DST transition
 * cannot make a day longer/shorter in the comparison (the boundaries are zoned
 * day starts, not fixed 24h offsets).
 *
 * `thisWeek` is the upcoming rolling week: the seven days after tomorrow
 * (`today + 2 … today + 7`). Overdue, today and tomorrow are disjoint, so a
 * task is in exactly one bucket; a task further out is `later` and no-date
 * tasks are `noDate` (they never appear under Today).
 */

export const TASK_BUCKETS = [
  "overdue",
  "today",
  "tomorrow",
  "thisWeek",
  "noDate"
] as const

export const TaskBucket = Schema.Literals(TASK_BUCKETS)
export type TaskBucket = Schema.Schema.Type<typeof TaskBucket>

/** Placement includes the two non-bucketed outcomes (done/far future). */
export type TaskBucketPlacement = TaskBucket | "later" | "done"

export interface TaskBucketBounds {
  readonly timeZone: string
  /** The user's wall date right now (`YYYY-MM-DD`). */
  readonly today: LocalDate
  readonly tomorrow: LocalDate
  /** First day after tomorrow (`today + 2`). */
  readonly dayAfterTomorrow: LocalDate
  /** Last day of the rolling upcoming week (`today + 7`). */
  readonly weekEnd: LocalDate
  /** First day after the rolling week (`today + 8`); exclusive upper date. */
  readonly weekAfter: LocalDate
  /** Start of `today` as a UTC ISO instant. */
  readonly todayStart: string
  readonly tomorrowStart: string
  readonly dayAfterTomorrowStart: string
  /** Start of `today + 8`; the exclusive end of `thisWeek`. */
  readonly weekEndExclusive: string
}

export type TaskBucketDateInput = Date | string | Temporal.Instant

const asInstant = (now: TaskBucketDateInput): Temporal.Instant =>
  now instanceof Temporal.Instant
    ? now
    : typeof now === "string"
    ? Temporal.Instant.from(now)
    : Temporal.Instant.fromEpochMilliseconds(now.getTime())

const localDateAt = (
  date: Temporal.PlainDate,
  timeZone: string
): string => date.toZonedDateTime(timeZone).toInstant().toString()

/** UTC instant at which a local calendar date starts in `timeZone`. */
export const localDateStartInstant = (date: string, timeZone: string): string =>
  localDateAt(Temporal.PlainDate.from(date), timeZone)

/**
 * The boundary set a bucket query and `taskBucketOf` must share. Computing it
 * once per request keeps the SQL range query and the in-memory grouping from
 * disagreeing across a midnight/DST edge.
 */
export const taskBucketBounds = (
  timeZone: string,
  now: TaskBucketDateInput
): TaskBucketBounds => {
  const today = asInstant(now).toZonedDateTimeISO(timeZone).toPlainDate()
  const tomorrow = today.add({ days: 1 })
  const dayAfterTomorrow = today.add({ days: 2 })
  const weekEnd = today.add({ days: 7 })
  return {
    timeZone,
    today: today.toString() as LocalDate,
    tomorrow: tomorrow.toString() as LocalDate,
    dayAfterTomorrow: dayAfterTomorrow.toString() as LocalDate,
    weekEnd: weekEnd.toString() as LocalDate,
    weekAfter: today.add({ days: 8 }).toString() as LocalDate,
    todayStart: localDateAt(today, timeZone),
    tomorrowStart: localDateAt(tomorrow, timeZone),
    dayAfterTomorrowStart: localDateAt(dayAfterTomorrow, timeZone),
    weekEndExclusive: localDateAt(today.add({ days: 8 }), timeZone)
  }
}

export interface TaskBucketShape {
  readonly dueAt: string | null
  readonly dueDate: string | null
  readonly status: TaskStatus
}

/**
 * Place one task in a bucket. Pure and time-zone aware; the service calls it
 * only for rows returned by the SQL range queries, so it is also the
 * authoritative tie-breaker at boundary instants.
 */
export const taskBucketOf = (
  task: TaskBucketShape,
  bounds: TaskBucketBounds
): TaskBucketPlacement => {
  if (task.status === "done") return "done"
  if (task.dueDate === null && task.dueAt === null) return "noDate"

  if (task.dueAt !== null) {
    const due = Date.parse(task.dueAt)
    if (!Number.isFinite(due)) return "later"
    if (due < Date.parse(bounds.todayStart)) return "overdue"
    if (due < Date.parse(bounds.tomorrowStart)) return "today"
    if (due < Date.parse(bounds.dayAfterTomorrowStart)) return "tomorrow"
    if (due < Date.parse(bounds.weekEndExclusive)) return "thisWeek"
    return "later"
  }

  // `YYYY-MM-DD` strings sort lexicographically by calendar date.
  if (task.dueDate! < bounds.today) return "overdue"
  if (task.dueDate === bounds.today) return "today"
  if (task.dueDate === bounds.tomorrow) return "tomorrow"
  if (task.dueDate! <= bounds.weekEnd) return "thisWeek"
  return "later"
}
