import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  splitEventSeries,
  type EventId,
  type HouseholdId,
  type LocalDate,
  type RecurrenceRule,
  type UserId,
  uuidV7
} from "@tali/domain"
import { EventRepo, EventRepoLive } from "@tali/sql"
import {
  EventService,
  EventServiceLive,
  type EventServiceApi,
  type EventViewer
} from "../src/event-service.js"
import { SyncService, SyncServiceLive } from "../src/sync-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #58 at the service seam: the real service, repository and sync SQL on
 * SQLite (D1's engine), through a D1-shaped batch.
 *
 * The suite pins the ticket's exit criteria: a weekly event expands into every
 * occurrence of a window without writing, one occurrence can be moved or
 * deleted without changing the series, and "this and following" splits the
 * series — all of it on the #34 one-batch version/change_feed path.
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

const viewer = (overrides: Partial<EventViewer> = {}): EventViewer => ({
  userId: USER_A,
  householdId: HOUSEHOLD,
  timeZone: TZ,
  ...overrides
})

/** Wednesdays at 10:00 Tehran, ten occurrences from 2026-10-21. */
const weekly: RecurrenceRule = {
  frequency: "weekly",
  interval: 1,
  byDay: [3],
  end: { _tag: "count", count: 10 }
}

const timed = {
  _tag: "timed" as const,
  start: "2026-10-21T06:30:00.000Z",
  end: "2026-10-21T07:30:00.000Z"
}

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
  const services = Layer.mergeAll(EventServiceLive, SyncServiceLive, EventRepoLive).pipe(
    Layer.provide(d1)
  )
  // Expose the D1 client as well, so a test can drive a repo statement batch.
  const layer = Layer.merge(services, d1)

  const run = <A, E>(
    effect: Effect.Effect<A, E, EventService | SyncService | EventRepo | D1Client.D1Client>
  ): Promise<A> => Effect.runPromise(Effect.provide(effect, layer))

  const svc = <A, E>(
    f: (service: EventServiceApi) => Effect.Effect<A, E, never>
  ): Promise<A> =>
    run(
      Effect.gen(function*() {
        const service = yield* EventService
        return yield* f(service)
      })
    )

  const feed = (id: string): ReadonlyArray<Record<string, unknown>> =>
    db
      .prepare(
        "SELECT entity_type AS entityType, entity_id AS entityId, op, version FROM change_feed WHERE entity_id = ? ORDER BY seq"
      )
      .all(id) as ReadonlyArray<Record<string, unknown>>

  const ledger = (): ReadonlyArray<Record<string, unknown>> =>
    db
      .prepare(
        "SELECT client_mutation_id AS clientMutationId, entity_type AS entityType, entity_id AS entityId FROM applied_mutations ORDER BY client_mutation_id"
      )
      .all() as ReadonlyArray<Record<string, unknown>>

  const rowOf = (id: string): Record<string, unknown> | undefined =>
    db.prepare("SELECT * FROM events WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined

  return { db, fake, run, svc, feed, ledger, rowOf }
}

type Harness = ReturnType<typeof makeHarness>

const createSeries = async (
  h: Harness,
  overrides: Partial<Parameters<EventServiceApi["create"]>[1]> = {}
) => {
  const id = uuidV7() as EventId
  const created = await h.svc((svc) =>
    svc.create(
      viewer(),
      {
        clientMutationId: `m-create-${id}`,
        id,
        title: "جلسهٔ هفتگی",
        location: "خانه",
        timing: timed,
        recurrence: weekly,
        ...overrides
      },
      NOW
    )
  )
  return created
}

const occurrences = (
  h: Harness,
  from: string,
  before: string
) =>
  h.svc((svc) => svc.occurrences(viewer(), { from: from as LocalDate, before: before as LocalDate }))

describe("event recurrence — expansion", () => {
  it("shows every occurrence of a weekly series in a week without writing", async () => {
    const h = makeHarness()
    const created = await createSeries(h)
    const batchesBefore = h.fake.batchCalls

    const list = await occurrences(h, "2026-10-18", "2026-11-01")

    expect(
      list.map((occurrence) => [occurrence.instanceId, occurrence.date, occurrence.projected])
    ).toEqual([
      ["2026-10-21", "2026-10-21", false],
      ["2026-10-28", "2026-10-28", true]
    ])
    expect(list[0]!.title).toBe("جلسهٔ هفتگی")

    // Expansion is a read: no batch, no version bump, no feed row.
    expect(h.fake.batchCalls).toBe(batchesBefore)
    expect(h.feed(created.id)).toHaveLength(1)
    expect(h.rowOf(created.id)!.version).toBe(1)
  })

  it("scopes the expansion to the viewer's household and private rows", async () => {
    const h = makeHarness()
    const event = await createSeries(h, { visibility: "private" })

    const otherMember = await h.svc((svc) =>
      svc.occurrences(
        viewer({ userId: "user-b" as UserId }),
        { from: "2026-10-18" as LocalDate, before: "2026-11-01" as LocalDate }
      )
    )
    expect(otherMember).toEqual([])

    const anotherHousehold = await h.svc((svc) =>
      svc.occurrences(
        viewer({ householdId: "household-b" as HouseholdId }),
        { from: "2026-10-18" as LocalDate, before: "2026-11-01" as LocalDate }
      )
    )
    expect(anotherHousehold).toEqual([])

    const own = await occurrences(h, "2026-10-18", "2026-11-01")
    expect(own.map((occurrence) => occurrence.id)).toEqual([event.id, event.id])
  })
})

describe("event recurrence — this occurrence", () => {
  it("moves one occurrence without touching the series", async () => {
    const h = makeHarness()
    const created = await createSeries(h)

    const change = await h.svc((svc) =>
      svc.editOccurrence(
        viewer(),
        {
          id: created.id,
          instanceId: "2026-10-28" as LocalDate,
          clientMutationId: "m-move",
          scope: "thisOccurrence",
          overrides: {
            title: "جلسهٔ کوتاه",
            location: "کافه",
            timing: { _tag: "allDay", date: "2026-10-30" as LocalDate }
          }
        },
        NOW
      )
    )

    // The series is intact: same rule, same anchor timing, same title.
    expect(change.series.version).toBe(2)
    expect(change.series.title).toBe("جلسهٔ هفتگی")
    expect(change.series.timing).toEqual(timed)
    expect(change.series.recurrence).toEqual(weekly)
    expect(change.series.exceptions).toHaveLength(1)
    expect(change.following).toBeNull()

    const list = await occurrences(h, "2026-10-18", "2026-11-01")
    expect(list.map((occurrence) => [occurrence.instanceId, occurrence.date, occurrence.title])).toEqual([
      ["2026-10-21", "2026-10-21", "جلسهٔ هفتگی"],
      // The overridden occurrence keeps its key (10-28) but paints on 10-30.
      ["2026-10-28", "2026-10-30", "جلسهٔ کوتاه"]
    ])
    expect(list[1]).toMatchObject({
      projected: true,
      overridden: true,
      location: "کافه"
    })

    // One batch: a version bump and one feed row.
    expect(h.fake.batchCalls).toBe(2)
    expect(h.feed(created.id).map((row) => row.version)).toEqual([1, 2])
  })

  it("deletes one occurrence without shifting the schedule", async () => {
    const h = makeHarness()
    const created = await createSeries(h)

    const change = await h.svc((svc) =>
      svc.deleteOccurrence(
        viewer(),
        {
          id: created.id,
          instanceId: "2026-10-28" as LocalDate,
          clientMutationId: "m-skip",
          scope: "thisOccurrence"
        },
        NOW
      )
    )

    expect(change.series.exceptions[0]).toMatchObject({
      instanceId: "2026-10-28",
      action: "delete"
    })
    expect(change.series.recurrence).toEqual(weekly)
    expect(change.series.deletedAt).toBeNull()

    const list = await occurrences(h, "2026-10-18", "2026-11-08")
    expect(list.map((occurrence) => occurrence.instanceId)).toEqual([
      "2026-10-21",
      "2026-11-04"
    ])
  })

  it("patches a one-off event and tombstones it on delete", async () => {
    const h = makeHarness()
    const oneOff = await createSeries(h, { recurrence: null })

    const moved = await h.svc((svc) =>
      svc.editOccurrence(
        viewer(),
        {
          id: oneOff.id,
          instanceId: "2026-10-21" as LocalDate,
          clientMutationId: "m-one-off-move",
          scope: "thisOccurrence",
          overrides: { title: "قرار تازه" }
        },
        NOW
      )
    )
    expect(moved.series.title).toBe("قرار تازه")
    expect(moved.series.exceptions).toEqual([])
    expect(moved.series.version).toBe(2)

    const deleted = await h.svc((svc) =>
      svc.deleteOccurrence(
        viewer(),
        {
          id: oneOff.id,
          instanceId: "2026-10-21" as LocalDate,
          clientMutationId: "m-one-off-delete",
          scope: "thisOccurrence"
        },
        NOW
      )
    )
    expect(deleted.series.deletedAt).toBe(NOW)
    expect(h.feed(oneOff.id).map((row) => row.op)).toEqual(["upsert", "upsert", "delete"])
  })

  it("rejects an occurrence the rule does not generate", async () => {
    const h = makeHarness()
    const created = await createSeries(h)

    const rejected = await h.svc((svc) =>
      svc.editOccurrence(
        viewer(),
        {
          id: created.id,
          instanceId: "2026-10-22" as LocalDate,
          clientMutationId: "m-bad-day",
          scope: "thisOccurrence",
          overrides: { title: "x" }
        },
        NOW
      )
    ).catch((cause: unknown) => cause)

    expect(rejected).toMatchObject({ _tag: "EventValidationError" })

    const empty = await h.svc((svc) =>
      svc.editOccurrence(
        viewer(),
        {
          id: created.id,
          instanceId: "2026-10-28" as LocalDate,
          clientMutationId: "m-empty-edit",
          scope: "thisOccurrence",
          overrides: {}
        },
        NOW
      )
    ).catch((cause: unknown) => cause)
    expect(empty).toMatchObject({ _tag: "EventValidationError" })

    // Nothing was written.
    expect(h.feed(created.id)).toHaveLength(1)
  })
})

describe("event recurrence — this and following", () => {
  it("splits the series in one batch and keeps the schedule continuous", async () => {
    const h = makeHarness()
    const created = await createSeries(h)
    const followingId = uuidV7() as EventId
    const batchesBefore = h.fake.batchCalls

    const change = await h.svc((svc) =>
      svc.editOccurrence(
        viewer(),
        {
          id: created.id,
          instanceId: "2026-11-04" as LocalDate,
          clientMutationId: "m-split",
          followingId,
          followingMutationId: "m-split-tail",
          scope: "thisAndFollowing",
          overrides: { title: "جلسهٔ تازه", location: "دفتر" }
        },
        NOW
      )
    )

    // One batch wrote both rows.
    expect(h.fake.batchCalls).toBe(batchesBefore + 1)

    expect(change.series.id).toBe(created.id)
    expect(change.series.version).toBe(2)
    expect(change.series.recurrence).toEqual({
      ...weekly,
      end: { _tag: "until", date: "2026-11-03" }
    })
    expect(change.following).toMatchObject({
      id: followingId,
      title: "جلسهٔ تازه",
      location: "دفتر",
      version: 1,
      deletedAt: null
    })
    // Ten occurrences, two of them before the split (10-21, 10-28).
    expect(change.following!.recurrence?.end).toEqual({ _tag: "count", count: 8 })

    // Both rows are on the feed and in the ledger.
    expect(h.feed(created.id).map((row) => row.version)).toEqual([1, 2])
    expect(h.feed(followingId).map((row) => row.version)).toEqual([1])
    expect(
      h.ledger().map((row) => [row.clientMutationId, row.entityId])
    ).toEqual(
      expect.arrayContaining([
        ["m-split", created.id],
        ["m-split-tail", followingId]
      ])
    )

    // The two halves expand into one continuous weekly schedule.
    const list = await occurrences(h, "2026-10-18", "2026-12-01")
    expect(list.map((occurrence) => [occurrence.instanceId, occurrence.title])).toEqual([
      ["2026-10-21", "جلسهٔ هفتگی"],
      ["2026-10-28", "جلسهٔ هفتگی"],
      ["2026-11-04", "جلسهٔ تازه"],
      ["2026-11-11", "جلسهٔ تازه"],
      ["2026-11-18", "جلسهٔ تازه"],
      ["2026-11-25", "جلسهٔ تازه"]
    ])
    expect(list.find((occurrence) => occurrence.instanceId === "2026-11-04")?.projected).toBe(
      false
    )
  })

  it("is replay-safe: the same split never writes twice", async () => {    const h = makeHarness()
    const created = await createSeries(h)
    const followingId = uuidV7() as EventId
    const input = {
      id: created.id,
      instanceId: "2026-11-04" as LocalDate,
      clientMutationId: "m-split-once",
      followingId,
      followingMutationId: "m-split-once-tail",
      scope: "thisAndFollowing" as const,
      overrides: { title: "جلسهٔ تازه" }
    }

    const first = await h.svc((svc) => svc.editOccurrence(viewer(), input, NOW))
    const batches = h.fake.batchCalls
    const replay = await h.svc((svc) =>
      svc.editOccurrence(viewer(), input, "2026-10-20T10:00:00.000Z")
    )

    expect(replay.series.version).toBe(first.series.version)
    expect(replay.following!.version).toBe(first.following!.version)
    expect(h.fake.batchCalls).toBe(batches)
    expect(h.feed(created.id)).toHaveLength(2)
    expect(h.feed(followingId)).toHaveLength(1)
  })

  it("gates the new tail row on the old row reaching the truncated version", async () => {
    const h = makeHarness()
    const created = await createSeries(h)
    const followingId = uuidV7() as EventId
    const event = await h.svc((svc) => svc.get(viewer(), created.id))
    const split = splitEventSeries({
      event,
      instanceId: "2026-11-04" as LocalDate,
      overrides: { title: "جلسهٔ تازه" },
      followingId,
      now: NOW
    })!

    const insertTail = (gateVersion: number) =>
      h.run(
        Effect.gen(function*() {
          const repo = yield* EventRepo
          const d1 = yield* D1Client.D1Client
          yield* d1.batch([
            repo.insertStatementGated(split.following, {
              id: created.id,
              version: gateVersion
            })
          ])
        })
      )

    // The old row is still v1: a gate expecting the truncated v2 inserts
    // nothing, so a lost CAS cannot leave an orphan tail.
    await insertTail(created.version + 1)
    expect(h.rowOf(followingId)).toBeUndefined()

    await insertTail(created.version)
    expect(h.rowOf(followingId)).toBeDefined()
  })

  it("deletes this and following by truncating the series", async () => {
    const h = makeHarness()
    const created = await createSeries(h)

    const change = await h.svc((svc) =>
      svc.deleteOccurrence(
        viewer(),
        {
          id: created.id,
          instanceId: "2026-11-04" as LocalDate,
          clientMutationId: "m-cut",
          scope: "thisAndFollowing"
        },
        NOW
      )
    )

    expect(change.series.deletedAt).toBeNull()
    expect(change.series.recurrence).toEqual({
      ...weekly,
      end: { _tag: "until", date: "2026-11-03" }
    })

    const list = await occurrences(h, "2026-10-18", "2026-12-01")
    expect(list.map((occurrence) => occurrence.instanceId)).toEqual([
      "2026-10-21",
      "2026-10-28"
    ])
  })

  it("deletes the whole series when this and following starts at the first occurrence", async () => {
    const h = makeHarness()
    const created = await createSeries(h)

    const change = await h.svc((svc) =>
      svc.deleteOccurrence(
        viewer(),
        {
          id: created.id,
          instanceId: "2026-10-21" as LocalDate,
          clientMutationId: "m-cut-all",
          scope: "thisAndFollowing"
        },
        NOW
      )
    )

    expect(change.series.deletedAt).toBe(NOW)
    expect(h.feed(created.id).map((row) => row.op)).toEqual(["upsert", "delete"])
    expect(await occurrences(h, "2026-10-18", "2026-12-01")).toEqual([])
  })
})
