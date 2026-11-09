import { Option } from 'effect'
import { beforeEach, describe, expect, test } from 'vitest'

import {
  DEFAULT_TASK_VIEW,
  ProjectFilter,
  TaskFilters,
  TaskSort,
  TaskViewSettings,
} from './tasks-model'
import {
  cacheTaskViewSettings,
  parseTaskViewSettings,
  readTaskViewSettings,
} from './tasks-view-cache'

/** The filter bar persists per user and degrades to defaults on bad data. */

const stored = (settings: TaskViewSettings) => {
  const filters = settings.filters

  const projectId = ProjectFilter.match(filters.project, {
    All: () => undefined,
    None: () => null,
    Project: ({ projectId }) => projectId,
  })

  return {
    filters: {
      projectId,
      tagIds: filters.tagIds,
      priority: filters.priority,
      status: filters.status,
      date: filters.date,
    },
    sort: settings.sort,
  }
}

describe('task view persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('round-trips filters and sort through localStorage', () => {
    const view = TaskViewSettings.make({
      filters: TaskFilters.make({
        project: ProjectFilter.Project({
          projectId: '11111111-1111-7111-8111-111111111111',
        }),
        tagIds: ['22222222-2222-7222-8222-222222222222'],
        priority: 'high',
        status: 'doing',
        date: 'week',
      }),
      sort: TaskSort.make({ by: 'title', direction: 'desc' }),
    })

    cacheTaskViewSettings('user-1', view)

    expect(readTaskViewSettings('user-1')).toStrictEqual(Option.some(view))
    expect(
      JSON.parse(localStorage.getItem('tali.tasks.view.v1.user-1') ?? '{}'),
    ).toStrictEqual(stored(view))
  })

  test('falls back to defaults for corrupt or unknown values', () => {
    expect(parseTaskViewSettings('nope')).toStrictEqual(Option.none())
    expect(
      parseTaskViewSettings(
        JSON.stringify({
          filters: {
            projectId: 7,
            tagIds: ['a', 3],
            priority: 'urgent',
            status: '?',
            date: 'soon',
          },
          sort: { by: 'sideways', direction: 'up' },
        }),
      ),
    ).toStrictEqual(
      Option.some(
        TaskViewSettings.make({
          filters: TaskFilters.make({
            project: ProjectFilter.All(),
            tagIds: ['a'],
            priority: 'all',
            status: 'all',
            date: 'all',
          }),
          sort: DEFAULT_TASK_VIEW.sort,
        }),
      ),
    )
  })

  test('keeps the no-project filter distinct from all projects', () => {
    expect(
      Option.map(
        parseTaskViewSettings(JSON.stringify({ filters: { projectId: null } })),
        settings => settings.filters.project,
      ),
    ).toStrictEqual(Option.some(ProjectFilter.None()))
    expect(DEFAULT_TASK_VIEW.filters.project).toStrictEqual(ProjectFilter.All())
  })
})
