import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  uuidV7,
  type SyncPullResponse,
  type SyncPushEntry
} from "@tali/domain"
import { SyncService, SyncServiceLive } from "../src/sync-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * The exit criterion for #18: two devices converge for the dummy aggregate
 * after offline edits on both sides.
 *
 * These run the real service + repository SQL against SQLite (D1's engine),
 * through a D1-shaped batch so atomicity and `last_insert_rowid()` behave like
 * production. "Devices" are independent cursors/outboxes hitting the same
 * server, which is exactly what two browsers do.
 */

const MIGRATIONS = ["0001_list_items.sql", "0002_auth.sql", "0003_sync_engine.sql"]
const NOW = (): string => new Date().toISOString()
const PAST = "2020-01-01T00:00:00.000Z"
const FUTURE = (): string => new Date(Date.now() + 60_000).toISOString()

const HOUSEHOLD = "household-a"
const USER_A = "user-a"
const USER_B = "user-b"
const HOUSEHOLD_B = "household-b"
const USER_C = "user-c"

const makeHarness = () => {
  const db = new DatabaseSync(":memory:")
  const dir = new URL("../../../packages/sql/migrations/", import.meta.url)
  for (const file of MIGRATIONS) {
    db.exec(readFileSync(fileURLToPath(new URL(file, dir)), "utf8"))
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

  return { db, run }
}

type Harness = ReturnType<typeof makeHarness>

const pull = (
  harness: Harness,
  input: { readonly userId: string; readonly householdId: string; readonly cursor: number; readonly limit?: number }
): Promise<SyncPullResponse> =>
  harness.run(
    Effect.gen(function*() {
      const sync = yield* SyncService
      return yield* sync.pull(input)
    })
  )

const push = (
  harness: Harness,
  input: { readonly userId: string; readonly householdId: string; readonly entries: ReadonlyArray<SyncPushEntry> }
) =>
  harness.run(
    Effect.gen(function*() {
      const sync = yield* SyncService
      return yield* sync.push(input)
    })
  )

const entry = (input: {
  readonly entityId: string
  readonly baseVersion: number
  readonly patch?: Record<string, unknown>
  readonly op?: "upsert" | "delete"
  readonly at?: string
  readonly clientMutationId?: string
}): SyncPushEntry => ({
  clientMutationId: input.clientMutationId ?? uuidV7(),
  entityType: "listItem",
  entityId: input.entityId,
  baseVersion: input.baseVersion,
  op: input.op ?? "upsert",
  patch: input.patch ?? {},
  clientUpdatedAt: input.at ?? NOW()
})

const itemOf = (page: SyncPullResponse, entityId: string) =>
  page.items.find((item) => item.entityId === entityId)

const feedCount = (db: DatabaseSync): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM change_feed").get() as { readonly n: number }).n

describe("sync engine", () => {
  it("converges two devices after offline edits on both sides", async () => {
    const h = makeHarness()
    const id = uuidV7()

    // Device A creates while offline, then pushes.
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityId: id,
          baseVersion: 0,
          patch: { title: "خرید نان", checked: false, sortOrder: 0 }
        })
      ]
    })

    // Both devices drain the feed to their own cursors.
    const aStart = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    const bStart = await pull(h, { userId: USER_B, householdId: HOUSEHOLD, cursor: 0 })
    expect(itemOf(aStart, id)?.data.title).toBe("خرید نان")
    expect(itemOf(bStart, id)?.data.title).toBe("خرید نان")

    // A renames offline; B checks it off offline. Neither has seen the other.
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 1, patch: { title: "نان تازه" } })]
    })
    const bResult = await push(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 1, patch: { checked: true } })]
    })
    expect(bResult.results[0]?._tag).toBe("conflict")

    // Each device now pulls the delta from its own cursor.
    const aDelta = await pull(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      cursor: aStart.nextCursor
    })
    const bDelta = await pull(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      cursor: bStart.nextCursor
    })
    expect(aDelta.nextCursor).toBeGreaterThanOrEqual(bDelta.nextCursor)
    expect(aDelta.hasMore).toBe(false)

    // Convergence: same bytes on both devices, both edits preserved.
    const aItem = itemOf(aDelta, id)
    const bItem = itemOf(bDelta, id)
    expect(aItem).toEqual(bItem)
    expect(aItem?.data).toMatchObject({ title: "نان تازه", checked: true })
    expect(aItem?.version).toBe(3)
  })

  it("resolves same-field races by field-level LWW against the row updatedAt", async () => {
    const h = makeHarness()
    const id = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 0, patch: { title: "اول" } })]
    })

    // A's stale edit is older than the row's server updatedAt: it loses.
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 1, patch: { title: "قدیمی" }, at: PAST })]
    })

    // B's stale edit is newer: it wins the same field.
    const winner = await push(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 1, patch: { title: "تازه" }, at: FUTURE() })]
    })
    expect(winner.results[0]?._tag).toBe("conflict")

    // A third stale, older edit loses and writes no feed entry.
    const before = feedCount(h.db)
    const loser = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 1, patch: { title: "خیلی قدیمی" }, at: PAST })]
    })
    expect(loser.results[0]?._tag).toBe("conflict")
    expect(loser.results[0]?.seq).toBe(0)
    expect(feedCount(h.db)).toBe(before)

    const page = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    expect(itemOf(page, id)?.data.title).toBe("تازه")
  })

  it("makes delete win over a concurrent edit (tombstone + recoverable trash)", async () => {
    const h = makeHarness()
    const id = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 0, patch: { title: "حذف‌شدنی" } })]
    })

    // B edits while A deletes; the edit is applied first.
    await push(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 1, patch: { title: "ویرایش" }, at: FUTURE() })]
    })
    const deleted = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 2, op: "delete" })]
    })
    expect(deleted.results[0]?._tag).toBe("applied")

    // An offline edit arriving after the tombstone never resurrects the row.
    const resurrect = await push(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 2, patch: { title: "بازگشت" }, at: FUTURE() })]
    })
    expect(resurrect.results[0]?._tag).toBe("tombstone")

    const page = await pull(h, { userId: USER_B, householdId: HOUSEHOLD, cursor: 0 })
    expect(itemOf(page, id)?.deletedAt).not.toBeNull()
  })

  it("dedupes a replayed push: same mutation id, one feed entry", async () => {
    const h = makeHarness()
    const id = uuidV7()
    const mutation = entry({
      entityId: id,
      baseVersion: 0,
      patch: { title: "یک‌بار" }
    })

    const first = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [mutation]
    })
    const before = feedCount(h.db)
    const replay = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [mutation]
    })

    expect(first.results[0]?._tag).toBe("applied")
    expect(replay.results[0]?._tag).toBe("alreadyApplied")
    expect(replay.results[0]?.seq).toBe(first.results[0]?.seq)
    expect(feedCount(h.db)).toBe(before)
  })

  it("scopes the feed to the household and turns a private flip into a removal", async () => {
    const h = makeHarness()
    const shared = uuidV7()
    const priv = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({ entityId: shared, baseVersion: 0, patch: { title: "مشترک" } }),
        entry({
          entityId: priv,
          baseVersion: 0,
          patch: { title: "خصوصی", visibility: "private" }
        })
      ]
    })

    const forB = await pull(h, { userId: USER_B, householdId: HOUSEHOLD, cursor: 0 })
    expect(forB.entries.map((item) => item.entityId)).toEqual([shared])
    expect(forB.items.map((item) => item.entityId)).toEqual([shared])
    // DP-9: the spouse's private row is "remove from mirror", not invisible.
    expect(forB.removed).toContainEqual({ entityType: "listItem", entityId: priv })

    const forA = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    expect(forA.entries.map((item) => item.entityId)).toEqual([shared, priv])
    expect(forA.removed).toHaveLength(0)

    // A different household never sees this feed at all.
    const other = uuidV7()
    await push(h, {
      userId: USER_C,
      householdId: HOUSEHOLD_B,
      entries: [entry({ entityId: other, baseVersion: 0, patch: { title: "خانه‌ی دیگر" } })]
    })
    const scoped = await pull(h, { userId: USER_C, householdId: HOUSEHOLD_B, cursor: 0 })
    expect(scoped.entries.map((item) => item.entityId)).toEqual([other])
  })

  it("paginates pull and resumes exactly at the last returned seq", async () => {
    const h = makeHarness()
    const ids = [uuidV7(), uuidV7(), uuidV7()]
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: ids.map((entityId) => entry({ entityId, baseVersion: 0, patch: { title: entityId } }))
    })

    const first = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0, limit: 2 })
    expect(first.entries).toHaveLength(2)
    expect(first.hasMore).toBe(true)

    const second = await pull(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      cursor: first.nextCursor,
      limit: 2
    })
    expect(second.entries).toHaveLength(1)
    expect(second.hasMore).toBe(false)
    expect([
      ...first.entries.map((item) => item.entityId),
      ...second.entries.map((item) => item.entityId)
    ]).toEqual(ids)
  })

  it("flags a cursor older than the 90-day feed window and bootstraps live rows", async () => {
    const h = makeHarness()
    const old = uuidV7()
    const recent = uuidV7()
    const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()

    // A row whose feed entry is already outside the retained window (seq 1).
    h.db.exec(`
      INSERT INTO list_items
        (id, title, checked, sort_order, version, created_at, updated_at, deleted_at,
         owner_id, visibility, household_id)
      VALUES
        ('${old}', 'کهنه', 0, 0, 1, '${longAgo}', '${longAgo}', NULL,
         '${USER_A}', 'shared', '${HOUSEHOLD}')
    `)
    h.db.exec(`
      INSERT INTO change_feed
        (household_id, entity_type, entity_id, op, version, updated_at, owner_id, visibility)
      VALUES
        ('${HOUSEHOLD}', 'listItem', '${old}', 'upsert', 1, '${longAgo}', '${USER_A}', 'shared')
    `)

    // A recent push lands at seq 2; pruning leaves seq 2 as the oldest row.
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: recent, baseVersion: 0, patch: { title: "تازه" } })]
    })

    const stale = await pull(h, { userId: USER_B, householdId: HOUSEHOLD, cursor: 0 })
    expect(stale.resetRequired).toBe(true)
    expect(stale.entries).toHaveLength(0)
    expect(stale.nextCursor).toBe(0)

    const boot = await h.run(
      Effect.gen(function*() {
        const sync = yield* SyncService
        return yield* sync.bootstrap({
          userId: USER_B,
          householdId: HOUSEHOLD,
          offset: 0,
          limit: 500
        })
      })
    )
    // Bootstrap recovers the aged-out live row as well as the recent one.
    expect(boot.items.map((item) => item.entityId).sort()).toEqual([old, recent].sort())
    expect(boot.cursor).toBe(2)

    // The client can then continue incrementally from the bootstrap cursor.
    const next = await pull(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      cursor: boot.cursor
    })
    expect(next.resetRequired).toBe(false)
    expect(next.entries).toHaveLength(0)
  })
})
