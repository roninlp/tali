import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  type HabitEntryId,
  HabitEntryOutOfWindow,
  type HabitId,
  type HouseholdId,
  type SyncPushEntry,
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
 * Ticket #64 at the service + sync seam: the daily tap is one row per
 * `(habit, day)`, the second tap replaces the status, an out-of-window day is a
 * typed refusal, and a tombstoned day is revived in place on the service CAS
 * path (the generic push still refuses it — that is the point).
 *
 * Runs the real HabitService + HabitEntryRepo + sync primitives against
 * SQLite (D1's engine) through a D1-shaped batch, so atomicity and the
 * `changes()` gating behave like production.
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
/** 2026-10-20T09:30Z = 13:00 on 20 October in Tehran. */
const NOW = "2026-10-20T09:30:00.000Z"
const TOMORROW = "2026-10-21T09:30:00.000Z"

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

  const syncPush = (input: {
    readonly userId: string
    readonly householdId: string
    readonly entries: ReadonlyArray<SyncPushEntry>
  }) =>
    run(
      Effect.gen(function*() {
        const sync = yield* SyncService
        return yield* sync.push(input)
      })
    )

  const feedCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM change_feed").get() as { readonly n: number }).n

  const entryRows = (habitId: string) =>
    db.prepare("SELECT * FROM habit_entries WHERE habit_id = ? ORDER BY local_date").all(habitId) as
      ReadonlyArray<Record<string, unknown>>

  return { db, fake, run, svc, syncPush, feedCount, entryRows }
}

type Harness = ReturnType<typeof makeHarness>

const createHabit = async (
  h: Harness,
  overrides: {
    readonly id?: string
    readonly visibility?: "private" | "shared"
    readonly userId?: UserId
    readonly householdId?: HouseholdId
  } = {}
): Promise<HabitId> => {
  const id = (overrides.id ?? uuidV7()) as HabitId
  await h.svc((svc) =>
    svc.create(
      viewer({
        userId: overrides.userId ?? USER_A,
        householdId: overrides.householdId ?? HOUSEHOLD
      }),
      {
        clientMutationId: `create-${id}`,
        id,
        title: "کتاب",
        frequency: { _tag: "daily" },
        visibility: overrides.visibility ?? "shared"
      },
      NOW
    )
  )
  return id
}

const syncEntry = (input: {
  readonly entityId: string
  readonly baseVersion: number
  readonly patch?: Record<string, unknown>
  readonly op?: "upsert" | "delete"
  readonly clientMutationId?: string
}): SyncPushEntry => ({
  clientMutationId: input.clientMutationId ?? uuidV7(),
  entityType: "habitEntry",
  entityId: input.entityId,
  baseVersion: input.baseVersion,
  op: input.op ?? "upsert",
  patch: input.patch ?? {},
  clientUpdatedAt: NOW
})

