import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  uuidV7,
  type HouseholdId,
  type TaskId,
  type UserId
} from "@tali/domain"
import {
  SyncService,
  SyncServiceLive
} from "../src/sync-service.js"
import {
  TaskService,
  TaskServiceLive,
  type TaskServiceApi,
  type TaskViewer
} from "../src/task-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #36, at the service seam. These run the real service + repository +
 * sync-primitive SQL against SQLite (D1's engine), through a D1-shaped batch so
 * atomicity, `changes()` gating and `last_insert_rowid()` behave like
 * production.
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)

const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort()

const USER_A = "user-a" as UserId
const USER_B = "user-b" as UserId
const HOUSEHOLD = "household-a" as HouseholdId
const OTHER_HOUSEHOLD = "household-b" as HouseholdId
const TZ = "Asia/Tehran"
const NOW = "2026-10-20T09:30:00.000Z"

const viewer = (overrides: Partial<TaskViewer> = {}): TaskViewer => ({
  userId: USER_A,
  householdId: HOUSEHOLD,
  timeZone: TZ,
  ...overrides
})

const makeHarness = () => {
  const db = new DatabaseSync(":memory:")
  for (const file of migrationFiles()) {
    db.exec(readFileSync(fileURLToPath(new URL(file, MIGRATIONS_DIR)), "utf8"))
  }

  const fake = new FakeD1(db)
  const d1 = D1Client.layer({
    db: fake.asD1Database(),
    transformQueryNames: Str.camelToSnake,
    transformResultNames: Str.snakeToCamel
  })
  const layer = Layer.mergeAll(TaskServiceLive, SyncServiceLive).pipe(Layer.provide(d1))

  const run = <A, E>(effect: Effect.Effect<A, E, TaskService | SyncService>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, layer))

  const svc = <A, E>(
    f: (service: TaskServiceApi) => Effect.Effect<A, E, never>
  ): Promise<A> =>
    run(
      Effect.gen(function*() {
        const service = yield* TaskService
        return yield* f(service)
      })
    )

  const sync = <A, E>(
    f: (service: SyncService) => Effect.Effect<A, E, never>
  ): Promise<A> =>
    run(
      Effect.gen(function*() {
        const service = yield* SyncService
        return yield* f(service)
      })
    )

  const feedCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM change_feed").get() as { readonly n: number }).n

  return { db, fake, run, svc, sync, feedCount }
}

