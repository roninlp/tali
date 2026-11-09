import { Array, Clock, Effect, Option, Schema } from 'effect'

import {
  type Event,
  type EventEditScope,
  type EventException,
  EventExceptionId,
  type EventExceptionOverrides,
  EventException as EventExceptionSchema,
  EventId,
  type EventOccurrence,
  type EventTiming,
  HouseholdId,
  LocalDate,
  OccasionId,
  UserId,
  defaultVisibilityFor,
  eventAnchorDate,
  isEventOccurrence,
  localDateTimeInstant,
  localDayBefore,
  localizeDigits,
  splitEventSeries,
  storedOccurrenceOverrides,
  uuidV7,
} from '@tali/domain'
import type { LocalStore, MirrorRecord, ServerRow } from '@tali/sync-client'

import {
  type CalendarEventException,
  CalendarEventException as CalendarEventExceptionData,
  type CalendarEventOccurrence,
  type CalendarEventSource,
  CalendarEventSource as CalendarEventSourceSchema,
  type CalendarRecurrenceRule,
  CalendarRecurrenceRule as CalendarRecurrenceRuleSchema,
  type CalendarTiming,
  CalendarTiming as CalendarTimingSchema,
  eventSourceWithDomainValues,
  recurrenceWithDomainValues,
  timingWithDomainValues,
} from './calendar-data'

const asRecurrenceOption = Schema.decodeUnknownOption(
  CalendarRecurrenceRuleSchema,
)

const asTimingOption = Schema.decodeUnknownOption(CalendarTimingSchema)

const asExceptionsOption = Schema.decodeUnknownOption(
  Schema.Array(CalendarEventExceptionData),
)

/**
 * The calendar's event lane, ported from `apps/web/src/lib/events/model.ts`
 * and `apps/web/src/lib/events/scope.ts`.
 *
 * The mirror row is projected into the structural shape the shared
 * `eventOccurrences` builder consumes, so the offline grid cannot disagree
 * with the server read model. A local quick add commits the mirror row and the
 * outbox entry together; a scoped occurrence edit writes one row locally or
 * goes through the service's gated split RPC when the outbox cannot make the
 * two-row change atomic.
 */

// MODEL

export const EventRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  people: Schema.Array(Schema.String),
  timing: CalendarTimingSchema,
  timeZone: Schema.String,
  recurrence: Schema.NullOr(CalendarRecurrenceRuleSchema),
  exceptions: Schema.Array(CalendarEventExceptionData),
  occasionId: Schema.NullOr(Schema.String),
  ownerId: Schema.NullOr(Schema.String),
  householdId: Schema.NullOr(Schema.String),
  visibility: Schema.Literals(['private', 'shared']),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  version: Schema.Int,
  deletedAt: Schema.NullOr(Schema.String),
  hasSyncError: Schema.Boolean,
})

export type EventRow = typeof EventRow.Type

export const EventScopeIds = Schema.Struct({
  exceptionId: Schema.String,
  followingId: Schema.String,
  clientMutationId: Schema.String,
  followingMutationId: Schema.String,
})

export type EventScopeIds = typeof EventScopeIds.Type

export const CalendarEventDraft = Schema.Struct({
  title: Schema.String,
  date: Schema.String,
  allDay: Schema.Boolean,
  startTime: Schema.String,
  endTime: Schema.String,
})

export type CalendarEventDraft = typeof CalendarEventDraft.Type

// PROJECTION

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

const asJson = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value
  }

  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const asPeople = (value: unknown): ReadonlyArray<string> => {
  const parsed = asJson(value)

  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string')
    : []
}

const asTiming = (value: unknown, fallbackDate: string): CalendarTiming => {
  const parsed = asJson(value)
  const decoded = asTimingOption(parsed)

  if (Option.isSome(decoded)) {
    return decoded.value
  }

  const day = /^\d{4}-\d{2}-\d{2}/.test(fallbackDate)
    ? fallbackDate.slice(0, 10)
    : '1970-01-01'

  return { _tag: 'allDay', date: day }
}

const asRecurrence = (value: unknown): CalendarRecurrenceRule | null => {
  const parsed = asJson(value)
  const decoded = asRecurrenceOption(parsed)

  return Option.getOrNull(decoded)
}

