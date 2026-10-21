import type { ListCheckedPlacement, ListItemSort } from "@tali/domain"
import { uuidV7 } from "@tali/domain"
import type { LocalStore } from "../local-store"
import { orderPatch, type ListItemRow } from "./model"

/**
 * List/ListItem mirror writes (ticket #39).
 *
 * Every helper commits the mirror row and its outbox entry in one
 * `writeLocal` transaction before resolving, so the screen is correct offline
 * and the existing sync engine carries the mutation on reconnect. Patches carry
 * both the legacy wire names (`title`/`checked`/`sortOrder`) and the real
 * aggregate names (`name`/`done`/`ordering`) — the registry accepts either and
 * dual-writes the table columns.
 */

export interface ListDraft {
  readonly title: string
  readonly description?: string | null
  readonly color?: string | null
  readonly icon?: string | null
  readonly sort?: ListItemSort
  readonly checkedPlacement?: ListCheckedPlacement
  readonly visibility?: "private" | "shared"
}

export const createListInMirror = async (
  store: LocalStore,
  draft: ListDraft,
  now: string = new Date().toISOString()
): Promise<string> => {
  const title = draft.title.trim()
  if (title === "") throw new Error("a list needs a title")
  const id = uuidV7()
  await store.writeLocal({
    entityType: "list",
    entityId: id,
    op: "upsert",
    patch: {
      id,
      type: "list",
      // The owner is known offline too, so the detail screen can offer the
      // private/shared toggle before the first ack fills it in.
      ownerId: store.userId,
      title,
      description: draft.description ?? null,
      color: draft.color ?? null,
      icon: draft.icon ?? null,
      sort: draft.sort ?? "manual",
      checkedPlacement: draft.checkedPlacement ?? "bottom",
      visibility: draft.visibility ?? "shared",
      createdAt: now
    },
    now
  })
  return id
}

export interface ListEditPatch {
  readonly title?: string
  readonly description?: string | null
  readonly color?: string | null
  readonly icon?: string | null
  readonly sort?: ListItemSort
  readonly checkedPlacement?: ListCheckedPlacement
  readonly visibility?: "private" | "shared"
}

export const updateListInMirror = async (
  store: LocalStore,
  id: string,
  patch: ListEditPatch,
  now: string = new Date().toISOString()
): Promise<void> => {
  const record: Record<string, unknown> = {}
  if (patch.title !== undefined) record.title = patch.title.trim()
  if (patch.description !== undefined) record.description = patch.description
  if (patch.color !== undefined) record.color = patch.color
  if (patch.icon !== undefined) record.icon = patch.icon
  if (patch.sort !== undefined) record.sort = patch.sort
  if (patch.checkedPlacement !== undefined) {
    record.checkedPlacement = patch.checkedPlacement
  }
  if (patch.visibility !== undefined) record.visibility = patch.visibility
  if (Object.keys(record).length === 0) return
  await store.writeLocal({ entityType: "list", entityId: id, op: "upsert", patch: record, now })
}

/** Soft delete the list and its locally known items. */
export const deleteListInMirror = async (
  store: LocalStore,
  id: string,
  items: ReadonlyArray<Pick<ListItemRow, "id">>,
  now: string = new Date().toISOString()
): Promise<void> => {
  await store.writeLocal({
    entityType: "list",
    entityId: id,
    op: "delete",
    patch: {},
    now
  })
  for (const item of items) {
    await store.writeLocal({
      entityType: "listItem",
      entityId: item.id,
      op: "delete",
      patch: {},
      now
    })
  }
}

export interface ListItemDraft {
  readonly name: string
  readonly order: number
  readonly color?: string | null
  readonly tagIds?: ReadonlyArray<string>
  readonly visibility?: "private" | "shared"
}

const itemPatch = (
  id: string,
  listId: string,
  draft: ListItemDraft,
  now: string,
  ownerId: string
) => {
  const name = draft.name.trim()
  return {
    id,
    type: "listItem",
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
    visibility: draft.visibility ?? "shared",
    ownerId,
    createdAt: now
  } satisfies Record<string, unknown>
}

