import { Option } from 'effect'

import { HabitFrequency, HabitRow } from './habits-model'
import { CalendarTiming } from './lib/calendar-data'
import { EventRow } from './lib/event-writes'
import { OccasionRow } from './lib/occasion-writes'
import { ListRow } from './lists-model'
import { NoteRow, TaskRow, emptyMirrorSnapshot } from './mirror'
import type { MirrorSnapshot } from './mirror'
import { HOUSEHOLD_ID, USER_ID } from './test-fixtures'

/**
 * Builders for the mirrored rows the page fixtures hand to their screens.
 *
 * Each builder opens with the field set every page fixture used to re-spell
 * inline; a page keeps its own id/title by passing overrides. Times are the
 * fixed instant the Story and Scene tests share, expressed as literal strings so
 * no builder depends on the machine clock or zone.
 */

/** A stable placeholder id; every page builder overrides it with its own. */
const FIXTURE_ID = '0192f0a0-0000-7000-8000-0000000000ff'
const FIXTURE_DATE = '2026-10-30'
const FIXTURE_TIME_ZONE = 'Asia/Tehran'

export const mirrorTask = (overrides: Partial<TaskRow> = {}): TaskRow => ({
  ...TaskRow.make({
    id: FIXTURE_ID,
    title: 'خرید نان',
    description: null,
    status: 'todo',
    priority: 'medium',
    dueDate: FIXTURE_DATE,
    dueAt: null,
    timeZone: FIXTURE_TIME_ZONE,
    projectId: null,
    tagIds: [],
    startedAt: null,
    completedAt: null,
    createdAt: '2026-10-28T08:00:00.000Z',
    updatedAt: '2026-10-28T08:00:00.000Z',
    version: 1,
    hasSyncError: false,
  }),
  ...overrides,
})

export const mirrorNote = (overrides: Partial<NoteRow> = {}): NoteRow => ({
  ...NoteRow.make({
    id: FIXTURE_ID,
    title: 'خرید دارو',
    text: 'قرص می‌روم و دارو می‌خورم',
    excerpt: 'قرص می‌روم و دارو می‌خورم',
    isPinned: false,
    isArchived: false,
    tagIds: [],
    updatedAt: '2026-10-20T09:30:00.000Z',
    deletedAt: null,
    version: 1,
    syncErrorCode: Option.none(),
  }),
  ...overrides,
})

export const mirrorHabit = (overrides: Partial<HabitRow> = {}): HabitRow => ({
  ...HabitRow.make({
    id: FIXTURE_ID,
    title: 'آب خوردن',
    description: null,
    icon: '💧',
    color: null,
    frequency: HabitFrequency.daily(),
    frequencyHistory: [
      { effectiveFrom: '2026-10-01', frequency: HabitFrequency.daily() },
    ],
    startedOn: '2026-10-01',
    reminderTime: null,
    timeZone: FIXTURE_TIME_ZONE,
    ownerId: null,
    visibility: 'shared',
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    version: 1,
    hasSyncError: false,
  }),
  ...overrides,
})

export const mirrorList = (overrides: Partial<ListRow> = {}): ListRow => ({
  ...ListRow.make({
    id: FIXTURE_ID,
    ownerId: USER_ID,
    title: 'خرید هفتگی',
    description: null,
    color: '#0f9d8f',
    icon: '🛒',
    sort: 'manual',
    checkedPlacement: 'bottom',
    visibility: 'shared',
    lastWriterId: USER_ID,
    createdAt: '2026-10-20T09:00:00.000Z',
    updatedAt: '2026-10-20T09:00:00.000Z',
    version: 1,
    hasSyncError: false,
  }),
  ...overrides,
})

export const mirrorEvent = (overrides: Partial<EventRow> = {}): EventRow => ({
  ...EventRow.make({
    id: FIXTURE_ID,
    title: 'سفر',
    description: null,
    location: null,
    category: null,
    color: null,
    people: [],
    timing: CalendarTiming.allDay({ date: FIXTURE_DATE }),
    timeZone: FIXTURE_TIME_ZONE,
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
  }),
  ...overrides,
})

export const mirrorOccasion = (
  overrides: Partial<OccasionRow> = {},
): OccasionRow => ({
  ...OccasionRow.make({
    id: FIXTURE_ID,
    title: 'تولد مامان',
    originDate: FIXTURE_DATE,
    timeZone: FIXTURE_TIME_ZONE,
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
  }),
  ...overrides,
})

/** A mirror snapshot with only the lanes a page cares about filled in. */
export const mirrorSnapshot = (
  parts: Partial<MirrorSnapshot> = {},
): MirrorSnapshot => ({ ...emptyMirrorSnapshot(), ...parts })