const asExceptions = (
  value: unknown,
): ReadonlyArray<CalendarEventException> => {
  const parsed = asJson(value)
  const decoded = asExceptionsOption(parsed)

  return Option.getOrElse(decoded, () => [])
}

/** One mirrored event row, in the plain shape the screen's Model holds. */
export const toEventRow = (record: MirrorRecord): EventRow =>
  EventRow.make({
    id: record.entityId,
    title: typeof record.data.title === 'string' ? record.data.title : '',
    description: asString(record.data.description),
    location: asString(record.data.location),
    category: asString(record.data.category),
    color: asString(record.data.color),
    people: asPeople(record.data.people),
    timing: asTiming(record.data.timing, record.updatedAt),
    timeZone: asString(record.data.timeZone) ?? 'UTC',
    recurrence: asRecurrence(record.data.recurrence),
    exceptions: asExceptions(record.data.exceptions),
    occasionId: asString(record.data.occasionId),
    ownerId: asString(record.data.ownerId),
    householdId: asString(record.data.householdId),
    visibility:
      record.data.visibility === 'private' ||
      record.data.visibility === 'shared'
        ? record.data.visibility
        : defaultVisibilityFor('event'),
    createdAt: asString(record.data.createdAt) ?? record.updatedAt,
    updatedAt: record.updatedAt,
    version: record.version,
    deletedAt: record.deletedAt,
    hasSyncError: record.syncError !== undefined,
  })

export const eventRowsFromMirror = (
  records: ReadonlyArray<MirrorRecord>,
): ReadonlyArray<EventRow> => Array.map(records, toEventRow)

/** The structural shape the shared occurrence builder consumes. */
export const eventSourceOf = (row: EventRow): CalendarEventSource =>
  CalendarEventSourceSchema.make({
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    category: row.category,
    color: row.color,
    people: row.people,
    timing: row.timing,
    timeZone: row.timeZone,
    recurrence: row.recurrence,
    exceptions: row.exceptions,
  })

export const eventSourcesOf = (
  rows: ReadonlyArray<EventRow>,
): ReadonlyArray<CalendarEventSource> => Array.map(rows, eventSourceOf)

/** One server-source row, ready for the domain builder. */
export const eventSourceWithDomainTiming = eventSourceWithDomainValues

/**
 * Merge one local mirror row over its server snapshot row. The store applies a
 * local patch over the row it already holds, so the projected row is complete;
 * the merge keeps the overlay explicit.
 */
const mergeEventSource = (
  base: CalendarEventSource,
  row: EventRow,
): CalendarEventSource =>
  CalendarEventSourceSchema.make({
    ...base,
    title: row.title,
    description: row.description,
    location: row.location,
    category: row.category,
    color: row.color,
    people: row.people,
    timing: row.timing,
    timeZone: row.timeZone,
    recurrence: row.recurrence,
    exceptions: row.exceptions,
  })

/**
 * Overlay the local event writes the server snapshot has not seen yet. Only the
 * overlaid ids are merged, so an unrelated mirror row cannot roll the server
 * back; tombstoned ids disappear at once.
 */
export const overlayEventSources = (input: {
  readonly base: ReadonlyArray<CalendarEventSource>
  readonly mirror: ReadonlyArray<EventRow>
  readonly overlayIds: ReadonlySet<string>
  readonly deletedIds?: ReadonlySet<string>
}): ReadonlyArray<CalendarEventSource> => {
  const byId = new Map(input.base.map(event => [event.id, event] as const))
  const mirrorById = new Map(input.mirror.map(row => [row.id, row] as const))

  for (const id of input.overlayIds) {
    if (input.deletedIds?.has(id) === true) {
      byId.delete(id)
      continue
    }

    const row = mirrorById.get(id)

    if (row === undefined) {
      continue
    }

    const base = byId.get(id)
    byId.set(
      id,
      base === undefined ? eventSourceOf(row) : mergeEventSource(base, row),
    )
  }

  return [...byId.values()]
}

// WRITES

const MINUTES = 60_000

const normalizeTime = (value: string, fallback: string): string =>
  /^\d{2}:\d{2}/.test(value) ? value : fallback