describe("TaskService round-trip", () => {
  it("create → filter → move → complete → undo", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId

    const created = await h.svc((svc) =>
      svc.create(viewer(), { clientMutationId: "m-create", id, title: "خرید نان" }, NOW)
    )
    expect(created).toMatchObject({
      id,
      title: "خرید نان",
      status: "todo",
      priority: "medium",
      dueAt: null,
      dueDate: null,
      timeZone: TZ,
      version: 1
    })

    const project = await h.svc((svc) =>
      svc.createProject(
        viewer(),
        { clientMutationId: "m-project", title: "خانه" },
        NOW
      )
    )
    const tag = await h.svc((svc) =>
      svc.createTag(viewer(), { clientMutationId: "m-tag", name: "فوری" }, NOW)
    )

    const organised = await h.svc((svc) =>
      svc.update(
        viewer(),
        {
          id,
          clientMutationId: "m-organise",
          patch: {
            description: "نان سنگک",
            priority: "high",
            projectId: project.id,
            tagIds: [tag.id]
          }
        },
        NOW
      )
    )
    expect(organised).toMatchObject({
      description: "نان سنگک",
      priority: "high",
      projectId: project.id,
      tagIds: [tag.id],
      version: 2
    })

    // Filter by project, tag, priority and status; stable due/id ordering.
    const filtered = await h.svc((svc) =>
      svc.list(
        viewer(),
        {
          filter: {
            projectId: project.id,
            tagIds: [tag.id],
            priority: "high",
            status: "todo"
          }
        },
        NOW
      )
    )
    expect(filtered.map((task) => task.id)).toEqual([id])

    const moved = await h.svc((svc) =>
      svc.move(viewer(), { id, clientMutationId: "m-move", dueDate: "2026-10-21" }, NOW)
    )
    expect(moved).toMatchObject({ dueAt: null, dueDate: "2026-10-21", version: 3 })

    const started = await h.svc((svc) =>
      svc.start(viewer(), { id, clientMutationId: "m-start" }, NOW)
    )
    expect(started.status).toBe("doing")
    expect(started.startedAt).toBe(NOW)
    expect(started.version).toBe(4)

    const completed = await h.svc((svc) =>
      svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW)
    )
    expect(completed.status).toBe("done")
    expect(completed.completedAt).toBe(NOW)
    expect(completed.dueDate).toBe("2026-10-21")
    expect(completed.version).toBe(5)

    const undone = await h.svc((svc) =>
      svc.undo(viewer(), { id, clientMutationId: "m-undo" }, NOW)
    )
    // The prior state was `doing` because startedAt is set; the original due
    // date was never moved by completion.
    expect(undone.status).toBe("doing")
    expect(undone.completedAt).toBeNull()
    expect(undone.dueDate).toBe("2026-10-21")
    expect(undone.version).toBe(6)

    // Every row lives in tags' canonical join, not just the denormalized array.
    const joinRows = h.db
      .prepare("SELECT tag_id AS tagId FROM item_tags WHERE item_id = ? AND item_type = 'task'")
      .all(id) as ReadonlyArray<{ readonly tagId: string }>
    expect(joinRows.map((row) => row.tagId)).toEqual([tag.id])
  })

  it("rejects a duplicate live tag name as a typed validation error", async () => {
    const h = makeHarness()
    await h.svc((svc) =>
      svc.createTag(viewer(), { clientMutationId: "m-tag-a", name: "خانه" }, NOW)
    )
    const duplicate = await h
      .svc((svc) =>
        svc.createTag(viewer(), { clientMutationId: "m-tag-b", name: "خانه" }, NOW)
      )
      .catch((cause: unknown) => cause)
    expect(duplicate).toMatchObject({ _tag: "TaskValidationError" })
  })

  it("sorts stably and filters by date, and renames projects and tags", async () => {
    const h = makeHarness()
    const low = uuidV7() as TaskId
    const high = uuidV7() as TaskId
    const later = uuidV7() as TaskId

    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-low",
          id: low,
          title: "کم",
          priority: "low",
          dueDate: "2026-10-20"
        },
        NOW
      )
    )
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-high",
          id: high,
          title: "زیاد",
          priority: "high",
          dueDate: "2026-10-20"
        },
        NOW
      )
    )
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-later",
          id: later,
          title: "بعدتر",
          priority: "medium",
          dueDate: "2026-10-25"
        },
        NOW
      )
    )

    const sorted = await h.svc((svc) =>
      svc.list(viewer(), { sort: { by: "priority", direction: "asc" } }, NOW)
    )
    expect(sorted.map((task) => task.id)).toEqual([high, later, low])

    const dated = await h.svc((svc) =>
      svc.list(viewer(), { filter: { dueFrom: "2026-10-20", dueBefore: "2026-10-25" } }, NOW)
    )
    expect(dated.map((task) => task.id).sort()).toEqual([low, high].sort())

    const project = await h.svc((svc) =>
      svc.createProject(viewer(), { clientMutationId: "m-p", title: "کار" }, NOW)
    )
    const renamedProject = await h.svc((svc) =>
      svc.renameProject(
        viewer(),
        { id: project.id, clientMutationId: "m-p-rename", title: "کار خانه" },
        NOW
      )
    )
    expect(renamedProject.title).toBe("کار خانه")

    const tag = await h.svc((svc) =>
      svc.createTag(viewer(), { clientMutationId: "m-t", name: "خانه" }, NOW)
    )
    const renamedTag = await h.svc((svc) =>
      svc.renameTag(
        viewer(),
        { id: tag.id, clientMutationId: "m-t-rename", name: "خانه‌داری" },
        NOW
      )
    )
    expect(renamedTag.name).toBe("خانه‌داری")

    const projects = await h.svc((svc) => svc.listProjects(viewer()))
    const tags = await h.svc((svc) => svc.listTags(viewer()))
    expect(projects.map((row) => row.title)).toContain("کار خانه")
    expect(tags.map((row) => row.name)).toContain("خانه‌داری")
  })

  it("complete is idempotent and writes no version/feed", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(viewer(), { clientMutationId: "m-create", id, title: "یک‌بار" }, NOW)
    )
    const done = await h.svc((svc) =>
      svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW)
    )
    const feedAfterFirst = h.feedCount()

    const again = await h.svc((svc) =>
      svc.complete(viewer(), { id, clientMutationId: "m-complete-again" }, NOW)
    )
    expect(again.version).toBe(done.version)
    expect(again.completedAt).toBe(done.completedAt)
    expect(h.feedCount()).toBe(feedAfterFirst)
  })

  it("undo restores a task completed directly from todo", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "بدون شروع",
          dueDate: "2026-10-20"
        },
        NOW
      )
    )
    await h.svc((svc) => svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW))
    const undone = await h.svc((svc) =>
      svc.undo(viewer(), { id, clientMutationId: "m-undo" }, NOW)
    )
    expect(undone.status).toBe("todo")
    expect(undone.startedAt).toBeNull()
    expect(undone.dueDate).toBe("2026-10-20")
  })

  it("keeps a completed task restorable through day 7 and archives it after", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(viewer(), { clientMutationId: "m-create", id, title: "بایگانی" }, NOW)
    )
    await h.svc((svc) => svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW))

    const exactlySevenDays = new Date(Date.parse(NOW) + 7 * 24 * 60 * 60 * 1000).toISOString()
    const afterSevenDays = new Date(Date.parse(exactlySevenDays) + 1).toISOString()

    // Retained at the inclusive boundary: still listed as done and undoable.
    const visible = await h.svc((svc) =>
      svc.list(viewer(), { filter: { status: "done" } }, exactlySevenDays)
    )
    expect(visible.map((task) => task.id)).toContain(id)

    const archived = await h.svc((svc) =>
      svc.list(viewer(), { filter: { status: "done" } }, afterSevenDays)
    )
    expect(archived.map((task) => task.id)).not.toContain(id)

    // `includeArchived` exposes it for a history view without resurrecting it.
    const history = await h.svc((svc) =>
      svc.list(
        viewer(),
        { filter: { status: "done", includeArchived: true } },
        afterSevenDays
      )
    )
    expect(history.map((task) => task.id)).toContain(id)

    const error = await h
      .svc((svc) => svc.undo(viewer(), { id, clientMutationId: "m-undo-late" }, afterSevenDays))
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({ _tag: "TaskNotRestorable", id })
  })

  it("retries a lost version CAS without dropping the patch or its tag joins", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    const firstTag = await h.svc((svc) =>
      svc.createTag(viewer(), { clientMutationId: "m-tag-1", name: "اول" }, NOW)
    )
    const secondTag = await h.svc((svc) =>
      svc.createTag(viewer(), { clientMutationId: "m-tag-2", name: "دوم" }, NOW)
    )
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "قبل",
          tagIds: [firstTag.id]
        },
        NOW
      )
    )

    // Another writer commits between the service's read and its batch.
    h.fake.beforeBatch = () => {
      h.fake.beforeBatch = undefined
      h.db
        .prepare("UPDATE tasks SET version = version + 1, title = ?, updated_at = ? WHERE id = ?")
        .run("نوشته‌ی همسر", NOW, id)
    }

    const updated = await h.svc((svc) =>
      svc.update(
        viewer(),
        {
          id,
          clientMutationId: "m-update",
          patch: { title: "از من", tagIds: [secondTag.id] }
        },
        NOW
      )
    )
    expect(updated.title).toBe("از من")
    expect(updated.tagIds).toEqual([secondTag.id])
    expect(updated.version).toBe(3)

    // The failed CAS appended no feed row; the retry appended exactly one.
    expect(h.feedCount()).toBe(4)
    const joined = h.db
      .prepare("SELECT tag_id AS tagId FROM item_tags WHERE item_id = ? AND item_type = 'task'")
      .all(id) as ReadonlyArray<{ readonly tagId: string }>
    expect(joined.map((row) => row.tagId)).toEqual([secondTag.id])
  })

  it("replays a mutation id exactly once", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    const input = { clientMutationId: "m-replay", id, title: "یک‌بار" }
    await h.svc((svc) => svc.create(viewer(), input, NOW))
    const feedAfterFirst = h.feedCount()
    const replay = await h.svc((svc) => svc.create(viewer(), input, NOW))
    expect(replay.id).toBe(id)
    expect(replay.version).toBe(1)
    expect(h.feedCount()).toBe(feedAfterFirst)
  })

  it("never hands another member's private task back through the replay guard", async () => {
    const h = makeHarness()
    const privateId = uuidV7() as TaskId
    const mutationId = "m-private-create"
    await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: mutationId, id: privateId, title: "top secret", visibility: "private" },
        NOW
      )
    )

    // The owner's replay still works.
    const own = await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: mutationId, id: privateId, title: "top secret", visibility: "private" },
        NOW
      )
    )
    expect(own.id).toBe(privateId)

    // A spouse who reuses the id against the private row gets the normal
    // visibility error, not the row.
    const byId = await h
      .svc((svc) =>
        svc.update(
          viewer({ userId: USER_B }),
          { id: privateId, clientMutationId: mutationId, patch: { title: "نفوذ" } },
          NOW
        )
      )
      .catch((cause: unknown) => cause)
    expect(byId).toMatchObject({ _tag: "TaskForbidden", reason: "private" })

    // Reusing the id for a *different* row is rejected, not silently replayed.
    const otherId = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(viewer({ userId: USER_B }), { clientMutationId: "m-b", id: otherId, title: "b" }, NOW)
    )
    const mismatched = await h
      .svc((svc) =>
        svc.complete(viewer({ userId: USER_B }), { id: otherId, clientMutationId: mutationId }, NOW)
      )
      .catch((cause: unknown) => cause)
    expect(mismatched).toMatchObject({ _tag: "TaskValidationError" })
  })

  it("rejects a mutation id already spent on another aggregate without writing", async () => {
    const h = makeHarness()
    const mutationId = "m-one-key"
    const project = await h.svc((svc) =>
      svc.createProject(viewer(), { clientMutationId: mutationId, title: "خانه" }, NOW)
    )
    const feedAfterProject = h.feedCount()

    const rejected = await h
      .svc((svc) => svc.create(viewer(), { clientMutationId: mutationId, title: "وظیفه" }, NOW))
      .catch((cause: unknown) => cause)
    expect(rejected).toMatchObject({ _tag: "TaskValidationError" })
    expect(h.feedCount()).toBe(feedAfterProject)
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toMatchObject({ n: 0 })

    // The original mutation still replays.
    const replay = await h.svc((svc) =>
      svc.createProject(viewer(), { clientMutationId: mutationId, title: "خانه" }, NOW)
    )
    expect(replay.id).toBe(project.id)
    expect(h.feedCount()).toBe(feedAfterProject)
  })

  it("refuses private tasks of another member and foreign households", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-private", id, title: "خصوصی", visibility: "private" },
        NOW
      )
    )

    const privateRead = await h
      .svc((svc) => svc.get(viewer({ userId: USER_B }), id))
      .catch((cause: unknown) => cause)
    expect(privateRead).toMatchObject({ _tag: "TaskForbidden", reason: "private" })

    const foreignUpdate = await h
      .svc((svc) =>
        svc.update(
          viewer({ householdId: OTHER_HOUSEHOLD }),
          { id, clientMutationId: "m-foreign", patch: { title: "نفوذ" } },
          NOW
        )
      )
      .catch((cause: unknown) => cause)
    expect(foreignUpdate).toMatchObject({ _tag: "TaskForbidden", reason: "household" })

    const missing = await h
      .svc((svc) => svc.get(viewer(), uuidV7() as TaskId))
      .catch((cause: unknown) => cause)
    expect(missing).toMatchObject({ _tag: "TaskNotFound" })
  })

  it("rejects invalid transitions and both due shapes", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(viewer(), { clientMutationId: "m-create", id, title: "وضعیت" }, NOW)
    )
    await h.svc((svc) => svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW))
    const reopen = await h
      .svc((svc) =>
        svc.update(
          viewer(),
          { id, clientMutationId: "m-reopen", patch: { status: "doing" } },
          NOW
        )
      )
      .catch((cause: unknown) => cause)
    expect(reopen).toMatchObject({ _tag: "TaskInvalidTransition", from: "done", to: "doing" })

    const both = await h
      .svc((svc) =>
        svc.create(
          viewer(),
          {
            clientMutationId: "m-both",
            title: "دو موعد",
            dueDate: "2026-10-20",
            dueAt: "2026-10-20T10:00:00.000Z"
          },
          NOW
        )
      )
      .catch((cause: unknown) => cause)
    expect(both).toMatchObject({ _tag: "TaskValidationError" })
  })
})

