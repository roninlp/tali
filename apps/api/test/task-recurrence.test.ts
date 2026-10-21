import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  uuidV7,
  type HouseholdId,
  type RecurrenceRule,
  type TaskId,
  type UserId
} from "@tali/domain"
import { SyncService, SyncServiceLive } from "../src/sync-service.js"
import {
  TaskService,
  TaskServiceLive,
  type TaskServiceApi,
  type TaskViewer
} from "../src/task-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #38, at the service seam: a completed recurring task spawns exactly
 * one next occurrence through the same one-batch version/feed/ledger path as
 * every other task mutation, in both recurrence modes, with replay as a no-op.
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)

const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort()

const USER_A = "user-a" as UserId
const HOUSEHOLD = "household-a" as HouseholdId
const TZ = "Asia/Tehran"
const NOW = "2026-10-20T09:30:00.000Z"

const viewer = (overrides: Partial<TaskViewer> = {}): TaskViewer => ({
  userId: USER_A,
  householdId: HOUSEHOLD,
  timeZone: TZ,
  ...overrides
})

const daily = (overrides: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  frequency: "daily",
  interval: 1,
  end: { _tag: "never" },
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

  const taskCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { readonly n: number }).n

  const childCount = (parentId: string): number =>
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE recurrence_parent_id = ?")
        .get(parentId) as { readonly n: number }
    ).n

  const childrenOf = (parentId: string): ReadonlyArray<Record<string, unknown>> =>
    db
      .prepare("SELECT * FROM tasks WHERE recurrence_parent_id = ? ORDER BY created_at")
      .all(parentId) as ReadonlyArray<Record<string, unknown>>

  return { db, fake, run, svc, sync, feedCount, taskCount, childCount, childrenOf }
}

