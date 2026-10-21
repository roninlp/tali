import {
  addJalaliDays,
  formatJalaliDate,
  localizeDigits,
  taskBucketBounds,
  taskBucketOf,
  toIsoDate,
  toJalaliDate,
  toJalaliDateInZone,
  uuidV7,
  type Digits,
  type Priority,
  type TaskBucketBounds,
  type TaskBucketPlacement,
  type TaskStatus
} from "@tali/domain"
import type { LocalStore, MirrorRecord } from "../local-store"

/**
 * The `/tasks` screen's client model (ticket #37; FR-TASK-01/02/05/06).
 *
 * Everything the board renders is derived from the IndexedDB mirror, and every
 * write goes through `writeLocal` first: the mirror row and the outbox entry
 * commit in one transaction, so the board is correct offline and the existing
 * sync engine reconciles with the server afterwards. The server stays the
 * source of truth for versions/timestamps; these helpers only shape the
 * client's optimistic view.
 *
 * Bucketing reuses the domain's `taskBucketBounds`/`taskBucketOf` (the same
 * functions TaskService uses) so the local board cannot disagree with the
 * server's `GetTaskBuckets` answer at a day boundary.
 */

export interface TaskRow {
  readonly id: string
  readonly title: string
  readonly description: string | null
  readonly status: TaskStatus
  readonly priority: Priority
  /** All-day due date (`YYYY-MM-DD`), the board's move target. */
  readonly dueDate: string | null
  /** Timed due instant (UTC); never created by this screen but hydrated. */
  readonly dueAt: string | null
  readonly timeZone: string
  readonly projectId: string | null
  readonly tagIds: ReadonlyArray<string>
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null

const stringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

const asPriority = (value: unknown): Priority =>
  value === "high" || value === "low" ? value : "medium"

const asStatus = (value: unknown): TaskStatus =>
  value === "doing" || value === "done" ? value : "todo"

/** Project a mirrored task row into the fields the board understands. */
export const toTaskRow = (record: MirrorRecord): TaskRow => ({
  id: record.entityId,
  title: typeof record.data.title === "string" ? record.data.title : "",
  description: asNullableString(record.data.description),
  status: asStatus(record.data.status),
  priority: asPriority(record.data.priority),
  dueDate: asNullableString(record.data.dueDate),
  dueAt: asNullableString(record.data.dueAt),
  timeZone:
    typeof record.data.timeZone === "string" && record.data.timeZone !== ""
      ? record.data.timeZone
      : "UTC",
  projectId: asNullableString(record.data.projectId),
  tagIds: stringArray(record.data.tagIds),
  startedAt: asNullableString(record.data.startedAt),
  completedAt: asNullableString(record.data.completedAt),
  createdAt: asNullableString(record.data.createdAt) ?? record.updatedAt,
  updatedAt: record.updatedAt,
  version: record.version
})

// ── Filtering and sorting ─────────────────────────────────────────────────

/** `all` plus the placement presets the filter bar offers. */
export const DATE_FILTERS = [
  "all",
  "overdue",
  "today",
  "tomorrow",
  "week",
  "none"
] as const
export type TaskDateFilter = (typeof DATE_FILTERS)[number]

export interface TaskFilters {
  /** `undefined` = every project, `null` = tasks without a project. */
  readonly projectId: string | null | undefined
  /** Any-of tag filter, matching the service's OR semantics. */
  readonly tagIds: ReadonlyArray<string>
  readonly priority: Priority | "all"
  readonly status: TaskStatus | "all"
  readonly date: TaskDateFilter
}

export const TASK_SORT_FIELDS = [
  "dueDate",
  "priority",
  "status",
  "createdAt",
  "updatedAt",
  "title"
] as const
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number]
export type SortDirection = "asc" | "desc"

export interface TaskSort {
  readonly by: TaskSortField
  readonly direction: SortDirection
}

export const DEFAULT_TASK_FILTERS: TaskFilters = {
  projectId: undefined,
  tagIds: [],
  priority: "all",
  status: "all",
  date: "all"
}

