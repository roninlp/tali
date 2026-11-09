import { Array, Match, Option, Schema } from 'effect'

import { defaultVisibilityFor } from '@tali/domain'
import type { MirrorRecord } from '@tali/sync-client'

import { JsonField } from './lib/json-field'

/**
 * The `/lists` read model and its ordering rules, ported from
 * `apps/web/src/lib/lists/model.ts` (ticket #39; FR-LIST-01/02/03).
 *
 * Everything the screens render is derived from the IndexedDB mirror: the
 * Model holds JSON-safe row projections, and these helpers shape the local
 * rows and compute the ordering/grouping rules. Writes live in
 * `lib/list-writes.ts` and always go through `writeLocal`.
 */

export const ListSort = Schema.Literals(['manual', 'alpha', 'status'])

export type ListSort = typeof ListSort.Type

export const CheckedPlacement = Schema.Literals(['inPlace', 'bottom'])

export type CheckedPlacement = typeof CheckedPlacement.Type

export const ListVisibility = Schema.Literals(['private', 'shared'])

export type ListVisibility = typeof ListVisibility.Type

export const ListRow = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(Schema.String),
  sort: ListSort,
  checkedPlacement: CheckedPlacement,
  visibility: ListVisibility,
  /** Server-stamped last writer (migration 0008), for the "updated by" label. */
  lastWriterId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  version: Schema.Int,
  hasSyncError: Schema.Boolean,
})

export type ListRow = typeof ListRow.Type

export const ListItemRow = Schema.Struct({
  id: Schema.String,
  listId: Schema.String,
  name: Schema.String,
  done: Schema.Boolean,
  /** Manual ordering integer (the server's `ordering`/`sortOrder`). */
  order: Schema.Int,
  checkedAt: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  tagIds: Schema.Array(Schema.String),
  visibility: ListVisibility,
  lastWriterId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  version: Schema.Int,
  hasSyncError: Schema.Boolean,
})

export type ListItemRow = typeof ListItemRow.Type

export const COLOR_CHOICES: ReadonlyArray<string> = [
  '#3558b5',
  '#0f9d8f',
  '#b45309',
  '#9f1239',
  '#6d28d9',
  '#0369a1',
  '#4d7c0f',
  '#a21caf',
]

export const ICON_CHOICES: ReadonlyArray<string> = [
  '🛒',
  '🏠',
  '🧳',
  '🧹',
  '🎉',
  '💊',
  '📚',
  '✨',
]

const asNullableString = Schema.decodeUnknownOption(Schema.String)

const asString = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isMinLength(1)),
)

const asVisibility = Schema.decodeUnknownOption(
  Schema.Literals(['private', 'shared']),
)

const asSort = Schema.decodeUnknownOption(ListSort)

const asPlacement = Schema.decodeUnknownOption(CheckedPlacement)

const asFiniteNumber = Schema.decodeUnknownOption(Schema.Finite)

const asStringArray = Schema.decodeUnknownOption(
  JsonField(Schema.Array(Schema.String)),
)

const asOrder = (record: MirrorRecord): number => {
  const candidates = Array.getSomes(
    Array.map(
      [record.data.order, record.data.ordering, record.data.sortOrder],
      value => asFiniteNumber(value),
    ),
  )

  return Option.match(Array.head(candidates), {
    onNone: () => 0,
    onSome: value => Math.trunc(value),
  })
}

const asDone = (record: MirrorRecord): boolean =>
  record.data.done === true || record.data.checked === true

const asName = (record: MirrorRecord): string =>
  Option.getOrElse(asString(record.data.name), () =>
    Option.getOrElse(asString(record.data.title), () => ''),
  )

