import type { ListCheckedPlacement, ListItemSort } from "@tali/domain"
import type { MirrorRecord } from "../local-store"

/**
 * The `/lists` client model (ticket #39; FR-LIST-01/02/03).
 *
 * Everything the screens render is derived from the IndexedDB mirror, exactly
 * like `/tasks` (#37). Sync metadata stays in the envelope; these helpers only
 * shape local rows and compute the ordering/grouping rules. Writes live in
 * `mirror.ts` and always go through `writeLocal`.
 */

export interface ListRow {
  readonly id: string
  readonly ownerId: string
  readonly title: string
  readonly description: string | null
  readonly color: string | null
  readonly icon: string | null
  readonly sort: ListItemSort
  readonly checkedPlacement: ListCheckedPlacement
  readonly visibility: "private" | "shared"
  /** Server-stamped last writer (migration 0008), for the "updated by" label. */
  readonly lastWriterId: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}

export interface ListItemRow {
  readonly id: string
  readonly listId: string
  readonly name: string
  readonly done: boolean
  /** Manual ordering integer (the server's `ordering`/`sortOrder`). */
  readonly order: number
  readonly checkedAt: string | null
  readonly color: string | null
  readonly tagIds: ReadonlyArray<string>
  readonly visibility: "private" | "shared"
  readonly lastWriterId: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null

const asVisibility = (value: unknown): "private" | "shared" =>
  value === "private" ? "private" : "shared"

const asSort = (value: unknown): ListItemSort =>
  value === "alpha" || value === "status" ? value : "manual"

const asPlacement = (value: unknown): ListCheckedPlacement =>
  value === "inPlace" ? "inPlace" : "bottom"

const asOrder = (record: MirrorRecord): number => {
  const candidates = [record.data.order, record.data.ordering, record.data.sortOrder]
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value)
  }
  return 0
}

const asDone = (record: MirrorRecord): boolean =>
  record.data.done === true || record.data.checked === true

const asName = (record: MirrorRecord): string =>
  typeof record.data.name === "string"
    ? record.data.name
    : typeof record.data.title === "string"
      ? record.data.title
      : ""

const stringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

export const toListRow = (record: MirrorRecord): ListRow => ({
  id: record.entityId,
  ownerId: typeof record.data.ownerId === "string" ? record.data.ownerId : "",
  title: typeof record.data.title === "string" ? record.data.title : "",
  description: asNullableString(record.data.description),
  color: asNullableString(record.data.color),
  icon:
    typeof record.data.icon === "string" && record.data.icon !== ""
      ? record.data.icon
      : null,
  sort: asSort(record.data.sort),
  checkedPlacement: asPlacement(record.data.checkedPlacement),
  visibility: asVisibility(record.data.visibility),
  lastWriterId: asNullableString(record.data.lastWriterId),
  createdAt:
    typeof record.data.createdAt === "string" ? record.data.createdAt : record.updatedAt,
  updatedAt: record.updatedAt,
  version: record.version
})

const sameStringArray = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>
): boolean => a.length === b.length && a.every((entry, index) => entry === b[index])

/** Structural equality for a decoded row (used to keep DOM identity across acks). */
export const sameItemRow = (a: ListItemRow, b: ListItemRow): boolean =>
  a.id === b.id &&
  a.listId === b.listId &&
  a.name === b.name &&
  a.done === b.done &&
  a.order === b.order &&
  a.checkedAt === b.checkedAt &&
  a.color === b.color &&
  a.visibility === b.visibility &&
  a.lastWriterId === b.lastWriterId &&
  a.createdAt === b.createdAt &&
  a.updatedAt === b.updatedAt &&
  a.version === b.version &&
  sameStringArray(a.tagIds, b.tagIds)

/**
 * Reuse the previous row object when nothing changed.
 *
 * The mirror reloads after every local write and every sync ack (a poll, a
 * wake, a reconnect or a retry), and `<For>` keys rows by reference: handing
 * it fresh objects would remount every row, drop keyboard focus and restart
 * the strike-through animation. Keeping the identity of unchanged rows is what
 * makes an ack invisible (#37's remount class).
 */
export const stableItemRows = (
  previous: ReadonlyArray<ListItemRow>,
  next: ReadonlyArray<ListItemRow>
): ReadonlyArray<ListItemRow> => {
  const byId = new Map(previous.map((row) => [row.id, row]))
  return next.map((row) => {
    const before = byId.get(row.id)
    return before !== undefined && sameItemRow(before, row) ? before : row
  })
}

export const toListItemRow = (record: MirrorRecord): ListItemRow => ({
  id: record.entityId,
  listId: typeof record.data.listId === "string" ? record.data.listId : "",
  name: asName(record),
  done: asDone(record),
  order: asOrder(record),
  checkedAt: asNullableString(record.data.checkedAt),
  color: asNullableString(record.data.color),
  tagIds: stringArray(record.data.tagIds),
  visibility: asVisibility(record.data.visibility),
  lastWriterId: asNullableString(record.data.lastWriterId),
  createdAt:
    typeof record.data.createdAt === "string" ? record.data.createdAt : record.updatedAt,
  updatedAt: record.updatedAt,
  version: record.version
})

// ── Sorting and checked placement ─────────────────────────────────────────

const manualCompare = (a: ListItemRow, b: ListItemRow): number =>
  a.order - b.order || a.id.localeCompare(b.id)