export const DEFAULT_TASK_SORT: TaskSort = { by: "dueDate", direction: "asc" }

const priorityRank: Record<Priority, number> = { high: 0, medium: 1, low: 2 }
const statusRank: Record<TaskStatus, number> = { todo: 0, doing: 1, done: 2 }

const placementOf = (task: TaskRow, bounds: TaskBucketBounds): TaskBucketPlacement =>
  taskBucketOf(
    { dueAt: task.dueAt, dueDate: task.dueDate, status: task.status },
    bounds
  )

const matchesDate = (placement: TaskBucketPlacement, filter: TaskDateFilter): boolean => {
  if (filter === "all") return true
  if (filter === "week") return placement === "thisWeek"
  if (filter === "none") return placement === "noDate"
  return placement === filter
}

/** One task against the filter bar. `done` rows are handled by the history list. */
export const matchesTaskFilters = (
  task: TaskRow,
  filters: TaskFilters,
  bounds: TaskBucketBounds
): boolean => {
  if (filters.projectId !== undefined) {
    if (filters.projectId === null) {
      if (task.projectId !== null) return false
    } else if (task.projectId !== filters.projectId) {
      return false
    }
  }
  if (filters.tagIds.length > 0) {
    if (!task.tagIds.some((tagId) => filters.tagIds.includes(tagId))) return false
  }
  if (filters.priority !== "all" && task.priority !== filters.priority) return false
  if (filters.status !== "all" && task.status !== filters.status) return false
  return matchesDate(placementOf(task, bounds), filters.date)
}

const dueSortKey = (task: TaskRow): string =>
  task.dueDate ?? task.dueAt ?? "9999-99-99"

/**
 * Stable board ordering. The default is due-date ascending with priority as the
 * tie-break (the service's order); every sort direction flips only the chosen
 * field, and the id is the final tie-break so a re-render never reshuffles.
 */
export const compareTasks = (a: TaskRow, b: TaskRow, sort: TaskSort): number => {
  let result = 0
  switch (sort.by) {
    case "dueDate":
      result =
        dueSortKey(a).localeCompare(dueSortKey(b)) ||
        priorityRank[a.priority] - priorityRank[b.priority]
      break
    case "priority":
      result =
        priorityRank[a.priority] - priorityRank[b.priority] ||
        dueSortKey(a).localeCompare(dueSortKey(b))
      break
    case "status":
      result = statusRank[a.status] - statusRank[b.status]
      break
    case "createdAt":
      result = a.createdAt.localeCompare(b.createdAt)
      break
    case "updatedAt":
      result = a.updatedAt.localeCompare(b.updatedAt)
      break
    case "title":
      result = a.title.localeCompare(b.title, "fa")
      break
  }
  if (result === 0) return a.id.localeCompare(b.id)
  return sort.direction === "asc" ? result : -result
}

// ── Board grouping ────────────────────────────────────────────────────────

export const BOARD_KEYS = ["today", "upcoming", "inbox"] as const
export type TaskBoardKey = (typeof BOARD_KEYS)[number]

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
  /** Live (not done), filtered tasks in board order. */
  readonly visible: ReadonlyArray<TaskRow>
}

/**
 * Build the three boards: today (calm overdue first), upcoming
 * (tomorrow → this week → later), and the no-date inbox. Counts are the
 * filtered counts, so the persistent filter bar and the boards always agree.
 */
