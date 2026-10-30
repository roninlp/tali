import { Array, Option, Schema } from 'effect'

import {
  DEFAULT_TASK_FILTERS,
  DEFAULT_TASK_SORT,
  ProjectFilter,
  TaskDateFilter,
  TaskFilters,
  TaskPriorityFilter,
  TaskSort,
  TaskSortField,
  TaskStatusFilter,
  TaskViewSettings,
} from './tasks-model'

/**
 * Persisted filter/sort state for `/tasks`, ported from
 * `apps/web/src/lib/tasks/view-cache.ts` (FR-TASK-02: filters and sorts are
 * preserved).
 *
 * Filters are a device preference, not server state, so they live in
 * localStorage keyed by user id: synchronous, so the first render already has
 * the user's view, and isolated per account on a shared browser. The stored
 * JSON keeps the legacy key and shape, so a browser that used the Solid app
 * keeps its saved view after the migration.
 */

const KEY_PREFIX = 'tali.tasks.view.v1.'

const keyFor = (userId: string): string => `${KEY_PREFIX}${userId}`

const storage = (): Storage | undefined => {
  if (typeof localStorage === 'undefined') {
    return undefined
  }

  try {
    return localStorage
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const decodePriority = Schema.decodeUnknownOption(TaskPriorityFilter)
const decodeStatus = Schema.decodeUnknownOption(TaskStatusFilter)
const decodeDate = Schema.decodeUnknownOption(TaskDateFilter)
const decodeSortField = Schema.decodeUnknownOption(TaskSortField)

const parseProject = (value: unknown): ProjectFilter => {
  if (value === null) {
    return ProjectFilter.None()
  }

  if (typeof value === 'string') {
    return ProjectFilter.Project({ projectId: value })
  }

  return ProjectFilter.All()
}

const parseFilters = (value: unknown): TaskFilters => {
  if (!isRecord(value)) {
    return DEFAULT_TASK_FILTERS
  }

  const tagIds = Array.isArray(value.tagIds)
    ? value.tagIds.filter((entry): entry is string => typeof entry === 'string')
    : []

  return TaskFilters.make({
    project: parseProject(value.projectId),
    tagIds,
    priority: Option.getOrElse(
      decodePriority(value.priority),
      () => DEFAULT_TASK_FILTERS.priority,
    ),
    status: Option.getOrElse(
      decodeStatus(value.status),
      () => DEFAULT_TASK_FILTERS.status,
    ),
    date: Option.getOrElse(
      decodeDate(value.date),
      () => DEFAULT_TASK_FILTERS.date,
    ),
  })
}

const parseSort = (value: unknown): TaskSort => {
  if (!isRecord(value)) {
    return DEFAULT_TASK_SORT
  }

  const by = Option.getOrElse(
    decodeSortField(value.by),
    () => DEFAULT_TASK_SORT.by,
  )

  return TaskSort.make({
    by,
    direction: value.direction === 'desc' ? 'desc' : 'asc',
  })
}

/** Decode a stored view defensively; a corrupt entry falls back to defaults. */
export const parseTaskViewSettings = (
  raw: string | null | undefined,
): Option.Option<TaskViewSettings> => {
  if (raw === null || raw === undefined) {
    return Option.none()
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    if (!isRecord(parsed)) {
      return Option.none()
    }

    return Option.some(
      TaskViewSettings.make({
        filters: parseFilters(parsed.filters),
        sort: parseSort(parsed.sort),
      }),
    )
  } catch {
    return Option.none()
  }
}

export const readTaskViewSettings = (
  userId: string,
): Option.Option<TaskViewSettings> => {
  try {
    return parseTaskViewSettings(storage()?.getItem(keyFor(userId)))
  } catch {
    return Option.none()
  }
}

const storedProjectId = (project: ProjectFilter): string | null | undefined =>
  ProjectFilter.match(project, {
    All: () => undefined,
    None: () => null,
    Project: ({ projectId }) => projectId,
  })

export const cacheTaskViewSettings = (
  userId: string,
  settings: TaskViewSettings,
): void => {
  try {
    storage()?.setItem(
      keyFor(userId),
      JSON.stringify({
        filters: {
          projectId: storedProjectId(settings.filters.project),
          tagIds: settings.filters.tagIds,
          priority: settings.filters.priority,
          status: settings.filters.status,
          date: settings.filters.date,
        },
        sort: {
          by: settings.sort.by,
          direction: settings.sort.direction,
        },
      }),
    )
  } catch {
    // Storage can be disabled; the defaults still render.
  }
}
