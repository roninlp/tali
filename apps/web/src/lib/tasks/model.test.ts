import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import { uuidV7 } from "@tali/domain"
import { openLocalStore } from "../local-store/store"
import {
  COMPLETED_TASK_RETENTION_MS,
  activeFilterCount,
  buildTaskView,
  completeTaskInMirror,
  createProjectInMirror,
  createTagInMirror,
  createTaskInMirror,
  dueLabel,
  isRestorable,
  moveTaskInMirror,
  pendingTaskIds,
  recentCompletions,
  shiftLocalDate,
  toProjectRow,
  toTagRow,
  toTaskRow,
  undoTaskInMirror,
  updateTaskInMirror,
  type TaskRow
} from "./model"

/**
 * Ticket #37 client model: the mirror-first board grouping, the filter/sort
 * bar, the seven-day completion window and the local-first write helpers.
 */

const NOW = "2026-10-21T10:00:00.000Z"
const ZONE = "UTC"

const task = (overrides: Partial<TaskRow> = {}): TaskRow => ({
  id: overrides.id ?? uuidV7(),
  title: "کار",
  description: null,
  status: "todo",
  priority: "medium",
  dueDate: null,
  dueAt: null,
  timeZone: ZONE,
  projectId: null,
  tagIds: [],
  startedAt: null,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  version: 1,
  ...overrides
})

const view = (rows: ReadonlyArray<TaskRow>, filters = {}, sort = {}) =>
  buildTaskView(rows, {
    timeZone: ZONE,
    now: NOW,
    filters: {
      projectId: undefined,
      tagIds: [],
      priority: "all",
      status: "all",
      date: "all",
      ...filters
    },
    sort: { by: "dueDate", direction: "asc", ...sort }
  } as never)

const titles = (rows: ReadonlyArray<TaskRow>) => rows.map((entry) => entry.title)

describe("board grouping", () => {
  it("places every live task in exactly one bucket and hides completed ones", () => {
    const rows = [
      task({ title: "عقب", dueDate: "2026-10-20" }),
      task({ title: "امروز", dueDate: "2026-10-21" }),
      task({ title: "فردا", dueDate: "2026-10-22" }),
      task({ title: "این‌هفته", dueDate: "2026-10-25" }),
      task({ title: "بعدتر", dueDate: "2026-11-02" }),
      task({ title: "بی‌تاریخ" }),
      task({ title: "تمام", status: "done", completedAt: NOW })
    ]

    const result = view(rows)
    expect(titles(result.today.groups[0]!.tasks)).toEqual(["عقب"])
    expect(titles(result.today.groups[1]!.tasks)).toEqual(["امروز"])
    expect(titles(result.upcoming.groups[0]!.tasks)).toEqual(["فردا"])
    expect(titles(result.upcoming.groups[1]!.tasks)).toEqual(["این‌هفته"])
    expect(titles(result.upcoming.groups[2]!.tasks)).toEqual(["بعدتر"])
    expect(titles(result.inbox.groups[0]!.tasks)).toEqual(["بی‌تاریخ"])
    expect(result.counts).toEqual({ today: 2, upcoming: 3, inbox: 1 })
    expect(result.total).toBe(6)
    expect(result.visible.some((entry) => entry.title === "تمام")).toBe(false)
  })

  it("uses the viewer's zone at a day boundary (Tehran, not UTC)", () => {
    // 22:30 UTC on the 21st is already the 22nd in Tehran (UTC+3:30).
    const rows = [task({ title: "تهران فردا", dueDate: "2026-10-22" })]
    const tehran = buildTaskView(rows, {
      timeZone: "Asia/Tehran",
      now: "2026-10-21T22:30:00.000Z",
      filters: {
        projectId: undefined,
        tagIds: [],
        priority: "all",
        status: "all",
        date: "all"
      },
      sort: { by: "dueDate", direction: "asc" }
    })
    expect(titles(tehran.today.groups[1]!.tasks)).toEqual(["تهران فردا"])
    expect(tehran.upcoming.count).toBe(0)
  })

  it("sorts the default view by due date, then priority", () => {
    const rows = [
      task({ title: "کم", dueDate: "2026-10-21", priority: "low" }),
      task({ title: "زیاد", dueDate: "2026-10-21", priority: "high" })
    ]
    expect(titles(view(rows).today.groups[1]!.tasks)).toEqual(["زیاد", "کم"])
  })
})

