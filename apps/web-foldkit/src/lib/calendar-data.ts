import { Schema } from 'effect'

import type { CalendarEventSource as DomainEventSource } from '@tali/domain'
import {
  EventException,
  EventExceptionId,
  EventTiming,
  LocalDate,
  RecurrenceRule,
  TimestampUtc,
} from '@tali/domain'

/**
 * Plain calendar wire/read-model shapes.
 *
 * The api Worker serves the domain's week and month read models, but the app
 * decodes them with its own Schema runtime: dev Vite serves `effect/schema` as
 * a second module graph, so decoding through the domain's branded schemas would
 * produce values from the other instance (the same rule `today-api.ts`
 * follows). The branded values only reappear at the domain builder seam, where
 * `eventSourcesWithDomainValues` reconstructs them with the schema
 * constructors.
 */

export const CalendarTiming = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('timed'),
    start: Schema.String,
    end: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal('allDay'),
    date: Schema.String,
  }),
])

export type CalendarTiming = typeof CalendarTiming.Type

export const CalendarRecurrenceEnd = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('never') }),
  Schema.Struct({ _tag: Schema.Literal('count'), count: Schema.Int }),
  Schema.Struct({ _tag: Schema.Literal('until'), date: Schema.String }),
])

export type CalendarRecurrenceEnd = typeof CalendarRecurrenceEnd.Type

export const CalendarRecurrenceRule = Schema.Struct({
  frequency: Schema.Literals(['daily', 'weekly', 'monthly', 'yearly']),
  interval: Schema.Int,
  byDay: Schema.optional(Schema.Array(Schema.Int)),
  byMonthDay: Schema.optional(Schema.Array(Schema.Int)),
  nthWeekday: Schema.optional(
    Schema.Struct({ nth: Schema.Int, day: Schema.Int }),
  ),
  end: CalendarRecurrenceEnd,
})

export type CalendarRecurrenceRule = typeof CalendarRecurrenceRule.Type

export const CalendarExceptionOverrides = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  location: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  timing: Schema.optional(CalendarTiming),
  timeZone: Schema.optional(Schema.String),
})

export type CalendarExceptionOverrides = typeof CalendarExceptionOverrides.Type

export const CalendarEventException = Schema.Struct({
  id: Schema.String,
  instanceId: Schema.String,
  action: Schema.Literals(['delete', 'override']),
  overrides: Schema.NullOr(CalendarExceptionOverrides),
  createdAt: Schema.String,
})

export type CalendarEventException = typeof CalendarEventException.Type

export const CalendarWeekStart = Schema.Literals([
  'saturday',
  'sunday',
  'monday',
])

export type CalendarWeekStart = typeof CalendarWeekStart.Type

export const CalendarTaskStatus = Schema.Literals(['todo', 'doing', 'done'])

export type CalendarTaskStatus = typeof CalendarTaskStatus.Type

export const CalendarPriority = Schema.Literals(['high', 'medium', 'low'])

export type CalendarPriority = typeof CalendarPriority.Type

export const CalendarTaskSource = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: CalendarTaskStatus,
  priority: CalendarPriority,
  dueDate: Schema.NullOr(Schema.String),
  dueAt: Schema.NullOr(Schema.String),
  recurrence: Schema.NullOr(CalendarRecurrenceRule),
  recurrenceMode: Schema.NullOr(Schema.Literals(['onCompletion', 'onDueDate'])),
})

export type CalendarTaskSource = typeof CalendarTaskSource.Type

export const CalendarEventSource = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  people: Schema.Array(Schema.String),
  timing: CalendarTiming,
  timeZone: Schema.String,
  recurrence: Schema.NullOr(CalendarRecurrenceRule),
  exceptions: Schema.Array(CalendarEventException),
})

export type CalendarEventSource = typeof CalendarEventSource.Type

export const CalendarOccasionSource = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  color: Schema.NullOr(Schema.String),
  originDate: Schema.String,
  timeZone: Schema.String,
  yearly: Schema.Boolean,
  advanceReminderDays: Schema.NullOr(Schema.Int),
})

export type CalendarOccasionSource = typeof CalendarOccasionSource.Type

export const CalendarTaskItem = Schema.Struct({
  key: Schema.String,
  id: Schema.String,
  title: Schema.String,
  status: CalendarTaskStatus,
  priority: CalendarPriority,
  date: Schema.String,
  projected: Schema.Boolean,
  recurring: Schema.Boolean,
})

export type CalendarTaskItem = typeof CalendarTaskItem.Type

export const CalendarEventOccurrence = Schema.Struct({
  key: Schema.String,
  id: Schema.String,
  instanceId: Schema.String,
  date: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  people: Schema.Array(Schema.String),
  timing: CalendarTiming,
  timeZone: Schema.String,
  projected: Schema.Boolean,
  recurring: Schema.Boolean,
  overridden: Schema.Boolean,
  exceptionId: Schema.NullOr(Schema.String),
})