const canonicalInstant = (instant: string): string => {
  const millis = Date.parse(instant)

  return Number.isFinite(millis) ? new Date(millis).toISOString() : instant
}

/** The timing a draft describes, with a sane floor on the end instant. */
export const timingOfDraft = (
  draft: CalendarEventDraft & Readonly<{ timeZone: string }>,
): EventTiming => {
  if (draft.allDay) {
    return { _tag: 'allDay', date: LocalDate.make(draft.date) }
  }

  const start = canonicalInstant(
    localDateTimeInstant(
      draft.date,
      normalizeTime(draft.startTime, '09:00'),
      draft.timeZone,
    ),
  )

  const rawEnd = canonicalInstant(
    localDateTimeInstant(
      draft.date,
      normalizeTime(draft.endTime, '10:00'),
      draft.timeZone,
    ),
  )

  const end =
    Date.parse(rawEnd) > Date.parse(start)
      ? rawEnd
      : new Date(Date.parse(start) + 60 * MINUTES).toISOString()

  return { _tag: 'timed', start, end }
}

/** Create an event locally; the sync push inserts it on the server. */
export const createEventInMirror = async (
  store: LocalStore,
  draft: CalendarEventDraft & Readonly<{ timeZone: string }>,
  id: string,
  now: string,
): Promise<string> => {
  const title = draft.title.trim()

  if (title === '') {
    throw new Error('an event needs a title')
  }

  await store.writeLocal({
    entityType: 'event',
    entityId: id,
    op: 'upsert',
    patch: {
      id,
      type: 'event',
      ownerId: store.userId,
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
      visibility: defaultVisibilityFor('event'),
      createdAt: now,
    },
    now,
  })

  return id
}

// SCOPE

/** The rows a scoped edit or delete produces. */
export interface EventScopeChange {
  readonly series: Event
  readonly following: Event | null
}

export interface EventScopeInput {
  readonly event: Event
  readonly instanceId: string
  readonly exceptionId: string
  readonly followingId: string
  readonly now: string
}

export const SPLIT_REQUIRES_SERVER =
  'برای «این رویداد و رویدادهای بعدی» باید به سرور متصل باشید و این رویداد همگام شده باشد.'

export const EVENT_MISSING_COPY =
  'این رویداد هنوز در حافظهٔ محلی نیست؛ کمی بعد دوباره تلاش کنید.'

const notAnOccurrence = (instanceId: string): Error =>
  new Error(
    `این روز (${instanceId}) یکی از رویدادهای این مجموعه نیست؛ صفحه را تازه کنید.`,
  )

const assertOccurrence = (event: Event, instanceId: string): void => {
  if (!isEventOccurrence(event, instanceId)) {
    throw notAnOccurrence(instanceId)
  }
}

/**
 * Single-row transforms on the already-hydrated aggregate. They stay plain
 * objects instead of calling the domain's `new Event(...)` builders: the dev
 * optimizer serves `effect/schema` through a second module graph, and the
 * Model constructor rejects values built by the other copy. The domain
 * helpers below read the same fields, so the resulting shape is identical.
 */
const withEventFields = (event: Event, patch: Partial<Event>): Event => ({
  ...event,
  ...patch,
})

const patchSeriesLocal = (
  event: Event,
  overrides: EventExceptionOverrides,
  now: string,
): Event => {
  const anchor = eventAnchorDate(event)

  const merged: EventExceptionOverrides = {
    ...(storedOccurrenceOverrides(event, anchor) ?? {}),
    ...overrides,
  }

  return withEventFields(event, {
    title: merged.title ?? event.title,
    description:
      merged.description !== undefined ? merged.description : event.description,
    location: merged.location !== undefined ? merged.location : event.location,
    color: merged.color !== undefined ? merged.color : event.color,
    timing: merged.timing ?? event.timing,
    timeZone: merged.timeZone ?? event.timeZone,
    exceptions: event.exceptions.filter(
      exception => exception.instanceId !== anchor,
    ),
    version: event.version + 1,
    updatedAt: now,
  })
}