describe("filters", () => {
  const projectA = "11111111-1111-7111-8111-111111111111"
  const projectB = "22222222-2222-7222-8222-222222222222"
  const tagA = "33333333-3333-7333-8333-333333333333"
  const tagB = "44444444-4444-7444-8444-444444444444"
  const rows = [
    task({ title: "الف", dueDate: "2026-10-21", projectId: projectA, tagIds: [tagA], priority: "high" }),
    task({ title: "ب", dueDate: "2026-10-22", projectId: projectB, tagIds: [tagA, tagB], status: "doing" }),
    task({ title: "ج", dueDate: "2026-10-27", projectId: null }),
    task({ title: "د" })
  ]

  it("filters by project, including the no-project inbox", () => {
    expect(titles(view(rows, { projectId: projectA }).visible)).toEqual(["الف"])
    expect(titles(view(rows, { projectId: projectB }).visible)).toEqual(["ب"])
    expect(titles(view(rows, { projectId: null }).visible)).toEqual(["ج", "د"])
  })

  it("matches any selected tag (OR), the service's semantics", () => {
    expect(titles(view(rows, { tagIds: [tagA] }).visible)).toEqual(["الف", "ب"])
    expect(titles(view(rows, { tagIds: [tagB] }).visible)).toEqual(["ب"])
  })

  it("filters by priority, status and date preset", () => {
    expect(titles(view(rows, { priority: "high" }).visible)).toEqual(["الف"])
    expect(titles(view(rows, { status: "doing" }).visible)).toEqual(["ب"])
    expect(titles(view(rows, { date: "overdue" }).visible)).toEqual([])
    expect(titles(view(rows, { date: "tomorrow" }).visible)).toEqual(["ب"])
    expect(titles(view(rows, { date: "none" }).visible)).toEqual(["د"])
    expect(titles(view(rows, { date: "week" }).visible)).toEqual(["ج"])
  })

  it("counts active filters for the persistent bar", () => {
    expect(activeFilterCount({ projectId: undefined, tagIds: [], priority: "all", status: "all", date: "all" })).toBe(0)
    expect(activeFilterCount({ projectId: null, tagIds: [tagA], priority: "high", status: "doing", date: "today" })).toBe(5)
  })
})

describe("sorting", () => {
  const rows = [
    task({ title: "ب", dueDate: "2026-10-22", priority: "low", status: "todo" }),
    task({ title: "الف", dueDate: "2026-10-21", priority: "high", status: "doing" }),
    task({ title: "ج", dueDate: null, priority: "medium", status: "todo" })
  ]

  it("sorts by title and flips direction", () => {
    const sameDay = rows.map((row) => ({ ...row, dueDate: "2026-10-21" }))
    const group = (sort: { by: "title"; direction: "asc" | "desc" }) =>
      view(sameDay, {}, sort).today.groups[1]!.tasks
    expect(titles(group({ by: "title", direction: "asc" }))).toEqual(["الف", "ب", "ج"])
    expect(titles(group({ by: "title", direction: "desc" }))).toEqual(["ج", "ب", "الف"])
  })

  it("sorts high priority first, and overdue days oldest-first", () => {
    const sameDay = rows.map((row) => ({ ...row, dueDate: "2026-10-21" }))
    expect(
      titles(view(sameDay, {}, { by: "priority", direction: "asc" }).today.groups[1]!.tasks)
    ).toEqual(["الف", "ج", "ب"])
    const overdue = [
      task({ title: "دیروز", dueDate: "2026-10-20" }),
      task({ title: "پریروز", dueDate: "2026-10-19" })
    ]
    expect(titles(view(overdue).today.groups[0]!.tasks)).toEqual(["پریروز", "دیروز"])
  })

  it("labels overdue calmly and localizes the due chip", () => {
    const bounds = view([]).bounds
    expect(dueLabel(task({ dueDate: "2026-10-20" }), bounds, "persian")).toMatch(/^عقب‌افتاده · /)
    expect(dueLabel(task({ dueDate: "2026-10-21" }), bounds, "persian")).toBe("امروز")
    expect(dueLabel(task(), bounds, "persian")).toBe("بدون تاریخ")
  })
})

describe("completion history", () => {
  it("keeps seven days of completions, newest first, and rejects older ones", () => {
    const now = "2026-10-21T10:00:00.000Z"
    const fresh = task({ title: "تازه", status: "done", completedAt: "2026-10-20T10:00:00.000Z" })
    const older = task({
      title: "قدیمی",
      status: "done",
      completedAt: new Date(Date.parse(now) - COMPLETED_TASK_RETENTION_MS - 1000).toISOString()
    })
    const live = task({ title: "باز" })
    expect(titles(recentCompletions([fresh, older, live], now))).toEqual(["تازه"])
    expect(isRestorable(older.completedAt, now)).toBe(false)
    expect(isRestorable(fresh.completedAt, now)).toBe(true)
  })
})