/** Project a mirrored list row into the shape the screens understand. */
export const toListRow = (record: MirrorRecord): ListRow =>
  ListRow.make({
    id: record.entityId,
    ownerId: Option.getOrElse(asNullableString(record.data.ownerId), () => ''),
    title: Option.getOrElse(asNullableString(record.data.title), () => ''),
    description: Option.getOrNull(asNullableString(record.data.description)),
    color: Option.getOrNull(asNullableString(record.data.color)),
    icon: Option.getOrNull(asString(record.data.icon)),
    sort: Option.getOrElse(asSort(record.data.sort), () => 'manual'),
    checkedPlacement: Option.getOrElse(
      asPlacement(record.data.checkedPlacement),
      () => 'bottom',
    ),
    visibility: Option.getOrElse(asVisibility(record.data.visibility), () =>
      defaultVisibilityFor('list'),
    ),
    lastWriterId: Option.getOrNull(asNullableString(record.data.lastWriterId)),
    createdAt: Option.getOrElse(
      asNullableString(record.data.createdAt),
      () => record.updatedAt,
    ),
    updatedAt: record.updatedAt,
    version: record.version,
    hasSyncError: record.syncError !== undefined,
  })

/** Project a mirrored list-item row into the shape the screens understand. */
export const toListItemRow = (record: MirrorRecord): ListItemRow =>
  ListItemRow.make({
    id: record.entityId,
    listId: Option.getOrElse(asNullableString(record.data.listId), () => ''),
    name: asName(record),
    done: asDone(record),
    order: asOrder(record),
    checkedAt: Option.getOrNull(asNullableString(record.data.checkedAt)),
    color: Option.getOrNull(asNullableString(record.data.color)),
    tagIds: Option.getOrElse(asStringArray(record.data.tagIds), () => []),
    visibility: Option.getOrElse(asVisibility(record.data.visibility), () =>
      defaultVisibilityFor('listItem'),
    ),
    lastWriterId: Option.getOrNull(asNullableString(record.data.lastWriterId)),
    createdAt: Option.getOrElse(
      asNullableString(record.data.createdAt),
      () => record.updatedAt,
    ),
    updatedAt: record.updatedAt,
    version: record.version,
    hasSyncError: record.syncError !== undefined,
  })

export const listRowsFromMirror = (
  records: ReadonlyArray<MirrorRecord>,
): ReadonlyArray<ListRow> => Array.map(records, toListRow)

export const listItemRowsFromMirror = (
  records: ReadonlyArray<MirrorRecord>,
): ReadonlyArray<ListItemRow> => Array.map(records, toListItemRow)

// ── Sorting and checked placement ─────────────────────────────────────────

const compareText = (left: string, right: string): number =>
  left.localeCompare(right)

const manualCompare = (left: ListItemRow, right: ListItemRow): number =>
  left.order - right.order || compareText(left.id, right.id)

const nameCompare = (left: ListItemRow, right: ListItemRow): number =>
  left.name.localeCompare(right.name, 'fa') || manualCompare(left, right)

const compareFor = (
  sort: ListSort,
): ((left: ListItemRow, right: ListItemRow) => number) =>
  Match.value(sort).pipe(
    Match.when('alpha', () => nameCompare),
    Match.when(
      'status',
      () => (left: ListItemRow, right: ListItemRow) =>
        Number(left.done) - Number(right.done) || manualCompare(left, right),
    ),
    Match.orElse(() => manualCompare),
  )

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
  list: Readonly<{ sort: ListSort; checkedPlacement: CheckedPlacement }>,
  items: ReadonlyArray<ListItemRow>,
): ListItemsView => {
  const compare = compareFor(list.sort)
  const sorted = [...items].sort(compare)
  const open = Array.filter(sorted, item => !item.done)
  const checked = Array.filter(sorted, item => item.done)

  return list.checkedPlacement === 'inPlace'
    ? {
        open,
        checked,
        visible: sorted,
        total: sorted.length,
        doneCount: checked.length,
      }
    : {
        open,
        checked,
        visible: [...open, ...checked],
        total: sorted.length,
        doneCount: checked.length,
      }
}

