import { Schema } from "effect"
import { Temporal } from "temporal-polyfill/full"
import { occurrenceDates, type RecurrenceRule } from "../recurrence.js"
import { EventExceptionId, EventId, LocalDate, TimeZone } from "./common.js"
import {
  Event,
  type EventException,
  type EventExceptionOverrides,
  EventTiming
} from "./event.js"

/**
 * Event recurrence: expansion, per-occurrence exceptions and edit scope
 * (ticket #58; FR-CAL-03).
 *
 * The calendar arithmetic is **not** here: this module calls the shared #38
 * engine (`occurrenceDates` / `expandOccurrences`) exactly as the recurring
 * tasks do. It only turns the engine's local dates into event occurrences
 * (instants, all-day dates, overridden fields) and applies the "this
 * occurrence" / "this and following" edits to the series row.
 *
 * ## Occurrence keys
 *
 * `instanceId` is an occurrence's **local start date in the event's own zone**
 * (`YYYY-MM-DD`), per ADR-0004. Exceptions are keyed by it, and the expansion
 * produces it, so an occurrence can be addressed without materialising a row.
 *
 * ## Expansion is a read
 *
 * A series is one row. `eventOccurrences` projects that row onto a window and
 * marks every generated occurrence `projected: true`; the anchor row itself is
 * the one mutable occurrence (`projected: false`). Nothing is written, ever —
 * the #38 engine already guarantees Jalali leap months and bounded rules, and
 * the projection only reuses its dates.
 *
 * Overridden occurrences (`action: "override"`) are placed at *their* time
 * (which may fall on a different day or outside the series' own weekday); the
 * occurrence key still points at the rule date, so the exception is found
 * again on the next read. Deleted occurrences (`action: "delete"`) are simply
 * absent — they never shift the schedule.
 *
 * ## Edit scope
 *
 * - **this occurrence** — append/replace one exception on the same row.
 * - **this and following** — split the series: the old row's rule is truncated
 *   to the day before the occurrence and a new row starts at the occurrence.
 *   The new row is anchored on the edited occurrence's timing, so the rule grid
 *   continues in phase (a weekly series stays weekly); a count budget is
 *   reduced by the occurrences the old row already produced.
 */

// ── Read-model shape ─────────────────────────────────────────────────────

/**
 * One event occurrence inside a window.
 *
 * `key` is unique inside a day: the event id for the anchor row and
 * `id@instanceId` for a generated occurrence (the same series can appear on
 * several days of a week). `projected` is the read-only flag — generated
 * occurrences are never written, completed or patched; the series row is.
 */
export const EventOccurrence = Schema.Struct({
  key: Schema.String,
  id: EventId,
  /** Occurrence key: local start date in the event's zone. */
  instanceId: LocalDate,
  /** The day it is painted on, in the viewer's zone. */
  date: LocalDate,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  people: Schema.Array(Schema.String),
  /** The occurrence's own timing (overridden when an override applies). */
  timing: EventTiming,
  /** The zone the occurrence's all-day date / instants are read in. */
  timeZone: TimeZone,
  /** True for a generated occurrence; false for the series row itself. */
  projected: Schema.Boolean,
  /** True when the series has a recurrence rule (anchor row included). */
  recurring: Schema.Boolean,
  /** True when an `override` exception changed this occurrence. */
  overridden: Schema.Boolean,
  exceptionId: Schema.NullOr(EventExceptionId)
})
export type EventOccurrence = Schema.Schema.Type<typeof EventOccurrence>

/**
 * A local-date window: `from` is inclusive, `before` is exclusive (the same
 * convention as the other range inputs). The builder's own `to` is inclusive.
 */
export const EventOccurrenceQuery = Schema.Struct({
  from: LocalDate,
  before: LocalDate
})
export type EventOccurrenceQuery = Schema.Schema.Type<typeof EventOccurrenceQuery>

/**
 * The fields both a server `Event` and a mirrored row can provide. Keeping the
 * builder structural is what lets the offline client re-project the mirror
 * with the same code the API uses.
 */
export interface EventOccurrenceSource {
  readonly id: string
  readonly title: string
  readonly description: string | null
  readonly location: string | null
  readonly category: string | null
  readonly color: string | null
  readonly people: ReadonlyArray<string>
  readonly timing: EventTiming
  readonly timeZone: string
  readonly recurrence: RecurrenceRule | null
  readonly exceptions: ReadonlyArray<EventException>
}