const withExceptionLocal = (
  event: Event,
  instanceId: string,
  action: 'override' | 'delete',
  overrides: EventExceptionOverrides | null,
  exceptionId: string,
  now: string,
): Event =>
  withEventFields(event, {
    exceptions: [
      ...event.exceptions.filter(
        exception => exception.instanceId !== instanceId,
      ),
      {
        id: EventExceptionId.make(exceptionId),
        instanceId: LocalDate.make(instanceId),
        action,
        overrides,
        createdAt: now,
      },
    ],
    version: event.version + 1,
    updatedAt: now,
  })

const trashLocal = (event: Event, now: string): Event =>
  withEventFields(event, {
    deletedAt: now,
    version: event.version + 1,
    updatedAt: now,
  })

const truncateLocal = (
  event: Event,
  instanceId: string,
  now: string,
): Event => {
  const anchor = eventAnchorDate(event)

  if (instanceId <= anchor) {
    return trashLocal(event, now)
  }

  return withEventFields(event, {
    recurrence:
      event.recurrence === null
        ? null
        : {
            ...event.recurrence,
            end: { _tag: 'until', date: localDayBefore(instanceId) },
          },
    exceptions: event.exceptions.filter(
      exception => exception.instanceId < instanceId,
    ),
    version: event.version + 1,
    updatedAt: now,
  })
}

/** "This occurrence" / "this and following" edit. */
export const editEventWithinScope = (
  input: EventScopeInput & {
    readonly overrides: EventExceptionOverrides
    readonly scope: EventEditScope
  },
): EventScopeChange => {
  const { event, instanceId, overrides, scope } = input

  if (event.recurrence === null) {
    if (instanceId !== eventAnchorDate(event)) {
      throw notAnOccurrence(instanceId)
    }

    return {
      series: patchSeriesLocal(event, overrides, input.now),
      following: null,
    }
  }

  assertOccurrence(event, instanceId)

  if (scope === 'thisAndFollowing') {
    const stored = event.exceptions.find(
      exception => exception.instanceId === instanceId,
    )

    if (stored?.action === 'delete') {
      throw new Error('مجموعه نمی‌تواند از روزی شروع شود که حذف شده است.')
    }

    if (instanceId === eventAnchorDate(event)) {
      return {
        series: patchSeriesLocal(event, overrides, input.now),
        following: null,
      }
    }

    const split = splitEventSeries({
      event,
      instanceId,
      overrides,
      followingId: input.followingId,
      now: input.now,
    })

    if (split === null) {
      throw notAnOccurrence(instanceId)
    }

    return { series: split.previous, following: split.following }
  }

  return {
    series: withExceptionLocal(
      event,
      instanceId,
      'override',
      overrides,
      input.exceptionId,
      input.now,
    ),
    following: null,
  }
}

/** "This occurrence" / "this and following" delete. */
export const deleteEventWithinScope = (
  input: EventScopeInput & Readonly<{ scope: EventEditScope }>,
): EventScopeChange => {
  const { event, instanceId, scope } = input

  if (event.recurrence === null) {
    if (instanceId !== eventAnchorDate(event)) {
      throw notAnOccurrence(instanceId)
    }

    return { series: trashLocal(event, input.now), following: null }
  }

  assertOccurrence(event, instanceId)

  if (scope === 'thisAndFollowing') {
    return {
      series: truncateLocal(event, instanceId, input.now),
      following: null,
    }
  }

  return {
    series: withExceptionLocal(
      event,
      instanceId,
      'delete',
      null,
      input.exceptionId,
      input.now,
    ),
    following: null,
  }
}

const eventWritePatch = (event: Event): Readonly<Record<string, unknown>> => ({
  title: event.title,
  description: event.description,
  location: event.location,
  category: event.category,
  color: event.color,
  people: event.people,
  timing: event.timing,
  timeZone: event.timeZone,
  recurrence: event.recurrence,
  exceptions: event.exceptions,
  occasionId: event.occasionId,
  visibility: event.visibility,
})

/**
 * Commit the single-row half of a scoped change to the mirror + outbox. A
 * split (two rows) is refused here on purpose: it must go through the
 * service's gated batch, because the outbox cannot order the pair against a
 * concurrent head write.
 */
export const applyEventScopeInMirror = async (
  store: LocalStore,
  change: EventScopeChange,
  now: string,
): Promise<void> => {
  if (change.following !== null) {
    throw new Error(SPLIT_REQUIRES_SERVER)
  }

  await store.writeLocal({
    entityType: 'event',
    entityId: change.series.id,
    op: change.series.deletedAt === null ? 'upsert' : 'delete',
    patch: eventWritePatch(change.series),
    now,
  })
}

