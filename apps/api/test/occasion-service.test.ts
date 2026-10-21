import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  type HouseholdId,
  type OccasionId,
  type SyncPushEntry,
  type UserId,
  uuidV7
} from "@tali/domain"
import {
  OccasionService,
  OccasionServiceLive,
  type OccasionServiceApi,
  type OccasionViewer
} from "../src/occasion-service.js"
import {
  ReminderService,
  ReminderServiceLive,
  type ReminderServiceApi
} from "../src/reminder-service.js"
import { SyncService, SyncServiceLive } from "../src/sync-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #59 at the service and sync seams. These run the real service +
 * repository + sync-primitive SQL against SQLite (D1's engine), through a
 * D1-shaped batch so atomicity, `changes()` gating and `last_insert_rowid()`
 * behave like production.
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

const viewer = (overrides: Partial<OccasionViewer> = {}): OccasionViewer => ({
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
  const layer = Layer.mergeAll(OccasionServiceLive, SyncServiceLive, ReminderServiceLive).pipe(
    Layer.provide(d1)
  )

  const run = <A, E>(
    effect: Effect.Effect<A, E, OccasionService | SyncService | ReminderService>
  ): Promise<A> => Effect.runPromise(Effect.provide(effect, layer))

  const svc = <A, E>(
    f: (service: OccasionServiceApi) => Effect.Effect<A, E, never>
  ): Promise<A> =>
    run(
      Effect.gen(function*() {
        const service = yield* OccasionService
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

  const reminderSvc = <A, E>(
    f: (service: ReminderServiceApi) => Effect.Effect<A, E, never>
  ): Promise<A> =>
    run(
      Effect.gen(function*() {
        const service = yield* ReminderService
        return yield* f(service)
      })
    )

  const feedCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM change_feed").get() as { readonly n: number }).n

  const reminderRow = (id: string): Record<string, unknown> | undefined =>
    db.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined

  const reminderCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM reminders").get() as { readonly n: number }).n

  const occasionRow = (id: string): Record<string, unknown> | undefined =>
    db.prepare("SELECT * FROM occasions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined

  const taskRow = (id: string): Record<string, unknown> | undefined =>
    db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined

  return {
    db,
    fake,
    run,
    svc,
    sync,
    reminderSvc,
    feedCount,
    occasionRow,
    taskRow,
    reminderRow,
    reminderCount
  }
}

const createInput = (overrides: Record<string, unknown> = {}) => ({
  clientMutationId: `m-${uuidV7()}`,
  title: "تولد مامان",
  originDate: "1990-04-01",
  advanceReminderDays: 7,
  ...overrides
})

describe("OccasionService", () => {
  it("creates an occasion in one batch and lands it on the change feed", async () => {
    const h = makeHarness()
    const id = uuidV7() as OccasionId
    const before = h.feedCount()

    const created = await h.svc((svc) =>
      svc.create(viewer(), createInput({ id }) as never, NOW)
    )

    expect(created.id).toBe(id)
    expect(created.type).toBe("occasion")
    expect(created.originDate).toBe("1990-04-01")
    expect(created.yearly).toBe(true)
    expect(created.advanceReminderDays).toBe(7)
    expect(created.version).toBe(1)
    expect(h.feedCount()).toBe(before + 1)
    expect(h.occasionRow(id)).toMatchObject({
      origin_date: "1990-04-01",
      yearly: 1,
      advance_reminder_days: 7,
      version: 1
    })
  })

  it("projects the annual occurrence into the Jalali month", async () => {
    const h = makeHarness()
    const id = uuidV7() as OccasionId
    await h.svc((svc) => svc.create(viewer(), createInput({ id }) as never, NOW))

    const occurrences = await h.svc((svc) =>
      svc.occurrences(viewer(), { from: "2026-04-01", to: "2026-04-30" } as never)
    )

    expect(occurrences).toHaveLength(1)
    expect(occurrences[0]).toMatchObject({
      id,
      date: "2026-04-01",
      jalali: { year: 1405, month: 1, day: 12 },
      gregorian: { year: 2026, month: 4, day: 1 },
      advanceReminderDate: "2026-03-25"
    })
  })

  it("derives the advance reminder at the offset, without storing a year", async () => {
    const h = makeHarness()
    const id = uuidV7() as OccasionId
    await h.svc((svc) => svc.create(viewer(), createInput({ id }) as never, NOW))

    const due = await h.svc((svc) =>
      svc.advanceReminders(viewer(), { from: "2026-03-20", to: "2026-03-31" } as never)
    )
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({
      occasionId: id,
      occurrenceDate: "2026-04-01",
      dueDate: "2026-03-25",
      fireAt: "2026-03-25T05:30:00Z",
      advanceDays: 7,
      link: { _tag: "occasion", occasionId: id }
    })

    // The next year's reminder is projected too; no row was written for either.
    const next = await h.svc((svc) =>
      svc.advanceReminders(viewer(), { from: "2027-03-20", to: "2027-03-31" } as never)
    )
    expect(next[0]?.dueDate).toBe("2027-03-25")
    const rows = h.db
      .prepare("SELECT COUNT(*) AS n FROM occasions")
      .get() as { readonly n: number }
    expect(rows.n).toBe(1)
  })

  it("returns a detail with the next occurrence and its reminder", async () => {
    const h = makeHarness()
    const id = uuidV7() as OccasionId
    await h.svc((svc) => svc.create(viewer(), createInput({ id }) as never, NOW))

    const detail = await h.svc((svc) => svc.get(viewer(), id, NOW))
    expect(detail.next?.date).toBe("2027-04-01")
    expect(detail.nextReminder?.dueDate).toBe("2027-03-25")
  })

  it("creates the preparation task in the same batch and links it", async () => {
    const h = makeHarness()
    const id = uuidV7() as OccasionId
    await h.svc((svc) => svc.create(viewer(), createInput({ id }) as never, NOW))
    const before = h.feedCount()

    const prepared = await h.svc((svc) =>
      svc.prepareTask(viewer(), { id, clientMutationId: "m-prepare" }, NOW)
    )

    expect(prepared.created).toBe(true)
    expect(prepared.task.title).toBe("آماده‌سازی برای تولد مامان")
    expect(prepared.task.dueDate).toBe("2027-03-25")
    expect(prepared.task.status).toBe("todo")
    expect(prepared.occasion.preparationTaskId).toBe(prepared.task.id)
    expect(prepared.occasion.version).toBe(2)
    // One feed row for the occasion link and one for the task.
    expect(h.feedCount()).toBe(before + 2)
    expect(h.taskRow(prepared.task.id)).toMatchObject({
      due_date: "2027-03-25",
      type: "task",
      status: "todo"
    })

    // One tap repeated is idempotent: the live task comes back, nothing writes.
    const again = await h.svc((svc) =>
      svc.prepareTask(viewer(), { id, clientMutationId: "m-prepare-2" }, NOW)
    )
    expect(again.created).toBe(false)
    expect(again.task.id).toBe(prepared.task.id)
    expect(h.feedCount()).toBe(before + 2)

    // A retried identical mutation replays the ledger instead of creating a task.
    const replay = await h.svc((svc) =>
      svc.prepareTask(viewer(), { id, clientMutationId: "m-prepare" }, NOW)
    )
    expect(replay.task.id).toBe(prepared.task.id)
  })

  it("updates and soft-deletes through the same version/feed path", async () => {
    const h = makeHarness()
    const id = uuidV7() as OccasionId
    await h.svc((svc) => svc.create(viewer(), createInput({ id }) as never, NOW))

    const updated = await h.svc((svc) =>
      svc.update(
        viewer(),
        {
          id,
          clientMutationId: "m-update",
          patch: { title: "سالگرد ازدواج", yearly: false, advanceReminderDays: 14 }
        } as never,
        NOW
      )
    )
    expect(updated.version).toBe(2)
    expect(updated.title).toBe("سالگرد ازدواج")
    expect(updated.yearly).toBe(false)

    const deleted = await h.svc((svc) =>
      svc.delete(viewer(), { id, clientMutationId: "m-delete" }, NOW)
    )
    expect(deleted.deletedAt).toBe(NOW)
    expect(deleted.version).toBe(3)
    expect(h.occasionRow(id)?.deleted_at).toBe(NOW)
  })

  it("rejects a malformed zone with a typed error, not a defect", async () => {
    const h = makeHarness()
    await expect(
      h.svc((svc) => svc.create(viewer(), createInput({ timeZone: "Mars/Olympus" }) as never, NOW))
    ).rejects.toMatchObject({ _tag: "OccasionValidationError" })
  })

  it("never exposes another member's private occasion", async () => {
    const h = makeHarness()
    const id = uuidV7() as OccasionId
    await h.svc((svc) =>
      svc.create(viewer(), createInput({ id, visibility: "private" }) as never, NOW)
    )

    const otherViewer = viewer({ userId: USER_B })
    expect(await h.svc((svc) => svc.list(otherViewer))).toEqual([])
    expect(
      await h.svc((svc) =>
        svc.occurrences(otherViewer, { from: "2026-01-01", to: "2026-12-31" } as never)
      )
    ).toEqual([])
    await expect(
      h.svc((svc) => svc.get(otherViewer, id, NOW))
    ).rejects.toMatchObject({ _tag: "OccasionForbidden" })
    await expect(
      h.svc((svc) => svc.get(viewer({ householdId: OTHER_HOUSEHOLD }), id, NOW))
    ).rejects.toMatchObject({ _tag: "OccasionForbidden" })
  })
})

describe("advance reminder materialisation (#60 wiring)", () => {
  it("creates the reminder at occurrence − offset, 09:00 local, exactly once", async () => {
    const h = makeHarness()
    const id = uuidV7() as OccasionId
    await h.svc((svc) => svc.create(viewer(), createInput({ id }) as never, NOW))

    const window = { from: "2026-03-20", to: "2026-03-31" } as never
    const first = await h.svc((svc) => svc.materialiseReminders(viewer(), window))
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      type: "reminder",
      title: "تولد مامان",
      kind: "general",
      repeat: { _tag: "once" },
      // 25 March 2026 09:00 Asia/Tehran (UTC+03:30) = 05:30Z.
      fireAt: "2026-03-25T05:30:00.000Z",
      offsetMinutes: 7 * 24 * 60,
      timeZone: TZ,
      visibility: "shared",
      link: { _tag: "occasion", occasionId: id }
    })
    expect(h.reminderCount()).toBe(1)
    expect(h.reminderRow(first[0]!.id)).toMatchObject({
      link_type: "occasion",
      link_id: id,
      fire_at: "2026-03-25T05:30:00.000Z",
      deleted_at: null
    })

    // A second materialisation of the same window returns the same row and
    // writes nothing: no duplicate reminder.
    const second = await h.svc((svc) => svc.materialiseReminders(viewer(), window))
    expect(second.map((reminder) => reminder.id)).toEqual([first[0]!.id])
    expect(h.reminderCount()).toBe(1)
  })

  it("syncs the materialised occasion reminder to the partner", async () => {
    const h = makeHarness()
    const id = uuidV7() as OccasionId
    await h.svc((svc) => svc.create(viewer(), createInput({ id }) as never, NOW))
    const created = await h.svc((svc) =>
      svc.materialiseReminders(viewer(), { from: "2026-03-20", to: "2026-03-31" } as never)
    )

    // The partner's own cursor sees the server-created reminder on /sync/pull.
    const pulled = await h.sync((sync) =>
      sync.pull({ userId: USER_B, householdId: HOUSEHOLD, cursor: 0 })
    )
    const reminder = pulled.items.find(
      (item) => item.entityType === "reminder" && item.entityId === created[0]!.id
    )
    expect(reminder?.data).toMatchObject({
      title: "تولد مامان",
      fireAt: "2026-03-25T05:30:00.000Z",
      link: { _tag: "occasion", occasionId: id }
    })
  })

  it("does not resurrect a deleted advance reminder", async () => {
    const h = makeHarness()
    const id = uuidV7() as OccasionId
    await h.svc((svc) => svc.create(viewer(), createInput({ id }) as never, NOW))
    const window = { from: "2026-03-20", to: "2026-03-31" } as never
    const [created] = await h.svc((svc) => svc.materialiseReminders(viewer(), window))

    await h.reminderSvc((svc) =>
      svc.delete(viewer(), { id: created!.id, clientMutationId: "m-rem-delete" }, NOW)
    )

    const again = await h.svc((svc) => svc.materialiseReminders(viewer(), window))
    expect(again).toEqual([])
    expect(h.reminderCount()).toBe(1)
    expect(h.reminderRow(created!.id)?.deleted_at).toBe(NOW)
  })
})

describe("occasion sync", () => {
  const entry = (input: {
    readonly entityId: string
    readonly baseVersion: number
    readonly patch?: Record<string, unknown>
    readonly op?: "upsert" | "delete"
    readonly clientMutationId?: string
  }): SyncPushEntry => ({
    clientMutationId: input.clientMutationId ?? uuidV7(),
    entityType: "occasion",
    entityId: input.entityId,
    baseVersion: input.baseVersion,
    op: input.op ?? "upsert",
    patch: input.patch ?? {},
    clientUpdatedAt: NOW
  })

  it("carries an occasion from /sync/push to /sync/pull", async () => {
    const h = makeHarness()
    const id = uuidV7()

    const pushed = await h.sync((sync) =>
      sync.push({
        userId: USER_A,
        householdId: HOUSEHOLD,
        entries: [
          entry({
            entityId: id,
            baseVersion: 0,
            patch: {
              title: "تولد سارا",
              originDate: "2015-09-23",
              timeZone: TZ,
              yearly: true,
              advanceReminderDays: 3,
              color: "#f4b6c2"
            }
          })
        ]
      })
    )
    expect(pushed.results[0]?._tag).toBe("applied")

    const pulled = await h.sync((sync) =>
      sync.pull({ userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    )
    const occasion = pulled.items.find(
      (item) => item.entityType === "occasion" && item.entityId === id
    )
    expect(occasion?.data).toMatchObject({
      title: "تولد سارا",
      originDate: "2015-09-23",
      timeZone: TZ,
      yearly: true,
      advanceReminderDays: 3,
      color: "#f4b6c2"
    })
  })

  it("rejects a malformed zone instead of storing it", async () => {
    const h = makeHarness()
    const result = await h.sync((sync) =>
      sync.push({
        userId: USER_A,
        householdId: HOUSEHOLD,
        entries: [
          entry({
            entityId: uuidV7(),
            baseVersion: 0,
            patch: {
              title: "تولد",
              originDate: "1990-04-01",
              timeZone: "Mars/Olympus",
              yearly: true,
              advanceReminderDays: 7
            }
          })
        ]
      })
    )
    expect(result.results[0]?._tag).toBe("rejected")
  })

  it("soft-deletes an occasion on the push path", async () => {
    const h = makeHarness()
    const id = uuidV7()
    await h.sync((sync) =>
      sync.push({
        userId: USER_A,
        householdId: HOUSEHOLD,
        entries: [
          entry({
            entityId: id,
            baseVersion: 0,
            patch: {
              title: "سالگرد",
              originDate: "2018-06-15",
              timeZone: TZ,
              yearly: true,
              advanceReminderDays: null
            }
          })
        ]
      })
    )
    const deleted = await h.sync((sync) =>
      sync.push({
        userId: USER_A,
        householdId: HOUSEHOLD,
        entries: [entry({ entityId: id, baseVersion: 1, op: "delete" })]
      })
    )
    expect(deleted.results[0]?._tag).toBe("applied")
    expect(h.occasionRow(id)?.deleted_at).not.toBeNull()
  })
})
