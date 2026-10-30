import { Option } from 'effect'

import type { HabitEntryRow, HabitRow } from '../habits-model'
import { TodayReadModel } from '../lib/today-api'
import type { TodayCounts } from '../lib/today-api'
import { emptyMirrorSnapshot } from '../mirror'
import type { NoteRow, TaskRow } from '../mirror'
import { TODAY_NOW } from '../test-fixtures'
import type { Inputs } from './today'

/**
 * Shared, deterministic fixtures for Today's Story and Scene tests.
 *
 * The fixed instant is a Friday morning in Tehran, so Jalali week and time
 * assertions stay stable across machines and DST.
 */

export const TodayReadModelFixture = TodayReadModel

export const taskId = '0192f0a0-0000-7000-8000-000000000010'
export const secondTaskId = '0192f0a0-0000-7000-8000-000000000011'
export const noteId = '0192f0a0-0000-7000-8000-000000000020'
export const habitId = '0192f0a0-0000-7000-8000-000000000030'
export const habitEntryId = '0192f0a0-0000-7000-8000-000000000031'

export const task: TaskRow = {
  id: taskId,
  title: 'خرید نان',
  description: null,
  status: 'todo',
  priority: 'medium',
  dueDate: '2026-10-30',
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
}

export const secondTask: TaskRow = {
  ...task,
  id: secondTaskId,
  title: 'تماس با مادر',
  dueAt: '2026-10-30T12:30:00.000Z',
  updatedAt: '2026-10-28T09:00:00.000Z',
}

export const tomorrowTask: TaskRow = {
  ...task,
  id: '0192f0a0-0000-7000-8000-000000000012',
  title: 'کار فردا',
  dueDate: '2026-10-31',
}

export const note: NoteRow = {
  id: noteId,
  title: 'ایده‌های هفته',
  text: 'متن یادداشت',
  excerpt: 'متن یادداشت',
  isPinned: true,
  isArchived: false,
  tagIds: [],
  updatedAt: '2026-10-29T08:00:00.000Z',
  deletedAt: null,
  version: 1,
  syncErrorCode: Option.none(),
}

export const habit: HabitRow = {
  id: habitId,
  title: 'آب خوردن',
  description: null,
  icon: '💧',
  color: null,
  frequency: { _tag: 'daily' },
  frequencyHistory: [
    { effectiveFrom: '2026-10-01', frequency: { _tag: 'daily' } },
  ],
  startedOn: '2026-10-01',
  reminderTime: null,
  timeZone: 'Asia/Tehran',
  visibility: 'shared',
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
  version: 1,
  hasSyncError: false,
}

export const habitEntry: HabitEntryRow = {
  id: habitEntryId,
  habitId,
  localDate: '2026-10-29',
  status: 'done',
  timeZone: 'Asia/Tehran',
  updatedAt: '2026-10-29T08:00:00.000Z',
  version: 1,
}

export const counts = (
  tasks: number,
  overdue: number,
  notes: number,
): TodayCounts => ({
  tasks,
  overdue,
  events: 0,
  reminders: 0,
  habits: 0,
  notes,
})

export const empty = (hasTasks: boolean, hasNotes: boolean) => ({
  tasks: !hasTasks,
  events: true,
  reminders: true,
  habits: true,
  notes: !hasNotes,
})

export const readModel = (input: {
  tasks?: ReadonlyArray<TaskRow>
  notes?: ReadonlyArray<NoteRow>
  today?: string
  tomorrow?: string
}) => {
  const tasks = input.tasks ?? []
  const notes = input.notes ?? []

  return TodayReadModel.make({
    today: input.today ?? '2026-10-30',
    tomorrow: input.tomorrow ?? '2026-10-31',
    timeZone: 'Asia/Tehran',
    tasks: tasks.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      dueDate: row.dueDate,
      dueAt: row.dueAt,
      timeZone: row.timeZone,
      projectId: row.projectId,
      tagIds: [...row.tagIds],
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      version: row.version,
    })),
    notes: notes.map(row => ({
      id: row.id,
      title: row.title,
      plainText: row.text,
      isPinned: row.isPinned,
      isArchived: row.isArchived,
      tagIds: [...row.tagIds],
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      version: row.version,
    })),
    counts: counts(tasks.length, 0, notes.length),
    empty: empty(tasks.length > 0, notes.length > 0),
  })
}

export const defaultInputs = (overrides: Partial<Inputs> = {}): Inputs => ({
  display: {
    timeZone: 'Asia/Tehran',
    weekStart: 'saturday',
    digits: 'persian',
  },
  sectionOrder: ['tasks', 'events', 'reminders', 'habits', 'notes'],
  isStoreReady: true,
  isOnline: true,
  pending: 0,
  mirror: emptyMirrorSnapshot(),
  pendingKeys: [],
  ...overrides,
})

export const maybeEtag = Option.none<string>()
export const now = TODAY_NOW
