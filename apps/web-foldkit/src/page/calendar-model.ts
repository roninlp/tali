import { Array, Option, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import {
  DEFAULT_TIME_ZONE,
  type Digits,
  type CalendarOccasionSource as DomainOccasionSource,
  type CalendarTaskSource as DomainTaskSource,
  type EventOccurrence,
  JALALI_MONTHS,
  JALALI_WEEKDAYS,
  type MonthReadModel,
  type OccasionOccurrence,
  RecurrenceRule,
  type WeekReadModel,
  type WeekStart,
  addJalaliMonths,
  buildMonthReadModel,
  buildWeekReadModel,
  eventOccurrences,
  formatJalaliDate,
  formatJalaliMonth,
  jalaliMonthOf,
  jalaliWeek,
  localizeDigits,
  toIsoDate,
  toJalaliDate,
  toJalaliDateInZone,
  toJalaliFields,
} from '@tali/domain'

import type {
  CalendarEventSource,
  CalendarMonthPayload,
  CalendarOccasionSource,
  CalendarTaskSource,
  CalendarWeekPayload,
} from '../lib/calendar-data'
import { eventSourceWithDomainValues } from '../lib/calendar-data'
import {
  type EventRow,
  eventSourceOf,
  overlayEventSources,
} from '../lib/event-writes'
import {
  monthOccasionsFromSources,
  occasionSourcesOf,
} from '../lib/occasion-writes'
import { entityKey } from '../mirror'
import type { MirrorSnapshot, TaskRow } from '../mirror'
import type { DisplayFields } from '../preferences-model'

/**
 * The `/calendar` client model, ported from
 * `apps/web/src/lib/calendar/model.ts`.
 *
 * The screen renders the same domain read models the API serves: the server
 * payload when online, and a projection built from the IndexedDB mirror when
 * offline or while the outbox still holds writes. Reusing the domain builders
 * means the offline week cannot disagree with the online one at a Jalali month
 * edge, a DST change or a recurrence boundary.
 */

export const CalendarViewName = Schema.Literals(['week', 'month'])
export type CalendarViewName = typeof CalendarViewName.Type

export const CalendarSource = Schema.Literals(['server', 'mirror'])
export type CalendarSource = typeof CalendarSource.Type

export const CalendarFetchState = defineTaggedUnion({
  Idle: {},
  Ready: {},
  Offline: {},
  Error: {},
})
export type CalendarFetchState = typeof CalendarFetchState.Type

export type CalendarView = Readonly<{
  view: CalendarViewName
  source: CalendarSource
  today: string
  week: WeekReadModel
  month: MonthReadModel
  monthEvents: ReadonlyMap<string, ReadonlyArray<EventOccurrence>>
  monthOccasions: ReadonlyMap<string, ReadonlyArray<OccasionOccurrence>>
}>

/** The sibling state the pure view reads. */
export type CalendarReadInputs = Readonly<{
  display: DisplayFields
  isOnline: boolean
  pending: number
  mirror: MirrorSnapshot
  pendingKeys: ReadonlyArray<string>
}>

const validTimeZone = (timeZone: string): string => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return timeZone
  } catch {
    return DEFAULT_TIME_ZONE
  }
}

const recurrenceOf = (
  recurrence: TaskRow['recurrence'],
): DomainTaskSource['recurrence'] =>
  Option.match(Option.fromNullishOr(recurrence), {
    onNone: () => null,
    onSome: rule => RecurrenceRule.make(rule),
  })

const taskSourceOf = (task: TaskRow): DomainTaskSource => ({
  id: task.id,
  title: task.title,
  status: task.status,
  priority: task.priority,
  dueDate: task.dueDate,
  dueAt: task.dueAt,
  recurrence: recurrenceOf(task.recurrence),
  recurrenceMode: task.recurrenceMode ?? null,
})

const taskSourcesOf = (
  tasks: ReadonlyArray<TaskRow>,
): ReadonlyArray<DomainTaskSource> => Array.map(tasks, taskSourceOf)

