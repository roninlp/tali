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

const StoredTaskFilters = Schema.Struct({
  projectId: Schema.optional(Schema.Unknown),
  tagIds: Schema.optional(Schema.Unknown),
  priority: Schema.optional(Schema.Unknown),
  status: Schema.optional(Schema.Unknown),
  date: Schema.optional(Schema.Unknown),
})

type StoredTaskFilters = typeof StoredTaskFilters.Type

const StoredTaskSort = Schema.Struct({
  by: Schema.optional(Schema.Unknown),
  direction: Schema.optional(Schema.Unknown),
})

type StoredTaskSort = typeof StoredTaskSort.Type

const StoredTaskView = Schema.Struct({
  filters: Schema.optional(Schema.Unknown),
  sort: Schema.optional(Schema.Unknown),
})

type StoredTaskView = typeof StoredTaskView.Type

const asStoredView = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredTaskView),
)

const asStoredFilters = Schema.decodeUnknownOption(StoredTaskFilters)

const asStoredSort = Schema.decodeUnknownOption(StoredTaskSort)

const asProjectId = Schema.decodeUnknownOption(Schema.NullOr(Schema.String))

const asUnknownArray = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))

const asString = Schema.decodeUnknownOption(Schema.String)

const decodePriority = Schema.decodeUnknownOption(TaskPriorityFilter)
const decodeStatus = Schema.decodeUnknownOption(TaskStatusFilter)
const decodeDate = Schema.decodeUnknownOption(TaskDateFilter)
const decodeSortField = Schema.decodeUnknownOption(TaskSortField)

const parseProject = (value: StoredTaskFilters['projectId']): ProjectFilter =>
  Option.match(asProjectId(value), {
    onNone: () => ProjectFilter.All(),
    onSome: projectId =>
      projectId === null
        ? ProjectFilter.None()
        : ProjectFilter.Project({ projectId }),
  })

const parseTagIds = (
  value: StoredTaskFilters['tagIds'],
): ReadonlyArray<string> =>
  Option.getOrElse(
    Option.map(asUnknownArray(value), entries =>
      Array.getSomes(Array.map(entries, value => asString(value))),
    ),
    () => [],
  )

const parseFilters = (filters: StoredTaskView['filters']): TaskFilters => {
  const stored = Option.getOrNull(asStoredFilters(filters))

  if (stored === null) {
    return DEFAULT_TASK_FILTERS
  }

  return TaskFilters.make({
    project: parseProject(stored.projectId),
    tagIds: parseTagIds(stored.tagIds),
    priority: Option.getOrElse(
      decodePriority(stored.priority),
      () => DEFAULT_TASK_FILTERS.priority,
    ),
    status: Option.getOrElse(
      decodeStatus(stored.status),
      () => DEFAULT_TASK_FILTERS.status,
    ),
    date: Option.getOrElse(
      decodeDate(stored.date),
      () => DEFAULT_TASK_FILTERS.date,
    ),
  })
}

const parseSort = (sort: StoredTaskView['sort']): TaskSort => {
  const stored = Option.getOrNull(asStoredSort(sort))

  if (stored === null) {
    return DEFAULT_TASK_SORT
  }

  const by = Option.getOrElse(
    decodeSortField(stored.by),
    () => DEFAULT_TASK_SORT.by,
  )

  return TaskSort.make({
    by,
    direction: stored.direction === 'desc' ? 'desc' : 'asc',
  })
}

/** Decode a stored view defensively; a corrupt entry falls back to defaults. */
export const parseTaskViewSettings = (
  raw: string | null | undefined,
): Option.Option<TaskViewSettings> => {
  if (raw === null || raw === undefined) {
    return Option.none()
  }

  return Option.map(asStoredView(raw), view =>
    TaskViewSettings.make({
      filters: parseFilters(view.filters),
      sort: parseSort(view.sort),
    }),
  )
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
