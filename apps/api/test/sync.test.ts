import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  uuidV7,
  type SyncEntityRow,
  type SyncEntityType,
  type SyncBootstrapResponse,
  type SyncPullResponse,
  type SyncPushEntry
} from "@tali/domain"
import { NoteSearchService, NoteSearchServiceLive } from "../src/note-search-service.js"
import {
  MAX_ISOLATION_BATCHES,
  SyncService,
  SyncServiceLive
} from "../src/sync-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * The sync-engine suite: #18's two-device convergence for the dummy aggregate,
 * extended by #34 to the per-entity registry (Task alongside the legacy
 * listItem), plus visibility/authorization, dedupe, CAS and bootstrap.
 *
 * These run the real service + repository SQL against SQLite (D1's engine),
 * through a D1-shaped batch so atomicity and `last_insert_rowid()` behave like
 * production. "Devices" are independent cursors/outboxes hitting the same
 * server, which is exactly what two browsers do.
 */

const MIGRATIONS = [
  "0001_list_items.sql",
  "0002_auth.sql",
  "0003_sync_engine.sql",
  "0005_core_planning.sql",
  "0007_task_recurrence.sql",
  "0008_list_last_writer.sql",
  "0009_note_search.sql",
  "0010_events.sql",
  "0011_habits.sql",
  "0012_reminders.sql",
  "0013_occasions.sql"
]
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
  const layer = Layer.mergeAll(NoteSearchServiceLive, SyncServiceLive).pipe(
    Layer.provide(d1)
  )

  const run = <A>(
    effect: Effect.Effect<A, unknown, SyncService | NoteSearchService>
  ): Promise<A> => Effect.runPromise(Effect.provide(effect, layer))

  return { db, fake, run }
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

const bootstrap = (
  harness: Harness,
  input: {
    readonly userId: string
    readonly householdId: string
    readonly offset?: number
    readonly limit?: number
  }
): Promise<SyncBootstrapResponse> =>
  harness.run(
    Effect.gen(function*() {
      const sync = yield* SyncService
      return yield* sync.bootstrap(input)
    })
  )

const entry = (input: {
  readonly entityType?: SyncEntityType
  readonly entityId: string
  readonly baseVersion: number
  readonly patch?: Record<string, unknown>
  readonly op?: "upsert" | "delete"
  readonly at?: string
  readonly clientMutationId?: string
}): SyncPushEntry => ({
  clientMutationId: input.clientMutationId ?? uuidV7(),
  entityType: input.entityType ?? "listItem",
  entityId: input.entityId,
  baseVersion: input.baseVersion,
  op: input.op ?? "upsert",
  patch: input.patch ?? {},
  clientUpdatedAt: input.at ?? NOW()
})

/**
 * A full-size push chunk of listItems, with the listed positions replaced by
 * tasks whose project parent does not exist — permanent FK constraint
 * failures. Task and listItem share a dependency rank, so input order (and
 * therefore the position under test) is preserved.
 */
const isolationChunk = (count: number, poisonAt: ReadonlyArray<number>) => {
  const poisoned = new Set(poisonAt)
  const ids = Array.from({ length: count }, () => uuidV7())
  const entries = ids.map((entityId, index) =>
    poisoned.has(index)
      ? entry({
        entityType: "task",
        entityId,
        baseVersion: 0,
        patch: { title: `poison-${index}`, projectId: uuidV7() }
      })
      : entry({ entityId, baseVersion: 0, patch: { title: `ok-${index}` } })
  )
  return { ids, entries }
}

const itemOf = (page: SyncPullResponse, entityId: string) =>
  page.items.find((item) => item.entityId === entityId)

const feedCount = (db: DatabaseSync): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM change_feed").get() as { readonly n: number }).n

const appliedCount = (db: DatabaseSync): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM applied_mutations").get() as { readonly n: number }).n

/** The stored search row, exactly as FTS5 holds it (folded values). */
const noteIndex = (
  db: DatabaseSync,
  noteId: string
): { readonly searchTitle: string; readonly searchBody: string } | undefined =>
  db
    .prepare(
      "SELECT search_title AS searchTitle, search_body AS searchBody FROM notes_fts WHERE note_id = ?"
    )
    .get(noteId) as
    | { readonly searchTitle: string; readonly searchBody: string }
    | undefined

/** Note ids the search service returns, scoped like the UI's viewer. */
const searchNotes = (
  harness: Harness,
  query: string
): Promise<ReadonlyArray<string>> =>
  harness.run(
    Effect.gen(function*() {
      const search = yield* NoteSearchService
      const result = yield* search.search(
        { userId: USER_A, householdId: HOUSEHOLD },
        query
      )
      return result.hits.map((hit) => hit.id)
    })
  )

/** Insert a note through the push path (the way the web app writes). */
const insertNote = (
  harness: Harness,
  id: string,
  input?: { readonly title?: string; readonly plainText?: string }
) =>
  push(harness, {
    userId: USER_A,
    householdId: HOUSEHOLD,
    entries: [
      entry({
        entityType: "note",
        entityId: id,
        baseVersion: 0,
        patch: {
          title: input?.title ?? "خرید",
          plainText: input?.plainText ?? "نان و پنیر",
          body: { type: "doc" }
        }
      })
    ]
  })

/** A device as the client engine models it: a cursor plus a mirror. */
interface Device {
  readonly userId: string
  cursor: number
  readonly mirror: Map<string, SyncEntityRow>
}

const device = (userId: string): Device => ({ userId, cursor: 0, mirror: new Map() })

/** One client reconcile pass: pull every page, merge it, advance the cursor. */
const syncDevice = async (harness: Harness, current: Device): Promise<void> => {
  for (;;) {
    const page = await pull(harness, {
      userId: current.userId,
      householdId: HOUSEHOLD,
      cursor: current.cursor
    })
    for (const item of page.items) current.mirror.set(item.entityId, item)
    for (const removed of page.removed) current.mirror.delete(removed.entityId)
    current.cursor = page.nextCursor
    if (!page.hasMore) return
  }
}

describe("sync engine", () => {
  it("converges two devices after offline edits on both sides", async () => {
    const h = makeHarness()
    const a = device(USER_A)
    const b = device(USER_B)
    const id = uuidV7()

    // Device A creates while offline, then pushes and syncs.
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
    await syncDevice(h, a)
    await syncDevice(h, b)
    expect(a.mirror.get(id)?.data.title).toBe("خرید نان")
    expect(b.mirror.get(id)?.data.title).toBe("خرید نان")

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
    expect(bResult.results[0]?.seq).toBeGreaterThan(0)

    // Each device pulls the delta from its own cursor (a push never advances
    // the cursor — see the client engine), then renders the same bytes.
    await syncDevice(h, a)
    await syncDevice(h, b)

    const fromA = a.mirror.get(id)
    const fromB = b.mirror.get(id)
    expect(fromA).toEqual(fromB)
    expect(fromA?.data).toMatchObject({ title: "نان تازه", checked: true })
    expect(fromA?.version).toBe(3)
    expect(a.cursor).toBe(b.cursor)
  })

  it("never reports applied when a concurrent writer wins the compare-and-set", async () => {
    const h = makeHarness()
    const id = uuidV7()
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 0, patch: { title: "اول" } })]
    })
    const before = feedCount(h.db)

    // Simulate the race the pre-read cannot see: another writer commits after
    // our pre-read (baseVersion 1) but before our batch.
    h.fake.beforeBatch = () => {
      h.fake.beforeBatch = undefined
      h.db.prepare(
        "UPDATE list_items SET version = version + 1, title = ?, updated_at = ? WHERE id = ?"
      ).run("نوشته‌ی همسر", NOW(), id)
    }

    const mutation = entry({
      entityId: id,
      baseVersion: 1,
      patch: { title: "نوشته‌ی من" },
      at: FUTURE()
    })
    await expect(
      push(h, { userId: USER_A, householdId: HOUSEHOLD, entries: [mutation] })
    ).rejects.toMatchObject({ _tag: "SyncContended" })

    // The losing push wrote no feed entry and no ledger row, so it is safe to retry.
    expect(feedCount(h.db)).toBe(before)
    expect(appliedCount(h.db)).toBe(1)

    // The retry resolves against fresh state instead of silently dropping the edit.
    const retry = await push(h, { userId: USER_A, householdId: HOUSEHOLD, entries: [mutation] })
    expect(retry.results[0]?._tag).toBe("conflict")
    expect(retry.results[0]?.item?.data.title).toBe("نوشته‌ی من")
    expect(feedCount(h.db)).toBe(before + 1)
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

  it("refuses to write rows outside the pusher's household (including unclaimed rows)", async () => {
    const h = makeHarness()
    const foreign = uuidV7()
    const legacy = uuidV7()
    const now = NOW()

    h.db.exec(`
      INSERT INTO list_items
        (id, title, checked, sort_order, version, created_at, updated_at, deleted_at,
         owner_id, visibility, household_id)
      VALUES
        ('${foreign}', 'خانه‌ی دیگر', 0, 0, 1, '${now}', '${now}', NULL,
         '${USER_C}', 'shared', '${HOUSEHOLD_B}'),
        ('${legacy}', 'پیش از سینک', 0, 0, 1, '${now}', '${now}', NULL,
         '', 'shared', NULL)
    `)
    const before = feedCount(h.db)

    for (const entityId of [foreign, legacy]) {
      for (const op of ["upsert", "delete"] as const) {
        await expect(
          push(h, {
            userId: USER_A,
            householdId: HOUSEHOLD,
            entries: [entry({ entityId, baseVersion: 1, op, patch: { title: "نفوذ" } })]
          })
        ).rejects.toMatchObject({ _tag: "SyncEntityForbidden" })
      }
    }

    expect(feedCount(h.db)).toBe(before)
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

  it("pages bootstrap by the global order across registry chunks", async () => {
    const h = makeHarness()
    const taskEarly = uuidV7()
    const noteMiddle = uuidV7()
    const taskThird = uuidV7()
    const occasionFourth = uuidV7()
    const noteFifth = uuidV7()
    const taskLast = uuidV7()
    const at = (day: number) => `2026-01-0${day}T00:00:00.000Z`

    // Rows are spread across three compound-SELECT chunks (tasks, notes,
    // occasions) and interleaved in time. A per-chunk `LIMIT limit + 1`
    // instead of the page-end prefix would drop the last rows here.
    h.db.exec(`
      INSERT INTO tasks (id, title, owner_id, household_id, created_at, updated_at, version)
      VALUES
        ('${taskEarly}', 'اول', '${USER_A}', '${HOUSEHOLD}', '${at(1)}', '${at(1)}', 1),
        ('${taskThird}', 'سوم', '${USER_A}', '${HOUSEHOLD}', '${at(3)}', '${at(3)}', 1),
        ('${taskLast}', 'ششم', '${USER_A}', '${HOUSEHOLD}', '${at(6)}', '${at(6)}', 1);
      INSERT INTO notes (id, title, owner_id, household_id, created_at, updated_at, version)
      VALUES
        ('${noteMiddle}', 'دوم', '${USER_A}', '${HOUSEHOLD}', '${at(2)}', '${at(2)}', 1),
        ('${noteFifth}', 'پنجم', '${USER_A}', '${HOUSEHOLD}', '${at(5)}', '${at(5)}', 1);
      INSERT INTO occasions
        (id, title, owner_id, household_id, origin_date, created_at, updated_at, version)
      VALUES
        ('${occasionFourth}', 'چهارم', '${USER_A}', '${HOUSEHOLD}', '2026-01-04',
         '${at(4)}', '${at(4)}', 1)
    `)

    const second = await bootstrap(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      offset: 1,
      limit: 1
    })
    expect(second.items.map((item) => item.entityId)).toEqual([noteMiddle])
    expect(second.nextOffset).toBe(2)
    expect(second.hasMore).toBe(true)

    // Walk every offset: proves the per-chunk prefix is deep enough for a
    // page that starts past each chunk's first few rows.
    const expected = [taskEarly, noteMiddle, taskThird, occasionFourth, noteFifth, taskLast]
    const seen: Array<string> = []
    for (let offset = 0; offset < expected.length; offset += 1) {
      const page = await bootstrap(h, {
        userId: USER_A,
        householdId: HOUSEHOLD,
        offset,
        limit: 1
      })
      seen.push(...page.items.map((item) => item.entityId))
      expect(page.nextOffset).toBe(offset + 1)
      expect(page.hasMore).toBe(offset < expected.length - 1)
    }
    expect(seen).toEqual(expected)
  })

  it("still requires a reset when every feed entry is outside the window", async () => {
    const h = makeHarness()
    const first = uuidV7()
    const second = uuidV7()
    const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()

    // The entire feed has aged out: without a retained high-water marker the
    // cursor's staleness would be undetectable and those rows silently missing.
    h.db.exec(`
      INSERT INTO list_items
        (id, title, checked, sort_order, version, created_at, updated_at, deleted_at,
         owner_id, visibility, household_id)
      VALUES
        ('${first}', 'اول', 0, 0, 1, '${longAgo}', '${longAgo}', NULL,
         '${USER_A}', 'shared', '${HOUSEHOLD}'),
        ('${second}', 'دوم', 0, 0, 1, '${longAgo}', '${longAgo}', NULL,
         '${USER_A}', 'shared', '${HOUSEHOLD}')
    `)
    h.db.exec(`
      INSERT INTO change_feed
        (household_id, entity_type, entity_id, op, version, updated_at, owner_id, visibility)
      VALUES
        ('${HOUSEHOLD}', 'listItem', '${first}', 'upsert', 1, '${longAgo}', '${USER_A}', 'shared'),
        ('${HOUSEHOLD}', 'listItem', '${second}', 'upsert', 1, '${longAgo}', '${USER_A}', 'shared')
    `)

    const stale = await pull(h, { userId: USER_B, householdId: HOUSEHOLD, cursor: 0 })
    expect(stale.resetRequired).toBe(true)

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
    expect(boot.items.map((item) => item.entityId).sort()).toEqual([first, second].sort())
    expect(boot.cursor).toBe(2)

    // Bootstrapping once is enough: the retained marker keeps it from looping.
    const next = await pull(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      cursor: boot.cursor
    })
    expect(next.resetRequired).toBe(false)
    expect(next.entries).toHaveLength(0)
  })

  // ── #34: the registry, exercised through Task alongside the legacy listItem ──

  it("converges a Task edited offline on both devices", async () => {
    const h = makeHarness()
    const a = device(USER_A)
    const b = device(USER_B)
    const id = uuidV7()

    // A creates the task offline and pushes it.
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "task",
          entityId: id,
          baseVersion: 0,
          patch: { title: "خرید هدیه", dueDate: "2026-10-22" }
        })
      ]
    })
    await syncDevice(h, a)
    await syncDevice(h, b)
    expect(a.mirror.get(id)?.data.status).toBe("todo")
    expect(b.mirror.get(id)?.data.title).toBe("خرید هدیه")

    // A renames offline; B completes it offline. Neither has seen the other.
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({ entityType: "task", entityId: id, baseVersion: 1, patch: { title: "خرید کادو" } })
      ]
    })
    const bResult = await push(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "task",
          entityId: id,
          baseVersion: 1,
          patch: { status: "done" },
          at: FUTURE()
        })
      ]
    })
    expect(bResult.results[0]?._tag).toBe("conflict")
    expect(bResult.results[0]?.item?.data.status).toBe("done")
    // The completion stamp is server-side and part of the synced row.
    expect(bResult.results[0]?.item?.data.completedAt).toEqual(expect.any(String))

    await syncDevice(h, a)
    await syncDevice(h, b)

    const fromA = a.mirror.get(id)
    const fromB = b.mirror.get(id)
    expect(fromA).toEqual(fromB)
    // Field-level LWW: A's rename and B's completion both survive.
    expect(fromA?.data).toMatchObject({ title: "خرید کادو", status: "done" })
    expect(fromA?.version).toBe(3)
    expect(a.cursor).toBe(b.cursor)
  })

  it("lets a task completion beat a concurrent rename (done-wins)", async () => {
    const h = makeHarness()
    const id = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityType: "task", entityId: id, baseVersion: 0, patch: { title: "اول" } })]
    })
    await push(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "task",
          entityId: id,
          baseVersion: 1,
          patch: { status: "done" },
          at: FUTURE()
        })
      ]
    })
    // A's rename is *newer* than the completion but must not reopen the task.
    const rename = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "task",
          entityId: id,
          baseVersion: 1,
          patch: { title: "دوم" },
          at: new Date(Date.now() + 120_000).toISOString()
        })
      ]
    })
    expect(rename.results[0]?._tag).toBe("conflict")
    expect(rename.results[0]?.item?.data).toMatchObject({ title: "دوم", status: "done" })

    // Replying against the current version can still reopen it (not a conflict).
    const reopen = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({ entityType: "task", entityId: id, baseVersion: 3, patch: { status: "todo" } })
      ]
    })
    expect(reopen.results[0]?._tag).toBe("applied")
    expect(reopen.results[0]?.item?.data.status).toBe("todo")
    expect(reopen.results[0]?.item?.data.completedAt).toBeNull()
  })

  it("authorizes Task rows: private owner-only, shared household-wide, foreign unwritable", async () => {
    const h = makeHarness()
    const shared = uuidV7()
    const priv = uuidV7()
    const foreign = uuidV7()
    const now = NOW()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({ entityType: "task", entityId: shared, baseVersion: 0, patch: { title: "مشترک" } }),
        entry({
          entityType: "task",
          entityId: priv,
          baseVersion: 0,
          patch: { title: "خصوصی", visibility: "private" }
        })
      ]
    })
    h.db.exec(`
      INSERT INTO tasks (id, title, owner_id, household_id, created_at, updated_at, version)
      VALUES ('${foreign}', 'خانه‌ی دیگر', '${USER_C}', '${HOUSEHOLD_B}', '${now}', '${now}', 1)
    `)

    const forB = await pull(h, { userId: USER_B, householdId: HOUSEHOLD, cursor: 0 })
    expect(forB.items.filter((item) => item.entityType === "task").map((item) => item.entityId))
      .toEqual([shared])
    expect(forB.removed).toContainEqual({ entityType: "task", entityId: priv })

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
    expect(boot.items.filter((item) => item.entityType === "task").map((item) => item.entityId))
      .toEqual([shared])

    // A spouse's private task is not writable.
    for (const op of ["upsert", "delete"] as const) {
      await expect(
        push(h, {
          userId: USER_B,
          householdId: HOUSEHOLD,
          entries: [
            entry({ entityType: "task", entityId: priv, baseVersion: 1, op, patch: { title: "نفوذ" } })
          ]
        })
      ).rejects.toMatchObject({ _tag: "SyncEntityForbidden" })
    }

    // A shared task is.
    const edit = await push(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      entries: [
        entry({ entityType: "task", entityId: shared, baseVersion: 1, patch: { title: "از سوی همسر" } })
      ]
    })
    expect(edit.results[0]?._tag).toBe("applied")
    expect(edit.results[0]?.item?.data.title).toBe("از سوی همسر")

    // A row in another household is never writable, even when shared.
    await expect(
      push(h, {
        userId: USER_A,
        householdId: HOUSEHOLD,
        entries: [
          entry({ entityType: "task", entityId: foreign, baseVersion: 1, patch: { title: "نفوذ" } })
        ]
      })
    ).rejects.toMatchObject({ _tag: "SyncEntityForbidden" })

    // B's own private task exists for B only.
    const own = uuidV7()
    await push(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "task",
          entityId: own,
          baseVersion: 0,
          patch: { title: "مال من", visibility: "private" }
        })
      ]
    })
    const forA = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    expect(forA.items.map((item) => item.entityId)).not.toContain(own)
  })

  it("returns a retryable conflict when a Task loses the compare-and-set", async () => {
    const h = makeHarness()
    const id = uuidV7()
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityType: "task", entityId: id, baseVersion: 0, patch: { title: "اول" } })]
    })
    const before = feedCount(h.db)

    // Another writer commits after our pre-read (baseVersion 1) but before our batch.
    h.fake.beforeBatch = () => {
      h.fake.beforeBatch = undefined
      h.db.prepare(
        "UPDATE tasks SET version = version + 1, title = ?, updated_at = ? WHERE id = ?"
      ).run("نوشته‌ی همسر", NOW(), id)
    }

    const mutation = entry({
      entityType: "task",
      entityId: id,
      baseVersion: 1,
      patch: { title: "نوشته‌ی من" },
      at: FUTURE()
    })
    await expect(
      push(h, { userId: USER_A, householdId: HOUSEHOLD, entries: [mutation] })
    ).rejects.toMatchObject({ _tag: "SyncContended" })
    expect(feedCount(h.db)).toBe(before)

    const retry = await push(h, { userId: USER_A, householdId: HOUSEHOLD, entries: [mutation] })
    expect(retry.results[0]?._tag).toBe("conflict")
    expect(retry.results[0]?.item?.data.title).toBe("نوشته‌ی من")
    expect(feedCount(h.db)).toBe(before + 1)
  })

  it("hydrates every registered aggregate on pull and bootstrap", async () => {
    const h = makeHarness()
    const ids: Record<string, string> = {
      task: uuidV7(),
      project: uuidV7(),
      tag: uuidV7(),
      list: uuidV7(),
      listItem: uuidV7(),
      note: uuidV7(),
      event: uuidV7()
    }
    const patches: Record<string, Record<string, unknown>> = {
      task: { title: "کار", dueDate: "2026-10-22" },
      project: { title: "خانه" },
      tag: { name: "فوری" },
      list: { title: "هفتگی" },
      listItem: { title: "شیر", checked: false, sortOrder: 0 },
      note: { title: "ایده", body: { type: "doc" }, plainText: "ایده" },
      event: {
        title: "قرار",
        timing: { _tag: "allDay", date: "2026-10-22" },
        timeZone: "Asia/Tehran"
      }
    }
    const types = Object.keys(ids) as ReadonlyArray<SyncEntityType>

    const result = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: types.map((entityType) =>
        entry({ entityType, entityId: ids[entityType]!, baseVersion: 0, patch: patches[entityType]! })
      )
    })
    expect(result.results.every((entry) => entry._tag === "applied")).toBe(true)
    // Every entry of the push lands in ONE D1 batch (§4.2).
    expect(h.fake.batchCalls).toBe(1)

    const page = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    for (const entityType of types) {
      const item = page.items.find((row) => row.entityType === entityType)
      expect(item?.entityId).toBe(ids[entityType])
    }
    const task = page.items.find((row) => row.entityType === "task")
    expect(task?.data).toMatchObject({ title: "کار", status: "todo", priority: "medium", timeZone: "UTC" })
    const note = page.items.find((row) => row.entityType === "note")
    expect(note?.data.body).toEqual({ type: "doc" })
    const list = page.items.find((row) => row.entityType === "list")
    expect(list?.data).toMatchObject({ title: "هفتگی", sort: "manual", checkedPlacement: "bottom" })

    const boot = await h.run(
      Effect.gen(function*() {
        const sync = yield* SyncService
        return yield* sync.bootstrap({
          userId: USER_A,
          householdId: HOUSEHOLD,
          offset: 0,
          limit: 500
        })
      })
    )
    expect(boot.items.map((item) => item.entityType).sort()).toEqual([...types].sort())
  })

  it("keeps the legacy listItem wire shape and dual-writes the real columns", async () => {
    const h = makeHarness()
    const id = uuidV7()
    const listId = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 0, patch: { title: "نان", checked: true, sortOrder: 3 } })]
    })
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 1, patch: { checked: false, listId } })]
    })

    const page = await pull(h, { userId: USER_A, householdId: HOUSEHOLD, cursor: 0 })
    const item = page.items.find((row) => row.entityId === id)
    // No web change: the wire payload stays title/checked/sortOrder.
    expect(item?.data).toMatchObject({ title: "نان", checked: false, sortOrder: 3, listId })

    const row = h.db
      .prepare("SELECT name, done, ordering, checked_at, list_id FROM list_items WHERE id = ?")
      .get(id) as {
        readonly name: string
        readonly done: number
        readonly ordering: number
        readonly checked_at: string | null
        readonly list_id: string | null
      }
    // …and the real #33 columns move with it (retires the one-way dual-write).
    expect(row).toMatchObject({ name: "نان", done: 0, ordering: 3, checked_at: null, list_id: listId })
  })

  it("chunks IN lookups below D1's bound-parameter ceiling", async () => {
    const h = makeHarness()
    // More refs than one statement may bind: the dedupe pre-read, the entity
    // hydration and a full pull/bootstrap page all build `IN` lists.
    const ids = Array.from({ length: 150 }, () => uuidV7())

    const pushed = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: ids.map((entityId) => entry({ entityId, baseVersion: 0, patch: { title: entityId } }))
    })
    expect(pushed.results).toHaveLength(ids.length)
    expect(pushed.results.every((result) => result._tag === "applied")).toBe(true)

    const page = await pull(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      cursor: 0,
      limit: 500
    })
    expect(page.items).toHaveLength(ids.length)

    const boot = await h.run(
      Effect.gen(function*() {
        const sync = yield* SyncService
        return yield* sync.bootstrap({
          userId: USER_A,
          householdId: HOUSEHOLD,
          offset: 0,
          limit: 500
        })
      })
    )
    expect(boot.items).toHaveLength(ids.length)
    expect(new Set(boot.items.map((item) => item.entityId)).size).toBe(ids.length)
  })

  it("rejects an entity type with no registry definition", async () => {
    // Every current `ItemType` now has a registry entry (occasion was the last
    // one), so this guards the seam a future aggregate crosses: its enum value
    // can exist on the wire before its definition lands. The cast models that
    // pre-registration state; the service must still refuse it, not fall
    // through to a missing definition.
    const h = makeHarness()
    await expect(
      push(h, {
        userId: USER_A,
        householdId: HOUSEHOLD,
        entries: [
          entry({
            entityType: "attachment" as SyncEntityType,
            entityId: uuidV7(),
            baseVersion: 0,
            patch: { title: "پیوست" }
          })
        ]
      })
    ).rejects.toMatchObject({ _tag: "UnsupportedSyncEntity", entityType: "attachment" })
  })

  it("guards patch values and rejects an insert the aggregate cannot accept", async () => {
    const h = makeHarness()

    // A value that fails its field guard is dropped, not written: the default applies.
    const guarded = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "task",
          entityId: uuidV7(),
          baseVersion: 0,
          patch: { title: "کار", status: "archived", ownerId: "someone-else" }
        })
      ]
    })
    expect(guarded.results[0]?._tag).toBe("applied")
    expect(guarded.results[0]?.item?.data).toMatchObject({ status: "todo", ownerId: USER_A })

    // A task cannot exist without a title (FR-TASK-01); the schema rejects it
    // as a *per-entry* rejection, so the valid entry in the same push applies.
    const before = feedCount(h.db)
    const valid = uuidV7()
    const rejected = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({ entityType: "task", entityId: uuidV7(), baseVersion: 0, patch: { title: "" } }),
        entry({ entityType: "listItem", entityId: valid, baseVersion: 0, patch: { title: "سالم" } })
      ]
    })
    expect(rejected.results[0]).toMatchObject({ _tag: "rejected", code: "InvalidPatch" })
    expect(rejected.results[1]?._tag).toBe("applied")
    expect(rejected.results[1]?.item?.data.title).toBe("سالم")
    expect(feedCount(h.db)).toBe(before + 1)
  })

  // ── M4: one unappliable entry must not wedge the outbox chunk ──────────────

  it("rejects a duplicate live tag name without wedging the rest of the push", async () => {
    const h = makeHarness()
    const existing = uuidV7()
    const duplicate = uuidV7()

    // The spouse's tag is already live in the household.
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({ entityType: "tag", entityId: existing, baseVersion: 0, patch: { name: "فوری" } })
      ]
    })
    const beforeFeed = feedCount(h.db)
    const beforeApplied = appliedCount(h.db)

    const mutation = entry({
      entityType: "tag",
      entityId: duplicate,
      baseVersion: 0,
      patch: { name: "فوری" }
    })
    const healthy = uuidV7()
    const result = await push(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      entries: [
        mutation,
        entry({
          entityType: "listItem",
          entityId: healthy,
          baseVersion: 0,
          patch: { title: "سالم" }
        })
      ]
    })

    // The duplicate tag is rejected on its own; the healthy entry still applies.
    expect(result.results).toHaveLength(2)
    expect(result.results[0]).toMatchObject({
      _tag: "rejected",
      code: "UniqueViolation",
      entityId: duplicate
    })
    expect(result.results[1]?._tag).toBe("applied")
    expect(result.results[1]?.entityId).toBe(healthy)
    // Exactly one feed row and one ledger row came from the healthy entry.
    expect(feedCount(h.db)).toBe(beforeFeed + 1)
    expect(appliedCount(h.db)).toBe(beforeApplied + 1)
    // The duplicate id never landed; the spouse's row is still the only tag.
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM tags").get() as { readonly n: number }).n).toBe(1)

    // Replaying the rejected entry is a no-op, and the next pass is not wedged.
    const replay = await push(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      entries: [mutation]
    })
    expect(replay.results[0]).toMatchObject({ _tag: "rejected", code: "UniqueViolation" })
    expect(feedCount(h.db)).toBe(beforeFeed + 1)
    expect(appliedCount(h.db)).toBe(beforeApplied + 1)

    const after = uuidV7()
    const next = await push(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      entries: [
        entry({ entityType: "listItem", entityId: after, baseVersion: 0, patch: { title: "بعدی" } })
      ]
    })
    expect(next.results[0]?._tag).toBe("applied")
  })

  it("orders parents before children so a project+task push succeeds in one batch", async () => {
    const h = makeHarness()
    const projectId = uuidV7()
    const taskId = uuidV7()

    // The task arrives first in the request but its FK parent is also here.
    const result = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "task",
          entityId: taskId,
          baseVersion: 0,
          patch: { title: "کار", projectId }
        }),
        entry({
          entityType: "project",
          entityId: projectId,
          baseVersion: 0,
          patch: { title: "خانه" }
        })
      ]
    })

    expect(result.results.map((row) => row._tag)).toEqual(["applied", "applied"])
    // Ordering inside the one batch is what makes the FK satisfiable.
    expect(h.fake.batchCalls).toBe(1)
    const task = h.db
      .prepare("SELECT project_id FROM tasks WHERE id = ?")
      .get(taskId) as { readonly project_id: string }
    expect(task.project_id).toBe(projectId)
  })

  it("rejects a task whose project parent is missing instead of failing the request", async () => {
    const h = makeHarness()
    const taskId = uuidV7()
    const healthy = uuidV7()
    const before = feedCount(h.db)

    const result = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "task",
          entityId: taskId,
          baseVersion: 0,
          patch: { title: "یتیم", projectId: uuidV7() }
        }),
        entry({
          entityType: "listItem",
          entityId: healthy,
          baseVersion: 0,
          patch: { title: "سالم" }
        })
      ]
    })

    expect(result.results[0]).toMatchObject({
      _tag: "rejected",
      code: "ForeignKeyViolation",
      entityId: taskId
    })
    expect(result.results[1]?._tag).toBe("applied")
    expect(feedCount(h.db)).toBe(before + 1)
    expect(
      (h.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id = ?").get(taskId) as { readonly n: number }).n
    ).toBe(0)
  })

  // ── M4 follow-up: bounded bisection, not an O(entries) isolation sweep ─────

  it("isolates one poison entry among 200 within MAX_ISOLATION_BATCHES", async () => {
    const h = makeHarness()

    // The happy path is unchanged: a full chunk still commits in one batch.
    const healthy = Array.from({ length: 200 }, () => uuidV7())
    const happy = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: healthy.map((entityId) =>
        entry({ entityId, baseVersion: 0, patch: { title: entityId } })
      )
    })
    expect(happy.results.every((result) => result._tag === "applied")).toBe(true)
    expect(h.fake.batchCalls).toBe(1)

    h.fake.batchCalls = 0
    const beforeFeed = feedCount(h.db)
    const beforeApplied = appliedCount(h.db)
    const { ids, entries } = isolationChunk(200, [100])

    const result = await push(h, { userId: USER_A, householdId: HOUSEHOLD, entries })

    expect(result.results).toHaveLength(200)
    expect(result.results[100]).toMatchObject({
      _tag: "rejected",
      code: "ForeignKeyViolation",
      entityId: ids[100]
    })
    expect(result.results.filter((row) => row._tag === "applied")).toHaveLength(199)
    // Bisection needs 16 batches for one bad entry in 200 — not 201.
    expect(h.fake.batchCalls).toBe(16)
    expect(h.fake.batchCalls).toBeLessThanOrEqual(MAX_ISOLATION_BATCHES)
    expect(feedCount(h.db)).toBe(beforeFeed + 199)
    expect(appliedCount(h.db)).toBe(beforeApplied + 199)
  })

  it("isolates a poison entry in first, middle and last position", async () => {
    const h = makeHarness()

    for (const position of [0, 100, 199]) {
      h.fake.batchCalls = 0
      const { ids, entries } = isolationChunk(200, [position])
      const result = await push(h, { userId: USER_A, householdId: HOUSEHOLD, entries })

      expect(result.results[position]).toMatchObject({
        _tag: "rejected",
        code: "ForeignKeyViolation",
        entityId: ids[position]
      })
      expect(result.results.filter((row) => row._tag === "applied")).toHaveLength(199)
      expect(h.fake.batchCalls).toBeLessThanOrEqual(MAX_ISOLATION_BATCHES)
    }
  })

  it("isolates two poison entries without a per-entry sweep", async () => {
    const h = makeHarness()
    const beforeFeed = feedCount(h.db)
    const beforeApplied = appliedCount(h.db)
    const { ids, entries } = isolationChunk(200, [0, 199])

    const result = await push(h, { userId: USER_A, householdId: HOUSEHOLD, entries })

    expect(result.results[0]).toMatchObject({
      _tag: "rejected",
      code: "ForeignKeyViolation",
      entityId: ids[0]
    })
    expect(result.results[199]).toMatchObject({
      _tag: "rejected",
      code: "ForeignKeyViolation",
      entityId: ids[199]
    })
    expect(result.results.filter((row) => row._tag === "applied")).toHaveLength(198)
    // Two bad entries at opposite ends of the chunk: 31 batches, still bounded.
    expect(h.fake.batchCalls).toBe(31)
    expect(h.fake.batchCalls).toBeLessThanOrEqual(MAX_ISOLATION_BATCHES)
    expect(feedCount(h.db)).toBe(beforeFeed + 198)
    expect(appliedCount(h.db)).toBe(beforeApplied + 198)
  })

  it("returns AttributionLimit instead of wedging when the batch budget is exhausted", async () => {
    const h = makeHarness()
    const { entries } = isolationChunk(200, [0, 100, 199])

    const result = await push(h, { userId: USER_A, householdId: HOUSEHOLD, entries })

    // The push still completes: no retryable failure, no unbounded fan-out.
    expect(result.results).toHaveLength(200)
    expect(h.fake.batchCalls).toBe(MAX_ISOLATION_BATCHES)
    expect(result.results.every((row) => row._tag === "applied" || row._tag === "rejected")).toBe(true)
    const limited = result.results.filter(
      (row) => row._tag === "rejected" && row.code === "AttributionLimit"
    )
    expect(limited.length).toBeGreaterThan(0)
    // Every entry the server said it applied is in the feed and ledger exactly once.
    const applied = result.results.filter((row) => row._tag === "applied").length
    expect(feedCount(h.db)).toBe(applied)
    expect(appliedCount(h.db)).toBe(applied)
  })

  it("propagates a non-constraint failure from the attribution path as retryable", async () => {
    const h = makeHarness()
    const { entries } = isolationChunk(200, [100])

    // The full batch fails on the poison's constraint; the very next
    // attribution batch hits a transient network failure. That must escape as
    // retryable, never as a per-entry rejection the client would ack.
    let seen = 0
    h.fake.beforeBatch = () => {
      seen += 1
      if (seen === 2) throw new Error("D1_ERROR: network connection lost: NETWORK")
    }

    await expect(
      push(h, { userId: USER_A, householdId: HOUSEHOLD, entries })
    ).rejects.toMatchObject({ _tag: "SqlError" })
    expect(feedCount(h.db)).toBe(0)
    expect(appliedCount(h.db)).toBe(0)

    h.fake.beforeBatch = undefined
    h.fake.batchCalls = 0
    const retry = await push(h, { userId: USER_A, householdId: HOUSEHOLD, entries })
    expect(retry.results.filter((row) => row._tag === "applied")).toHaveLength(199)
    expect(retry.results[100]?._tag).toBe("rejected")
    expect(h.fake.batchCalls).toBeLessThanOrEqual(MAX_ISOLATION_BATCHES)
  })

  it("replays a partially isolated push exactly once", async () => {
    const h = makeHarness()
    const { entries } = isolationChunk(200, [100])

    const first = await push(h, { userId: USER_A, householdId: HOUSEHOLD, entries })
    expect(first.results.filter((row) => row._tag === "applied")).toHaveLength(199)
    const feedAfterFirst = feedCount(h.db)
    const appliedAfterFirst = appliedCount(h.db)

    h.fake.batchCalls = 0
    const replay = await push(h, { userId: USER_A, householdId: HOUSEHOLD, entries })
    expect(replay.results.filter((row) => row._tag === "alreadyApplied")).toHaveLength(199)
    expect(replay.results[100]).toMatchObject({
      _tag: "rejected",
      code: "ForeignKeyViolation"
    })
    expect(feedCount(h.db)).toBe(feedAfterFirst)
    expect(appliedCount(h.db)).toBe(appliedAfterFirst)
    // Only the rejected entry was re-attempted.
    expect(h.fake.batchCalls).toBe(2)
  })

  it("keeps a delete tombstone retryable when the row appears after the pre-read", async () => {
    const h = makeHarness()
    const id = uuidV7()

    // A `delete` for an unseen row is inserted as a tombstone. Another writer
    // creates that row between our pre-read and our batch, so the insert is
    // suppressed by ON CONFLICT DO NOTHING. That is a lost race, not an
    // unappliable entry: the retry sees the live row and deletes it.
    h.fake.beforeBatch = () => {
      h.fake.beforeBatch = undefined
      h.db
        .prepare(
          `INSERT INTO list_items
             (id, title, checked, sort_order, version, created_at, updated_at, deleted_at,
              household_id, owner_id, visibility, type, done, ordering, tag_ids)
           VALUES (?, ?, 0, 0, 1, ?, ?, NULL, ?, ?, 'shared', 'listItem', 0, 0, '[]')`
        )
        .run(id, "همسر", NOW(), NOW(), HOUSEHOLD, USER_B)
    }

    const mutation = entry({ entityId: id, baseVersion: 0, op: "delete", patch: {} })
    await expect(
      push(h, { userId: USER_A, householdId: HOUSEHOLD, entries: [mutation] })
    ).rejects.toMatchObject({ _tag: "SyncContended" })
    expect(feedCount(h.db)).toBe(0)

    // The retry resolves against the row that now exists and tombstones it,
    // instead of silently dropping the user's delete.
    const retry = await push(h, { userId: USER_A, householdId: HOUSEHOLD, entries: [mutation] })
    expect(retry.results[0]?._tag).toBe("applied")
    expect(retry.results[0]?.item?.deletedAt).not.toBeNull()
  })

  it("keeps non-constraint failures retryable instead of rejecting the entry", async () => {
    const h = makeHarness()
    const id = uuidV7()

    // A transient D1 failure must not be isolated into a per-entry rejection:
    // that would tell the client to drop a mutation that is perfectly valid.
    h.fake.beforeBatch = () => {
      h.fake.beforeBatch = undefined
      throw new Error("D1_ERROR: network connection lost: NETWORK")
    }

    const mutation = entry({ entityId: id, baseVersion: 0, patch: { title: "سالم" } })
    await expect(
      push(h, { userId: USER_A, householdId: HOUSEHOLD, entries: [mutation] })
    ).rejects.toMatchObject({ _tag: "SqlError" })
    expect(feedCount(h.db)).toBe(0)
    expect(appliedCount(h.db)).toBe(0)

    const retry = await push(h, { userId: USER_A, householdId: HOUSEHOLD, entries: [mutation] })
    expect(retry.results[0]?._tag).toBe("applied")
  })

  // ── Note search index: no rewrite when the text cannot change ────────────

  it("indexes an inserted note in the write's own batch", async () => {
    const h = makeHarness()
    const id = uuidV7()
    await insertNote(h, id)

    expect(h.fake.batchStatementCounts).toEqual([5])
    expect(noteIndex(h.db, id)).toEqual({
      searchTitle: "خرید",
      searchBody: "نان و پنیر"
    })
    expect(await searchNotes(h, "پنیر")).toEqual([id])
  })

  it("keeps the search row untouched for pin, tag and archive changes", async () => {
    const h = makeHarness()
    const id = uuidV7()
    await insertNote(h, id)
    const indexed = noteIndex(h.db, id)
    expect(indexed).toBeDefined()

    const tagIds = [uuidV7(), uuidV7()]
    const metadataChanges = [
      { patch: { isPinned: true }, column: "is_pinned", expected: 1 },
      {
        patch: { tagIds },
        column: "tag_ids",
        expected: JSON.stringify(tagIds)
      },
      { patch: { isArchived: true }, column: "is_archived", expected: 1 }
    ] as const

    let baseVersion = 1
    for (const change of metadataChanges) {
      const beforeFeed = feedCount(h.db)
      h.fake.batchStatementCounts.length = 0

      const result = await push(h, {
        userId: USER_A,
        householdId: HOUSEHOLD,
        entries: [
          entry({
            entityType: "note",
            entityId: id,
            baseVersion,
            patch: change.patch
          })
        ]
      })

      expect(result.results[0]?._tag).toBe("applied")
      // Row + feed + ledger. The FTS delete/insert pair is skipped because
      // title and plainText are unchanged (5 statements → 3).
      expect(h.fake.batchStatementCounts).toEqual([3])
      // The note row still lands and the feed still tells other devices.
      const row = h.db
        .prepare(`SELECT ${change.column} AS value FROM notes WHERE id = ?`)
        .get(id) as { readonly value: unknown }
      expect(row.value).toEqual(change.expected)
      expect(feedCount(h.db)).toBe(beforeFeed + 1)
      expect(noteIndex(h.db, id)).toEqual(indexed)

      baseVersion += 1
    }
  })

  it("re-indexes a title-only change and finds the note by the new title", async () => {
    const h = makeHarness()
    const id = uuidV7()
    await insertNote(h, id)
    h.fake.batchStatementCounts.length = 0

    const result = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "note",
          entityId: id,
          baseVersion: 1,
          patch: { title: "سفر" }
        })
      ]
    })

    expect(result.results[0]?._tag).toBe("applied")
    expect(h.fake.batchStatementCounts).toEqual([5])
    expect((await searchNotes(h, "سفر"))).toEqual([id])
    expect((await searchNotes(h, "خرید"))).toEqual([])
    expect(noteIndex(h.db, id)?.searchTitle).toBe("سفر")
    // The body was merged, not dropped, so its text is still searchable.
    expect((await searchNotes(h, "پنیر"))).toEqual([id])
  })

  it("re-indexes a body-only change and finds the note by the new text", async () => {
    const h = makeHarness()
    const id = uuidV7()
    await insertNote(h, id)
    h.fake.batchStatementCounts.length = 0

    const result = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityType: "note",
          entityId: id,
          baseVersion: 1,
          patch: { plainText: "بلیط هواپیما", body: { type: "doc" } }
        })
      ]
    })

    expect(result.results[0]?._tag).toBe("applied")
    expect(h.fake.batchStatementCounts).toEqual([5])
    expect((await searchNotes(h, "بلیط"))).toEqual([id])
    expect((await searchNotes(h, "پنیر"))).toEqual([])
    expect(noteIndex(h.db, id)?.searchBody).toBe("بلیط هواپیما")
    // The title was merged, not dropped, so its text is still searchable.
    expect((await searchNotes(h, "خرید"))).toEqual([id])
  })

  it("requires a reset for a non-zero cursor against an empty feed", async () => {
    const h = makeHarness()
    // The trash purge can remove the last feed row at ~30 days; a mirror that
    // still holds the purged row must be told to re-bootstrap.
    h.db.exec("DELETE FROM change_feed")

    const fresh = await pull(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      cursor: 0
    })
    expect(fresh.resetRequired).toBe(false)

    const stale = await pull(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      cursor: 7
    })
    expect(stale.resetRequired).toBe(true)
    expect(stale.entries).toEqual([])
    expect(stale.nextCursor).toBe(7)
  })
})
