import { Array } from 'effect'

import { defaultVisibilityFor } from '@tali/domain'
import type { LocalStore } from '@tali/sync-client'

import {
  type CheckedPlacement,
  type ListItemRow,
  type ListSort,
  type ListVisibility,
  orderPatch,
  toListItemRow,
} from '../lists-model'

/**
 * List/ListItem mirror writes, ported from `apps/web/src/lib/lists/mirror.ts`
 * (ticket #39).
 *
 * Every helper commits the mirror row and its outbox entry in one
 * `writeLocal` transaction before resolving, so the screen is correct offline
 * and the sync engine carries the mutation on reconnect. Patches carry both the
 * legacy wire names (`title`/`checked`/`sortOrder`) and the real aggregate names
 * (`name`/`done`/`ordering`) — the registry accepts either and dual-writes the
 * table columns.
 *
 * Ids and timestamps are supplied by the caller because a Foldkit Command mints
 * them in `execute`, never while preparing its arguments.
 */

export interface ListDraft {
  readonly title: string
  readonly color?: string | null
  readonly icon?: string | null
  readonly sort?: ListSort
  readonly checkedPlacement?: CheckedPlacement
  readonly visibility?: ListVisibility
}

export const createListInMirror = async (
  store: LocalStore,
  draft: ListDraft,
  id: string,
  now: string,
): Promise<string> => {
  const title = draft.title.trim()

  if (title === '') {
    throw new Error('a list needs a title')
  }

  await store.writeLocal({
    entityType: 'list',
    entityId: id,
    op: 'upsert',
    patch: {
      id,
      type: 'list',
      // The owner is known offline too, so the detail screen can offer the
      // private/shared toggle before the first ack fills it in.
      ownerId: store.userId,
      title,
      description: null,
      color: draft.color ?? null,
      icon: draft.icon ?? null,
      sort: draft.sort ?? 'manual',
      checkedPlacement: draft.checkedPlacement ?? 'bottom',
      visibility: draft.visibility ?? defaultVisibilityFor('list'),
      createdAt: now,
    },
    now,
  })

  return id
}

export interface ListEditPatch {
  readonly title?: string
  readonly description?: string | null
  readonly color?: string | null
  readonly icon?: string | null
  readonly sort?: ListSort
  readonly checkedPlacement?: CheckedPlacement
  readonly visibility?: ListVisibility
}

export const updateListInMirror = async (
  store: LocalStore,
  id: string,
  patch: ListEditPatch,
  now: string,
): Promise<void> => {
  const record: Record<string, unknown> = {}

  if (patch.title !== undefined) {
    record.title = patch.title.trim()
  }

  if (patch.description !== undefined) {
    record.description = patch.description
  }

  if (patch.color !== undefined) {
    record.color = patch.color
  }

  if (patch.icon !== undefined) {
    record.icon = patch.icon
  }

  if (patch.sort !== undefined) {
    record.sort = patch.sort
  }

  if (patch.checkedPlacement !== undefined) {
    record.checkedPlacement = patch.checkedPlacement
  }

  if (patch.visibility !== undefined) {
    record.visibility = patch.visibility
  }

  if (Object.keys(record).length === 0) {
    return
  }

  await store.writeLocal({
    entityType: 'list',
    entityId: id,
    op: 'upsert',
    patch: record,
    now,
  })
}

type ListSettingField = 'sort' | 'placement' | 'visibility'

/**
 * The newest revision seen per list and setting.
 *
 * A fast pair of select changes can start two Commands whose writes land out
 * of order. Each helper records the revision immediately before its write, so
 * an older intent can never overwrite a newer one: whichever call runs last
 * either carries the newest revision or is skipped.
 */
const latestSettingRevisions: Readonly<
  Record<ListSettingField, Map<string, number>>
> = {
  sort: new Map(),
  placement: new Map(),
  visibility: new Map(),
}

const writeListSettingIfLatest = async (
  store: LocalStore,
  field: ListSettingField,
  listId: string,
  revision: number,
  patch: ListEditPatch,
  now: string,
): Promise<void> => {
  const revisions = latestSettingRevisions[field]
  const latest = revisions.get(listId) ?? 0

  if (revision < latest) {
    return
  }

  revisions.set(listId, revision)
  await updateListInMirror(store, listId, patch, now)
}

export { writeListSettingIfLatest }

/** Soft delete the list and its locally known items. */
export const deleteListInMirror = async (
  store: LocalStore,
  id: string,
  itemIds: ReadonlyArray<string>,
  now: string,
): Promise<void> => {
  await store.writeLocal({
    entityType: 'list',
    entityId: id,
    op: 'delete',
    patch: {},
    now,
  })

  await Promise.all(
    Array.map(itemIds, itemId =>
      store.writeLocal({
        entityType: 'listItem',
        entityId: itemId,
        op: 'delete',
        patch: {},
        now,
      }),
    ),
  )
}

