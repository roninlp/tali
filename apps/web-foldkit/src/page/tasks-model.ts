import { Array, Option, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import {
  addJalaliDays,
  formatJalaliDate,
  localizeDigits,
  taskBucketBounds,
  taskBucketOf,
  toIsoDate,
  toJalaliDate,
  toJalaliDateInZone,
} from '@tali/domain'
import type {
  Digits,
  TaskBucketBounds,
  TaskBucketPlacement,
} from '@tali/domain'

import type { ProjectRow, TagRow, TaskRow } from '../mirror'

/**
 * The `/tasks` client model, ported from `apps/web/src/lib/tasks/model.ts`.
 *
 * Everything the board renders is derived from the IndexedDB mirror, and every
 * write goes through the store first: the mirror row and the outbox entry
 * commit in one transaction, so the board is correct offline and the sync
 * engine reconciles afterwards. Bucketing reuses the domain's
 * `taskBucketBounds`/`taskBucketOf`, the same functions TaskService uses, so the
 * local board cannot disagree with the server at a day boundary.
 */

// FILTERS AND SORT

export const TaskBoardKey = Schema.Literals(['today', 'upcoming', 'inbox'])
export type TaskBoardKey = typeof TaskBoardKey.Type

export const TaskDateFilter = Schema.Literals([
  'all',
  'overdue',
  'today',
  'tomorrow',
  'week',
  'none',
])
export type TaskDateFilter = typeof TaskDateFilter.Type

export const DATE_FILTERS: ReadonlyArray<TaskDateFilter> = [
  'all',
  'overdue',
  'today',
  'tomorrow',
  'week',
  'none',
]

export const TaskPriorityFilter = Schema.Literals([
  'all',
  'high',
  'medium',
  'low',
])
export type TaskPriorityFilter = typeof TaskPriorityFilter.Type

export const TaskStatusFilter = Schema.Literals(['all', 'todo', 'doing'])
export type TaskStatusFilter = typeof TaskStatusFilter.Type

export const TaskPriority = Schema.Literals(['high', 'medium', 'low'])
export type TaskPriority = typeof TaskPriority.Type

export const TaskStatusOption = Schema.Literals(['todo', 'doing'])
export type TaskStatusOption = typeof TaskStatusOption.Type

/** `All` = every project, `None` = tasks without a project, `Project` = one id. */
export const ProjectFilter = defineTaggedUnion({
  All: {},
  None: {},
  Project: { projectId: Schema.String },
})
export type ProjectFilter = typeof ProjectFilter.Type

export const TaskFilters = Schema.Struct({
  project: ProjectFilter,
  /** Any-of tag filter, matching the service's OR semantics. */
  tagIds: Schema.Array(Schema.String),
  priority: TaskPriorityFilter,
  status: TaskStatusFilter,
  date: TaskDateFilter,
})
export type TaskFilters = typeof TaskFilters.Type

export const TaskSortField = Schema.Literals([
  'dueDate',
  'priority',
  'status',
  'createdAt',
  'updatedAt',
  'title',
])
export type TaskSortField = typeof TaskSortField.Type

export const TASK_SORT_FIELDS: ReadonlyArray<TaskSortField> = [
  'dueDate',
  'priority',
  'status',
  'createdAt',
  'updatedAt',
  'title',
]

export const SortDirection = Schema.Literals(['asc', 'desc'])
export type SortDirection = typeof SortDirection.Type

export const TaskSort = Schema.Struct({
  by: TaskSortField,
  direction: SortDirection,
})
export type TaskSort = typeof TaskSort.Type

export const TaskViewSettings = Schema.Struct({
  filters: TaskFilters,
  sort: TaskSort,
})
export type TaskViewSettings = typeof TaskViewSettings.Type

export const DEFAULT_TASK_FILTERS: TaskFilters = TaskFilters.make({
  project: ProjectFilter.All(),
  tagIds: [],
  priority: 'all',
  status: 'all',
  date: 'all',
})

export const DEFAULT_TASK_SORT: TaskSort = TaskSort.make({
  by: 'dueDate',
  direction: 'asc',
})

export const DEFAULT_TASK_VIEW: TaskViewSettings = TaskViewSettings.make({
  filters: DEFAULT_TASK_FILTERS,
  sort: DEFAULT_TASK_SORT,
})

export const SORT_FIELD_LABELS: Readonly<Record<TaskSortField, string>> = {
  dueDate: 'موعد',
  priority: 'اولویت',
  status: 'وضعیت',
  createdAt: 'تاریخ ایجاد',
  updatedAt: 'آخرین تغییر',
  title: 'عنوان',
}

const decodePriorityFilter = Schema.decodeUnknownOption(TaskPriorityFilter)
const decodeStatusFilter = Schema.decodeUnknownOption(TaskStatusFilter)
const decodeDateFilter = Schema.decodeUnknownOption(TaskDateFilter)
const decodeSortField = Schema.decodeUnknownOption(TaskSortField)
const decodePriority = Schema.decodeUnknownOption(TaskPriority)

/** Decode a select value without ever trusting the DOM's string. */
export const priorityFilterOf = (value: string): TaskPriorityFilter =>
  Option.getOrElse(decodePriorityFilter(value), () => 'all')

export const statusFilterOf = (value: string): TaskStatusFilter =>
  Option.getOrElse(decodeStatusFilter(value), () => 'all')

export const dateFilterOf = (value: string): TaskDateFilter =>
  Option.getOrElse(decodeDateFilter(value), () => 'all')

export const sortFieldOf = (value: string): TaskSortField =>
  Option.getOrElse(decodeSortField(value), () => DEFAULT_TASK_SORT.by)

export const priorityOf = (value: string): TaskPriority =>
  Option.getOrElse(decodePriority(value), () => 'medium')

export const PRIORITY_LABELS: Readonly<Record<TaskPriority, string>> = {
  high: 'بالا',
  medium: 'متوسط',
  low: 'پایین',
}

export const STATUS_LABELS: Readonly<Record<TaskStatusOption, string>> = {
  todo: 'انجام‌نشده',
  doing: 'در حال انجام',
}

export const PRIORITY_OPTIONS: ReadonlyArray<{
  readonly value: TaskPriorityFilter
  readonly label: string
}> = [
  { value: 'all', label: 'همه‌ی اولویت‌ها' },
  { value: 'high', label: 'بالا' },
  { value: 'medium', label: 'متوسط' },
  { value: 'low', label: 'پایین' },
]

export const STATUS_OPTIONS: ReadonlyArray<{
  readonly value: TaskStatusFilter
  readonly label: string
}> = [
  { value: 'all', label: 'همه‌ی وضعیت‌ها' },
  { value: 'todo', label: 'انجام‌نشده' },
  { value: 'doing', label: 'در حال انجام' },
]

export const DATE_OPTIONS: ReadonlyArray<{
  readonly value: TaskDateFilter
  readonly label: string
}> = [
  { value: 'all', label: 'همه‌ی زمان‌ها' },
  { value: 'overdue', label: 'عقب‌افتاده' },
  { value: 'today', label: 'امروز' },
  { value: 'tomorrow', label: 'فردا' },
  { value: 'week', label: 'این هفته' },
  { value: 'none', label: 'بدون تاریخ' },
]

/** The priority choices the quick-add and editor expose. */
export const PRIORITY_CHOICES: ReadonlyArray<{
  readonly value: TaskPriority
  readonly label: string
}> = [
  { value: 'high', label: 'بالا' },
  { value: 'medium', label: 'متوسط' },
  { value: 'low', label: 'پایین' },
]

const priorityRank: Readonly<Record<TaskPriority, number>> = {
  high: 0,
  medium: 1,
  low: 2,
}

const statusRank: Readonly<Record<TaskRow['status'], number>> = {
  todo: 0,
  doing: 1,
  done: 2,
}

const asPriority = (value: string): TaskPriority =>
  value === 'high' ? 'high' : value === 'low' ? 'low' : 'medium'

const placementOf = (
  task: TaskRow,
  bounds: TaskBucketBounds,
): TaskBucketPlacement =>
  taskBucketOf(
    { dueAt: task.dueAt, dueDate: task.dueDate, status: task.status },
    bounds,
  )

const matchesDate = (
  placement: TaskBucketPlacement,
  filter: TaskDateFilter,
): boolean => {
  if (filter === 'all') {
    return true
  }

  if (filter === 'week') {
    return placement === 'thisWeek'
  }

  if (filter === 'none') {
    return placement === 'noDate'
  }

  return placement === filter
}

/** One live task against the filter bar. Done rows live in the history list. */
export const matchesTaskFilters = (
  task: TaskRow,
  filters: TaskFilters,
  bounds: TaskBucketBounds,
): boolean => {
  const projectMatches = ProjectFilter.match(filters.project, {
    All: () => true,
    None: () => task.projectId === null,
    Project: ({ projectId }) => task.projectId === projectId,
  })

  if (!projectMatches) {
    return false
  }

  if (
    !Array.isReadonlyArrayEmpty(filters.tagIds) &&
    !Array.some(task.tagIds, tagId => Array.contains(filters.tagIds, tagId))
  ) {
    return false
  }

  if (filters.priority !== 'all' && task.priority !== filters.priority) {
    return false
  }

  if (filters.status !== 'all' && task.status !== filters.status) {
    return false
  }

  return matchesDate(placementOf(task, bounds), filters.date)
}

const dueSortKey = (task: TaskRow): string =>
  task.dueDate ?? task.dueAt ?? '9999-99-99'

const compareText = (left: string, right: string): -1 | 0 | 1 =>
  left < right ? -1 : left > right ? 1 : 0

const compareByField = (
  field: TaskSortField,
  left: TaskRow,
  right: TaskRow,
): number => {
  if (field === 'dueDate') {
    return (
      compareText(dueSortKey(left), dueSortKey(right)) ||
      priorityRank[left.priority] - priorityRank[right.priority]
    )
  }

  if (field === 'priority') {
    return (
      priorityRank[left.priority] - priorityRank[right.priority] ||
      compareText(dueSortKey(left), dueSortKey(right))
    )
  }

  if (field === 'status') {
    return statusRank[left.status] - statusRank[right.status]
  }

  if (field === 'createdAt') {
    return compareText(left.createdAt, right.createdAt)
  }

  if (field === 'updatedAt') {
    return compareText(left.updatedAt, right.updatedAt)
  }

  return left.title.localeCompare(right.title, 'fa')
}

/**
 * Stable board ordering. The default is due-date ascending with priority as
 * the tie-break; a descending sort flips only the chosen field, and the id is
 * the final tie-break so a re-render never reshuffles.
 */
export const compareTasks = (
  left: TaskRow,
  right: TaskRow,
  sort: TaskSort,
): number => {
  const result = compareByField(sort.by, left, right)

  if (result === 0) {
    return compareText(left.id, right.id)
  }

  return sort.direction === 'asc' ? result : -result
}

export const sortTasks = (
  tasks: ReadonlyArray<TaskRow>,
  sort: TaskSort,
): ReadonlyArray<TaskRow> =>
  [...tasks].sort((left, right) => compareTasks(left, right, sort))

// BOARD

export interface TaskGroup {
  readonly key: TaskBucketPlacement
  readonly tasks: ReadonlyArray<TaskRow>
}

export interface TaskBoard {
  readonly key: TaskBoardKey
  readonly groups: ReadonlyArray<TaskGroup>
  readonly count: number
}

export interface TaskView {
  readonly bounds: TaskBucketBounds
  readonly today: TaskBoard
  readonly upcoming: TaskBoard
  readonly inbox: TaskBoard
  readonly counts: Readonly<Record<TaskBoardKey, number>>
  readonly total: number
  /** Live (not done), filtered tasks in mirror order. */
  readonly visible: ReadonlyArray<TaskRow>
}

/**
 * Build the three boards: today (calm overdue first), upcoming
 * (tomorrow → this week → later), and the no-date inbox. Counts are the
 * filtered counts, so the persistent filter bar and the boards always agree.
 */
export const buildTaskView = (
  rows: ReadonlyArray<TaskRow>,
  options: Readonly<{
    timeZone: string
    now: string
    filters: TaskFilters
    sort: TaskSort
  }>,
): TaskView => {
  const bounds = taskBucketBounds(options.timeZone, options.now)
  const live = Array.filter(rows, task => task.status !== 'done')
  const visible = Array.filter(live, task =>
    matchesTaskFilters(task, options.filters, bounds),
  )
  const group = (key: TaskBucketPlacement): TaskGroup => ({
    key,
    tasks: sortTasks(
      Array.filter(visible, task => placementOf(task, bounds) === key),
      options.sort,
    ),
  })
  const todayGroups = [group('overdue'), group('today')]
  const upcomingGroups = [group('tomorrow'), group('thisWeek'), group('later')]
  const inboxGroups = [group('noDate')]
  const countOf = (groups: ReadonlyArray<TaskGroup>): number =>
    Array.reduce(groups, 0, (total, entry) => total + Array.length(entry.tasks))
  const today: TaskBoard = {
    key: 'today',
    groups: todayGroups,
    count: countOf(todayGroups),
  }
  const upcoming: TaskBoard = {
    key: 'upcoming',
    groups: upcomingGroups,
    count: countOf(upcomingGroups),
  }
  const inbox: TaskBoard = {
    key: 'inbox',
    groups: inboxGroups,
    count: countOf(inboxGroups),
  }

  return {
    bounds,
    today,
    upcoming,
    inbox,
    counts: {
      today: today.count,
      upcoming: upcoming.count,
      inbox: inbox.count,
    },
    total: Array.length(visible),
    visible,
  }
}

/** How many filter controls differ from "show everything". */
export const activeFilterCount = (filters: TaskFilters): number =>
  ProjectFilter.match(filters.project, {
    All: () => 0,
    None: () => 1,
    Project: () => 1,
  }) +
  (Array.isReadonlyArrayEmpty(filters.tagIds) ? 0 : 1) +
  (filters.priority !== 'all' ? 1 : 0) +
  (filters.status !== 'all' ? 1 : 0) +
  (filters.date !== 'all' ? 1 : 0)

export const liveTasks = (
  rows: ReadonlyArray<TaskRow>,
): ReadonlyArray<TaskRow> => Array.filter(rows, task => task.status !== 'done')

export const projectCountsOf = (
  rows: ReadonlyArray<TaskRow>,
): ReadonlyMap<string, number> =>
  Array.reduce(rows, new Map<string, number>(), (counts, task) => {
    if (task.projectId !== null) {
      counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1)
    }
    return counts
  })