/**
 * One continuous-entry line. The caller owns the `order` so a five-Enter
 * sequence appends 1..5 without a server round trip.
 */
export const createListItemInMirror = async (
  store: LocalStore,
  listId: string,
  draft: ListItemDraft,
  now: string = new Date().toISOString()
): Promise<string> => {
  const name = draft.name.trim()
  if (name === "") throw new Error("an item needs a name")
  const id = uuidV7()
  await store.writeLocal({
    entityType: "listItem",
    entityId: id,
    op: "upsert",
    patch: itemPatch(id, listId, { ...draft, name }, now, store.userId),
    now
  })
  return id
}

/** Batch append used by the RPC-equivalent path and tests. */
export const appendListItemsInMirror = async (
  store: LocalStore,
  listId: string,
  names: ReadonlyArray<string>,
  startOrder: number,
  now: string = new Date().toISOString()
): Promise<ReadonlyArray<string>> => {
  const ids: Array<string> = []
  for (const [index, name] of names.entries()) {
    ids.push(
      await createListItemInMirror(store, listId, { name, order: startOrder + index }, now)
    )
  }
  return ids
}

export const setListItemCheckedInMirror = async (
  store: LocalStore,
  item: Pick<ListItemRow, "id" | "done" | "checkedAt">,
  checked: boolean,
  now: string = new Date().toISOString()
): Promise<void> => {
  // Idempotent locally too: no new outbox entry when the row already agrees.
  if (item.done === checked && (checked ? item.checkedAt !== null : item.checkedAt === null)) {
    return
  }
  await store.writeLocal({
    entityType: "listItem",
    entityId: item.id,
    op: "upsert",
    patch: {
      checked,
      done: checked,
      checkedAt: checked ? now : null
    },
    now
  })
}

export const toggleListItemInMirror = (
  store: LocalStore,
  item: Pick<ListItemRow, "id" | "done" | "checkedAt">,
  now: string = new Date().toISOString()
): Promise<void> => setListItemCheckedInMirror(store, item, !item.done, now)

export const updateListItemInMirror = async (
  store: LocalStore,
  id: string,
  patch: {
    readonly name?: string
    readonly color?: string | null
    readonly tagIds?: ReadonlyArray<string>
    readonly visibility?: "private" | "shared"
  },
  now: string = new Date().toISOString()
): Promise<void> => {
  const record: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    record.name = name
    record.title = name
  }
  if (patch.color !== undefined) record.color = patch.color
  if (patch.tagIds !== undefined) record.tagIds = [...patch.tagIds]
  if (patch.visibility !== undefined) record.visibility = patch.visibility
  if (Object.keys(record).length === 0) return
  await store.writeLocal({ entityType: "listItem", entityId: id, op: "upsert", patch: record, now })
}

export const deleteListItemInMirror = async (
  store: LocalStore,
  id: string,
  now: string = new Date().toISOString()
): Promise<void> => {
  await store.writeLocal({
    entityType: "listItem",
    entityId: id,
    op: "delete",
    patch: {},
    now
  })
}

/**
 * Persist a manual reorder: write the new ordering integer on every item whose
 * position changed. The server bumps each item's version plus the list version
 * when the equivalent `ReorderListItems` call runs.
 */
export const reorderListItemsInMirror = async (
  store: LocalStore,
  items: ReadonlyArray<Pick<ListItemRow, "id" | "order">>,
  orderedIds: ReadonlyArray<string>,
  now: string = new Date().toISOString()
): Promise<void> => {
  const byId = new Map(items.map((item) => [item.id, item]))
  for (const [index, id] of orderedIds.entries()) {
    const item = byId.get(id)
    if (item === undefined || item.order === index + 1) continue
    await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      patch: orderPatch(index),
      now
    })
  }
}
