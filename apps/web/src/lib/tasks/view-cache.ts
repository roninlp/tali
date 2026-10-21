import {
  DATE_FILTERS,
  DEFAULT_TASK_FILTERS,
  DEFAULT_TASK_SORT,
  TASK_SORT_FIELDS,
  type TaskDateFilter,
  type TaskFilters,
  type TaskSort,
  type TaskSortField
} from "./model"

/**
 * Persisted filter/sort state for `/tasks` (FR-TASK-02: "filters and sorts are
 * preserved").
 *
 * Filters are a device preference, not server state (#35 owns the preference
 * fields and has no filter columns), so they live in localStorage keyed by
 * user id — synchronous, so the first render already has the user's view, and
 * isolated per account on a shared browser.
 */

const KEY_PREFIX = "tali.tasks.view.v1."

export interface TaskViewSettings {
  readonly filters: TaskFilters
  readonly sort: TaskSort
}

export const DEFAULT_TASK_VIEW: TaskViewSettings = {
  filters: DEFAULT_TASK_FILTERS,
  sort: DEFAULT_TASK_SORT
}

const keyFor = (userId: string): string => `${KEY_PREFIX}${userId}`

const storage = (): Storage | undefined => {
  if (typeof localStorage === "undefined") return undefined
  try {
    return localStorage
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseFilters = (value: unknown): TaskFilters => {
  if (!isRecord(value)) return DEFAULT_TASK_FILTERS
  const project = value.projectId
  const projectId =
    project === null || project === undefined
      ? (project as null | undefined)
      : typeof project === "string"
        ? project
        : undefined
  const tagIds = Array.isArray(value.tagIds)
    ? value.tagIds.filter((entry): entry is string => typeof entry === "string")
    : []
  const priority =
    value.priority === "high" || value.priority === "medium" || value.priority === "low"
      ? value.priority
      : "all"
  const status =
    value.status === "todo" || value.status === "doing" || value.status === "done"
      ? value.status
      : "all"
  const date: TaskDateFilter = DATE_FILTERS.includes(value.date as TaskDateFilter)
    ? (value.date as TaskDateFilter)
    : "all"
  return { projectId, tagIds, priority, status, date }
}

const parseSort = (value: unknown): TaskSort => {
  if (!isRecord(value)) return DEFAULT_TASK_SORT
  const by: TaskSortField = TASK_SORT_FIELDS.includes(value.by as TaskSortField)
    ? (value.by as TaskSortField)
    : DEFAULT_TASK_SORT.by
  const direction = value.direction === "desc" ? "desc" : "asc"
  return { by, direction }
}

/** Decode a stored view defensively; a corrupt entry falls back to defaults. */
export const parseTaskViewSettings = (raw: string | null | undefined): TaskViewSettings | undefined => {
  if (raw === null || raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return undefined
    return { filters: parseFilters(parsed.filters), sort: parseSort(parsed.sort) }
  } catch {
    return undefined
  }
}

export const readTaskViewSettings = (userId: string): TaskViewSettings | undefined =>
  parseTaskViewSettings(storage()?.getItem(keyFor(userId)))

export const cacheTaskViewSettings = (userId: string, settings: TaskViewSettings): void => {
  try {
    storage()?.setItem(
      keyFor(userId),
      JSON.stringify({ filters: settings.filters, sort: settings.sort })
    )
  } catch {
    // Storage can be disabled; the defaults still render.
  }
}