describe("local-first writes", () => {
  const newStore = () => openLocalStore(uuidV7())

  it("quick-add commits the mirror row and the outbox entry together", async () => {
    const store = await newStore()
    try {
      const id = await createTaskInMirror(
        store,
        {
          title: "  خرید شیر  ",
          dueDate: "2026-10-22",
          priority: "high",
          projectId: null,
          tagIds: [],
          timeZone: ZONE
        },
        NOW
      )
      const record = await store.get("task", id)
      expect(record?.data).toMatchObject({
        title: "خرید شیر",
        type: "task",
        status: "todo",
        priority: "high",
        dueDate: "2026-10-22",
        timeZone: ZONE,
        visibility: "shared"
      })
      const pending = await store.pending()
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        entityType: "task",
        entityId: id,
        op: "upsert",
        patch: { title: "خرید شیر", priority: "high", dueDate: "2026-10-22" }
      })
      expect(pendingTaskIds(pending).has(id)).toBe(true)

      const row = toTaskRow(record!)
      expect(row.title).toBe("خرید شیر")
      expect(row.dueDate).toBe("2026-10-22")
    } finally {
      store.close()
    }
  })

  it("patches only the submitted fields", async () => {
    const store = await newStore()
    try {
      const id = await createTaskInMirror(
        store,
        { title: "نان", dueDate: null, priority: "medium", projectId: null, tagIds: [], timeZone: ZONE },
        NOW
      )
      await updateTaskInMirror(store, id, { description: "سنگک", tagIds: ["33333333-3333-7333-8333-333333333333"] }, NOW)
      const record = await store.get("task", id)
      expect(record?.data).toMatchObject({
        title: "نان",
        description: "سنگک",
        tagIds: ["33333333-3333-7333-8333-333333333333"]
      })
    } finally {
      store.close()
    }
  })

  it("completes locally with a timestamp and undoes to the prior status", async () => {
    const store = await newStore()
    try {
      const id = await createTaskInMirror(
        store,
        { title: "نان", dueDate: null, priority: "medium", projectId: null, tagIds: [], timeZone: ZONE },
        NOW
      )
      await completeTaskInMirror(store, id, NOW)
      let row = toTaskRow((await store.get("task", id))!)
      expect(row.status).toBe("done")
      expect(row.completedAt).toBe(NOW)

      await undoTaskInMirror(store, row, NOW)
      row = toTaskRow((await store.get("task", id))!)
      expect(row.status).toBe("todo")
      expect(row.completedAt).toBeNull()

      // A task that had been started returns to `doing`, matching #36. The
      // local doing patch stamps `startedAt` so this works before the ack.
      await updateTaskInMirror(store, id, { status: "doing" }, NOW)
      row = toTaskRow((await store.get("task", id))!)
      expect(row.startedAt).toBe(NOW)
      await completeTaskInMirror(store, id, NOW)
      await undoTaskInMirror(store, row, NOW)
      row = toTaskRow((await store.get("task", id))!)
      expect(row.status).toBe("doing")
    } finally {
      store.close()
    }
  })

  it("moves a task between days and back into the inbox", async () => {
    const store = await newStore()
    try {
      const id = await createTaskInMirror(
        store,
        { title: "نان", dueDate: "2026-10-21", priority: "medium", projectId: null, tagIds: [], timeZone: ZONE },
        NOW
      )
      await moveTaskInMirror(store, id, "2026-10-22", ZONE, NOW)
      expect(toTaskRow((await store.get("task", id))!).dueDate).toBe("2026-10-22")

      await moveTaskInMirror(store, id, null, ZONE, NOW)
      const row = toTaskRow((await store.get("task", id))!)
      expect(row.dueDate).toBeNull()
      expect(row.dueAt).toBeNull()
    } finally {
      store.close()
    }
  })

  it("creates projects and tags in the same local-first path", async () => {
    const store = await newStore()
    try {
      const projectId = await createProjectInMirror(store, "خانه", "#2f5fe0", NOW)
      const tagId = await createTagInMirror(store, "فوری", null, NOW)
      const project = toProjectRow((await store.get("project", projectId))!)
      const tag = toTagRow((await store.get("tag", tagId))!)
      expect(project.title).toBe("خانه")
      expect(tag.name).toBe("فوری")
      expect(await store.pendingCount()).toBe(2)
    } finally {
      store.close()
    }
  })

  it("shifts wall dates across a month boundary", () => {
    expect(shiftLocalDate("2026-10-21", 7)).toBe("2026-10-28")
    expect(shiftLocalDate("2026-03-20", 1)).toBe("2026-03-21")
  })
})
