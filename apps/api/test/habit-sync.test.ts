import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  localDateIn,
  type SyncPullResponse,
  type SyncPushEntry,
  uuidV7
} from "@tali/domain"
import { SyncService, SyncServiceLive } from "../src/sync-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #63 at the sync seam: a habit (and a day's entry) has to travel
 * through the real push and pull path — the same path the web client's outbox
 * uses — so the registry entries, the wire shapes, the frequency versioning
 * and the household filter are exercised together.
 *
 * These run the real registry + repository SQL against SQLite (D1's engine),
 * through a D1-shaped batch so atomicity and `changes()` gating behave like
 * production.
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)

const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort()

const HOUSEHOLD = "household-a"
const USER_A = "user-a"
const USER_B = "user-b"
const HOUSEHOLD_B = "household-b"

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
  const layer = SyncServiceLive.pipe(Layer.provide(d1))

  const run = <A>(effect: Effect.Effect<A, unknown, SyncService>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, layer))

  return { db, fake, run }
}

type Harness = ReturnType<typeof makeHarness>

const pull = (
  harness: Harness,
  input: { readonly userId: string; readonly householdId: string; readonly cursor: number }
): Promise<SyncPullResponse> =>
  harness.run(
    Effect.gen(function*() {
      const sync = yield* SyncService
      return yield* sync.pull(input)
    })
  )

const push = (
  harness: Harness,
  input: {
    readonly userId: string
    readonly householdId: string
    readonly entries: ReadonlyArray<SyncPushEntry>
  }
) =>
  harness.run(
    Effect.gen(function*() {
      const sync = yield* SyncService
      return yield* sync.push(input)
    })
  )

const entry = (input: {
  readonly entityType: "habit" | "habitEntry"
  readonly entityId: string
  readonly baseVersion: number
  readonly patch?: Record<string, unknown>
  readonly op?: "upsert" | "delete"
  readonly clientMutationId?: string
  readonly clientUpdatedAt?: string
}): SyncPushEntry => ({
  clientMutationId: input.clientMutationId ?? uuidV7(),
  entityType: input.entityType,
  entityId: input.entityId,
  baseVersion: input.baseVersion,
  op: input.op ?? "upsert",
  patch: input.patch ?? {},
  clientUpdatedAt: input.clientUpdatedAt ?? new Date().toISOString()
})