export const buildTaskView = (
  rows: ReadonlyArray<TaskRow>,
  options: {
    readonly timeZone: string
    readonly now: string
    readonly filters: TaskFilters
    readonly sort: TaskSort
  }
): TaskView => {
  const bounds = taskBucketBounds(options.timeZone, options.now)
  const buckets = new Map<TaskBucketPlacement, Array<TaskRow>>()
  for (const key of ["overdue", "today", "tomorrow", "thisWeek", "later", "noDate"] as const) {
    buckets.set(key, [])
  }

  const visible = rows
    .filter((task) => task.status !== "done")
    .filter((task) => matchesTaskFilters(task, options.filters, bounds))

  for (const task of visible) {
    const placement = placementOf(task, bounds)
    buckets.get(placement === "done" ? "noDate" : placement)?.push(task)
  }
  for (const tasks of buckets.values()) tasks.sort((a, b) => compareTasks(a, b, options.sort))

  const group = (key: TaskBucketPlacement): TaskGroup => ({
    key,
    tasks: buckets.get(key) ?? []
  })
  const todayGroups = [group("overdue"), group("today")]
  const upcomingGroups = [group("tomorrow"), group("thisWeek"), group("later")]
  const inboxGroups = [group("noDate")]
  const countOf = (groups: ReadonlyArray<TaskGroup>): number =>
    groups.reduce((total, entry) => total + entry.tasks.length, 0)

  const today: TaskBoard = { key: "today", groups: todayGroups, count: countOf(todayGroups) }
  const upcoming: TaskBoard = {
    key: "upcoming",
    groups: upcomingGroups,
    count: countOf(upcomingGroups)
  }
  const inbox: TaskBoard = { key: "inbox", groups: inboxGroups, count: countOf(inboxGroups) }

  return {
    bounds,
    today,
    upcoming,
    inbox,
    counts: { today: today.count, upcoming: upcoming.count, inbox: inbox.count },
    total: visible.length,
    visible
  }
}

/** How many filter controls differ from "show everything". */
export const activeFilterCount = (filters: TaskFilters): number =>
  (filters.projectId !== undefined ? 1 : 0) +
  (filters.tagIds.length > 0 ? 1 : 0) +
  (filters.priority !== "all" ? 1 : 0) +
  (filters.status !== "all" ? 1 : 0) +
  (filters.date !== "all" ? 1 : 0)

// ── Dates ────────────────────────────────────────────────────────────────

/** Shift a `YYYY-MM-DD` wall date by whole days (calendar-safe, no UTC slicing). */
export const shiftLocalDate = (date: string, days: number): string =>
  toIsoDate(addJalaliDays(toJalaliDate(date), days))

export const todayLocalDate = (timeZone: string, now?: string): string =>
  toIsoDate(toJalaliDateInZone(now === undefined ? new Date() : new Date(now), timeZone))

export const formatLocalDate = (date: string, digits: Digits): string =>
  formatJalaliDate(toJalaliDate(date), { style: "short", digits })

export const formatCompletionTime = (
  completedAt: string,
  timeZone: string,
  digits: Digits
): string => {
  const instant = new Date(completedAt)
  const date = formatJalaliDate(toJalaliDateInZone(instant, timeZone), {
    style: "medium",
    digits
  })
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone
  }).format(instant)
  return `${date}، ${localizeDigits(time, digits)}`
}

/** A short, calm label for the due chip. Overdue is quiet amber, never an alert. */
export const dueLabel = (task: TaskRow, bounds: TaskBucketBounds, digits: Digits): string => {
  if (task.dueDate === null && task.dueAt === null) return "بدون تاریخ"
  if (task.dueDate === bounds.today) return "امروز"
  if (task.dueDate === bounds.tomorrow) return "فردا"
  if (task.dueDate !== null) {
    const label = formatLocalDate(task.dueDate, digits)
    return task.dueDate < bounds.today ? `عقب‌افتاده · ${label}` : label
  }
  return new Intl.DateTimeFormat("fa-IR", {
    day: "numeric",
    month: "short",
    timeZone: bounds.timeZone
  }).format(new Date(task.dueAt!))
}

// ── Completion history (FR-TASK-06: seven days, then archived) ───────────

export const COMPLETED_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** True while the completion is still restorable (mirrors TaskService.undo). */
export const isRestorable = (
  completedAt: string | null,
  now: string,
  retentionMs: number = COMPLETED_TASK_RETENTION_MS
): boolean => {
  if (completedAt === null) return false
  const completed = Date.parse(completedAt)
  if (!Number.isFinite(completed)) return false
  return completed >= Date.parse(now) - retentionMs
}