describe("habit entry logging (#64)", () => {
  it("logs a day locally once and reads it back by range", async () => {
    const h = makeHarness()
    const habitId = await createHabit(h)
    const entryId = uuidV7()
    const feedBefore = h.feedCount()

    const logged = await h.svc((svc) =>
      svc.logEntry(
        viewer(),
        {
          id: entryId as HabitEntryId,
          clientMutationId: "m-log-1",
          habitId,
          localDate: "2026-10-20",
          status: "done"
        },
        NOW
      )
    )

    expect(logged).toMatchObject({
      id: entryId,
      habitId,
      ownerId: USER_A,
      householdId: HOUSEHOLD,
      visibility: "shared",
      localDate: "2026-10-20",
      timeZone: TZ,
      status: "done",
      version: 1,
      deletedAt: null
    })
    // One batch: one feed row for the entry, one ledger row.
    expect(h.fake.batchCalls).toBeGreaterThanOrEqual(1)
    expect(h.feedCount()).toBe(feedBefore + 1)
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM applied_mutations WHERE client_mutation_id = ?")
        .get("m-log-1")
    ).toEqual({ n: 1 })

    const range = await h.svc((svc) =>
      svc.entries(viewer(), { from: "2026-10-20", before: "2026-10-21" })
    )
    expect(range.map((entry) => [entry.id, entry.status])).toEqual([[entryId, "done"]])

    // Half-open: a window that ends on the logged day excludes it.
    const before = await h.svc((svc) =>
      svc.entries(viewer(), { from: "2026-10-19", before: "2026-10-20" })
    )
    expect(before).toEqual([])
  })

  it("a second tap replaces the day's status instead of adding a row", async () => {
    const h = makeHarness()
    const habitId = await createHabit(h)

    const first = await h.svc((svc) =>
      svc.logEntry(
        viewer(),
        { clientMutationId: "m-tap-1", habitId, localDate: "2026-10-20", status: "done" },
        NOW
      )
    )
    const second = await h.svc((svc) =>
      svc.logEntry(
        viewer(),
        {
          clientMutationId: "m-tap-2",
          habitId,
          // No id: the server must resolve the day, not mint a second row.
          localDate: "2026-10-20",
          status: "partial"
        },
        NOW
      )
    )

    expect(second.id).toBe(first.id)
    expect(second.status).toBe("partial")
    expect(second.version).toBe(2)
    expect(second.createdAt).toBe(first.createdAt)

    const rows = h.entryRows(habitId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: first.id, status: "partial", version: 2 })
  })

  it("refuses an eight-day-old tap with a typed error and writes nothing", async () => {
    const h = makeHarness()
    const habitId = await createHabit(h)
    const feedBefore = h.feedCount()

    const result = await h.run(
      Effect.gen(function*() {
        const svc = yield* HabitService
        return yield* Effect.result(
          svc.logEntry(
            viewer(),
            {
              clientMutationId: "m-too-old",
              habitId,
              localDate: "2026-10-12",
              status: "done"
            },
            NOW
          )
        )
      })
    )

    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure).toBeInstanceOf(HabitEntryOutOfWindow)
    expect(result.failure).toMatchObject({
      _tag: "HabitEntryOutOfWindow",
      localDate: "2026-10-12",
      earliest: "2026-10-13",
      latest: "2026-10-20"
    })
    expect(h.entryRows(habitId)).toEqual([])
    expect(h.feedCount()).toBe(feedBefore)
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM applied_mutations WHERE client_mutation_id = ?")
        .get("m-too-old")
    ).toEqual({ n: 0 })
  })

  it("allows the seventh day back and refuses the future", async () => {
    const h = makeHarness()
    const habitId = await createHabit(h)

    const oldest = await h.svc((svc) =>
      svc.logEntry(
        viewer(),
        { clientMutationId: "m-oldest", habitId, localDate: "2026-10-13", status: "done" },
        NOW
      )
    )
    expect(oldest.localDate).toBe("2026-10-13")

    const future = await h.run(
      Effect.gen(function*() {
        const svc = yield* HabitService
        return yield* Effect.result(
          svc.logEntry(
            viewer(),
            { clientMutationId: "m-future", habitId, localDate: "2026-10-21", status: "done" },
            NOW
          )
        )
      })
    )
    expect(future._tag).toBe("Failure")
  })

  it("revives a tombstoned day in place on the service CAS path", async () => {
    const h = makeHarness()
    const habitId = await createHabit(h)

    const logged = await h.svc((svc) =>
      svc.logEntry(
        viewer(),
        { clientMutationId: "m-entry", habitId, localDate: "2026-10-20", status: "done" },
        NOW
      )
    )

    // Tombstone the day through the real sync path (the future "clear the
    // day" action has no service mutation of its own yet).
    const deleted = await h.syncPush({
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        syncEntry({
          entityId: logged.id,
          baseVersion: 1,
          op: "delete",
          clientMutationId: "m-clear"
        })
      ]
    })
    expect(deleted.results[0]).toMatchObject({ _tag: "applied", version: 2 })
    expect(h.entryRows(habitId)[0]).toMatchObject({ deleted_at: expect.any(String), version: 2 })

    // The generic resolver keeps tombstone-wins: an offline upsert is a
    // no-write, which is exactly the gap the service path closes.
    const generic = await h.syncPush({
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        syncEntry({
          entityId: logged.id,
          baseVersion: 2,
          patch: {
            habitId,
            localDate: "2026-10-20",
            timeZone: TZ,
            status: "partial"
          },
          clientMutationId: "m-generic"
        })
      ]
    })
    expect(generic.results[0]).toMatchObject({ _tag: "tombstone" })
    expect(h.entryRows(habitId)[0]).toMatchObject({ deleted_at: expect.any(String), version: 2 })

    const revived = await h.svc((svc) =>
      svc.logEntry(
        viewer(),
        {
          clientMutationId: "m-revive",
          habitId,
          localDate: "2026-10-20",
          status: "partial"
        },
        NOW
      )
    )
    expect(revived.id).toBe(logged.id)
    expect(revived.version).toBe(3)
    expect(revived.status).toBe("partial")
    expect(revived.deletedAt).toBeNull()

    const rows = h.entryRows(habitId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: logged.id,
      status: "partial",
      version: 3,
      deleted_at: null
    })

    // The revive rode the same version/feed path, so the other device's next
    // pull sees the live row at the new version (not the tombstone).
    const pulled = await h.run(
      Effect.gen(function*() {
        const sync = yield* SyncService
        return yield* sync.pull({ userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
      })
    )
    const live = pulled.items.find((item) => item.entityType === "habitEntry")!
    expect(live).toMatchObject({
      entityId: logged.id,
      version: 3,
      deletedAt: null,
      data: { status: "partial" }
    })
  })

  it("inherits the habit's visibility and refuses another member's private habit", async () => {
    const h = makeHarness()
    const privateHabit = await createHabit(h, { visibility: "private" })

    const logged = await h.svc((svc) =>
      svc.logEntry(
        viewer(),
        { clientMutationId: "m-private", habitId: privateHabit, localDate: "2026-10-20", status: "done" },
        NOW
      )
    )
    expect(logged.visibility).toBe("private")

    const partner = await h.run(
      Effect.gen(function*() {
        const svc = yield* HabitService
        return yield* Effect.result(
          svc.logEntry(
            viewer({ userId: USER_B }),
            {
              clientMutationId: "m-partner",
              habitId: privateHabit,
              localDate: "2026-10-20",
              status: "done"
            },
            NOW
          )
        )
      })
    )
    expect(partner._tag).toBe("Failure")
    if (partner._tag === "Failure") {
      expect(partner.failure).toMatchObject({ _tag: "HabitForbidden", reason: "private" })
    }

    // Range reads apply the same scope: the partner sees no private day.
    const partnerRange = await h.svc((svc) =>
      svc.entries(viewer({ userId: USER_B }), { from: "2026-10-20", before: "2026-10-21" })
    )
    expect(partnerRange).toEqual([])

    const outsiderRange = await h.svc((svc) =>
      svc.entries(
        viewer({ householdId: OTHER_HOUSEHOLD }),
        { from: "2026-10-20", before: "2026-10-21" }
      )
    )
    expect(outsiderRange).toEqual([])
  })

  it("is replay-safe: the same mutation id returns the row without a second write", async () => {
    const h = makeHarness()
    const habitId = await createHabit(h)
    const input = {
      clientMutationId: "m-replay",
      habitId,
      localDate: "2026-10-20",
      status: "done" as const
    }

    const first = await h.svc((svc) => svc.logEntry(viewer(), input, NOW))
    const feedAfterFirst = h.feedCount()
    const second = await h.svc((svc) => svc.logEntry(viewer(), input, NOW))

    expect(second.id).toBe(first.id)
    expect(second.version).toBe(1)
    expect(h.feedCount()).toBe(feedAfterFirst)
    expect(h.entryRows(habitId)).toHaveLength(1)
  })

  it("rejects an invalid range and a malformed day", async () => {
    const h = makeHarness()
    const habitId = await createHabit(h)

    const badRange = await h.run(
      Effect.gen(function*() {
        const svc = yield* HabitService
        return yield* Effect.result(
          svc.entries(viewer(), { from: "2026-10-20", before: "2026-10-20" })
        )
      })
    )
    expect(badRange._tag).toBe("Failure")
    if (badRange._tag === "Failure") {
      expect(badRange.failure).toMatchObject({
        _tag: "HabitValidationError",
        issues: [{ field: "before" }]
      })
    }

    const badDay = await h.run(
      Effect.gen(function*() {
        const svc = yield* HabitService
        return yield* Effect.result(
          svc.logEntry(
            viewer(),
            {
              clientMutationId: "m-bad-day",
              habitId,
              localDate: "2026/10/20" as never,
              status: "done"
            },
            NOW
          )
        )
      })
    )
    expect(badDay._tag).toBe("Failure")
    if (badDay._tag === "Failure") {
      expect(badDay.failure).toMatchObject({
        _tag: "HabitValidationError",
        issues: [{ field: "localDate" }]
      })
    }
    expect(h.entryRows(habitId)).toEqual([])
  })

  it("does not log against a trashed habit", async () => {
    const h = makeHarness()
    const habitId = await createHabit(h)
    await h.svc((svc) =>
      svc.delete(viewer(), { id: habitId, clientMutationId: "m-delete-habit" }, NOW)
    )

    const result = await h.run(
      Effect.gen(function*() {
        const svc = yield* HabitService
        return yield* Effect.result(
          svc.logEntry(
            viewer(),
            { clientMutationId: "m-trashed", habitId, localDate: "2026-10-20", status: "done" },
            NOW
          )
        )
      })
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({ _tag: "HabitNotFound" })
    }
  })

  it("logs tomorrow's day only when the tap's zone says it is today", async () => {
    const h = makeHarness()
    const habitId = await createHabit(h)

    // 21 Oct 09:30Z is 21 Oct in Tehran: the same wall date is now allowed.
    const logged = await h.svc((svc) =>
      svc.logEntry(
        viewer(),
        { clientMutationId: "m-next-day", habitId, localDate: "2026-10-21", status: "done" },
        TOMORROW
      )
    )
    expect(logged.localDate).toBe("2026-10-21")
  })
})