export const weekFromMirror = (input: {
  readonly tasks: ReadonlyArray<TaskRow>
  readonly events: ReadonlyArray<EventRow>
  readonly occasions: ReadonlyArray<CalendarOccasionSource>
  readonly anchor: string
  readonly weekStart: WeekStart
  readonly timeZone: string
}): WeekReadModel =>
  buildWeekReadModel({
    tasks: taskSourcesOf(input.tasks),
    events: Array.map(input.events, row =>
      eventSourceWithDomainValues(eventSourceOf(row)),
    ),
    occasions: input.occasions,
    anchor: input.anchor,
    weekStart: input.weekStart,
    timeZone: validTimeZone(input.timeZone),
  })

export const monthFromMirror = (input: {
  readonly tasks: ReadonlyArray<TaskRow>
  readonly events: ReadonlyArray<EventRow>
  readonly occasions: ReadonlyArray<CalendarOccasionSource>
  readonly anchor: string
  readonly weekStart: WeekStart
  readonly timeZone: string
  readonly day?: string | null
}): MonthReadModel => {
  const { year, month } = jalaliMonthOf(input.anchor)

  return buildMonthReadModel({
    tasks: taskSourcesOf(input.tasks),
    events: Array.map(input.events, row =>
      eventSourceWithDomainValues(eventSourceOf(row)),
    ),
    occasions: input.occasions,
    year,
    month,
    weekStart: input.weekStart,
    timeZone: validTimeZone(input.timeZone),
    day: input.day ?? null,
  })
}

const domainTaskSource = (source: CalendarTaskSource): DomainTaskSource => ({
  id: source.id,
  title: source.title,
  status: source.status,
  priority: source.priority,
  dueDate: source.dueDate,
  dueAt: source.dueAt,
  recurrence:
    source.recurrence === null ? null : RecurrenceRule.make(source.recurrence),
  recurrenceMode: source.recurrenceMode,
})

const domainOccasionSource = (
  source: CalendarOccasionSource,
): DomainOccasionSource => ({
  id: source.id,
  title: source.title,
  color: source.color,
  originDate: source.originDate,
  timeZone: source.timeZone,
  yearly: source.yearly,
  advanceReminderDays: source.advanceReminderDays,
})

export const weekFromSources = (input: {
  readonly tasks: ReadonlyArray<CalendarTaskSource>
  readonly events: ReadonlyArray<CalendarEventSource>
  readonly occasions: ReadonlyArray<CalendarOccasionSource>
  readonly anchor: string
  readonly weekStart: WeekStart
  readonly timeZone: string
}): WeekReadModel =>
  buildWeekReadModel({
    tasks: Array.map(input.tasks, domainTaskSource),
    events: Array.map(input.events, eventSourceWithDomainValues),
    occasions: Array.map(input.occasions, domainOccasionSource),
    anchor: input.anchor,
    weekStart: input.weekStart,
    timeZone: validTimeZone(input.timeZone),
  })

export const monthFromSources = (input: {
  readonly tasks: ReadonlyArray<CalendarTaskSource>
  readonly events: ReadonlyArray<CalendarEventSource>
  readonly occasions: ReadonlyArray<CalendarOccasionSource>
  readonly year: number
  readonly month: number
  readonly weekStart: WeekStart
  readonly timeZone: string
  readonly day: string | null
}): MonthReadModel =>
  buildMonthReadModel({
    tasks: Array.map(input.tasks, domainTaskSource),
    events: Array.map(input.events, eventSourceWithDomainValues),
    occasions: Array.map(input.occasions, domainOccasionSource),
    year: input.year,
    month: input.month,
    weekStart: input.weekStart,
    timeZone: validTimeZone(input.timeZone),
    day: input.day,
  })

/**
 * Merge one local mirror row over its server snapshot row. The store applies a
 * local patch over the row it already holds, so the projected row is always
 * complete; this keeps the merge explicit for the fields the calendar paints.
 */
const mergeTaskSource = (
  base: CalendarTaskSource,
  task: TaskRow,
): CalendarTaskSource => ({
  ...base,
  title: task.title,
  status: task.status,
  priority: task.priority,
  dueDate: task.dueDate,
  dueAt: task.dueAt,
  recurrence: recurrenceOf(task.recurrence),
  recurrenceMode: task.recurrenceMode ?? null,
})