describe("TaskService buckets", () => {
  it("uses the viewer's zone and never puts no-date tasks in Today", async () => {
    const h = makeHarness()
    const today = uuidV7() as TaskId
    const tomorrow = uuidV7() as TaskId
    const noDate = uuidV7() as TaskId
    const timedToday = uuidV7() as TaskId

    await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-today", id: today, title: "امروز", dueDate: "2026-10-20" },
        NOW
      )
    )
    await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-tomorrow", id: tomorrow, title: "فردا", dueDate: "2026-10-21" },
        NOW
      )
    )
    await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-none", id: noDate, title: "بی‌موعد" },
        NOW
      )
    )
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-timed",
          id: timedToday,
          title: "ساعت‌دار",
          // 2026-10-20 12:00 in Tehran (UTC+03:30) = 08:30Z.
          dueAt: "2026-10-20T08:30:00.000Z"
        },
        NOW
      )
    )

    const buckets = await h.svc((svc) => svc.buckets(viewer(), NOW))
    expect(buckets.today).toBe("2026-10-20")
    expect(buckets.todayTasks.map((task) => task.id).sort()).toEqual(
      [today, timedToday].sort()
    )
    expect(buckets.tomorrowTasks.map((task) => task.id)).toEqual([tomorrow])
    expect(buckets.noDate.map((task) => task.id)).toEqual([noDate])
    expect(buckets.todayTasks.map((task) => task.id)).not.toContain(noDate)

    // The bucket filter agrees with the bucket view.
    const filtered = await h.svc((svc) =>
      svc.list(viewer(), { filter: { bucket: "today" } }, NOW)
    )
    expect(filtered.map((task) => task.id).sort()).toEqual([today, timedToday].sort())
  })

  it("keeps completed tasks out of a bucket filter until a status is asked for", async () => {
    const h = makeHarness()
    const active = uuidV7() as TaskId
    const finished = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(viewer(), { clientMutationId: "m-active", id: active, title: "باز", dueDate: "2026-10-20" }, NOW)
    )
    await h.svc((svc) =>
      svc.create(viewer(), { clientMutationId: "m-finished", id: finished, title: "تمام", dueDate: "2026-10-20" }, NOW)
    )
    await h.svc((svc) => svc.complete(viewer(), { id: finished, clientMutationId: "m-done" }, NOW))

    // Same answer as `buckets()`: active work only.
    const todayBucket = await h.svc((svc) =>
      svc.list(viewer(), { filter: { bucket: "today" } }, NOW)
    )
    expect(todayBucket.map((task) => task.id)).toEqual([active])
    const view = await h.svc((svc) => svc.buckets(viewer(), NOW))
    expect(view.todayTasks.map((task) => task.id)).toEqual([active])

    // An explicit status still asks the question directly (e.g. history).
    const doneToday = await h.svc((svc) =>
      svc.list(viewer(), { filter: { bucket: "today", status: "done" } }, NOW)
    )
    expect(doneToday.map((task) => task.id)).toEqual([finished])
  })
})

describe("TaskService write path and sync", () => {
  it("makes every mutation visible through /sync/pull with a bumped version", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId

    await h.svc((svc) =>
      svc.create(viewer(), { clientMutationId: "m-create", id, title: "اول" }, NOW)
    )
    await h.svc((svc) =>
      svc.update(
        viewer(),
        { id, clientMutationId: "m-update", patch: { title: "دوم" } },
        NOW
      )
    )
    await h.svc((svc) =>
      svc.move(viewer(), { id, clientMutationId: "m-move", dueDate: "2026-10-22" }, NOW)
    )
    await h.svc((svc) => svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW))
    await h.svc((svc) => svc.undo(viewer(), { id, clientMutationId: "m-undo" }, NOW))

    const page = await h.sync((sync) =>
      sync.pull({ userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    )
    const item = page.items.find((row) => row.entityId === id)
    expect(item?.version).toBe(5)
    expect(item?.data).toMatchObject({
      title: "دوم",
      status: "todo",
      dueDate: "2026-10-22"
    })
    expect(h.feedCount()).toBe(5)
    expect(page.entries.filter((entry) => entry.entityId === id)).toHaveLength(5)
  })
})
