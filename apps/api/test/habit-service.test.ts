import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  type HabitFrequency,
  type HabitId,
  type HouseholdId,
  type UserId,
  uuidV7
} from "@tali/domain"
import {
  HabitService,
  HabitServiceLive,
  type HabitServiceApi,
  type HabitViewer
} from "../src/habit-service.js"
import { SyncService, SyncServiceLive } from "../src/sync-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #63, at the service seam. These run the real service + repository +
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

const viewer = (overrides: Partial<HabitViewer> = {}): HabitViewer => ({
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
  const layer = Layer.mergeAll(HabitServiceLive, SyncServiceLive).pipe(Layer.provide(d1))

  const run = <A, E>(effect: Effect.Effect<A, E, HabitService | SyncService>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, layer))

  const svc = <A, E>(
    f: (service: HabitServiceApi) => Effect.Effect<A, E, never>
  ): Promise<A> =>
    run(
      Effect.gen(function*() {
        const service = yield* HabitService
        return yield* f(service)
      })
    )

  const feedCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM change_feed").get() as { readonly n: number }).n

  const rowOf = (id: string): Record<string, unknown> | undefined =>
    db.prepare("SELECT * FROM habits WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined

  return { db, fake, run, svc, feedCount, rowOf }
}

const daily = { _tag: "daily" as const }
const weekdays = { _tag: "weekdays" as const, days: [1, 3, 5] }
const weekly = { _tag: "weekly" as const, times: 3 }

describe("HabitService", () => {
  it("creates a habit in one batch and lands it on the change feed", async () => {
    const h = makeHarness()
    const id = uuidV7() as HabitId

    const created = await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "پیاده‌روی صبح",
          description: "بیست دقیقه",
          icon: "🚶",
          color: "#2f9e44",
          frequency: weekdays,
          reminderTime: "07:30"
        },
        NOW
      )
    )

    expect(created).toMatchObject({
      id,
      title: "پیاده‌روی صبح",
      description: "بیست دقیقه",
      icon: "🚶",
      color: "#2f9e44",
      frequency: weekdays,
      reminderTime: "07:30",
      timeZone: TZ,
      visibility: "shared",
      version: 1,
      deletedAt: null
    })
    // The first frequency version starts on the owner's local creation day.
    expect(created.frequencyHistory).toEqual([{ effectiveFrom: "2026-10-20", frequency: weekdays }])

    const row = h.rowOf(id)!
    expect(JSON.parse(row.frequency as string)).toEqual(weekdays)
    expect(JSON.parse(row.frequency_history as string)).toEqual(created.frequencyHistory)
    expect(row.reminder_time).toBe("07:30")
    expect(row.time_zone).toBe(TZ)
    expect(row.household_id).toBe(HOUSEHOLD)
    expect(row.type).toBe("habit")

    // One batch, one feed row, one ledger row.
    expect(h.fake.batchCalls).toBe(1)
    expect(h.feedCount()).toBe(1)
    const ledger = h.db
      .prepare("SELECT entity_type AS entityType, entity_id AS entityId FROM applied_mutations")
      .all() as ReadonlyArray<{ readonly entityType: string; readonly entityId: string }>
    expect(ledger).toEqual([{ entityType: "habit", entityId: id }])
  })

  it("defaults the zone to the viewer's and the visibility to shared", async () => {
    const h = makeHarness()

    const created = await h.svc((svc) =>
      svc.create(
        viewer({ timeZone: "Europe/Berlin" }),
        { clientMutationId: "m-defaults", title: "کتاب", frequency: daily },
        NOW
      )
    )

    expect(created.timeZone).toBe("Europe/Berlin")
    expect(created.visibility).toBe("shared")
    expect(created.description).toBeNull()
    expect(created.icon).toBeNull()
    expect(created.reminderTime).toBeNull()
    expect(created.frequencyHistory[0]?.effectiveFrom).toBe("2026-10-20")
  })

  it("versions the frequency instead of rewriting the past", async () => {
    const h = makeHarness()
    const id = uuidV7() as HabitId

    await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-create", id, title: "کتاب", frequency: daily },
        NOW
      )
    )

    // A change on the owner's next local day appends a version.
    const changed = await h.svc((svc) =>
      svc.update(
        viewer(),
        { id, clientMutationId: "m-change", patch: { frequency: weekly } },
        "2026-10-21T09:30:00.000Z"
      )
    )

    expect(changed.frequency).toEqual(weekly)
    expect(changed.frequencyHistory).toEqual([
      { effectiveFrom: "2026-10-20", frequency: daily },
      { effectiveFrom: "2026-10-21", frequency: weekly }
    ])
    expect(changed.version).toBe(2)
    expect(JSON.parse(h.rowOf(id)!.frequency_history as string)).toEqual(changed.frequencyHistory)
  })

  it("does not grow the history for a same-frequency or same-day edit", async () => {
    const h = makeHarness()
    const id = uuidV7() as HabitId

    await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-create", id, title: "کتاب", frequency: daily },
        NOW
      )
    )

    // Same frequency: a title edit writes no version.
    const renamed = await h.svc((svc) =>
      svc.update(
        viewer(),
        { id, clientMutationId: "m-rename", patch: { title: "کتاب خواندن" } },
        "2026-10-21T09:30:00.000Z"
      )
    )
    expect(renamed.frequencyHistory).toEqual([
      { effectiveFrom: "2026-10-20", frequency: daily }
    ])

    // A frequency change on the same local day replaces that day's version.
    const sameDay = await h.svc((svc) =>
      svc.update(
        viewer(),
        { id, clientMutationId: "m-sameday", patch: { frequency: weekdays } },
        "2026-10-20T15:00:00.000Z"
      )
    )
    expect(sameDay.frequencyHistory).toEqual([
      { effectiveFrom: "2026-10-20", frequency: weekdays }
    ])
  })

  it("keeps the stored values for the fields a patch omits", async () => {
    const h = makeHarness()
    const id = uuidV7() as HabitId

    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "پیاده‌روی",
          description: "توضیح",
          icon: "🚶",
          color: "#111111",
          frequency: weekdays,
          reminderTime: "06:45"
        },
        NOW
      )
    )

    const patched = await h.svc((svc) =>
      svc.update(
        viewer(),
        { id, clientMutationId: "m-patch", patch: { title: "پیاده‌روی تازه" } },
        "2026-10-20T10:00:00.000Z"
      )
    )

    expect(patched.title).toBe("پیاده‌روی تازه")
    expect(patched.description).toBe("توضیح")
    expect(patched.icon).toBe("🚶")
    expect(patched.color).toBe("#111111")
    expect(patched.frequency).toEqual(weekdays)
    expect(patched.reminderTime).toBe("06:45")
    expect(patched.version).toBe(2)
  })

  it("clears the reminder time when the patch says null", async () => {
    const h = makeHarness()
    const id = uuidV7() as HabitId

    await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-create", id, title: "کتاب", frequency: daily, reminderTime: "20:00" },
        NOW
      )
    )

    const cleared = await h.svc((svc) =>
      svc.update(
        viewer(),
        { id, clientMutationId: "m-clear", patch: { reminderTime: null } },
        "2026-10-20T10:00:00.000Z"
      )
    )
    expect(cleared.reminderTime).toBeNull()
  })

  it("soft deletes, hides, and restores the same habit for the undo toast", async () => {
    const h = makeHarness()
    const id = uuidV7() as HabitId

    const created = await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-create", id, title: "کتاب", frequency: daily },
        NOW
      )
    )

    const deleted = await h.svc((svc) =>
      svc.delete(viewer(), { id, clientMutationId: "m-delete" }, "2026-10-20T11:00:00.000Z")
    )

    expect(deleted.deletedAt).toBe("2026-10-20T11:00:00.000Z")
    expect(deleted.version).toBe(2)

    const feed = h.db
      .prepare("SELECT op FROM change_feed WHERE entity_id = ? ORDER BY seq")
      .all(id) as ReadonlyArray<{ readonly op: string }>
    expect(feed.map((row) => row.op)).toEqual(["upsert", "delete"])

    // A deleted habit reads as gone and is not listed.
    const gone = await h.svc((svc) => svc.get(viewer(), id)).catch((cause: unknown) => cause)
    expect(gone).toMatchObject({ _tag: "HabitNotFound" })
    expect(await h.svc((svc) => svc.list(viewer()))).toEqual([])

    const restored = await h.svc((svc) =>
      svc.restore(viewer(), { id, clientMutationId: "m-restore" }, "2026-10-20T11:05:00.000Z")
    )
    expect(restored.id).toBe(created.id)
    expect(restored.deletedAt).toBeNull()
    expect(restored.frequencyHistory).toEqual(created.frequencyHistory)
    expect(restored.version).toBe(3)

    const listed = await h.svc((svc) => svc.list(viewer()))
    expect(listed.map((habit) => habit.id)).toEqual([id])

    // Both operations are idempotent.
    const deletedAgain = await h.svc((svc) =>
      svc.delete(viewer(), { id, clientMutationId: "m-delete-2" }, "2026-10-20T12:00:00.000Z")
    )
    const deletedTwice = await h.svc((svc) =>
      svc.delete(viewer(), { id, clientMutationId: "m-delete-3" }, "2026-10-20T12:01:00.000Z")
    )
    expect(deletedTwice.version).toBe(deletedAgain.version)
  })

  it("is replay-safe: the same mutation id never writes twice", async () => {
    const h = makeHarness()
    const id = uuidV7() as HabitId

    const first = await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-once", id, title: "کتاب", frequency: daily },
        NOW
      )
    )
    const replay = await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-once", id, title: "کتاب دیگر", frequency: weekly },
        "2026-10-20T12:00:00.000Z"
      )
    )

    expect(replay.version).toBe(first.version)
    expect(replay.title).toBe("کتاب")
    expect(h.feedCount()).toBe(1)

    // A replayed delete returns the row without a second feed write.
    await h.svc((svc) =>
      svc.delete(viewer(), { id, clientMutationId: "m-del" }, "2026-10-20T13:00:00.000Z")
    )
    const deleteReplay = await h.svc((svc) =>
      svc.delete(viewer(), { id, clientMutationId: "m-del" }, "2026-10-20T13:05:00.000Z")
    )
    expect(deleteReplay.deletedAt).toBe("2026-10-20T13:00:00.000Z")
    expect(h.feedCount()).toBe(2)
  })

  it("refuses to reuse a mutation id for another habit", async () => {
    const h = makeHarness()
    const first = uuidV7() as HabitId
    const second = uuidV7() as HabitId

    await h.svc((svc) =>
      svc.create(viewer(), { clientMutationId: "m-shared", id: first, title: "کتاب", frequency: daily }, NOW)
    )

    const reused = await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-shared", id: second, title: "ورزش", frequency: daily },
        NOW
      )
    ).catch((cause: unknown) => cause)
    expect(reused).toMatchObject({ _tag: "HabitValidationError" })
  })

  it("scopes a habit to its household and its owner", async () => {
    const h = makeHarness()
    const id = uuidV7() as HabitId

    await h.svc((svc) =>
      svc.create(
        viewer({ userId: USER_B }),
        {
          clientMutationId: "m-private",
          id,
          title: "عادت خصوصی",
          frequency: daily,
          visibility: "private"
        },
        NOW
      )
    )

    // The other member of the same household may not read a private habit.
    const forbidden = await h.svc((svc) => svc.get(viewer(), id)).catch((cause: unknown) => cause)
    expect(forbidden).toMatchObject({ _tag: "HabitForbidden", reason: "private" })

    expect(await h.svc((svc) => svc.list(viewer()))).toEqual([])

    // The owner still sees it.
    const own = await h.svc((svc) => svc.get(viewer({ userId: USER_B }), id))
    expect(own.id).toBe(id)

    // Another household may not read it at all.
    const outsider = await h.svc((svc) =>
      svc.get(viewer({ householdId: OTHER_HOUSEHOLD }), id)
    ).catch((cause: unknown) => cause)
    expect(outsider).toMatchObject({ _tag: "HabitForbidden", reason: "household" })

    // A shared habit is visible to the other member.
    const shared = uuidV7() as HabitId
    await h.svc((svc) =>
      svc.create(
        viewer({ userId: USER_B }),
        { clientMutationId: "m-shared-habit", id: shared, title: "عادت مشترک", frequency: daily },
        NOW
      )
    )
    expect((await h.svc((svc) => svc.list(viewer()))).map((habit) => habit.id)).toEqual([shared])
  })

  it("rejects an empty title and an invalid frequency union", async () => {
    const h = makeHarness()

    const empty = await h.svc((svc) =>
      svc.create(viewer(), { clientMutationId: "m-empty", title: "  ", frequency: daily }, NOW)
    ).catch((cause: unknown) => cause)
    expect(empty).toMatchObject({ _tag: "HabitValidationError" })

    // The RPC edge rejects these; the service is the boundary for direct
    // callers, so it re-checks the union.
    for (const [index, frequency] of [
      { _tag: "weekdays", days: [] },
      { _tag: "weekdays", days: [2, 2] },
      { _tag: "weekdays", days: [0] },
      { _tag: "weekly", times: 0 },
      { _tag: "weekly", times: 8 }
    ].entries()) {
      const rejected = await h.svc((svc) =>
        svc.create(
          viewer(),
          {
            clientMutationId: `m-bad-${index}`,
            title: "عادت",
            frequency: frequency as unknown as HabitFrequency
          },
          NOW
        )
      ).catch((cause: unknown) => cause)
      expect(rejected).toMatchObject({ _tag: "HabitValidationError" })
    }

    // Nothing was written by any rejected call.
    expect(h.feedCount()).toBe(0)
  })

  it("retries a lost version CAS and still writes the patch", async () => {
    const h = makeHarness()
    const id = uuidV7() as HabitId

    await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-create", id, title: "کتاب", frequency: daily },
        NOW
      )
    )

    // Another writer lands between our read and our batch: the first CAS
    // misses, the service re-reads and reapplies.
    let interfered = false
    h.fake.beforeBatch = () => {
      if (interfered) return
      interfered = true
      h.db
        .prepare("UPDATE habits SET version = version + 1, title = 'از دستگاه دیگر' WHERE id = ?")
        .run(id)
    }

    const patched = await h.svc((svc) =>
      svc.update(
        viewer(),
        { id, clientMutationId: "m-patch", patch: { title: "از این دستگاه" } },
        "2026-10-20T10:00:00.000Z"
      )
    )

    expect(patched.title).toBe("از این دستگاه")
    expect(patched.version).toBe(3)
    expect(h.rowOf(id)!.title).toBe("از این دستگاه")
  })
})