export const noProjectCountOf = (rows: ReadonlyArray<TaskRow>): number =>
  Array.filter(rows, task => task.projectId === null).length

// COPY

export const GROUP_TITLES: Readonly<Record<TaskBucketPlacement, string>> = {
  overdue: 'از قبل مانده',
  today: 'امروز',
  tomorrow: 'فردا',
  thisWeek: 'این هفته',
  later: 'بعدتر',
  noDate: 'بدون تاریخ',
  done: '',
}

export interface BoardCopy {
  readonly title: string
  readonly subtitle: string
  readonly empty: string
}

export const BOARD_COPY: Readonly<Record<TaskBoardKey, BoardCopy>> = {
  today: {
    title: 'امروز',
    subtitle: 'کارهای امروز و آنچه از قبل مانده',
    empty: 'امروز خالی است — یک کار تازه اضافه کنید.',
  },
  upcoming: {
    title: 'پیش‌رو',
    subtitle: 'فردا تا هفتهٔ پیش‌رو',
    empty: 'برای روزهای آینده کاری برنامه‌ریزی نشده است.',
  },
  inbox: {
    title: 'بدون تاریخ',
    subtitle: 'صندوق ورودی برای وقتی هنوز روزش معلوم نیست',
    empty: 'صندوق ورودی خالی است.',
  },
}