/** A fresh exception id / split id / replay key for one scoped action. */
export const newScopedIds = (now: number): EventScopeIds => ({
  exceptionId: uuidV7(now),
  followingId: uuidV7(now),
  clientMutationId: uuidV7(now),
  followingMutationId: uuidV7(now),
})

const serverRowOf = (event: Event): ServerRow => ({
  entityType: 'event',
  entityId: event.id,
  version: event.version,
  updatedAt: event.updatedAt,
  deletedAt: event.deletedAt,
  data: { ...event },
})

/** Adopt the authoritative rows an occurrence mutation returned. */
export const applyEventChangeFromServer = async (
  store: LocalStore,
  change: Readonly<{ series: Event; following: Event | null }>,
): Promise<void> => {
  const rows =
    change.following === null
      ? [serverRowOf(change.series)]
      : [serverRowOf(change.series), serverRowOf(change.following)]

  await store.mergeServer(rows)
}

/**
 * Whether a scoped action must use the service RPC:
 *
 * - a one-off is an ordinary single-row edit and stays local-first;
 * - a series offline, or with an unsent head mutation, uses the local
 *   single-row path (a split edit is refused there);
 * - a connected series with a clean head uses the gated RPC.
 */
export const eventScopeUsesServer = (input: {
  readonly event: Event
  readonly action: 'edit' | 'delete'
  readonly scope: EventEditScope
  readonly isOnline: boolean
  readonly hasPending: boolean
}): boolean => {
  if (input.event.recurrence === null) {
    return false
  }

  if (input.action === 'edit' && input.scope === 'thisAndFollowing') {
    if (!input.isOnline || input.hasPending) {
      throw new Error(SPLIT_REQUIRES_SERVER)
    }

    return true
  }

  return input.isOnline && !input.hasPending
}

const exceptionWithDomainValues = (
  exception: CalendarEventException,
): EventException =>
  EventExceptionSchema.make({
    id: EventExceptionId.make(exception.id),
    instanceId: LocalDate.make(exception.instanceId),
    action: exception.action,
    overrides:
      exception.overrides === null
        ? null
        : {
            ...exception.overrides,
            ...(exception.overrides.timing === undefined
              ? {}
              : {
                  timing: timingWithDomainValues(exception.overrides.timing),
                }),
          },
    createdAt: exception.createdAt,
  })

/** Hydrate a mirrored event row into the aggregate the pure functions take. */
export const eventFromMirror = (
  row: EventRow,
  fallback: Readonly<{ userId: string; householdId: string }>,
): Event | null => {
  if (row.id === '') {
    return null
  }

  try {
    // A plain object cast at the seam: both `new Event(...)` and
    // `Event.make(...)` validate through the domain module's Model adapter,
    // which throws across the dev optimizer's second `effect/schema` graph.
    // The fields below are the exact aggregate shape the pure scope
    // functions consume.
    const event: Event = {
      id: EventId.make(row.id),
      type: 'event',
      title: row.title,
      description: row.description,
      location: row.location,
      category: row.category,
      people: [...row.people],
      timing: timingWithDomainValues(row.timing),
      timeZone: row.timeZone,
      recurrence:
        row.recurrence === null
          ? null
          : recurrenceWithDomainValues(row.recurrence),
      exceptions: row.exceptions.map(exceptionWithDomainValues),
      occasionId:
        row.occasionId === null ? null : OccasionId.make(row.occasionId),
      ownerId: UserId.make(row.ownerId ?? fallback.userId),
      householdId: HouseholdId.make(row.householdId ?? fallback.householdId),
      visibility: row.visibility,
      color: row.color,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      version: row.version,
      deletedAt: row.deletedAt,
    }

    return event
  } catch {
    return null
  }
}

// DISPLAY

/** The wall-clock start of a timed occurrence in the viewer's zone. */
export const occurrenceStartMinutes = (
  occurrence: CalendarEventOccurrence,
  viewerTimeZone: string,
): number | null => {
  if (occurrence.timing._tag !== 'timed') {
    return null
  }

  const parts = wallTimeIn(occurrence.timing.start, viewerTimeZone)

  return parts === null ? null : parts.hour * 60 + parts.minute
}

