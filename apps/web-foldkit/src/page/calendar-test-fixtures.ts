import { Option } from 'effect'

import {
  CalendarMonthPayload,
  CalendarRecurrenceEnd,
  CalendarTiming,
  CalendarWeekPayload,
} from '../lib/calendar-data'
import { EventRow } from '../lib/event-writes'
import { OccasionRow } from '../lib/occasion-writes'
import { emptyMirrorSnapshot } from '../mirror'
import type { MirrorSnapshot, TaskRow } from '../mirror'
import { HOUSEHOLD_ID, TODAY_NOW, USER_ID } from '../test-fixtures'
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

export const calendarTask = (overrides: Partial<TaskRow> = {}): TaskRow => ({
  id: CALENDAR_TASK_ID,
  title: 'خرید نان',
  description: null,
  status: 'todo',
  priority: 'medium',
  dueDate: TODAY,
  dueAt: null,
  timeZone: 'Asia/Tehran',
  projectId: null,
  tagIds: [],
  startedAt: null,
  completedAt: null,
  createdAt: '2026-10-28T08:00:00.000Z',
  updatedAt: '2026-10-28T08:00:00.000Z',
  version: 1,
  hasSyncError: false,
  ...overrides,
})

export const eventRow = (overrides: Partial<EventRow> = {}): EventRow =>
  EventRow.make({
    id: EVENT_ID,
    title: 'سفر',
    description: null,
    location: null,
    category: null,
    color: null,
    people: [],
    timing: CalendarTiming.allDay({ date: TODAY }),
    timeZone: 'Asia/Tehran',
    recurrence: null,
    exceptions: [],
    occasionId: null,
    ownerId: USER_ID,
    householdId: HOUSEHOLD_ID,
    visibility: 'shared',
    createdAt: '2026-10-28T08:00:00.000Z',
    updatedAt: '2026-10-28T08:00:00.000Z',
    version: 1,
    deletedAt: null,
    hasSyncError: false,
    ...overrides,
  })

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
): OccasionRow =>
  OccasionRow.make({
    id: OCCASION_ID,
    title: 'تولد مامان',
    originDate: TODAY,
    timeZone: 'Asia/Tehran',
    yearly: true,
    advanceReminderDays: 7,
    preparationTaskId: null,
    color: null,
    ownerId: null,
    visibility: 'shared',
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    version: 1,
    hasSyncError: false,
    ...overrides,
  })

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

export const mirrorWith = (input: {
  readonly tasks?: ReadonlyArray<TaskRow>
  readonly events?: ReadonlyArray<EventRow>
  readonly occasions?: ReadonlyArray<OccasionRow>
  readonly trashedEvents?: ReadonlyArray<EventRow>
  readonly trashedOccasions?: ReadonlyArray<OccasionRow>
}): MirrorSnapshot => ({
  ...emptyMirrorSnapshot(),
  tasks: input.tasks ?? [],
  events: input.events ?? [],
  occasions: input.occasions ?? [],
  trashedEvents: input.trashedEvents ?? [],
  trashedOccasions: input.trashedOccasions ?? [],
})

export const calendarInputs = (overrides: Partial<Inputs> = {}): Inputs => ({
  display: {
    timeZone: 'Asia/Tehran',
    weekStart: 'saturday',
    digits: 'persian',
  },
  isStoreReady: true,
  isOnline: true,
  pending: 0,
  mirror: mirrorWith({}),
  pendingKeys: [],
  maybeUserId: Option.some(USER_ID),
  maybeHouseholdId: Option.some(HOUSEHOLD_ID),
  ...overrides,
})

export const calendarModel = (overrides: Partial<Model> = {}): Model => ({
  ...Calendar.initialModel(TODAY_NOW),
  ...overrides,
})