/**
 * Overlay the local writes the server snapshot has not seen yet. Only ids in
 * `overlayIds` are merged, so an unrelated mirror row can never roll the
 * server back.
 */
export const overlayCalendarSources = (input: {
  readonly base: ReadonlyArray<CalendarTaskSource>
  readonly mirror: ReadonlyArray<TaskRow>
  readonly overlayIds: ReadonlySet<string>
}): ReadonlyArray<CalendarTaskSource> => {
  const byId = new Map(input.base.map(task => [task.id, task] as const))
  const mirrorById = new Map(input.mirror.map(row => [row.id, row] as const))

  for (const id of input.overlayIds) {
    const row = mirrorById.get(id)

    if (row === undefined) {
      continue
    }

    const base = byId.get(id)
    byId.set(
      id,
      base === undefined ? taskSourceOf(row) : mergeTaskSource(base, row),
    )
  }

  return [...byId.values()]
}

/**
 * Overlay local occasion writes the server snapshot has not seen yet, exactly
 * like the event lane. Occasion rows are few, so the merge is by id over the
 * full set rather than a range query.
 */
export const overlayOccasionSources = (input: {
  readonly base: ReadonlyArray<CalendarOccasionSource>
  readonly mirror: ReadonlyArray<CalendarOccasionSource>
  readonly overlayIds: ReadonlySet<string>
  readonly deletedIds?: ReadonlySet<string>
}): ReadonlyArray<CalendarOccasionSource> => {
  const byId = new Map(
    input.base.map(occasion => [occasion.id, occasion] as const),
  )
  const mirrorById = new Map(
    input.mirror.map(occasion => [occasion.id, occasion] as const),
  )

  for (const id of input.overlayIds) {
    if (input.deletedIds?.has(id) === true) {
      byId.delete(id)
      continue
    }

    const local = mirrorById.get(id)

    if (local === undefined) {
      continue
    }

    byId.set(id, local)
  }

  return [...byId.values()]
}

const idsWithPrefix = (
  keys: ReadonlyArray<string>,
  entityType: string,
): ReadonlySet<string> => {
  const prefix = entityKey(entityType, '')
  const ids = new Set<string>()

  for (const key of keys) {
    if (key.startsWith(prefix)) {
      ids.add(key.slice(prefix.length))
    }
  }

  return ids
}

const unionIds = (
  pendingKeys: ReadonlyArray<string>,
  entityType: string,
  dirtyIds: ReadonlyArray<string>,
): ReadonlySet<string> => {
  const ids = new Set(idsWithPrefix(pendingKeys, entityType))

  for (const id of dirtyIds) {
    ids.add(id)
  }

  return ids
}

/**
 * Pick the server snapshot only while it still describes the visible window.
 * Local writes it has not seen are overlaid on its source rows and re-projected
 * with the same domain builders, so a quick add, completion, move or priority
 * never blanks server-only tasks.
 */