/** Most recent completions first; anything older than the retention is archived. */
export const recentCompletions = (
  rows: ReadonlyArray<TaskRow>,
  now: string
): ReadonlyArray<TaskRow> =>
  rows
    .filter((task) => task.status === "done" && isRestorable(task.completedAt, now))
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))

// ── Mirror writes (local first, always) ───────────────────────────────────

export interface TaskCreateDraft {
  readonly title: string
  readonly dueDate: string | null
  readonly priority: Priority
  readonly projectId: string | null
  readonly tagIds: ReadonlyArray<string>
  readonly timeZone: string
}

/**
 * The quick-add path: mint the id offline, commit the mirror row and outbox
 * entry together, and let the sync engine create the server row. The patch
 * carries the client-owned fields the registry hydrates; the server fills
 * owner/household/timestamps.
 */
export const createTaskInMirror = async (
  store: LocalStore,
  draft: TaskCreateDraft,
  now: string = new Date().toISOString()
): Promise<string> => {
  const title = draft.title.trim()
  if (title === "") throw new Error("a task needs a title")
  const id = uuidV7()
  await store.writeLocal({
    entityType: "task",
    entityId: id,
    op: "upsert",
    patch: {
      id,
      type: "task",
      title,
      description: null,
      status: "todo",
      priority: draft.priority,
      dueAt: null,
      dueDate: draft.dueDate,
      timeZone: draft.timeZone,
      projectId: draft.projectId,
      tagIds: [...draft.tagIds],
      color: null,
      visibility: "shared",
      createdAt: now
    },
    now
  })
  return id
}

/** Only the editable, client-writable fields; absent means "leave it". */
export interface TaskEditPatch {
  readonly title?: string
  readonly description?: string | null
  readonly status?: TaskStatus
  readonly priority?: Priority
  readonly dueDate?: string | null
  readonly projectId?: string | null
  readonly tagIds?: ReadonlyArray<string>
  readonly timeZone?: string
}

const localTaskPatch = (
  patch: TaskEditPatch,
  now: string
): Record<string, unknown> => {
  const record: Record<string, unknown> = {}
  if (patch.title !== undefined) record.title = patch.title.trim()
  if (patch.description !== undefined) record.description = patch.description
  if (patch.status !== undefined) {
    record.status = patch.status
    // The server stamps the real value; mirroring it locally keeps undo
    // (doing → todo) correct when the ack has not arrived yet. It is not in
    // the sync writable allowlist, so the push drops it.
    if (patch.status === "doing") record.startedAt = now
  }
  if (patch.priority !== undefined) record.priority = patch.priority
  if (patch.projectId !== undefined) record.projectId = patch.projectId
  if (patch.tagIds !== undefined) record.tagIds = [...patch.tagIds]
  if (patch.timeZone !== undefined) record.timeZone = patch.timeZone
  if (patch.dueDate !== undefined) {
    // The UI is all-day only: setting a date clears any timed instant, and
    // clearing the date moves the task to the inbox.
    record.dueAt = null
    record.dueDate = patch.dueDate
  }
  return record
}

/** Patch one task in the mirror + outbox. The debounced autosave target. */
export const updateTaskInMirror = async (
  store: LocalStore,
  id: string,
  patch: TaskEditPatch,
  now: string = new Date().toISOString()
): Promise<void> => {
  const record = localTaskPatch(patch, now)
  if (Object.keys(record).length === 0) return
  await store.writeLocal({ entityType: "task", entityId: id, op: "upsert", patch: record, now })
}

/**
 * Complete locally. The sync registry's done-wins merge stamps the
 * server-authoritative `completedAt`; writing it here too keeps the local
 * history list immediate (the field is not client-writable and is dropped by
 * the push's allowlist, then replaced by the ack).
 */
export const completeTaskInMirror = async (
  store: LocalStore,
  id: string,
  now: string = new Date().toISOString()
): Promise<void> => {
  await store.writeLocal({
    entityType: "task",
    entityId: id,
    op: "upsert",
    patch: { status: "done", completedAt: now },
    now
  })
}