// DATES

export const validTimeZone = (timeZone: string): string => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return timeZone
  } catch {
    return 'UTC'
  }
}

export const boundsFor = (timeZone: string, now: number): TaskBucketBounds =>
  taskBucketBounds(validTimeZone(timeZone), new Date(now))

/** Shift a `YYYY-MM-DD` wall date by whole days (calendar-safe). */
export const shiftLocalDate = (date: string, days: number): string =>
  toIsoDate(addJalaliDays(toJalaliDate(date), days))

export const formatLocalDate = (date: string, digits: Digits): string =>
  formatJalaliDate(toJalaliDate(date), { style: 'short', digits })

export const formatCompletionTime = (
  completedAt: string,
  timeZone: string,
  digits: Digits,
): string => {
  const instant = new Date(completedAt)
  const date = formatJalaliDate(toJalaliDateInZone(instant, timeZone), {
    style: 'medium',
    digits,
  })
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(instant)

  return `${date}، ${localizeDigits(time, digits)}`
}

/** A short, calm label for the due chip. Overdue is quiet amber, never an alert. */
export const dueLabel = (
  task: TaskRow,
  bounds: TaskBucketBounds,
  digits: Digits,
): string => {
  if (task.dueDate === null && task.dueAt === null) {
    return 'بدون تاریخ'
  }

  if (task.dueDate === bounds.today) {
    return 'امروز'
  }

  if (task.dueDate === bounds.tomorrow) {
    return 'فردا'
  }

  if (task.dueDate !== null) {
    const label = formatLocalDate(task.dueDate, digits)
    return task.dueDate < bounds.today ? `عقب‌افتاده · ${label}` : label
  }

  return new Intl.DateTimeFormat('fa-IR', {
    day: 'numeric',
    month: 'short',
    timeZone: bounds.timeZone,
  }).format(new Date(task.dueAt ?? ''))
}