describe("recurring task completion: onDueDate", () => {
  it("spawns exactly one next instance through the feed/ledger path", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId

    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "پرداخت قبض",
          dueDate: "2026-10-20",
          recurrence: daily(),
          recurrenceMode: "onDueDate"
        },
        NOW
      )
    )
    expect(h.feedCount()).toBe(1)

    const completed = await h.svc((svc) =>
      svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW)
    )
    expect(completed).toMatchObject({
      id,
      status: "done",
      completedAt: NOW,
      dueDate: "2026-10-20",
      recurrenceMode: "onDueDate",
      version: 2
    })
    // The completed instance stays as history with its own due date and rule.
    expect(completed.recurrence).toEqual(daily())

    expect(h.taskCount()).toBe(2)
    expect(h.childCount(id)).toBe(1)
    expect(h.feedCount()).toBe(3)

    const [child] = h.childrenOf(id)
    expect(child).toMatchObject({
      title: "پرداخت قبض",
      status: "todo",
      due_date: "2026-10-21",
      due_at: null,
      time_zone: TZ,
      recurrence_mode: "onDueDate",
      started_at: null,
      completed_at: null,
      version: 1
    })
    expect(JSON.parse(child!.recurrence as string)).toEqual(daily())
    expect(child!.id).not.toBe(id)

    // Both rows are visible through /sync/pull with the right versions.
    const page = await h.sync((sync) =>
      sync.pull({ userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    )
    const parentItem = page.items.find((row) => row.entityId === id)
    expect(parentItem).toMatchObject({ version: 2 })
    expect(parentItem?.data).toMatchObject({
      status: "done",
      dueDate: "2026-10-20",
      recurrenceMode: "onDueDate"
    })
    const childItem = page.items.find((row) => row.entityId === child!.id)
    expect(childItem).toMatchObject({ version: 1 })
    expect(childItem?.data).toMatchObject({
      status: "todo",
      dueDate: "2026-10-21",
      recurrence: daily()
    })
    expect(page.entries.filter((entry) => entry.entityId === id)).toHaveLength(2)
    expect(page.entries.filter((entry) => entry.entityId === child!.id)).toHaveLength(1)
  })

  it("copies project and tags to the next instance and keeps the join table canonical", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    const project = await h.svc((svc) =>
      svc.createProject(viewer(), { clientMutationId: "m-project", title: "خانه" }, NOW)
    )
    const tag = await h.svc((svc) =>
      svc.createTag(viewer(), { clientMutationId: "m-tag", name: "ماهانه" }, NOW)
    )
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "اجاره",
          dueDate: "2026-10-20",
          projectId: project.id,
          tagIds: [tag.id],
          recurrence: daily({ frequency: "monthly", byMonthDay: [20] }),
          recurrenceMode: "onDueDate"
        },
        NOW
      )
    )

    await h.svc((svc) => svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW))
    const [child] = h.childrenOf(id)
    // Monthly rules are Jalali: the 20th of the next Jalali month (1405/08/20)
    // is 2026-11-11, not the 20th of the next Gregorian month.
    expect(child).toMatchObject({
      project_id: project.id,
      due_date: "2026-11-11"
    })
    const joined = h.db
      .prepare("SELECT tag_id AS tagId FROM item_tags WHERE item_id = ? AND item_type = 'task'")
      .all(child!.id) as ReadonlyArray<{ readonly tagId: string }>
    expect(joined.map((row) => row.tagId)).toEqual([tag.id])
  })

  it("advances the schedule from a moved due date without losing the rule", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "آبیاری",
          dueDate: "2026-10-20",
          recurrence: daily({ interval: 2 }),
          recurrenceMode: "onDueDate"
        },
        NOW
      )
    )

    const moved = await h.svc((svc) =>
      svc.move(viewer(), { id, clientMutationId: "m-move", dueDate: "2026-10-22" }, NOW)
    )
    expect(moved.recurrence).toEqual(daily({ interval: 2 }))
    expect(moved.dueDate).toBe("2026-10-22")

    await h.svc((svc) => svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW))
    const [child] = h.childrenOf(id)
    expect(child).toMatchObject({ due_date: "2026-10-24" })
  })

  it("spawns one successor when done arrives through update({ status })", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "از مسیر ویرایش",
          dueDate: "2026-10-20",
          recurrence: daily(),
          recurrenceMode: "onDueDate"
        },
        NOW
      )
    )
    const updated = await h.svc((svc) =>
      svc.update(
        viewer(),
        { id, clientMutationId: "m-update", patch: { status: "done" } },
        NOW
      )
    )
    expect(updated).toMatchObject({ status: "done", completedAt: NOW, version: 2 })
    expect(h.childCount(id)).toBe(1)
    const [child] = h.childrenOf(id)
    expect(child).toMatchObject({ due_date: "2026-10-21", status: "todo" })
  })

  it("keeps a timed task's local wall time across a DST transition", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(
        viewer({ timeZone: "America/New_York" }),
        {
          clientMutationId: "m-create",
          id,
          title: "قرص صبح",
          timeZone: "America/New_York",
          dueAt: "2026-03-07T14:00:00.000Z",
          recurrence: daily(),
          recurrenceMode: "onDueDate"
        },
        "2026-03-07T15:00:00.000Z"
      )
    )

    await h.svc((svc) =>
      svc.complete(
        viewer({ timeZone: "America/New_York" }),
        { id, clientMutationId: "m-complete" },
        "2026-03-07T15:00:00.000Z"
      )
    )
    const [child] = h.childrenOf(id)
    // 09:00 local on both sides of spring-forward: EST 14:00Z → EDT 13:00Z.
    expect(child).toMatchObject({
      due_at: "2026-03-08T13:00:00.000Z",
      due_date: null
    })
  })
})

describe("recurring task completion: onCompletion", () => {
  it("restarts the interval from the completion day", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "گیاهان",
          dueDate: "2026-10-10",
          recurrence: daily({ interval: 3 }),
          recurrenceMode: "onCompletion"
        },
        NOW
      )
    )

    await h.svc((svc) => svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW))
    const [child] = h.childrenOf(id)
    expect(child).toMatchObject({
      due_date: "2026-10-23",
      recurrence_mode: "onCompletion"
    })
  })

  it("uses the item time zone for the completion day", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "تمرین",
          recurrence: daily(),
          recurrenceMode: "onCompletion"
        },
        NOW
      )
    )
    // 21:00Z is already Oct 21 in Tehran.
    await h.svc((svc) =>
      svc.complete(viewer(), { id, clientMutationId: "m-complete" }, "2026-10-20T21:00:00.000Z")
    )
    const [child] = h.childrenOf(id)
    expect(child).toMatchObject({ due_date: "2026-10-22" })
  })
})