/**
 * Undo a completion with the #36 rule: a task that had been started returns to
 * `doing`, everything else to `todo`. Completion never moved the due date, so
 * neither does undo.
 */
export const undoTaskInMirror = async (
  store: LocalStore,
  task: Pick<TaskRow, "id" | "startedAt">,
  now: string = new Date().toISOString()
): Promise<void> => {
  await store.writeLocal({
    entityType: "task",
    entityId: task.id,
    op: "upsert",
    patch: {
      status: task.startedAt !== null ? "doing" : "todo",
      completedAt: null
    },
    now
  })
}

/** Move a task to a day (or to the no-date inbox with `null`). */
export const moveTaskInMirror = async (
  store: LocalStore,
  id: string,
  dueDate: string | null,
  timeZone: string,
  now: string = new Date().toISOString()
): Promise<void> => {
  await store.writeLocal({
    entityType: "task",
    entityId: id,
    op: "upsert",
    patch: { dueAt: null, dueDate, timeZone },
    now
  })
}

/** Create a project offline; the sidebar renders it immediately. */
export const createProjectInMirror = async (
  store: LocalStore,
  title: string,
  color: string | null = null,
  now: string = new Date().toISOString()
): Promise<string> => {
  const name = title.trim()
  if (name === "") throw new Error("a project needs a title")
  const id = uuidV7()
  await store.writeLocal({
    entityType: "project",
    entityId: id,
    op: "upsert",
    patch: { id, type: "project", title: name, color, visibility: "shared", createdAt: now },
    now
  })
  return id
}

/** Create a tag offline (multi-tag chips use it immediately). */
export const createTagInMirror = async (
  store: LocalStore,
  name: string,
  color: string | null = null,
  now: string = new Date().toISOString()
): Promise<string> => {
  const label = name.trim()
  if (label === "") throw new Error("a tag needs a name")
  const id = uuidV7()
  await store.writeLocal({
    entityType: "tag",
    entityId: id,
    op: "upsert",
    patch: { id, type: "tag", name: label, color, visibility: "shared", createdAt: now },
    now
  })
  return id
}

export interface TagRow {
  readonly id: string
  readonly name: string
  readonly color: string | null
}

export const toTagRow = (record: MirrorRecord): TagRow => ({
  id: record.entityId,
  name: typeof record.data.name === "string" ? record.data.name : "",
  color: asNullableString(record.data.color)
})

export interface ProjectRow {
  readonly id: string
  readonly title: string
  readonly color: string | null
}

export const toProjectRow = (record: MirrorRecord): ProjectRow => ({
  id: record.entityId,
  title: typeof record.data.title === "string" ? record.data.title : "",
  color: asNullableString(record.data.color)
})

/**
 * Tag colours. A saved colour wins; otherwise a stable palette slot keeps one
 * tag visually consistent across devices and sessions.
 */
export const TAG_COLORS = [
  "#2f5fe0",
  "#0f9d8f",
  "#b45309",
  "#9f1239",
  "#6d28d9",
  "#0369a1",
  "#4d7c0f",
  "#a21caf"
] as const

export const tagColor = (tag: Pick<TagRow, "id" | "color">): string => {
  if (tag.color !== null && /^#[0-9a-fA-F]{3,8}$/.test(tag.color)) return tag.color
  let hash = 0
  for (let index = 0; index < tag.id.length; index += 1) {
    hash = (hash * 31 + tag.id.charCodeAt(index)) >>> 0
  }
  return TAG_COLORS[hash % TAG_COLORS.length]!
}

// ── Pending state ─────────────────────────────────────────────────────────

/** Task ids with an unsent outbox entry, for the per-row pending badge. */
export const pendingTaskIds = (
  entries: ReadonlyArray<{ readonly entityType: string; readonly entityId: string }>
): ReadonlySet<string> =>
  new Set(entries.filter((entry) => entry.entityType === "task").map((entry) => entry.entityId))