const nameCompare = (a: ListItemRow, b: ListItemRow): number =>
  a.name.localeCompare(b.name, "fa") || manualCompare(a, b)

const compareFor = (sort: ListItemSort) => (a: ListItemRow, b: ListItemRow): number => {
  switch (sort) {
    case "alpha":
      return nameCompare(a, b)
    case "status":
      // Open items first; within one status keep a stable manual order.
      return Number(a.done) - Number(b.done) || manualCompare(a, b)
    case "manual":
      return manualCompare(a, b)
  }
}

export interface ListItemsView {
  readonly open: ReadonlyArray<ListItemRow>
  readonly checked: ReadonlyArray<ListItemRow>
  /** Flat, display-order sequence (open then checked when `bottom`). */
  readonly visible: ReadonlyArray<ListItemRow>
  readonly total: number
  readonly doneCount: number
}

/**
 * The list's two display preferences: its chosen sort and where checked items
 * go. `bottom` groups every checked item after every open item regardless of
 * sort; `inPlace` leaves the chosen sort alone.
 */
export const buildListItemsView = (
  list: Pick<ListRow, "sort" | "checkedPlacement">,
  items: ReadonlyArray<ListItemRow>
): ListItemsView => {
  const compare = compareFor(list.sort)
  const sorted = [...items].sort(compare)
  if (list.checkedPlacement === "inPlace") {
    const checked = sorted.filter((item) => item.done)
    return {
      open: sorted.filter((item) => !item.done),
      checked,
      visible: sorted,
      total: sorted.length,
      doneCount: checked.length
    }
  }
  const open = sorted.filter((item) => !item.done)
  const checked = sorted.filter((item) => item.done)
  return {
    open,
    checked,
    visible: [...open, ...checked],
    total: sorted.length,
    doneCount: checked.length
  }
}

/** The manual order used by drag/arrow reordering (all items, no grouping). */
export const manualOrder = (items: ReadonlyArray<ListItemRow>): ReadonlyArray<string> =>
  [...items].sort(manualCompare).map((item) => item.id)

/**
 * Move one item one slot up/down. `direction: -1` is toward the start of the
 * list (visually up in RTL, because the DOM order is textual/logical).
 */
export const movedOrder = (
  items: ReadonlyArray<ListItemRow>,
  id: string,
  direction: -1 | 1
): ReadonlyArray<string> => {
  const ids = [...manualOrder(items)]
  const index = ids.indexOf(id)
  if (index < 0) return ids
  const target = index + direction
  if (target < 0 || target >= ids.length) return ids
  ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
  return ids
}

/** Move a dragged item before/after a target (target `drop` position). */
export const droppedOrder = (
  items: ReadonlyArray<ListItemRow>,
  draggedId: string,
  targetId: string
): ReadonlyArray<string> => {
  const ids = [...manualOrder(items)]
  const from = ids.indexOf(draggedId)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return ids
  const [moved] = ids.splice(from, 1)
  ids.splice(to, 0, moved!)
  return ids
}

/** The local patch that encodes a new manual position (both field dialects). */
export const orderPatch = (index: number): Record<string, number> => ({
  order: index + 1,
  ordering: index + 1,
  sortOrder: index + 1
})

/** The next append position, one past the highest manual order. */
export const nextItemOrder = (items: ReadonlyArray<ListItemRow>): number =>
  items.reduce((max, item) => Math.max(max, item.order), 0) + 1

// ── Index summaries ───────────────────────────────────────────────────────

export interface ListSummary {
  readonly list: ListRow
  readonly total: number
  readonly done: number
  readonly open: number
  /** Up to two open item names, for the index preview. */
  readonly preview: ReadonlyArray<string>
}

export const summarizeList = (
  list: ListRow,
  items: ReadonlyArray<ListItemRow>
): ListSummary => {
  const view = buildListItemsView(list, items)
  return {
    list,
    total: view.total,
    done: view.doneCount,
    open: view.total - view.doneCount,
    preview: view.open.slice(0, 2).map((item) => item.name)
  }
}

/** Lists in the index order: most recently touched first, id as tiebreak. */
export const sortLists = (lists: ReadonlyArray<ListRow>): ReadonlyArray<ListRow> =>
  [...lists].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
  )

// ── Pending / writer labels ───────────────────────────────────────────────

interface PendingEntry {
  readonly entityType: string
  readonly entityId: string
}

export const pendingListIds = (entries: ReadonlyArray<PendingEntry>): ReadonlySet<string> =>
  new Set(entries.filter((entry) => entry.entityType === "list").map((entry) => entry.entityId))

export const pendingItemIds = (entries: ReadonlyArray<PendingEntry>): ReadonlySet<string> =>
  new Set(entries.filter((entry) => entry.entityType === "listItem").map((entry) => entry.entityId))

/**
 * True when the last writer is the *other* household member. Version 1 rows are
 * still untouched creations (the creator's name is already implied), so the
 * label only appears after a real edit.
 */
export const writtenByOther = (
  lastWriterId: string | null,
  currentUserId: string | undefined,
  version: number
): boolean =>
  lastWriterId !== null &&
  currentUserId !== undefined &&
  lastWriterId !== currentUserId &&
  version > 1

export const UPDATED_BY_OTHER_LABEL = "توسط همخانه به‌روزرسانی شد"