export const calendarViewOf = (input: {
  readonly view: CalendarViewName
  readonly anchor: string
  readonly maybeSelectedDay: Option.Option<string>
  readonly maybeServerWeek: Option.Option<CalendarWeekPayload>
  readonly maybeServerMonth: Option.Option<CalendarMonthPayload>
  readonly dirtyTaskIds: ReadonlyArray<string>
  readonly dirtyEventIds: ReadonlyArray<string>
  readonly now: number
  readonly inputs: CalendarReadInputs
}): CalendarView => {
  const display = input.inputs.display
  const timeZone = validTimeZone(display.timeZone)
  const weekStart = display.weekStart
  const days = input.maybeSelectedDay
  const mirror = input.inputs.mirror

  const mirrorWeek = weekFromMirror({
    tasks: mirror.tasks,
    events: mirror.events,
    occasions: occasionSourcesOf(mirror.occasions),
    anchor: input.anchor,
    weekStart,
    timeZone,
  })
  const mirrorMonth = monthFromMirror({
    tasks: mirror.tasks,
    events: mirror.events,
    occasions: occasionSourcesOf(mirror.occasions),
    anchor: input.anchor,
    weekStart,
    timeZone,
    day: Option.getOrNull(days),
  })

  const taskOverlayIds = unionIds(
    input.inputs.pendingKeys,
    'task',
    input.dirtyTaskIds,
  )
  const eventOverlayIds = unionIds(
    input.inputs.pendingKeys,
    'event',
    input.dirtyEventIds,
  )
  const occasionOverlayIds = idsWithPrefix(input.inputs.pendingKeys, 'occasion')
  const deletedEventIds = new Set(
    Array.map(mirror.trashedEvents, row => row.id),
  )
  const deletedOccasionIds = new Set(
    Array.map(mirror.trashedOccasions, row => row.id),
  )

  const weekHasServer =
    Option.isSome(input.maybeServerWeek) &&
    input.inputs.isOnline &&
    input.maybeServerWeek.value.weekStart === weekStart &&
    input.maybeServerWeek.value.start === mirrorWeek.start

  const week =
    Option.isSome(input.maybeServerWeek) && weekHasServer
      ? (() => {
          const server = input.maybeServerWeek.value
          return weekFromSources({
            tasks: overlayCalendarSources({
              base: server.tasks,
              mirror: mirror.tasks,
              overlayIds: taskOverlayIds,
            }),
            events: overlayEventSources({
              base: server.events,
              mirror: mirror.events,
              overlayIds: eventOverlayIds,
              deletedIds: deletedEventIds,
            }),
            occasions: overlayOccasionSources({
              base: server.occasions,
              mirror: occasionSourcesOf(mirror.occasions),
              overlayIds: occasionOverlayIds,
              deletedIds: deletedOccasionIds,
            }),
            anchor: server.start,
            weekStart: server.weekStart,
            timeZone: server.timeZone,
          })
        })()
      : mirrorWeek

  const monthHasServer =
    Option.isSome(input.maybeServerMonth) &&
    input.inputs.isOnline &&
    input.maybeServerMonth.value.weekStart === weekStart &&
    input.maybeServerMonth.value.year === mirrorMonth.year &&
    input.maybeServerMonth.value.month === mirrorMonth.month

  const month =
    Option.isSome(input.maybeServerMonth) && monthHasServer
      ? (() => {
          const server = input.maybeServerMonth.value
          return monthFromSources({
            tasks: overlayCalendarSources({
              base: server.tasks,
              mirror: mirror.tasks,
              overlayIds: taskOverlayIds,
            }),
            events: overlayEventSources({
              base: server.events,
              mirror: mirror.events,
              overlayIds: eventOverlayIds,
              deletedIds: deletedEventIds,
            }),
            occasions: overlayOccasionSources({
              base: server.occasions,
              mirror: occasionSourcesOf(mirror.occasions),
              overlayIds: occasionOverlayIds,
              deletedIds: deletedOccasionIds,
            }),
            year: server.year,
            month: server.month,
            weekStart: server.weekStart,
            timeZone: server.timeZone,
            day: Option.getOrNull(days),
          })
        })()
      : mirrorMonth

  const monthEventOccurrences = eventOccurrences({
    events: month.events,
    from: month.start,
    to: month.end,
    timeZone: month.timeZone,
  })
  const monthEvents = new Map<string, Array<EventOccurrence>>()

  for (const occurrence of monthEventOccurrences) {
    const bucket = monthEvents.get(occurrence.date) ?? []
    bucket.push(occurrence)
    monthEvents.set(occurrence.date, bucket)
  }

  const monthOccasions = monthOccasionsFromSources(
    month.occasions,
    month.start,
    month.end,
  )

  return {
    view: input.view,
    source:
      input.view === 'week'
        ? weekHasServer
          ? 'server'
          : 'mirror'
        : monthHasServer
          ? 'server'
          : 'mirror',
    today: todayIn(timeZone, new Date(input.now)),
    week,
    month,
    monthEvents,
    monthOccasions: monthOccasionsByDate(monthOccasions),
  }
}

const monthOccasionsByDate = (
  occurrences: ReadonlyArray<OccasionOccurrence>,
): ReadonlyMap<string, ReadonlyArray<OccasionOccurrence>> => {
  const map = new Map<string, Array<OccasionOccurrence>>()

  for (const occurrence of occurrences) {
    const bucket = map.get(occurrence.date) ?? []
    bucket.push(occurrence)
    map.set(occurrence.date, bucket)
  }

  return map
}