// ── Local-date helpers ───────────────────────────────────────────────────

const plainDate = (date: string): Temporal.PlainDate => Temporal.PlainDate.from(date)

/** A local date the calendar can actually read (`2026-02-30` cannot). */
const isReadableDate = (date: string): boolean => {
  try {
    plainDate(date)
    return true
  } catch {
    return false
  }
}

/** The local date one day before `date` (`YYYY-MM-DD`). */
export const localDayBefore = (date: string): LocalDate =>
  plainDate(date).subtract({ days: 1 }).toString() as LocalDate

const localDayAfter = (date: string): LocalDate =>
  plainDate(date).add({ days: 1 }).toString() as LocalDate

const localDateOfInstant = (instant: string, timeZone: string): LocalDate =>
  Temporal.Instant.from(instant)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString() as LocalDate

const canonicalInstant = (instant: Temporal.Instant): string =>
  new Date(instant.epochMilliseconds).toISOString()

/** The series' anchor: its first occurrence date in its own zone. */
export const eventAnchorDate = (
  event: Pick<EventOccurrenceSource, "timing" | "timeZone">
): LocalDate =>
  event.timing._tag === "allDay"
    ? event.timing.date
    : localDateOfInstant(event.timing.start, event.timeZone)

/**
 * The series' timing projected onto one occurrence date.
 *
 * - All-day: the occurrence date itself.
 * - Timed: the series' **wall-clock** start time in its own zone, placed on the
 *   occurrence date (`compatible` moves a nonexistent spring-forward wall time
 *   forward, exactly as a clock does), and the anchor's **duration** kept
 *   afterwards. A DST change therefore keeps the displayed start time and the
 *   event's length; a gap start moves to the first real instant with the same
 *   duration instead of collapsing to zero.
 */
export const eventTimingOn = (
  event: Pick<EventOccurrenceSource, "timing" | "timeZone">,
  instanceId: string
): EventTiming => {
  if (event.timing._tag === "allDay") {
    return { _tag: "allDay", date: instanceId as LocalDate }
  }

  const anchorStart = Temporal.Instant.from(event.timing.start)
  const anchorEnd = Temporal.Instant.from(event.timing.end)
  const startTime = anchorStart.toZonedDateTimeISO(event.timeZone).toPlainTime()
  const duration = anchorEnd.since(anchorStart)

  const startInstant = plainDate(instanceId)
    .toPlainDateTime(startTime)
    .toZonedDateTime(event.timeZone, { disambiguation: "compatible" })
    .toInstant()

  return {
    _tag: "timed",
    start: canonicalInstant(startInstant),
    end: canonicalInstant(startInstant.add(duration))
  }
}

/** The day an occurrence is painted on, in the given viewer zone. */
export const occurrenceDisplayDate = (
  timing: EventTiming,
  timeZone: string,
  viewerTimeZone: string
): LocalDate =>
  timing._tag === "allDay"
    ? timing.date
    : localDateOfInstant(timing.start, viewerTimeZone)

// ── Occurrence identity ──────────────────────────────────────────────────

/**
 * Is `instanceId` an occurrence of this series?
 *
 * The anchor row always counts (it is a real event even if the rule's weekday
 * selectors do not include its own weekday); beyond it the shared engine
 * answers, so `count`/`until` bounds are respected.
 */
export const isEventOccurrence = (
  event: Pick<EventOccurrenceSource, "recurrence" | "timing" | "timeZone">,
  instanceId: string
): boolean => {
  const anchor = eventAnchorDate(event)
  if (instanceId === anchor) return true
  if (event.recurrence === null) return false
  return occurrenceDates(event.recurrence, anchor, {
    from: instanceId,
    to: instanceId
  }).includes(instanceId as LocalDate)
}

/** The occurrence overrides already stored for `instanceId`, if any. */
export const storedOccurrenceOverrides = (
  event: Pick<EventOccurrenceSource, "exceptions">,
  instanceId: string
): EventExceptionOverrides | null => {
  const exception = event.exceptions.find((entry) => entry.instanceId === instanceId)
  return exception?.action === "override" ? exception.overrides ?? {} : null
}

// ── Expansion ────────────────────────────────────────────────────────────