export type CalendarEventOccurrence = typeof CalendarEventOccurrence.Type

export const CalendarCalendarDate = Schema.Struct({
  year: Schema.Int,
  month: Schema.Int,
  day: Schema.Int,
})

export type CalendarCalendarDate = typeof CalendarCalendarDate.Type

export const CalendarOccasionOccurrence = Schema.Struct({
  key: Schema.String,
  id: Schema.String,
  title: Schema.String,
  color: Schema.NullOr(Schema.String),
  date: Schema.String,
  jalali: CalendarCalendarDate,
  gregorian: CalendarCalendarDate,
  originDate: Schema.String,
  yearly: Schema.Boolean,
  projected: Schema.Boolean,
  advanceReminderDate: Schema.NullOr(Schema.String),
  advanceReminderAt: Schema.NullOr(Schema.String),
})

export type CalendarOccasionOccurrence = typeof CalendarOccasionOccurrence.Type

export const CalendarLaneCounts = Schema.Struct({
  tasks: Schema.Int,
  events: Schema.Int,
  occasions: Schema.Int,
  reminders: Schema.Int,
  habits: Schema.Int,
})

export type CalendarLaneCounts = typeof CalendarLaneCounts.Type

export const CalendarLaneEmpty = Schema.Struct({
  tasks: Schema.Boolean,
  events: Schema.Boolean,
  occasions: Schema.Boolean,
  reminders: Schema.Boolean,
  habits: Schema.Boolean,
})

export type CalendarLaneEmpty = typeof CalendarLaneEmpty.Type

export const CalendarDay = Schema.Struct({
  date: Schema.String,
  tasks: Schema.Array(CalendarTaskItem),
  events: Schema.Array(CalendarEventOccurrence),
  occasions: Schema.Array(CalendarOccasionOccurrence),
  counts: CalendarLaneCounts,
  empty: CalendarLaneEmpty,
})

export type CalendarDay = typeof CalendarDay.Type

/**
 * The subset of `GET /week` the screen needs. The occurrences are re-projected
 * from these source rows through the domain builders, so the day grids in the
 * payload are deliberately not decoded.
 */
export const CalendarWeekPayload = Schema.Struct({
  start: Schema.String,
  end: Schema.String,
  timeZone: Schema.String,
  weekStart: CalendarWeekStart,
  tasks: Schema.Array(CalendarTaskSource),
  events: Schema.Array(CalendarEventSource),
  occasions: Schema.Array(CalendarOccasionSource),
})

export type CalendarWeekPayload = typeof CalendarWeekPayload.Type

/** The subset of `GET /month` the screen needs; `day` is rebuilt locally. */
export const CalendarMonthPayload = Schema.Struct({
  year: Schema.Int,
  month: Schema.Int,
  start: Schema.String,
  end: Schema.String,
  timeZone: Schema.String,
  weekStart: CalendarWeekStart,
  tasks: Schema.Array(CalendarTaskSource),
  events: Schema.Array(CalendarEventSource),
  occasions: Schema.Array(CalendarOccasionSource),
})

export type CalendarMonthPayload = typeof CalendarMonthPayload.Type

/**
 * The same source rows, with the branded values the domain builders expect.
 * Construction is pure: the values were already decoded by the locals above.
 */
export const timingWithDomainValues = (timing: CalendarTiming): EventTiming =>
  timing._tag === 'allDay'
    ? EventTiming.make({
        _tag: 'allDay',
        date: LocalDate.make(timing.date),
      })
    : EventTiming.make({
        _tag: 'timed',
        start: TimestampUtc.make(timing.start),
        end: TimestampUtc.make(timing.end),
      })

export const recurrenceWithDomainValues = (
  rule: CalendarRecurrenceRule,
): RecurrenceRule =>
  RecurrenceRule.make({
    ...rule,
    end:
      rule.end._tag === 'until'
        ? { _tag: 'until', date: LocalDate.make(rule.end.date) }
        : rule.end,
  })

export const eventSourceWithDomainValues = (
  source: CalendarEventSource,
): DomainEventSource => ({
  id: source.id,
  title: source.title,
  description: source.description,
  location: source.location,
  category: source.category,
  color: source.color,
  people: [...source.people],
  timing: timingWithDomainValues(source.timing),
  timeZone: source.timeZone,
  recurrence:
    source.recurrence === null
      ? null
      : recurrenceWithDomainValues(source.recurrence),
  exceptions: source.exceptions.map(exception =>
    EventException.make({
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
      createdAt: TimestampUtc.make(exception.createdAt),
    }),
  ),
})