// DISPLAY HELPERS

export const dayLabel = (date: string, digits: Digits): string =>
  formatJalaliDate(toJalaliDate(date), { digits, style: 'long' })

export const shortDayLabel = (date: string, digits: Digits): string =>
  formatJalaliDate(toJalaliDate(date), { digits, style: 'short' })

export const weekTitle = (start: string, end: string, digits: Digits): string =>
  `${shortDayLabel(start, digits)} – ${shortDayLabel(end, digits)}`

export const monthTitle = (anchor: string, digits: Digits): string => {
  const { year, month } = jalaliMonthOf(anchor)

  return formatJalaliMonth(year, month, digits)
}

export const monthDayLabel = (date: string, digits: Digits): string =>
  formatJalaliDate(toJalaliDate(date), { digits, style: 'long' })

export const jalaliDayNumber = (date: string, digits: Digits): string =>
  localizeDigits(toJalaliFields(toJalaliDate(date)).day, digits)

export const shiftMonth = (anchor: string, months: number): string =>
  toIsoDate(addJalaliMonths(toJalaliDate(anchor), months))

export const shiftDay = (date: string, days: number): string =>
  toIsoDate(toJalaliDate(date).add({ days }))

export const todayIn = (timeZone: string, now: Date): string =>
  toIsoDate(toJalaliDateInZone(now, validTimeZone(timeZone)))

export const weekdayOf = (date: string): string =>
  JALALI_WEEKDAYS[toJalaliDate(date).withCalendar('iso8601').dayOfWeek - 1] ??
  ''

export type CalendarWeekDay = Readonly<{
  key: string
  weekday: string
  shortWeekday: string
}>

export const weekDaysFor = (
  anchor: string,
  weekStart: WeekStart,
): ReadonlyArray<CalendarWeekDay> =>
  Array.map(jalaliWeek(toJalaliDate(anchor), weekStart), day => {
    const weekday =
      JALALI_WEEKDAYS[day.withCalendar('iso8601').dayOfWeek - 1] ?? ''

    return {
      key: day.withCalendar('iso8601').toString(),
      weekday,
      shortWeekday: weekday.charAt(0),
    }
  })

export const PRIORITY_LABELS: Readonly<
  Record<'high' | 'medium' | 'low', string>
> = {
  high: 'بالا',
  medium: 'متوسط',
  low: 'پایین',
}

export const emptyWeekCopy = 'این هفته هنوز کاری ندارد.'
export const emptyDayCopy = 'این روز خالی است.'

export const taskCountLabel = (count: number, digits: Digits): string =>
  `${localizeDigits(count, digits)} کار`

export const monthOffsets = (count: number): ReadonlyArray<number> =>
  Array.makeBy(count, index => index)

export const monthEventSummary = (count: number, digits: Digits): string =>
  `${localizeDigits(count, digits)} رویداد`

export const monthOccasionSummary = (count: number, digits: Digits): string =>
  `${localizeDigits(count, digits)} مناسبت`

export const sourceText = (
  isOnline: boolean,
  fetchState: CalendarFetchState,
): string => {
  if (!isOnline) {
    return 'آفلاین — نمایش از حافظهٔ محلی'
  }

  return CalendarFetchState.match(fetchState, {
    Idle: () => '',
    Ready: () => '',
    Offline: () => 'آفلاین — نمایش از حافظهٔ محلی',
    Error: () => 'ارتباط با سرور برقرار نشد؛ نمایش از حافظهٔ محلی',
  })
}

export const showsSourceHint = (
  isOnline: boolean,
  fetchState: CalendarFetchState,
): boolean =>
  !isOnline ||
  CalendarFetchState.match(fetchState, {
    Idle: () => false,
    Ready: () => false,
    Offline: () => true,
    Error: () => true,
  })

export const monthNameOf = (date: string): string =>
  JALALI_MONTHS[toJalaliFields(toJalaliDate(date)).month - 1] ?? ''