const occurrenceOf = (input: {
  readonly event: EventOccurrenceSource
  readonly instanceId: LocalDate
  readonly projected: boolean
  readonly viewerTimeZone: string
  readonly exception: EventException | undefined
}): EventOccurrence => {
  const { event, exception } = input
  const overrides = exception?.action === "override" ? exception.overrides ?? {} : {}
  const timing = overrides.timing ?? eventTimingOn(event, input.instanceId)
  const timeZone = overrides.timeZone ?? event.timeZone
  return {
    key: input.projected ? `${event.id}@${input.instanceId}` : event.id,
    id: event.id as EventId,
    instanceId: input.instanceId,
    date: occurrenceDisplayDate(timing, timeZone, input.viewerTimeZone),
    title: overrides.title ?? event.title,
    description: overrides.description !== undefined
      ? overrides.description
      : event.description,
    location: overrides.location !== undefined ? overrides.location : event.location,
    category: event.category,
    color: overrides.color !== undefined ? overrides.color : event.color,
    people: event.people,
    timing,
    timeZone: timeZone as TimeZone,
    projected: input.projected,
    recurring: event.recurrence !== null,
    overridden: exception?.action === "override",
    exceptionId: exception?.id ?? null
  }
}

const compareOccurrences = (a: EventOccurrence, b: EventOccurrence): number =>
  a.date.localeCompare(b.date) ||
  (a.timing._tag === b.timing._tag ? 0 : a.timing._tag === "allDay" ? -1 : 1) ||
  (a.timing._tag === "timed" && b.timing._tag === "timed"
    ? a.timing.start.localeCompare(b.timing.start)
    : 0) ||
  a.key.localeCompare(b.key)

/** One series' occurrences inside a window (the read-only projection). */
const seriesOccurrences = (input: {
  readonly event: EventOccurrenceSource
  readonly from: LocalDate
  readonly to: LocalDate
  /** Display-day padding: the occurrence may paint on another day. */
  readonly windowStart: LocalDate
  readonly windowEnd: LocalDate
  readonly viewerTimeZone: string
}): ReadonlyArray<EventOccurrence> => {
  const { event } = input
  const anchor = eventAnchorDate(event)
  const exceptions = new Map(event.exceptions.map((entry) => [entry.instanceId, entry]))
  const instanceIds = new Set<string>([anchor])

  if (event.recurrence !== null) {
    for (const date of occurrenceDates(event.recurrence, anchor, {
      from: input.windowStart,
      to: input.windowEnd
    })) {
      instanceIds.add(date)
    }
    for (const exception of event.exceptions) {
      if (instanceIds.has(exception.instanceId)) continue
      // The wire pattern admits dates that are not days; such an exception is
      // noise, not a reason to hide the series.
      if (!isReadableDate(exception.instanceId)) continue
      if (!isEventOccurrence(event, exception.instanceId)) continue
      instanceIds.add(exception.instanceId)
    }
  }

  const occurrences: Array<EventOccurrence> = []
  for (const instanceId of instanceIds) {
    const exception = exceptions.get(instanceId)
    if (exception?.action === "delete") continue
    const occurrence = occurrenceOf({
      event,
      instanceId: instanceId as LocalDate,
      projected: instanceId !== anchor,
      viewerTimeZone: input.viewerTimeZone,
      exception
    })
    if (occurrence.date < input.from || occurrence.date > input.to) continue
    occurrences.push(occurrence)
  }
  return occurrences
}

export interface BuildOccurrencesInput {
  readonly events: ReadonlyArray<EventOccurrenceSource>
  /** Inclusive first display day. */
  readonly from: LocalDate
  /** Inclusive last display day. */
  readonly to: LocalDate
  /** The viewer's IANA zone: timed occurrences are placed by its wall date. */
  readonly timeZone: string
}

/**
 * Project every series onto a window.
 *
 * The engine is asked for one padded day on each side because an occurrence's
 * local date in the **event's** zone can paint on the previous/next day in the
 * **viewer's** zone. Overridden occurrences whose rule date sits outside the
 * padded range are considered too: moving an occurrence into the window must
 * show it, not hide the whole exception.
 */
