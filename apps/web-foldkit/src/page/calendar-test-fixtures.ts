import { Option } from 'effect'

import {
  CalendarMonthPayload,
  CalendarRecurrenceEnd,
  CalendarTiming,
  CalendarWeekPayload,
} from '../lib/calendar-data'
import type { EventRow } from '../lib/event-writes'
import type { OccasionRow } from '../lib/occasion-writes'
import type { TaskRow } from '../mirror'
import {
  mirrorEvent,
  mirrorOccasion,
  mirrorSnapshot,
  mirrorTask,
} from '../mirror-fixtures'
import { DISPLAY, HOUSEHOLD_ID, TODAY_NOW, USER_ID } from '../test-fixtures'
import * as Calendar from './calendar'
import type { Inputs, Model } from './calendar'

/**
 * Deterministic Calendar fixtures shared by the Story and Scene tests.
 *
 * The fixed instant is 2026-10-30T09:30Z: Friday 8 Aban 1405 in Tehran, the
 * last day of the Saturday-started week 2026-10-24…2026-10-30.
 */

export const EVENT_ID = '0192f0a0-0000-7000-8000-000000000040'
export const SECOND_EVENT_ID = '0192f0a0-0000-7000-8000-000000000041'
export const OCCASION_ID = '0192f0a0-0000-7000-8000-000000000042'
export const CALENDAR_TASK_ID = '0192f0a0-0000-7000-8000-000000000043'
export const RECURRING_EVENT_ID = '0192f0a0-0000-7000-8000-000000000044'

export const WEEK_START = '2026-10-24'
export const WEEK_END = '2026-10-30'
export const TODAY = '2026-10-30'

export const calendarTask = (overrides: Partial<TaskRow> = {}): TaskRow =>
  mirrorTask({ id: CALENDAR_TASK_ID, ...overrides })

export const eventRow = (overrides: Partial<EventRow> = {}): EventRow =>
  mirrorEvent({ id: EVENT_ID, ...overrides })

export const timedEventRow = (overrides: Partial<EventRow> = {}): EventRow =>
  eventRow({
    id: SECOND_EVENT_ID,
    title: 'جلسه',
    timing: CalendarTiming.timed({
      start: '2026-10-30T05:30:00.000Z',
      end: '2026-10-30T06:30:00.000Z',
    }),
    ...overrides,
  })

export const weeklyEventRow = (overrides: Partial<EventRow> = {}): EventRow =>
  eventRow({
    id: RECURRING_EVENT_ID,
    title: 'جلسهٔ هفتگی',
    timing: CalendarTiming.allDay({ date: '2026-10-23' }),
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      byDay: [5],
      end: CalendarRecurrenceEnd.never(),
    },
    ...overrides,
  })

export const occasionRow = (
  overrides: Partial<OccasionRow> = {},
): OccasionRow => mirrorOccasion({ id: OCCASION_ID, ...overrides })

export const weekPayload = (
  overrides: Partial<CalendarWeekPayload> = {},
): CalendarWeekPayload =>
  CalendarWeekPayload.make({
    start: WEEK_START,
    end: WEEK_END,
    timeZone: 'Asia/Tehran',
    weekStart: 'saturday',
    tasks: [],
    events: [],
    occasions: [],
    ...overrides,
  })

export const monthPayload = (
  overrides: Partial<CalendarMonthPayload> = {},
): CalendarMonthPayload =>
  CalendarMonthPayload.make({
    year: 1405,
    month: 8,
    start: '2026-10-23',
    end: '2026-11-20',
    timeZone: 'Asia/Tehran',
    weekStart: 'saturday',
    tasks: [],
    events: [],
    occasions: [],
    ...overrides,
  })

export const calendarInputs = (overrides: Partial<Inputs> = {}): Inputs => ({
  display: DISPLAY,
  isStoreReady: true,
  isOnline: true,
  pending: 0,
  mirror: mirrorSnapshot(),
  pendingKeys: [],
  maybeUserId: Option.some(USER_ID),
  maybeHouseholdId: Option.some(HOUSEHOLD_ID),
  ...overrides,
})

export const calendarModel = (overrides: Partial<Model> = {}): Model => ({
  ...Calendar.initialModel(TODAY_NOW),
  ...overrides,
})
