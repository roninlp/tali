import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import { type SyncPullResponse, type SyncPushEntry, uuidV7 } from "@tali/domain"
import { SyncService, SyncServiceLive } from "../src/sync-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #60 at the sync seam: a reminder has to travel through the real push
 * and pull path — the same path the web client's outbox uses — so the registry
 * entry, the wire shape (repeat union + flattened link + derived tier) and the
 * household/visibility filter are exercised together.
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
  readonly entityId: string
  readonly baseVersion: number
  readonly patch?: Record<string, unknown>
  readonly op?: "upsert" | "delete"
  readonly clientMutationId?: string
  readonly clientUpdatedAt?: string
}): SyncPushEntry => ({
  clientMutationId: input.clientMutationId ?? uuidV7(),
  entityType: "reminder",
  entityId: input.entityId,
  baseVersion: input.baseVersion,
  op: input.op ?? "upsert",
  patch: input.patch ?? {},
  clientUpdatedAt: input.clientUpdatedAt ?? new Date().toISOString()
})

const reminderPatch = {
  title: "دارو",
  kind: "medication",
  repeat: { _tag: "daily", time: "22:00" },
  fireAt: "2026-10-20T18:30:00.000Z",
  offsetMinutes: 0,
  link: { _tag: "none" },
  timeZone: "Asia/Tehran"
}

describe("reminder sync", () => {
  it("carries a reminder from /sync/push to /sync/pull with a derived tier", async () => {
    const h = makeHarness()
    const id = uuidV7()

    const pushed = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 0, patch: reminderPatch })]
    })
    expect(pushed.results[0]).toMatchObject({ _tag: "applied", entityId: id, version: 1 })

    const pulled = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    const row = pulled.items.find((item) => item.entityId === id)
    expect(row).toMatchObject({
      entityType: "reminder",
      deletedAt: null,
      data: {
        title: "دارو",
        kind: "medication",
        tier: "critical",
        repeat: { _tag: "daily", time: "22:00" },
        fireAt: "2026-10-20T18:30:00.000Z",
        link: { _tag: "none" },
        timeZone: "Asia/Tehran"
      }
    })
    expect(
      (h.db.prepare("SELECT tier FROM reminders WHERE id = ?").get(id) as { readonly tier: string })
        .tier
    ).toBe("critical")
  })

  it("round-trips a task link through the flattened columns", async () => {
    const h = makeHarness()
    const id = uuidV7()
    const taskId = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityId: id,
          baseVersion: 0,
          patch: {
            ...reminderPatch,
            kind: "chore",
            repeat: { _tag: "once" },
            offsetMinutes: 30,
            link: { _tag: "task", taskId }
          }
        })
      ]
    })

    const pulled = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    const row = pulled.items.find((item) => item.entityId === id)
    expect(row?.data).toMatchObject({
      tier: "normal",
      offsetMinutes: 30,
      link: { _tag: "task", taskId }
    })
    expect(
      (h.db.prepare("SELECT link_type, link_id FROM reminders WHERE id = ?").get(id) as {
        readonly link_type: string
        readonly link_id: string
      })
    ).toMatchObject({ link_type: "task", link_id: taskId })
  })

  it("honours private visibility in the household pull", async () => {
    const h = makeHarness()
    const id = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityId: id,
          baseVersion: 0,
          patch: { ...reminderPatch, visibility: "private" }
        })
      ]
    })

    const other = await pull(h, { userId: USER_B, householdId: HOUSEHOLD, cursor: 0 })
    expect(other.items.find((item) => item.entityId === id)).toBeUndefined()
    const foreign = await pull(h, { userId: USER_A, householdId: HOUSEHOLD_B, cursor: 0 })
    expect(foreign.items.find((item) => item.entityId === id)).toBeUndefined()
  })

  it("derives a pattern reminder's fireAt when an offline create omits it", async () => {
    const h = makeHarness()
    const id = uuidV7()
    const clientUpdatedAt = "2026-10-20T09:30:00.000Z"

    const pushed = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityId: id,
          baseVersion: 0,
          clientUpdatedAt,
          patch: {
            title: "هر روز",
            kind: "general",
            repeat: { _tag: "daily", time: "22:00" },
            timeZone: "Asia/Tehran"
          }
        })
      ]
    })
    expect(pushed.results[0]).toMatchObject({ _tag: "applied", version: 1 })

    // 22:00 Tehran on the edit day — not the edit instant, which is what the
    // old fallback stored (and what would fire immediately on the next sweep).
    const pulled = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    const row = pulled.items.find((item) => item.entityId === id)
    expect(row?.data).toMatchObject({ fireAt: "2026-10-20T18:30:00.000Z" })
    expect(
      (h.db.prepare("SELECT fire_at FROM reminders WHERE id = ?").get(id) as {
        readonly fire_at: string
      }).fire_at
    ).toBe("2026-10-20T18:30:00.000Z")
  })

  it("carries a delete-only tombstone", async () => {
    const h = makeHarness()
    const id = uuidV7()
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 0, patch: reminderPatch })]
    })
    const deleted = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityId: id,
          baseVersion: 1,
          op: "delete",
          patch: { deletedAt: new Date().toISOString() }
        })
      ]
    })
    expect(deleted.results[0]).toMatchObject({ _tag: "applied", version: 2 })

    const pulled = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    const row = pulled.items.find((item) => item.entityId === id)
    expect(row?.deletedAt).not.toBeNull()
  })
})