describe("exactly-once spawn", () => {
  it("replaying the same completion is a no-op", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "یک‌بار",
          dueDate: "2026-10-20",
          recurrence: daily(),
          recurrenceMode: "onDueDate"
        },
        NOW
      )
    )
    const done = await h.svc((svc) =>
      svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW)
    )
    const feedAfter = h.feedCount()
    const childAfter = h.childCount(id)

    const replay = await h.svc((svc) =>
      svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW)
    )
    expect(replay.version).toBe(done.version)
    expect(replay.completedAt).toBe(done.completedAt)
    expect(h.feedCount()).toBe(feedAfter)
    expect(h.childCount(id)).toBe(childAfter)
    expect(h.taskCount()).toBe(2)
  })

  it("a second completion with a different mutation id writes nothing new", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "دو بار",
          dueDate: "2026-10-20",
          recurrence: daily(),
          recurrenceMode: "onDueDate"
        },
        NOW
      )
    )
    await h.svc((svc) => svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW))
    const feedAfter = h.feedCount()

    await h.svc((svc) =>
      svc.complete(viewer(), { id, clientMutationId: "m-complete-again" }, NOW)
    )
    expect(h.feedCount()).toBe(feedAfter)
    expect(h.childCount(id)).toBe(1)
  })

  it("undo + re-complete never creates a second successor", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "بازگشت",
          dueDate: "2026-10-20",
          recurrence: daily(),
          recurrenceMode: "onDueDate"
        },
        NOW
      )
    )
    await h.svc((svc) => svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW))
    await h.svc((svc) => svc.undo(viewer(), { id, clientMutationId: "m-undo" }, NOW))
    // The spawned task is an independent row; undo only restores the parent.
    expect(h.childCount(id)).toBe(1)

    const recompleted = await h.svc((svc) =>
      svc.complete(viewer(), { id, clientMutationId: "m-complete-2" }, NOW)
    )
    expect(recompleted.status).toBe("done")
    expect(h.childCount(id)).toBe(1)
    expect(h.taskCount()).toBe(2)
  })

  it("does not leave an orphan successor when the completion loses its CAS", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "مسابقه",
          dueDate: "2026-10-20",
          recurrence: daily(),
          recurrenceMode: "onDueDate"
        },
        NOW
      )
    )

    // Another writer lands between the service's read and its batch: the
    // parent update must miss, and with it the child insert/feed/ledger.
    h.fake.beforeBatch = () => {
      h.fake.beforeBatch = undefined
      h.db
        .prepare("UPDATE tasks SET version = version + 1, title = ?, updated_at = ? WHERE id = ?")
        .run("نوشته‌ی همسر", NOW, id)
    }

    const completed = await h.svc((svc) =>
      svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW)
    )
    expect(completed.status).toBe("done")
    expect(completed.version).toBe(3)
    expect(h.taskCount()).toBe(2)
    expect(h.childCount(id)).toBe(1)
    // Parent create + competing edit (no feed, raw SQL) + completion + child.
    expect(h.feedCount()).toBe(3)
  })

  it("spawns nothing once a count/until bound is exhausted", async () => {    const h = makeHarness()
    const counted = uuidV7() as TaskId
    const bounded = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-counted",
          id: counted,
          title: "فقط یک‌بار",
          dueDate: "2026-10-20",
          recurrence: daily({ end: { _tag: "count", count: 1 } }),
          recurrenceMode: "onDueDate"
        },
        NOW
      )
    )
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-bounded",
          id: bounded,
          title: "تا دیروز",
          dueDate: "2026-10-20",
          recurrence: daily({ end: { _tag: "until", date: "2026-10-20" } }),
          recurrenceMode: "onDueDate"
        },
        NOW
      )
    )

    await h.svc((svc) => svc.complete(viewer(), { id: counted, clientMutationId: "m-c" }, NOW))
    await h.svc((svc) => svc.complete(viewer(), { id: bounded, clientMutationId: "m-b" }, NOW))
    expect(h.childCount(counted)).toBe(0)
    expect(h.childCount(bounded)).toBe(0)
    expect(h.taskCount()).toBe(2)
  })
})