/** The occurrence's length in minutes (0 for an all-day event). */
export const occurrenceDurationMinutes = (
  occurrence: CalendarEventOccurrence,
): number => {
  if (occurrence.timing._tag !== 'timed') {
    return 0
  }

  const start = Date.parse(occurrence.timing.start)
  const end = Date.parse(occurrence.timing.end)

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0
  }

  return Math.max(0, Math.round((end - start) / MINUTES))
}

export const wallTimeIn = (
  instant: string,
  timeZone: string,
): Readonly<{ hour: number; minute: number }> | null => {
  const millis = Date.parse(instant)

  if (!Number.isFinite(millis)) {
    return null
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })

    const parts = formatter.formatToParts(new Date(millis))
    const hour = Number(parts.find(part => part.type === 'hour')?.value)
    const minute = Number(parts.find(part => part.type === 'minute')?.value)

    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null
    }

    return { hour: hour === 24 ? 0 : hour, minute }
  } catch {
    return null
  }
}

/** The local wall date of an instant in a zone (`YYYY-MM-DD`). */
export const wallDateIn = (
  instant: string,
  timeZone: string,
): string | null => {
  const millis = Date.parse(instant)

  if (!Number.isFinite(millis)) {
    return null
  }

  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(millis))
  } catch {
    return null
  }
}

const twoDigits = (value: number): string => String(value).padStart(2, '0')

/** `۰۹:۳۰` in the viewer's zone, or `null` for an all-day event. */
export const occurrenceTimeLabel = (
  occurrence: CalendarEventOccurrence,
  viewerTimeZone: string,
  digits: 'persian' | 'latin',
): string | null => {
  if (occurrence.timing._tag !== 'timed') {
    return null
  }

  const parts = wallTimeIn(occurrence.timing.start, viewerTimeZone)

  if (parts === null) {
    return null
  }

  const label = `${twoDigits(parts.hour)}:${twoDigits(parts.minute)}`

  return localizeDigits(label, digits)
}

/** Whether any occurrence in a lane is timed (the time grid's on/off switch). */
export const hasTimedEvents = (
  occurrences: ReadonlyArray<CalendarEventOccurrence>,
): boolean => occurrences.some(occurrence => occurrence.timing._tag === 'timed')

/** Is this occurrence the series' own first occurrence (the mutable anchor)? */
export const isAnchorOccurrence = (
  occurrence: CalendarEventOccurrence,
): boolean => occurrence.key === occurrence.id

export const eventTitleOrFallback = (
  occurrence: CalendarEventOccurrence,
): string =>
  occurrence.title.trim() === '' ? 'رویداد بی‌نام' : occurrence.title

export const draftFromOccurrence = (
  occurrence: CalendarEventOccurrence,
): CalendarEventDraft => {
  const allDay = occurrence.timing._tag === 'allDay'

  const startParts =
    occurrence.timing._tag === 'timed'
      ? wallTimeIn(occurrence.timing.start, occurrence.timeZone)
      : null

  const endParts =
    occurrence.timing._tag === 'timed'
      ? wallTimeIn(occurrence.timing.end, occurrence.timeZone)
      : null

  return CalendarEventDraft.make({
    title: occurrence.title,
    date: allDay
      ? occurrence.timing.date
      : (wallDateIn(
          occurrence.timing._tag === 'timed' ? occurrence.timing.start : '',
          occurrence.timeZone,
        ) ?? ''),
    allDay,
    startTime:
      startParts === null
        ? '09:00'
        : `${twoDigits(startParts.hour)}:${twoDigits(startParts.minute)}`,
    endTime:
      endParts === null
        ? '10:00'
        : `${twoDigits(endParts.hour)}:${twoDigits(endParts.minute)}`,
  })
}

/** The clock instant a Command's result needs for server-stamped fields. */
export const currentIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

export const eventScopeIdsOrMint = (
  maybeIds: Option.Option<EventScopeIds>,
  now: number,
): EventScopeIds =>
  Option.match(maybeIds, {
    onNone: () => newScopedIds(now),
    onSome: ids => ids,
  })

export type { EventOccurrence, EventEditScope }