describe("habit sync", () => {
  it("carries an offline-created habit from /sync/push to /sync/pull", async () => {
    const h = makeHarness()
    const id = uuidV7()

    const pushed = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: id,
          baseVersion: 0,
          patch: {
            title: "پیاده‌روی",
            description: "بیست دقیقه",
            icon: "🚶",
            frequency: { _tag: "weekdays", days: [1, 3, 5] },
            reminderTime: "07:30",
            timeZone: "Asia/Tehran",
            visibility: "shared",
            createdAt: "2026-10-20T04:00:00.000Z"
          },
          clientUpdatedAt: "2026-10-20T04:00:00.000Z"
        })
      ]
    })

    expect(pushed.results[0]).toMatchObject({
      _tag: "applied",
      entityType: "habit",
      entityId: id,
      version: 1
    })

    const pulled = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })

    expect(pulled.entries.map((row) => [row.entityType, row.entityId])).toEqual([
      ["habit", id]
    ])
    expect(pulled.items).toHaveLength(1)
    const row = pulled.items[0]!
    expect(row).toMatchObject({ entityType: "habit", entityId: id, version: 1 })
    expect(row.data).toMatchObject({
      id,
      type: "habit",
      title: "پیاده‌روی",
      description: "بیست دقیقه",
      icon: "🚶",
      startedOn: "2026-10-20",
      frequency: { _tag: "weekdays", days: [1, 3, 5] },
      reminderTime: "07:30",
      timeZone: "Asia/Tehran",
      visibility: "shared"
    })
    // The offline create seeds the habit's first era from its creation day,
    // exactly like the service.
    expect(row.data.frequencyHistory).toEqual([
      { effectiveFrom: "2026-10-20", frequency: { _tag: "weekdays", days: [1, 3, 5] } }
    ])

    // The D1 row keeps the union as JSON text, never a string like "3x/week".
    const stored = h.db.prepare("SELECT frequency FROM habits WHERE id = ?").get(id) as {
      readonly frequency: string
    }
    expect(JSON.parse(stored.frequency)).toEqual({ _tag: "weekdays", days: [1, 3, 5] })
  })

  it("never back-dates an era from the client's edit day (#65)", async () => {
    const h = makeHarness()
    const id = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: id,
          baseVersion: 0,
          patch: {
            title: "کتاب",
            frequency: { _tag: "daily" },
            timeZone: "Asia/Tehran",
            createdAt: "2026-10-20T04:00:00.000Z"
          },
          clientUpdatedAt: "2026-10-20T04:00:00.000Z"
        })
      ]
    })

    const changed = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: id,
          baseVersion: 1,
          patch: { frequency: { _tag: "weekly", times: 3 } },
          // 21:30 UTC is already the 21st in Tehran.
          clientUpdatedAt: "2026-10-20T21:30:00.000Z"
        })
      ]
    })
    expect(changed.results[0]).toMatchObject({ _tag: "applied", version: 2 })

    const pulled = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    const row = pulled.items.find((item) => item.entityId === id)!
    expect(row.data.frequency).toEqual({ _tag: "weekly", times: 3 })
    const history = row.data.frequencyHistory as ReadonlyArray<{
      readonly effectiveFrom: string
      readonly frequency: unknown
    }>
    expect(history[0]).toEqual({ effectiveFrom: "2026-10-20", frequency: { _tag: "daily" } })
    const era = history[1]!
    expect(era.frequency).toEqual({ _tag: "weekly", times: 3 })
    // The client said it edited on 20 Oct (21:30 UTC = the 21st in Tehran);
    // the era is still dated from the server's apply day, and a weekly era can
    // only open on the fixed Saturday boundary.
    const today = localDateIn(new Date().toISOString(), "Asia/Tehran")
    expect(era.effectiveFrom).not.toBe("2026-10-20")
    expect(era.effectiveFrom >= today).toBe(true)
    expect(new Date(`${era.effectiveFrom}T00:00:00.000Z`).getUTCDay()).toBe(6)
  })

  it("does not let a client patch rewrite the frequency history", async () => {
    const h = makeHarness()
    const id = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: id,
          baseVersion: 0,
          patch: { title: "کتاب", frequency: { _tag: "daily" }, timeZone: "UTC" },
          clientUpdatedAt: "2026-10-20T04:00:00.000Z"
        })
      ]
    })

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: id,
          baseVersion: 1,
          patch: {
            title: "کتاب تازه",
            // Not in the writable allowlist: dropped, never stored.
            frequencyHistory: [{ effectiveFrom: "2020-01-01", frequency: { _tag: "daily" } }]
          },
          clientUpdatedAt: "2026-10-21T04:00:00.000Z"
        })
      ]
    })

    const pulled = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    const row = pulled.items.find((item) => item.entityId === id)!
    expect(row.data.title).toBe("کتاب تازه")
    expect(row.data.frequencyHistory).toEqual([
      { effectiveFrom: "2026-10-20", frequency: { _tag: "daily" } }
    ])
  })

  it("carries a logged habit entry on the same push and pull", async () => {
    const h = makeHarness()
    const habitId = uuidV7()
    const habitEntryId = uuidV7()

    const pushed = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: habitId,
          baseVersion: 0,
          patch: {
            title: "کتاب",
            frequency: { _tag: "daily" },
            timeZone: "Asia/Tehran",
            createdAt: "2026-10-20T04:00:00.000Z"
          },
          clientUpdatedAt: "2026-10-20T04:00:00.000Z"
        }),
        entry({
          entityType: "habitEntry",
          entityId: habitEntryId,
          baseVersion: 0,
          patch: {
            habitId,
            localDate: "2026-10-20",
            timeZone: "Asia/Tehran",
            status: "done"
          },
          clientUpdatedAt: "2026-10-20T16:00:00.000Z"
        })
      ]
    })

    expect(pushed.results.map((result) => result._tag)).toEqual(["applied", "applied"])
    // The habit is written before the entry that references it.
    expect(pushed.results[1]).toMatchObject({
      entityType: "habitEntry",
      entityId: habitEntryId,
      version: 1
    })

    const pulled = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    expect(pulled.entries.map((row) => row.entityType)).toEqual(["habit", "habitEntry"])
    const row = pulled.items.find((item) => item.entityId === habitEntryId)!
    expect(row).toMatchObject({ version: 1, deletedAt: null })
    expect(row.data).toMatchObject({
      id: habitEntryId,
      habitId,
      localDate: "2026-10-20",
      timeZone: "Asia/Tehran",
      status: "done",
      visibility: "shared"
    })

    const stored = h.db
      .prepare("SELECT habit_id, local_date, status FROM habit_entries WHERE id = ?")
      .get(habitEntryId) as {
        readonly habit_id: string
        readonly local_date: string
        readonly status: string
      }
    expect(stored).toEqual({ habit_id: habitId, local_date: "2026-10-20", status: "done" })
  })

  it("keeps one row per habit-day: a duplicate insert is rejected, not duplicated", async () => {
    const h = makeHarness()
    const habitId = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: habitId,
          baseVersion: 0,
          patch: { title: "کتاب", frequency: { _tag: "daily" }, timeZone: "UTC" },
          clientUpdatedAt: "2026-10-20T04:00:00.000Z"
        })
      ]
    })

    const firstPatch = {
      habitId,
      localDate: "2026-10-20",
      timeZone: "UTC",
      status: "done"
    }
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habitEntry",
          entityId: uuidV7(),
          baseVersion: 0,
          patch: firstPatch,
          clientUpdatedAt: "2026-10-20T16:00:00.000Z"
        })
      ]
    })

    // A second device minted a different id for the same (habit, day): the
    // unique index refuses it, and the entry is reported as rejected so the
    // outbox drops it instead of retrying forever. #64's tap resolves the day
    // first (`HabitEntryRepo.findForDate`) and updates that row instead.
    const duplicate = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habitEntry",
          entityId: uuidV7(),
          baseVersion: 0,
          patch: firstPatch,
          clientUpdatedAt: "2026-10-20T17:00:00.000Z"
        })
      ]
    })
    expect(duplicate.results[0]).toMatchObject({ _tag: "rejected", code: "UniqueViolation" })

    const count = h.db
      .prepare("SELECT COUNT(*) AS n FROM habit_entries WHERE habit_id = ? AND local_date = ?")
      .get(habitId, "2026-10-20") as { readonly n: number }
    expect(count.n).toBe(1)
  })

  it("rejects a malformed frequency, and drops a status outside the enum", async () => {
    const h = makeHarness()
    const habitId = uuidV7()

    const badFrequency = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: habitId,
          baseVersion: 0,
          patch: { title: "بی‌ریتم", frequency: { _tag: "weekdays", days: [] } }
        })
      ]
    })
    expect(badFrequency.results[0]).toMatchObject({ _tag: "rejected", code: "InvalidPatch" })

    const badStatus = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: habitId,
          baseVersion: 0,
          patch: { title: "کتاب", frequency: { _tag: "daily" }, timeZone: "UTC" },
          clientUpdatedAt: "2026-10-20T04:00:00.000Z"
        }),
        entry({
          entityType: "habitEntry",
          entityId: uuidV7(),
          baseVersion: 0,
          patch: {
            habitId,
            localDate: "2026-10-20",
            timeZone: "UTC",
            status: "skipped"
          }
        })
      ]
    })
    // A status outside the enum is rejected, never coerced to `done`: the RPC
    // and sync paths now agree that an unknown answer is an invalid patch.
    expect(badStatus.results[1]).toMatchObject({ _tag: "rejected", code: "InvalidPatch" })
    const count = h.db
      .prepare("SELECT COUNT(*) AS n FROM habit_entries WHERE habit_id = ?")
      .get(habitId) as { readonly n: number }
    expect(count.n).toBe(0)
  })

  it("filters a private habit and its entries out of the other member's pull", async () => {
    const h = makeHarness()
    const habitId = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: habitId,
          baseVersion: 0,
          patch: {
            title: "عادت خصوصی",
            frequency: { _tag: "daily" },
            timeZone: "UTC",
            visibility: "private"
          },
          clientUpdatedAt: "2026-10-20T04:00:00.000Z"
        }),
        entry({
          entityType: "habitEntry",
          entityId: uuidV7(),
          baseVersion: 0,
          patch: {
            habitId,
            localDate: "2026-10-20",
            timeZone: "UTC",
            status: "done",
            visibility: "private"
          },
          clientUpdatedAt: "2026-10-20T16:00:00.000Z"
        })
      ]
    })

    const own = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    expect(own.items.map((item) => item.entityType).sort()).toEqual(["habit", "habitEntry"])

    const partner = await pull(h, { userId: USER_B, householdId: HOUSEHOLD, cursor: 0 })
    expect(partner.items).toEqual([])

    const outsider = await pull(h, { userId: USER_A, householdId: HOUSEHOLD_B, cursor: 0 })
    expect(outsider.items).toEqual([])
  })

  it("keeps a private habit's log private even when the tap omits visibility", async () => {
    const h = makeHarness()
    const habitId = uuidV7()
    const entryId = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: habitId,
          baseVersion: 0,
          patch: {
            title: "عادت خصوصی",
            frequency: { _tag: "daily" },
            timeZone: "UTC",
            visibility: "private"
          },
          clientUpdatedAt: "2026-10-20T04:00:00.000Z"
        })
      ]
    })

    // The tap does not send visibility (or sends a wider one): the server must
    // inherit the habit's, not trust the patch.
    const pushed = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habitEntry",
          entityId: entryId,
          baseVersion: 0,
          patch: { habitId, localDate: "2026-10-20", timeZone: "UTC", status: "done" },
          clientUpdatedAt: "2026-10-20T16:00:00.000Z"
        })
      ]
    })
    expect(pushed.results[0]).toMatchObject({ _tag: "applied" })

    const stored = h.db
      .prepare("SELECT visibility FROM habit_entries WHERE id = ?")
      .get(entryId) as { readonly visibility: string }
    expect(stored.visibility).toBe("private")

    // The partner's mirror never receives the logged day.
    const partner = await pull(h, { userId: USER_B, householdId: HOUSEHOLD, cursor: 0 })
    expect(partner.items).toEqual([])
    expect(partner.entries).toEqual([])
  })

  it("refuses an entry whose habit is missing, trashed, private to another member, or in another household", async () => {
    const h = makeHarness()
    const privateHabit = uuidV7()
    const deletedHabit = uuidV7()
    const foreignHabit = uuidV7()

    await push(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: privateHabit,
          baseVersion: 0,
          patch: {
            title: "خصوصی",
            frequency: { _tag: "daily" },
            timeZone: "UTC",
            visibility: "private"
          }
        })
      ]
    })
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: deletedHabit,
          baseVersion: 0,
          patch: { title: "حذف‌شده", frequency: { _tag: "daily" }, timeZone: "UTC" }
        })
      ]
    })
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: deletedHabit,
          baseVersion: 1,
          op: "delete"
        })
      ]
    })
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD_B,
      entries: [
        entry({
          entityType: "habit",
          entityId: foreignHabit,
          baseVersion: 0,
          patch: { title: "خانه دیگر", frequency: { _tag: "daily" }, timeZone: "UTC" }
        })
      ]
    })

    const tap = (habitId: string, localDate: string) =>
      entry({
        entityType: "habitEntry",
        entityId: uuidV7(),
        baseVersion: 0,
        patch: { habitId, localDate, timeZone: "UTC", status: "done" }
      })

    const result = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        tap(uuidV7(), "2026-10-20"), // no such habit
        tap(deletedHabit, "2026-10-20"), // habit is in the trash
        tap(privateHabit, "2026-10-20"), // another member's private habit
        tap(foreignHabit, "2026-10-20") // another household's habit
      ]
    })
    expect(result.results.map((row) => row._tag === "rejected" ? [row.code] : row._tag)).toEqual([
      ["ParentNotFound"],
      ["ParentDeleted"],
      ["ParentForbidden"],
      ["ParentForbidden"]
    ])
    const count = h.db.prepare("SELECT COUNT(*) AS n FROM habit_entries").get() as {
      readonly n: number
    }
    expect(count.n).toBe(0)
  })

  it("rejects a bad IANA zone instead of throwing out of the push", async () => {
    const h = makeHarness()
    const habitId = uuidV7()

    // A client-supplied zone that Intl cannot resolve must be an invalid patch
    // for that entry, not a 500 that wedges the whole outbox.
    const pushed = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: habitId,
          baseVersion: 0,
          patch: {
            title: "کتاب",
            frequency: { _tag: "daily" },
            timeZone: "Mars/Olympus"
          }
        })
      ]
    })
    expect(pushed.results[0]).toMatchObject({ _tag: "rejected", code: "InvalidPatch" })

    // The same value on a frequency change is also rejected, not thrown.
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: habitId,
          baseVersion: 0,
          patch: { title: "کتاب", frequency: { _tag: "daily" }, timeZone: "UTC" }
        })
      ]
    })
    const changed = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: habitId,
          baseVersion: 1,
          patch: { frequency: { _tag: "weekly", times: 2 }, timeZone: "Mars/Olympus" }
        })
      ]
    })
    expect(changed.results[0]).toMatchObject({ _tag: "rejected", code: "InvalidPatch" })
  })

  it("rejects a malformed entry identity instead of silently substituting a default", async () => {
    const h = makeHarness()
    const habitId = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: habitId,
          baseVersion: 0,
          patch: { title: "کتاب", frequency: { _tag: "daily" }, timeZone: "UTC" }
        })
      ]
    })

    // A day the client could not express must not be replaced by "today": the
    // entry is rejected and the outbox drops it.
    const badDay = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habitEntry",
          entityId: uuidV7(),
          baseVersion: 0,
          patch: { habitId, localDate: "2026/10/20", timeZone: "UTC", status: "done" }
        })
      ]
    })
    expect(badDay.results[0]).toMatchObject({ _tag: "rejected", code: "InvalidPatch" })
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM habit_entries").get()).toEqual({ n: 0 })
  })

  it("does not grow an era for a frequency that only differs in representation", async () => {
    const h = makeHarness()
    const habitId = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: habitId,
          baseVersion: 0,
          patch: { title: "کتاب", frequency: { _tag: "daily" }, timeZone: "UTC" }
        })
      ]
    })

    // Extra keys decode away; the frequency is structurally unchanged, so the
    // merge must not append a phantom era.
    const pushed = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: habitId,
          baseVersion: 1,
          patch: { frequency: { _tag: "daily", days: [1] } }
        })
      ]
    })
    expect(pushed.results[0]).toMatchObject({ _tag: "applied", version: 2 })

    const pulled = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    const row = pulled.items.find((item) => item.entityId === habitId)!
    expect(row.data.frequencyHistory).toHaveLength(1)
    expect(row.data.frequency).toEqual({ _tag: "daily" })
  })

  it("deletes a habit through the shared tombstone path", async () => {
    const h = makeHarness()
    const habitId = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: habitId,
          baseVersion: 0,
          patch: { title: "کتاب", frequency: { _tag: "daily" }, timeZone: "UTC" },
          clientUpdatedAt: "2026-10-20T04:00:00.000Z"
        })
      ]
    })

    const deleted = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "habit",
          entityId: habitId,
          baseVersion: 1,
          op: "delete"
        })
      ]
    })
    expect(deleted.results[0]).toMatchObject({ _tag: "applied", version: 2 })

    const pulled = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    expect(pulled.items[0]?.deletedAt).toEqual(expect.any(String))
  })
})