describe("recurrence through the sync registry", () => {
  it("accepts a valid rule from a client push and rejects an invalid one", async () => {
    const h = makeHarness()
    const id = uuidV7()

    const pushed = await h.sync((sync) =>
      sync.push({
        userId: USER_A,
        householdId: HOUSEHOLD,
        entries: [
          {
            clientMutationId: "p-create",
            entityType: "task",
            entityId: id,
            baseVersion: 0,
            op: "upsert",
            patch: {
              title: "تکرار آفلاین",
              dueDate: "2026-10-20",
              recurrence: daily(),
              recurrenceMode: "onDueDate"
            },
            clientUpdatedAt: NOW
          }
        ]
      })
    )
    expect(pushed.results[0]).toMatchObject({ _tag: "applied", entityId: id })

    const page = await h.sync((sync) =>
      sync.pull({ userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    )
    expect(page.items.find((row) => row.entityId === id)?.data).toMatchObject({
      recurrence: daily(),
      recurrenceMode: "onDueDate"
    })

    const rejected = await h.sync((sync) =>
      sync.push({
        userId: USER_A,
        householdId: HOUSEHOLD,
        entries: [
          {
            clientMutationId: "p-invalid",
            entityType: "task",
            entityId: id,
            baseVersion: 1,
            op: "upsert",
            patch: {
              recurrence: {
                frequency: "weekly",
                interval: 1,
                byMonthDay: [1],
                end: { _tag: "never" }
              }
            },
            clientUpdatedAt: NOW
          }
        ]
      })
    )
    expect(rejected.results[0]).toMatchObject({ _tag: "rejected", code: "InvalidPatch" })
  })
})

describe("recurrence validation", () => {  it("rejects an on-due-date rule without a due date", async () => {
    const h = makeHarness()
    const error = await h
      .svc((svc) =>
        svc.create(
          viewer(),
          {
            clientMutationId: "m-create",
            title: "بی‌موعد",
            recurrence: daily(),
            recurrenceMode: "onDueDate"
          },
          NOW
        )
      )
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({ _tag: "TaskValidationError" })
    expect(h.taskCount()).toBe(0)
  })

  it("rejects a recurrence mode without a rule", async () => {
    const h = makeHarness()
    const error = await h
      .svc((svc) =>
        svc.create(
          viewer(),
          {
            clientMutationId: "m-create",
            title: "بی‌قاعده",
            dueDate: "2026-10-20",
            recurrenceMode: "onCompletion"
          },
          NOW
        )
      )
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({ _tag: "TaskValidationError" })
  })

  it("rejects a rule whose combinators do not fit the frequency", async () => {
    const h = makeHarness()
    const error = await h
      .svc((svc) =>
        svc.create(
          viewer(),
          {
            clientMutationId: "m-create",
            title: "روزانه با روز هفته",
            dueDate: "2026-10-20",
            recurrence: { frequency: "daily", interval: 1, byDay: [1], end: { _tag: "never" } },
            recurrenceMode: "onDueDate"
          },
          NOW
        )
      )
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({ _tag: "TaskValidationError" })
  })

  it("clearing the rule clears the mode, and a bare mode clear is rejected", async () => {
    const h = makeHarness()
    const id = uuidV7() as TaskId
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "شروع",
          dueDate: "2026-10-20",
          recurrence: daily(),
          recurrenceMode: "onDueDate"
        },
        NOW
      )
    )

    const rejected = await h
      .svc((svc) =>
        svc.update(
          viewer(),
          { id, clientMutationId: "m-mode", patch: { recurrenceMode: null } },
          NOW
        )
      )
      .catch((cause: unknown) => cause)
    expect(rejected).toMatchObject({ _tag: "TaskValidationError" })

    const cleared = await h.svc((svc) =>
      svc.update(
        viewer(),
        { id, clientMutationId: "m-clear", patch: { recurrence: null } },
        NOW
      )
    )
    expect(cleared.recurrence).toBeNull()
    expect(cleared.recurrenceMode).toBeNull()

    // A one-off completion now spawns nothing.
    await h.svc((svc) => svc.complete(viewer(), { id, clientMutationId: "m-complete" }, NOW))
    expect(h.childCount(id)).toBe(0)
  })
})