/** The manual order used by drag/arrow reordering (all items, no grouping). */
export const manualOrder = (
  items: ReadonlyArray<ListItemRow>,
): ReadonlyArray<string> => [...items].sort(manualCompare).map(item => item.id)

/**
 * Move one item one slot up/down. `direction: -1` is toward the start of the
 * list (visually up in RTL, because the DOM order is textual/logical).
 */
export const movedOrder = (
  items: ReadonlyArray<ListItemRow>,
  id: string,
  direction: -1 | 1,
): ReadonlyArray<string> => {
  const ids = [...manualOrder(items)]
  const index = ids.indexOf(id)

  if (index < 0) {
    return ids
  }

  const target = index + direction

  if (target < 0 || target >= ids.length) {
    return ids
  }

  const moved = ids[target] ?? id
  ids[target] = ids[index] ?? id
  ids[index] = moved

  return ids
}

/** Move a dragged item before/after a target (target `drop` position). */
export const droppedOrder = (
  items: ReadonlyArray<ListItemRow>,
  draggedId: string,
  targetId: string,
): ReadonlyArray<string> => {
  const ids = [...manualOrder(items)]
  const from = ids.indexOf(draggedId)
  const to = ids.indexOf(targetId)

  if (from < 0 || to < 0 || from === to) {
    return ids
  }

  const [moved] = ids.splice(from, 1)

  if (moved !== undefined) {
    ids.splice(to, 0, moved)
  }

  return ids
}

/** The local patch that encodes a new manual position (both field dialects). */
export const orderPatch = (index: number) => ({
  order: index + 1,
  ordering: index + 1,
  sortOrder: index + 1,
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
  items: ReadonlyArray<ListItemRow>,
): ListSummary => {
  const view = buildListItemsView(list, items)

  return {
    list,
    total: view.total,
    done: view.doneCount,
    open: view.total - view.doneCount,
    preview: Array.map(Array.take(view.open, 2), item => item.name),
  }
}

/** Lists in the index order: most recently touched first, id as tiebreak. */
export const sortListRows = (
  lists: ReadonlyArray<ListRow>,
): ReadonlyArray<ListRow> =>
  [...lists].sort(
    (left, right) =>
      compareText(right.updatedAt, left.updatedAt) ||
      compareText(left.id, right.id),
  )

export const listItemsFor = (
  items: ReadonlyArray<ListItemRow>,
  listId: string,
): ReadonlyArray<ListItemRow> =>
  Array.filter(items, item => item.listId === listId)

export const findListRow = (
  lists: ReadonlyArray<ListRow>,
  listId: string,
): Option.Option<ListRow> => Array.findFirst(lists, list => list.id === listId)

export const listSummaries = (
  lists: ReadonlyArray<ListRow>,
  items: ReadonlyArray<ListItemRow>,
): ReadonlyArray<ListSummary> =>
  Array.map(sortListRows(lists), list =>
    summarizeList(list, listItemsFor(items, list.id)),
  )

// ── Pending / writer labels ───────────────────────────────────────────────

const entityPrefix = (entityType: string): string => `${entityType}\u0000`

/** Ids of one entity type among the sync Model's pending `type\0id` keys. */
export const pendingIdsOf = (
  keys: ReadonlyArray<string>,
  entityType: string,
): ReadonlyArray<string> => {
  const prefix = entityPrefix(entityType)

  return Array.flatMap(keys, key =>
    key.startsWith(prefix) ? [key.slice(prefix.length)] : [],
  )
}

/**
 * True when the last writer is the *other* household member. Version 1 rows are
 * still untouched creations (the creator's name is already implied), so the
 * label only appears after a real edit.
 */
export const writtenByOther = (
  lastWriterId: string | null,
  maybeCurrentUserId: Option.Option<string>,
  version: number,
): boolean =>
  lastWriterId !== null &&
  version > 1 &&
  Option.exists(maybeCurrentUserId, userId => userId !== lastWriterId)

export const UPDATED_BY_OTHER_LABEL = 'توسط همخانه به‌روزرسانی شد'