// COMPLETION HISTORY

export const COMPLETED_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** True while the completion is still restorable (mirrors TaskService.undo). */
export const isRestorable = (
  completedAt: string | null,
  now: string,
  retentionMs: number = COMPLETED_TASK_RETENTION_MS,
): boolean => {
  if (completedAt === null) {
    return false
  }

  const completed = Date.parse(completedAt)

  if (!Number.isFinite(completed)) {
    return false
  }

  return completed >= Date.parse(now) - retentionMs
}

/** Most recent completions first; anything older than the retention is archived. */
export const recentCompletions = (
  rows: ReadonlyArray<TaskRow>,
  now: string,
): ReadonlyArray<TaskRow> =>
  [
    ...Array.filter(
      rows,
      task => task.status === 'done' && isRestorable(task.completedAt, now),
    ),
  ].sort((left, right) =>
    compareText(right.completedAt ?? '', left.completedAt ?? ''),
  )

// TAGS

/**
 * Tag colours. A saved colour wins; otherwise a stable palette slot keeps one
 * tag visually consistent across devices and sessions.
 */
export const TAG_COLORS: ReadonlyArray<string> = [
  '#2f5fe0',
  '#0f9d8f',
  '#b45309',
  '#9f1239',
  '#6d28d9',
  '#0369a1',
  '#4d7c0f',
  '#a21caf',
]

const TAG_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/

export const tagColor = (tag: Pick<TagRow, 'id' | 'color'>): string => {
  if (tag.color !== null && TAG_COLOR_PATTERN.test(tag.color)) {
    return tag.color
  }

  const hash = Array.reduce(
    Array.fromIterable(tag.id),
    0,
    (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
  )

  return TAG_COLORS[hash % TAG_COLORS.length] ?? '#2f5fe0'
}

export const projectOf = (
  projects: ReadonlyArray<ProjectRow>,
  projectId: string | null,
): ProjectRow | undefined =>
  projectId === null
    ? undefined
    : Array.findFirst(projects, project => project.id === projectId).pipe(
        Option.getOrUndefined,
      )

export const tagsOfTask = (
  tags: ReadonlyArray<TagRow>,
  tagIds: ReadonlyArray<string>,
): ReadonlyArray<TagRow> =>
  Array.filter(tags, tag => Array.contains(tagIds, tag.id))

/** The board's priority label for a stored priority value. */
export const priorityLabel = (priority: TaskRow['priority']): string =>
  PRIORITY_LABELS[asPriority(priority)]
