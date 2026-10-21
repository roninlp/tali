import {
  localDateTimeInstant,
  localizeDigits,
  uuidV7,
  type CalendarEventSource,
  type Digits,
  type EventException,
  type EventOccurrence,
  type EventTiming,
  type LocalDate,
  type RecurrenceRule
} from "@tali/domain"
import type { LocalStore, MirrorRecord } from "../local-store"

/**
 * The `/calendar` event client model (tickets #58/#62; FR-CAL-01/03).
 *
 * The calendar renders the same domain read models the API serves, so the
 * offline projection needs the mirror's event rows in the structural shape the
 * shared `eventOccurrences` builder consumes — exactly the way
 * `lib/calendar/model.ts` adapts task rows. A local quick add commits the
 * mirror row and the outbox entry in one transaction; the sync engine carries
 * the event (`event` is a registry entity), so the view never depends on the
 * server having seen it yet.
 *
 * Timed events are authored as a wall time on a local day **in the event's own
 * zone** and stored as UTC instants (`localDateTimeInstant`), the same rule the
 * event aggregate documents: an absolute instant plus the zone it was written
 * in, never a floating time.
 */

const asString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null

const asJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const asPeople = (value: unknown): ReadonlyArray<string> => {
  const parsed = asJson(value)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((entry): entry is string => typeof entry === "string")
}

const asTiming = (value: unknown, fallbackDate: string): EventTiming => {
  const parsed = asJson(value)
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>
    if (
      record._tag === "timed" &&
      typeof record.start === "string" &&
      typeof record.end === "string"
    ) {
      return { _tag: "timed", start: record.start, end: record.end }
    }
    if (record._tag === "allDay" && typeof record.date === "string") {
      return { _tag: "allDay", date: record.date as LocalDate }
    }
  }
  // A malformed row still has to paint something; the row's own updated date is
  // the only day the mirror can vouch for.
  const day = /^\d{4}-\d{2}-\d{2}/.test(fallbackDate)
    ? fallbackDate.slice(0, 10)
    : "1970-01-01"
  return { _tag: "allDay", date: day as LocalDate }
}

const asRecurrence = (value: unknown): RecurrenceRule | null => {
  const parsed = asJson(value)
  if (typeof parsed !== "object" || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.frequency !== "string" || record.end === undefined) return null
  return parsed as RecurrenceRule
}

const asExceptions = (value: unknown): ReadonlyArray<EventException> => {
  const parsed = asJson(value)
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (entry): entry is EventException =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).instanceId === "string" &&
      ((entry as Record<string, unknown>).action === "delete" ||
        (entry as Record<string, unknown>).action === "override")
  )
}

/** One mirrored event row → the structural shape the builders consume. */
export const eventSourceFromMirror = (record: MirrorRecord): CalendarEventSource => ({
  id: record.entityId,
  title: typeof record.data.title === "string" ? record.data.title : "",
  description: asString(record.data.description),
  location: asString(record.data.location),
  category: asString(record.data.category),
  color: asString(record.data.color),
  people: asPeople(record.data.people),
  timing: asTiming(record.data.timing, record.updatedAt),
  timeZone: asString(record.data.timeZone) ?? "UTC",
  recurrence: asRecurrence(record.data.recurrence),
  exceptions: asExceptions(record.data.exceptions)
})

export const eventSourcesFromMirror = (
  records: ReadonlyArray<MirrorRecord>
): ReadonlyArray<CalendarEventSource> => records.map(eventSourceFromMirror)

