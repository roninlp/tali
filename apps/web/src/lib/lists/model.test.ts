import { describe, expect, it } from "vitest"
import type { MirrorRecord } from "../local-store"
import {
  buildListItemsView,
  droppedOrder,
  movedOrder,
  nextItemOrder,
  orderPatch,
  pendingItemIds,
  pendingListIds,
  summarizeList,
  toListItemRow,
  toListRow,
  writtenByOther,
  type ListItemRow,
  type ListRow
} from "./model"

const list = (overrides: Partial<ListRow> = {}): ListRow => ({
  id: "list-1",
  ownerId: "user-a",
  title: "خرید",
  description: null,
  color: null,
  icon: null,
  sort: "manual",
  checkedPlacement: "bottom",
  visibility: "shared",
  lastWriterId: "user-a",
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
  version: 1,
  ...overrides
})

const item = (
  id: string,
  name: string,
  order: number,
  done = false
): ListItemRow => ({
  id,
  listId: "list-1",
  name,
  done,
  order,
  checkedAt: done ? "2026-10-20T09:30:00.000Z" : null,
  color: null,
  tagIds: [],
  visibility: "shared",
  lastWriterId: "user-a",
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
  version: 1
})

describe("list item ordering", () => {
  const rows = [
    item("b", "شیر", 2, true),
    item("a", "نان", 1, false),
    item("c", "پنیر", 3, true),
    item("d", "سبزی", 4, false)
  ]

  it("manual order keeps done items in place when asked", () => {
    const view = buildListItemsView(list({ checkedPlacement: "inPlace" }), rows)
    expect(view.visible.map((entry) => entry.id)).toEqual(["a", "b", "c", "d"])
    expect(view.doneCount).toBe(2)
  })

  it("groups checked items at the bottom", () => {
    const view = buildListItemsView(list({ checkedPlacement: "bottom" }), rows)
    expect(view.open.map((entry) => entry.id)).toEqual(["a", "d"])
    expect(view.checked.map((entry) => entry.id)).toEqual(["b", "c"])
    expect(view.visible.map((entry) => entry.id)).toEqual(["a", "d", "b", "c"])
  })

  it("sorts alphabetically in Persian and still groups checked at the bottom", () => {
    const view = buildListItemsView(list({ sort: "alpha", checkedPlacement: "bottom" }), rows)
    expect(view.open.map((entry) => entry.name)).toEqual(["سبزی", "نان"])
    expect(view.checked.map((entry) => entry.name)).toEqual(["پنیر", "شیر"])
  })

  it("sorts by status with open items first", () => {
    const view = buildListItemsView(list({ sort: "status", checkedPlacement: "inPlace" }), rows)
    expect(view.visible.map((entry) => entry.done)).toEqual([false, false, true, true])
  })
})

describe("accessible reorder helpers", () => {
  const rows = [item("a", "یک", 1), item("b", "دو", 2), item("c", "سه", 3)]

  it("moves one slot and refuses to fall off either end", () => {
    expect(movedOrder(rows, "b", -1)).toEqual(["b", "a", "c"])
    expect(movedOrder(rows, "b", 1)).toEqual(["a", "c", "b"])
    expect(movedOrder(rows, "a", -1)).toEqual(["a", "b", "c"])
    expect(movedOrder(rows, "c", 1)).toEqual(["a", "b", "c"])
  })

  it("drops a dragged row at the target position", () => {
    expect(droppedOrder(rows, "c", "a")).toEqual(["c", "a", "b"])
    expect(droppedOrder(rows, "a", "c")).toEqual(["b", "c", "a"])
  })

  it("writes both field dialects and computes the next append order", () => {
    expect(orderPatch(2)).toEqual({ order: 3, ordering: 3, sortOrder: 3 })
    expect(nextItemOrder(rows)).toBe(4)
    expect(nextItemOrder([])).toBe(1)
  })
})

describe("index summaries and pending state", () => {
  it("counts open/checked and previews two open items", () => {
    const summary = summarizeList(list(), [
      item("a", "نان", 1),
      item("b", "شیر", 2, true),
      item("c", "پنیر", 3),
      item("d", "سبزی", 4)
    ])
    expect(summary).toMatchObject({
      total: 4,
      done: 1,
      open: 3,
      preview: ["نان", "پنیر"]
    })
  })

  it("splits pending entries by entity type", () => {
    const pending = [
      { entityType: "list", entityId: "l1" },
      { entityType: "listItem", entityId: "i1" },
      { entityType: "task", entityId: "t1" }
    ]
    expect([...pendingListIds(pending)]).toEqual(["l1"])
    expect([...pendingItemIds(pending)]).toEqual(["i1"])
  })

  it("shows the other-writer label only after a real second version", () => {
    expect(writtenByOther("user-b", "user-a", 2)).toBe(true)
    expect(writtenByOther("user-b", "user-a", 1)).toBe(false)
    expect(writtenByOther("user-b", "user-b", 2)).toBe(false)
    expect(writtenByOther(null, "user-a", 2)).toBe(false)
  })
})

describe("mirror row decoding", () => {
  const record = (data: Record<string, unknown>): MirrorRecord => ({
    entityType: "listItem",
    entityId: "i1",
    version: 3,
    updatedAt: "2026-10-20T09:40:00.000Z",
    deletedAt: null,
    data
  })

  it("prefers the real aggregate names but still reads legacy fields", () => {
    expect(
      toListItemRow(record({ listId: "l1", name: "نان", done: true, ordering: 2 }))
    ).toMatchObject({ name: "نان", done: true, order: 2 })
    expect(
      toListItemRow(record({ listId: "l1", title: "شیر", checked: false, sortOrder: 1 }))
    ).toMatchObject({ name: "شیر", done: false, order: 1 })
  })

  it("decodes list preferences and ownership", () => {
    expect(
      toListRow({
        entityType: "list",
        entityId: "l1",
        version: 2,
        updatedAt: "2026-10-20T09:40:00.000Z",
        deletedAt: null,
        data: {
          ownerId: "user-a",
          title: "خرید",
          sort: "alpha",
          checkedPlacement: "inPlace",
          visibility: "private"
        }
      })
    ).toMatchObject({
      ownerId: "user-a",
      sort: "alpha",
      checkedPlacement: "inPlace",
      visibility: "private"
    })
  })
})
