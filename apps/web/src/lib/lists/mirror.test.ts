import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import { uuidV7, type SyncBootstrapResponse, type SyncPullResponse, type SyncPushEntry, type SyncPushResponse } from "@tali/domain"
import { openLocalStore } from "../local-store/store"
import type { LocalStore } from "../local-store/types"
import { createSyncEngine, type SyncTransport } from "../sync-engine"
import {
  appendListItemsInMirror,
  createListItemInMirror,
  createListInMirror,
  reorderListItemsInMirror,
  setListItemCheckedInMirror
} from "./mirror"
import { nextItemOrder, toListItemRow, toListRow } from "./model"

/**
 * Ticket #39 local-first writes: five continuous Enters queue five items,
 * check/undo is idempotent, reorder persists, and the queued batch drains on
 * reconnect. Everything here is the real IndexedDB store (fake-indexeddb).
 */

const open = (): Promise<LocalStore> => openLocalStore(`user-${uuidV7()}`)

const transport = (parts: {
  readonly pull?: (cursor: number, limit: number) => Promise<SyncPullResponse>
  readonly push?: (entries: ReadonlyArray<SyncPushEntry>) => Promise<SyncPushResponse>
}): SyncTransport => ({
  pull: parts.pull ?? (async (cursor) => ({
    entries: [],
    items: [],
    removed: [],
    nextCursor: cursor,
    hasMore: false,
    resetRequired: false
  })),
  bootstrap: async (): Promise<SyncBootstrapResponse> => ({
    items: [],
    nextOffset: 0,
    hasMore: false,
    cursor: 0
  }),
  push: parts.push ?? (async () => ({ results: [], cursor: 0 }))
})

describe("list mirror writes", () => {
  it("adds five items continuously and queues each write", async () => {
    const store = await open()
    const listId = await createListInMirror(
      store,
      {
        title: "خرید",
        color: "#0f9d8f",
        icon: "🛒",
        checkedPlacement: "bottom"
      },
      "2026-10-20T09:00:00.000Z"
    )
    const names = ["نان", "شیر", "تخم‌مرغ", "پنیر", "سبزی"]
    const ids = await appendListItemsInMirror(
      store,
      listId,
      names,
      1,
      "2026-10-20T09:01:00.000Z"
    )

    expect(ids).toHaveLength(5)
    expect(await store.pending()).toHaveLength(6) // list + five items
    const listRecord = await store.get("list", listId)
    expect(listRecord === undefined ? undefined : toListRow(listRecord)).toMatchObject({
      title: "خرید",
      checkedPlacement: "bottom",
      icon: "🛒"
    })

    const items = (await store.list("listItem"))
      .map(toListItemRow)
      .sort((a, b) => a.order - b.order)
    expect(items.map((item) => item.name)).toEqual(names)
    expect(items.map((item) => item.order)).toEqual([1, 2, 3, 4, 5])
    expect(nextItemOrder(items)).toBe(6)

    // Both wire dialects are present in the mirror row, so the registry can
    // hydrate either one after a pull.
    const first = await store.get("listItem", ids[0]!)
    expect(first?.data).toMatchObject({
      title: "نان",
      name: "نان",
      checked: false,
      done: false,
      sortOrder: 1,
      ordering: 1,
      listId
    })
  })

  it("checks with an audit timestamp, tolerates a repeat, and undoes", async () => {
    const store = await open()
    const listId = await createListInMirror(store, { title: "کارها" })
    const id = await createListItemInMirror(store, listId, { name: "ظرف‌ها", order: 1 })
    const before = (await store.list("listItem")).map(toListItemRow)[0]!

    const now = "2026-10-20T09:30:00.000Z"
    await setListItemCheckedInMirror(store, before, true, now)
    const checked = (await store.list("listItem")).map(toListItemRow)[0]!
    expect(checked.done).toBe(true)
    expect(checked.checkedAt).toBe(now)
    const pendingAfterCheck = (await store.pending()).length

    // Re-checking an already-checked row is a no-op, not another queued edit.
    await setListItemCheckedInMirror(store, checked, true, now)
    expect((await store.pending()).length).toBe(pendingAfterCheck)

    await setListItemCheckedInMirror(store, checked, false, now)
    const undone = (await store.list("listItem")).map(toListItemRow)[0]!
    expect(undone.done).toBe(false)
    expect(undone.checkedAt).toBeNull()
    expect(undone.id).toBe(id)
  })

  it("persists a manual reorder and only queues changed positions", async () => {
    const store = await open()
    const listId = await createListInMirror(store, { title: "ترتیب" })
    const ids = await appendListItemsInMirror(store, listId, ["یک", "دو", "سه"], 1)
    const items = (await store.list("listItem")).map(toListItemRow)

    await reorderListItemsInMirror(store, items, [ids[2]!, ids[0]!, ids[1]!])
    const reordered = (await store.list("listItem"))
      .map(toListItemRow)
      .sort((a, b) => a.order - b.order)
    expect(reordered.map((item) => item.name)).toEqual(["سه", "یک", "دو"])
    expect(reordered.map((item) => item.order)).toEqual([1, 2, 3])

    // A second identical reorder writes nothing new.
    const pendingBefore = (await store.pending()).length
    await reorderListItemsInMirror(store, reordered, [ids[2]!, ids[0]!, ids[1]!])
    expect((await store.pending()).length).toBe(pendingBefore)
  })

  it("drains an offline list+items queue on reconnect", async () => {
    const store = await open()
    const listId = await createListInMirror(store, { title: "آفلاین" })
    await appendListItemsInMirror(store, listId, ["الف", "ب", "پ"], 1)
    expect((await store.pending()).length).toBe(4)

    const pushed: Array<ReadonlyArray<SyncPushEntry>> = []
    const engine = createSyncEngine(
      transport({
        push: async (entries) => {
          pushed.push(entries)
          return {
            results: entries.map((entry) => ({
              _tag: "applied" as const,
              clientMutationId: entry.clientMutationId,
              entityType: entry.entityType,
              entityId: entry.entityId,
              version: 1,
              seq: 1
            })),
            cursor: 1
          }
        }
      })
    )

    await engine.sync(store)
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toHaveLength(4)
    expect(await store.pending()).toHaveLength(0)
    // A reconnect pass with nothing queued is a harmless no-op.
    await engine.sync(store)
    expect((await store.pending()).length).toBe(0)
    expect((await store.list("listItem")).length).toBe(3)
    store.close()
  })

  it("adopts the server-stamped last writer for the updated-by label", async () => {
    const store = await open()
    const id = uuidV7()
    await store.mergeServer([
      {
        entityType: "listItem",
        entityId: id,
        version: 2,
        updatedAt: "2026-10-20T09:30:00.000Z",
        deletedAt: null,
        data: {
          listId: "list-1",
          name: "شیر",
          done: false,
          order: 1,
          lastWriterId: "user-b"
        }
      }
    ])

    const row = (await store.list("listItem")).map(toListItemRow)[0]!
    expect(row.lastWriterId).toBe("user-b")
    store.close()
  })
})
