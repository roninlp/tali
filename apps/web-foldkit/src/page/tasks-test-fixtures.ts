import { Option } from 'effect'
import { modifyFields } from 'foldkit/struct'

import { emptyMirrorSnapshot } from '../mirror'
import type { ProjectRow, TagRow, TaskRow } from '../mirror'
import { TODAY_NOW, USER_ID } from '../test-fixtures'
import * as Tasks from './tasks'
import type { Inputs } from './tasks'

/**
 * Shared, deterministic fixtures for the Tasks Story and Scene tests. The
 * fixed instant is Friday morning in Tehran, so board buckets and the Jalali
 * due labels stay stable across machines and DST.
 */

export const todayTaskId = '0192f0a0-0000-7000-8000-000000000101'
export const overdueTaskId = '0192f0a0-0000-7000-8000-000000000102'
export const tomorrowTaskId = '0192f0a0-0000-7000-8000-000000000103'
export const laterTaskId = '0192f0a0-0000-7000-8000-000000000104'
export const inboxTaskId = '0192f0a0-0000-7000-8000-000000000105'
export const doneTaskId = '0192f0a0-0000-7000-8000-000000000106'
export const projectId = '0192f0a0-0000-7000-8000-000000000201'
export const tagId = '0192f0a0-0000-7000-8000-000000000301'

const baseTask: TaskRow = {
  id: todayTaskId,
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

export const todayTask: TaskRow = { ...baseTask }

export const overdueTask: TaskRow = {
  ...baseTask,
  id: overdueTaskId,
  title: 'کار عقب‌افتاده',
  dueDate: '2026-10-29',
  projectId,
  tagIds: [tagId],
  priority: 'high',
}

export const tomorrowTask: TaskRow = {
  ...baseTask,
  id: tomorrowTaskId,
  title: 'کار فردا',
  dueDate: '2026-10-31',
}

export const laterTask: TaskRow = {
  ...baseTask,
  id: laterTaskId,
  title: 'کار بعدتر',
  dueDate: '2026-11-05',
  status: 'doing',
  startedAt: '2026-10-28T09:00:00.000Z',
}

export const inboxTask: TaskRow = {
  ...baseTask,
  id: inboxTaskId,
  title: 'کار صندوق',
  dueDate: null,
}

export const doneTask: TaskRow = {
  ...baseTask,
  id: doneTaskId,
  title: 'کار تمام‌شده',
  status: 'done',
  completedAt: '2026-10-29T12:00:00.000Z',
}

export const project: ProjectRow = {
  id: projectId,
  title: 'خانه',
  color: null,
}

export const tag: TagRow = {
  id: tagId,
  name: 'فوری',
  color: null,
}

export const tasks: ReadonlyArray<TaskRow> = [
  todayTask,
  overdueTask,
  tomorrowTask,
  laterTask,
  inboxTask,
  doneTask,
]

export const mirror = {
  ...emptyMirrorSnapshot(),
  tasks: [...tasks],
  projects: [project],
  tags: [tag],
}

export const defaultInputs = (overrides: Partial<Inputs> = {}): Inputs => ({
  display: {
    timeZone: 'Asia/Tehran',
    weekStart: 'saturday',
    digits: 'persian',
  },
  isStoreReady: true,
  isOnline: true,
  pending: 0,
  mirror,
  pendingKeys: [],
  ...overrides,
})

export const baseModel = (): Tasks.Model =>
  Tasks.initialModel({
    now: TODAY_NOW,
    maybeUserId: Option.some(USER_ID),
    maybeSettings: Option.none(),
  })

export const withEditor = (
  model: Tasks.Model,
  task: TaskRow = todayTask,
): Tasks.Model =>
  modifyFields(model, {
    editors: () => [Tasks.taskEditorFor(task)],
  })