export interface ListItemDraft {
  readonly name: string
  readonly order: number
  readonly color?: string | null
  readonly tagIds?: ReadonlyArray<string>
}

const itemPatch = (
  id: string,
  listId: string,
  draft: ListItemDraft,
  now: string,
  ownerId: string,
): Readonly<Record<string, unknown>> => {
  const name = draft.name.trim()

  return {
    id,
    type: 'listItem',
    listId,
    title: name,
    name,
    checked: false,
    done: false,
    sortOrder: draft.order,
    ordering: draft.order,
    order: draft.order,
    checkedAt: null,
    color: draft.color ?? null,
    tagIds: [...(draft.tagIds ?? [])],
    // The list item inherits its list. Do not send a visibility from the
    // client's possibly-stale copy of the parent: the server resolves it, and
    // an explicit `shared` under a now-private list would be rejected.
    ownerId,
    createdAt: now,
  }
}

/**
 * One continuous-entry line. The caller owns the `order` so a five-Enter
 * sequence appends 1..5 without a server round trip.
 */
export const createListItemInMirror = async (
  store: LocalStore,
  listId: string,
  draft: ListItemDraft,
  id: string,
  now: string,
): Promise<string> => {
  const name = draft.name.trim()

  if (name === '') {
    throw new Error('an item needs a name')
  }

  await store.writeLocal({
    entityType: 'listItem',
    entityId: id,
    op: 'upsert',
    patch: itemPatch(id, listId, { ...draft, name }, now, store.userId),
    now,
  })

  return id
}

/** Idempotent locally too: no new outbox entry when the row already agrees. */
export const setListItemCheckedInMirror = async (
  store: LocalStore,
  item: Pick<ListItemRow, 'id' | 'done' | 'checkedAt'>,
  checked: boolean,
  now: string,
): Promise<void> => {
  if (
    item.done === checked &&
    (checked ? item.checkedAt !== null : item.checkedAt === null)
  ) {
    return
  }

  await store.writeLocal({
    entityType: 'listItem',
    entityId: item.id,
    op: 'upsert',
    patch: {
      checked,
      done: checked,
      checkedAt: checked ? now : null,
    },
    now,
  })
}

/**
 * Force an unchecked row. The undo toast's snapshot predates the tick, so it
 * cannot use the idempotent helper above without risking a skipped write.
 */
export const uncheckListItemInMirror = async (
  store: LocalStore,
  itemId: string,
  now: string,
): Promise<void> => {
  await store.writeLocal({
    entityType: 'listItem',
    entityId: itemId,
    op: 'upsert',
    patch: { checked: false, done: false, checkedAt: null },
    now,
  })
}

export const updateListItemInMirror = async (
  store: LocalStore,
  id: string,
  patch: {
    readonly name?: string
    readonly color?: string | null
    readonly tagIds?: ReadonlyArray<string>
    readonly visibility?: ListVisibility
  },
  now: string,
): Promise<void> => {
  const record: Record<string, unknown> = {}

  if (patch.name !== undefined) {
    const name = patch.name.trim()
    record.name = name
    record.title = name
  }

  if (patch.color !== undefined) {
    record.color = patch.color
  }

  if (patch.tagIds !== undefined) {
    record.tagIds = [...patch.tagIds]
  }

  if (patch.visibility !== undefined) {
    record.visibility = patch.visibility
  }

  if (Object.keys(record).length === 0) {
    return
  }

  await store.writeLocal({
    entityType: 'listItem',
    entityId: id,
    op: 'upsert',
    patch: record,
    now,
  })
}

export const deleteListItemInMirror = async (
  store: LocalStore,
  id: string,
  now: string,
): Promise<void> => {
  await store.writeLocal({
    entityType: 'listItem',
    entityId: id,
    op: 'delete',
    patch: {},
    now,
  })
}

/**
 * Persist a manual reorder: write the new ordering integer on every item whose
 * position changed. The server bumps each item's version plus the list version
 * when the equivalent `ReorderListItems` call runs.
 */
export const reorderListItemsInMirror = async (
  store: LocalStore,
  items: ReadonlyArray<Pick<ListItemRow, 'id' | 'order'>>,
  orderedIds: ReadonlyArray<string>,
  now: string,
): Promise<void> => {
  const byId = new Map(items.map(item => [item.id, item]))

  await Array.reduce(
    orderedIds,
    Promise.resolve(),
    async (previous, id, index) => {
      await previous
      const item = byId.get(id)

      if (item === undefined || item.order === index + 1) {
        return
      }

      await store.writeLocal({
        entityType: 'listItem',
        entityId: id,
        op: 'upsert',
        patch: orderPatch(index),
        now,
      })
    },
  )
}

/** Read the live list-item rows a reorder command needs. */
export const readListItems = async (
  store: LocalStore,
): Promise<ReadonlyArray<ListItemRow>> =>
  Array.map(await store.list('listItem'), toListItemRow)