export const eventOccurrences = (
  input: BuildOccurrencesInput
): ReadonlyArray<EventOccurrence> => {
  const occurrences: Array<EventOccurrence> = []
  const windowStart = localDayBefore(input.from)
  const windowEnd = localDayAfter(input.to)
  // The same series can arrive twice: the month read model unions the grid's
  // rows with a second range query for an out-of-grid drill-down, and both
  // queries also return every live recurring row. Expanding a row twice would
  // paint every occurrence twice (and double-count the month's busy marks), so
  // the source rows are deduped by id exactly as `taskOccurrences` does.
  const byId = new Map<string, EventOccurrenceSource>()
  for (const event of input.events) byId.set(event.id, event)

  for (const event of byId.values()) {
    try {
      occurrences.push(
        ...seriesOccurrences({
          event,
          from: input.from,
          to: input.to,
          windowStart,
          windowEnd,
          viewerTimeZone: input.timeZone
        })
      )
    } catch {
      // A stored row can carry a value the wire shapes only pattern-check
      // ("2026-02-30", a non-ISO instant) — a hand-edited database or a sync
      // push bypassing the service. Such a row is unreadable, but it must not
      // turn every calendar read into a 500: skip that series, keep the window.
      continue
    }
  }

  return occurrences.sort(compareOccurrences)
}

/** Deduped occurrences of one event (used by the service's window read). */
export const eventOccurrencesOf = (
  event: EventOccurrenceSource,
  input: Omit<BuildOccurrencesInput, "events">
): ReadonlyArray<EventOccurrence> =>
  eventOccurrences({ ...input, events: [event] })

// ── Per-occurrence edits (the pure half of the service) ──────────────────

/**
 * Apply occurrence-level fields to the series itself.
 *
 * Used for a one-off event and for "this and following" at the series' first
 * occurrence: there is no earlier part to keep, so the edit is a plain series
 * edit and the rule keeps running with the new values.
 *
 * A stored override on that first occurrence is folded into the new series
 * values field by field (the edit wins) and then dropped: leaving it in the
 * exception list would shadow the series values on the occurrence the edit was
 * made from.
 */
export const patchEventSeries = (
  event: Event,
  overrides: EventExceptionOverrides,
  now: string
): Event => {
  const anchor = eventAnchorDate(event)
  const merged: EventExceptionOverrides = {
    ...(storedOccurrenceOverrides(event, anchor) ?? {}),
    ...overrides
  }
  return new Event({
    ...event,
    title: merged.title ?? event.title,
    description: merged.description !== undefined
      ? merged.description
      : event.description,
    location: merged.location !== undefined ? merged.location : event.location,
    color: merged.color !== undefined ? merged.color : event.color,
    timing: merged.timing ?? event.timing,
    timeZone: merged.timeZone ?? event.timeZone,
    exceptions: event.exceptions.filter((exception) => exception.instanceId !== anchor),
    version: event.version + 1,
    updatedAt: now
  })
}

const withException = (
  event: Event,
  exception: EventException,
  now: string
): Event =>
  new Event({
    ...event,
    exceptions: [
      ...event.exceptions.filter((entry) => entry.instanceId !== exception.instanceId),
      exception
    ],
    version: event.version + 1,
    updatedAt: now
  })

/**
 * "This occurrence only" override: one exception on the same row. The rule,
 * the series' timing and every other occurrence are untouched.
 */
export const overrideEventOccurrence = (input: {
  readonly event: Event
  readonly instanceId: LocalDate
  readonly overrides: EventExceptionOverrides
  readonly exceptionId: string
  readonly now: string
}): Event =>
  withException(
    input.event,
    {
      id: input.exceptionId as EventException["id"],
      instanceId: input.instanceId,
      action: "override",
      overrides: input.overrides,
      createdAt: input.now
    },
    input.now
  )

/** "This occurrence only" delete: the occurrence vanishes, the schedule stays. */
export const deleteEventOccurrence = (input: {
  readonly event: Event
  readonly instanceId: LocalDate
  readonly exceptionId: string
  readonly now: string
}): Event =>
  withException(
    input.event,
    {
      id: input.exceptionId as EventException["id"],
      instanceId: input.instanceId,
      action: "delete",
      overrides: null,
      createdAt: input.now
    },
    input.now
  )

/**
 * Tombstone the row (the shared soft-delete contract). Used when a delete
 * covers the whole series.
 */