const has = (data: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(data, key)

/**
 * Merge one local mirror row over its server snapshot row. A mirror patch only
 * carries the fields the action changed (a title edit, a timing move), so
 * replacing the source wholesale would blank the fields the server supplied.
 */
const mergeEventSource = (
  base: CalendarEventSource,
  record: MirrorRecord
): CalendarEventSource => {
  const data = record.data
  return {
    ...base,
    title: typeof data.title === "string" ? data.title : base.title,
    description: has(data, "description") ? asString(data.description) : base.description,
    location: has(data, "location") ? asString(data.location) : base.location,
    category: has(data, "category") ? asString(data.category) : base.category,
    color: has(data, "color") ? asString(data.color) : base.color,
    people: has(data, "people") ? asPeople(data.people) : base.people,
    timing: has(data, "timing") ? asTiming(data.timing, record.updatedAt) : base.timing,
    timeZone: typeof data.timeZone === "string" && data.timeZone !== ""
      ? data.timeZone
      : base.timeZone,
    recurrence: has(data, "recurrence") ? asRecurrence(data.recurrence) : base.recurrence,
    exceptions: has(data, "exceptions") ? asExceptions(data.exceptions) : base.exceptions
  }
}

/**
 * Overlay the local event writes the server snapshot has not seen yet. Only ids
 * in `overlayIds` (pending outbox rows + this screen's just-written rows) are
 * merged, so an unrelated mirror row can never roll the server back.
 */
export const overlayEventSources = (input: {
  readonly base: ReadonlyArray<CalendarEventSource>
  readonly mirror: ReadonlyArray<MirrorRecord>
  readonly overlayIds: ReadonlySet<string>
  /**
   * Overlaid ids whose local row is a tombstone. `store.list` hides them, so
   * without this set a locally deleted series would keep painting from the
   * server snapshot until the next revalidation.
   */
  readonly deletedIds?: ReadonlySet<string>
}): ReadonlyArray<CalendarEventSource> => {
  const byId = new Map(input.base.map((event) => [event.id, event] as const))
  const mirrorById = new Map(
    input.mirror.map((record) => [record.entityId, record] as const)
  )
  for (const id of input.overlayIds) {
    if (input.deletedIds?.has(id) === true) {
      byId.delete(id)
      continue
    }
    const record = mirrorById.get(id)
    if (record === undefined) continue
    const base = byId.get(id)
    byId.set(id, base === undefined ? eventSourceFromMirror(record) : mergeEventSource(base, record))
  }
  return [...byId.values()]
}

// ── Writes ───────────────────────────────────────────────────────────────

export interface EventDraft {
  readonly title: string
  readonly date: string
  readonly allDay: boolean
  /** `HH:MM`; ignored when `allDay`. */
  readonly startTime: string
  /** `HH:MM`; ignored when `allDay`. */
  readonly endTime: string
  /** The event's own IANA zone. */
  readonly timeZone: string
}

const MINUTES = 60_000

/** The timing a draft describes, with a sane floor on the end instant. */
export const timingOfDraft = (draft: EventDraft): EventTiming => {
  if (draft.allDay) return { _tag: "allDay", date: draft.date as LocalDate }
  const start = canonicalInstant(
    localDateTimeInstant(draft.date, normalizeTime(draft.startTime, "09:00"), draft.timeZone)
  )
  const rawEnd = canonicalInstant(
    localDateTimeInstant(draft.date, normalizeTime(draft.endTime, "10:00"), draft.timeZone)
  )
  const end = Date.parse(rawEnd) > Date.parse(start)
    ? rawEnd
    : new Date(Date.parse(start) + 60 * MINUTES).toISOString()
  return { _tag: "timed", start, end }
}

const normalizeTime = (value: string, fallback: string): string =>
  /^\d{2}:\d{2}/.test(value) ? value : fallback

/** One instant spelling on the wire, with milliseconds (the domain's shape). */
const canonicalInstant = (instant: string): string => {
  const millis = Date.parse(instant)
  return Number.isFinite(millis) ? new Date(millis).toISOString() : instant
}

/** Create an event locally; the sync push inserts it on the server. */
export const createEventInMirror = async (
  store: LocalStore,
  draft: EventDraft,
  now: string = new Date().toISOString()
): Promise<string> => {
  const title = draft.title.trim()
  if (title === "") throw new Error("an event needs a title")
  const id = uuidV7()
  await store.writeLocal({
    entityType: "event",
    entityId: id,
    op: "upsert",
    patch: {
      id,
      type: "event",
      title,
      description: null,
      location: null,
      category: null,
      people: [],
      timing: timingOfDraft(draft),
      timeZone: draft.timeZone,
      recurrence: null,
      exceptions: [],
      occasionId: null,
      color: null,
      visibility: "shared",
      createdAt: now
    },
    now
  })
  return id
}

// ── Display helpers ──────────────────────────────────────────────────────

/** The wall-clock start of a timed occurrence in the viewer's zone. */
export const occurrenceStartMinutes = (
  occurrence: EventOccurrence,
  viewerTimeZone: string
): number | null => {
  if (occurrence.timing._tag !== "timed") return null
  const parts = wallTimeIn(occurrence.timing.start, viewerTimeZone)
  return parts === null ? null : parts.hour * 60 + parts.minute
}

/** The occurrence's length in minutes (0 for an all-day event). */
export const occurrenceDurationMinutes = (occurrence: EventOccurrence): number => {
  if (occurrence.timing._tag !== "timed") return 0
  const start = Date.parse(occurrence.timing.start)
  const end = Date.parse(occurrence.timing.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, Math.round((end - start) / MINUTES))
}

export const wallTimeIn = (
  instant: string,
  timeZone: string
): { readonly hour: number; readonly minute: number } | null => {
  const millis = Date.parse(instant)
  if (!Number.isFinite(millis)) return null
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    })
    const parts = formatter.formatToParts(new Date(millis))
    const hour = Number(parts.find((part) => part.type === "hour")?.value)
    const minute = Number(parts.find((part) => part.type === "minute")?.value)
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
    return { hour: hour === 24 ? 0 : hour, minute }
  } catch {
    return null
  }
}

const twoDigits = (value: number): string => String(value).padStart(2, "0")

/** `۰۹:۳۰` in the viewer's zone, or `null` for an all-day event. */
export const occurrenceTimeLabel = (
  occurrence: EventOccurrence,
  viewerTimeZone: string,
  digits: Digits
): string | null => {
  if (occurrence.timing._tag !== "timed") return null
  const parts = wallTimeIn(occurrence.timing.start, viewerTimeZone)
  if (parts === null) return null
  return localizeDigits(`${twoDigits(parts.hour)}:${twoDigits(parts.minute)}`, digits)
}

/** Is this occurrence the series' own first occurrence (the mutable anchor)? */
export const isAnchorOccurrence = (occurrence: EventOccurrence): boolean =>
  occurrence.key === occurrence.id

export const eventTitleOrFallback = (occurrence: EventOccurrence): string =>
  occurrence.title.trim() === "" ? "رویداد بی‌نام" : occurrence.title