export const trashEvent = (event: Event, now: string): Event =>
  new Event({ ...event, deletedAt: now, version: event.version + 1, updatedAt: now })

/** Number of rule-generated occurrences strictly before `date`. */
const occurrencesBefore = (
  rule: RecurrenceRule,
  anchor: LocalDate,
  date: LocalDate
): number =>
  date <= anchor
    ? 0
    : occurrenceDates(rule, anchor, { from: anchor, to: localDayBefore(date) }).length

/**
 * "This and following" delete: truncate the series before the occurrence.
 * Deleting from the first occurrence is deleting the series, so the row is
 * tombstoned instead of left as an empty shell.
 */
export const truncateEventSeries = (input: {
  readonly event: Event
  readonly instanceId: LocalDate
  readonly now: string
}): Event => {
  const anchor = eventAnchorDate(input.event)
  if (input.instanceId <= anchor) return trashEvent(input.event, input.now)
  return new Event({
    ...input.event,
    recurrence: input.event.recurrence === null
      ? null
      : {
        ...input.event.recurrence,
        end: { _tag: "until", date: localDayBefore(input.instanceId) }
      },
    exceptions: input.event.exceptions.filter(
      (exception) => exception.instanceId < input.instanceId
    ),
    version: input.event.version + 1,
    updatedAt: input.now
  })
}

export interface SplitEventSeriesInput {
  readonly event: Event
  readonly instanceId: LocalDate
  readonly overrides: EventExceptionOverrides
  /** The id the client minted for the new series row. */
  readonly followingId: string
  readonly now: string
}

export interface SplitEventSeries {
  /** The old row, truncated to the day before the split. */
  readonly previous: Event
  /** The new series, anchored on the split occurrence. */
  readonly following: Event
}

/**
 * "This and following": split the series at `instanceId`.
 *
 * - `previous` keeps everything before the occurrence; its rule is bounded
 *   with an inclusive `until` the day before.
 * - `following` is a new row anchored on the occurrence's (possibly edited)
 *   timing. The rule — including a reduced `count` budget — continues from
 *   there, so a weekly series stays on its weekday and a bounded series does
 *   not restart its budget.
 * - Exceptions before the split stay with `previous`; later ones move to
 *   `following` with their keys (their dates are unchanged unless the split
 *   occurrence itself moved).
 * - The split occurrence's own stored override (if any) is folded into the new
 *   row, and `overrides` wins over it field by field.
 *
 * Returns `null` when the split is meaningless (no rule, unknown occurrence or
 * the first occurrence — the caller applies it as a whole-series edit).
 */
export const splitEventSeries = (
  input: SplitEventSeriesInput
): SplitEventSeries | null => {
  const { event, instanceId, overrides } = input
  const rule = event.recurrence
  if (rule === null) return null
  if (!isEventOccurrence(event, instanceId)) return null
  const anchor = eventAnchorDate(event)
  if (instanceId === anchor) return null

  const stored = storedOccurrenceOverrides(event, instanceId) ?? {}
  const merged: EventExceptionOverrides = { ...stored, ...overrides }
  const timing = merged.timing ?? eventTimingOn(event, instanceId)
  const timeZone = merged.timeZone ?? event.timeZone

  const previous = new Event({
    ...event,
    recurrence: { ...rule, end: { _tag: "until", date: localDayBefore(instanceId) } },
    exceptions: event.exceptions.filter(
      (exception) => exception.instanceId < instanceId
    ),
    version: event.version + 1,
    updatedAt: input.now
  })

  const consumed = occurrencesBefore(rule, anchor, instanceId)
  const remainingEnd =
    rule.end._tag === "count"
      ? { _tag: "count" as const, count: rule.end.count - consumed }
      : rule.end

  const following = new Event({
    ...event,
    id: input.followingId as Event["id"],
    title: merged.title ?? event.title,
    description: merged.description !== undefined
      ? merged.description
      : event.description,
    location: merged.location !== undefined ? merged.location : event.location,
    color: merged.color !== undefined ? merged.color : event.color,
    timing,
    timeZone,
    recurrence: { ...rule, end: remainingEnd },
    exceptions: event.exceptions.filter(
      (exception) => exception.instanceId > instanceId
    ),
    createdAt: input.now,
    updatedAt: input.now,
    version: 1,
    deletedAt: null
  })

  return { previous, following }
}
