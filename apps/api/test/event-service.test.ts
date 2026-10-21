import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  type EventExceptionId,
  type EventId,
  type HouseholdId,
  type UserId,
  uuidV7
} from "@tali/domain"
import {
  EventService,
  EventServiceLive,
  type EventServiceApi,
  type EventViewer
} from "../src/event-service.js"
import {
  SyncService,
  SyncServiceLive
} from "../src/sync-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #57, at the service seam. These run the real service + repository +
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

const viewer = (overrides: Partial<EventViewer> = {}): EventViewer => ({
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
  const layer = Layer.mergeAll(EventServiceLive, SyncServiceLive).pipe(Layer.provide(d1))

  const run = <A, E>(effect: Effect.Effect<A, E, EventService | SyncService>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, layer))

  const svc = <A, E>(
    f: (service: EventServiceApi) => Effect.Effect<A, E, never>
  ): Promise<A> =>
    run(
      Effect.gen(function*() {
        const service = yield* EventService
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

  const rowOf = (id: string): Record<string, unknown> | undefined =>
    db.prepare("SELECT * FROM events WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined

  return { db, fake, run, svc, sync, feedCount, rowOf }
}

const timed = {
  _tag: "timed" as const,
  start: "2026-10-21T10:00:00.000Z",
  end: "2026-10-21T11:00:00.000Z"
}

const allDay = { _tag: "allDay" as const, date: "2026-10-21" }

describe("EventService", () => {
  it("creates a timed event in one batch and lands it on the change feed", async () => {
    const h = makeHarness()
    const id = uuidV7() as EventId

    const created = await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "جلسهٔ هم‌اندیشی",
          description: "برنامه‌ریزی هفته",
          location: "خانه",
          category: "work",
          people: ["سارا", "رضا"],
          timing: timed
        },
        NOW
      )
    )

    expect(created).toMatchObject({
      id,
      title: "جلسهٔ هم‌اندیشی",
      description: "برنامه‌ریزی هفته",
      location: "خانه",
      category: "work",
      people: ["سارا", "رضا"],
      timing: timed,
      timeZone: TZ,
      recurrence: null,
      exceptions: [],
      visibility: "shared",
      version: 1,
      deletedAt: null
    })

    // The row keeps the timed shape only: no all-day date.
    const row = h.rowOf(id)!
    expect(row.start_at).toBe("2026-10-21T10:00:00.000Z")
    expect(row.end_at).toBe("2026-10-21T11:00:00.000Z")
    expect(row.all_day_date).toBeNull()
    expect(row.time_zone).toBe(TZ)
    expect(row.household_id).toBe(HOUSEHOLD)

    // One batch, one feed row, one ledger row.
    expect(h.fake.batchCalls).toBe(1)
    expect(h.feedCount()).toBe(1)
    const ledger = h.db
      .prepare("SELECT entity_type AS entityType, entity_id AS entityId FROM applied_mutations")
      .all() as ReadonlyArray<{ readonly entityType: string; readonly entityId: string }>
    expect(ledger).toEqual([{ entityType: "event", entityId: id }])
  })

  it("creates an all-day event with a local date and no instants", async () => {
    const h = makeHarness()
    const id = uuidV7() as EventId

    const created = await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-allday", id, title: "تعطیلی", timing: allDay },
        NOW
      )
    )

    expect(created.timing).toEqual(allDay)
    const row = h.rowOf(id)!
    expect(row.all_day_date).toBe("2026-10-21")
    expect(row.start_at).toBeNull()
    expect(row.end_at).toBeNull()
  })

  it("round-trips the structured recurrence rule and the exception list", async () => {
    const h = makeHarness()
    const id = uuidV7() as EventId
    const recurrence = {
      frequency: "weekly" as const,
      interval: 1,
      byDay: [6],
      end: { _tag: "count" as const, count: 10 }
    }
    const exceptions = [
      {
        id: uuidV7() as EventExceptionId,
        instanceId: "2026-10-28",
        action: "override" as const,
        overrides: { title: "جلسهٔ کوتاه" },
        createdAt: NOW
      }
    ]

    const created = await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-recurring",
          id,
          title: "جلسهٔ هفتگی",
          timing: timed,
          recurrence,
          exceptions
        },
        NOW
      )
    )

    expect(created.recurrence).toEqual(recurrence)
    expect(created.exceptions).toEqual(exceptions)

    // The rule is stored as structured JSON, never as an RRULE string.
    const row = h.rowOf(id)!
    expect(JSON.parse(row.recurrence as string)).toEqual(recurrence)
    expect(JSON.parse(row.exceptions as string)).toEqual(exceptions)
  })

  it("edits an event: the timing is replaced as one unit", async () => {
    const h = makeHarness()
    const id = uuidV7() as EventId

    await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-create", id, title: "قرار", timing: timed },
        NOW
      )
    )

    const edited = await h.svc((svc) =>
      svc.update(
        viewer(),
        {
          id,
          clientMutationId: "m-edit",
          patch: { title: "قرار تازه", timing: allDay }
        },
        "2026-10-20T10:00:00.000Z"
      )
    )

    expect(edited.title).toBe("قرار تازه")
    expect(edited.timing).toEqual(allDay)
    expect(edited.version).toBe(2)

    const row = h.rowOf(id)!
    expect(row.all_day_date).toBe("2026-10-21")
    expect(row.start_at).toBeNull()
    expect(row.end_at).toBeNull()
    expect(row.title).toBe("قرار تازه")
  })

  it("keeps the stored values for the fields a patch omits", async () => {
    const h = makeHarness()
    const id = uuidV7() as EventId

    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-create",
          id,
          title: "قرار",
          description: "توضیح",
          location: "خانه",
          people: ["رضا"],
          timing: timed
        },
        NOW
      )
    )

    const patched = await h.svc((svc) =>
      svc.update(
        viewer(),
        { id, clientMutationId: "m-patch", patch: { title: "قرار تازه" } },
        "2026-10-20T10:00:00.000Z"
      )
    )

    expect(patched.title).toBe("قرار تازه")
    expect(patched.description).toBe("توضیح")
    expect(patched.location).toBe("خانه")
    expect(patched.people).toEqual(["رضا"])
    expect(patched.timing).toEqual(timed)
    expect(patched.version).toBe(2)
  })

  it("deletes an event as a tombstone and records the delete op", async () => {
    const h = makeHarness()
    const id = uuidV7() as EventId

    await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-create", id, title: "قرار", timing: timed },
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

    // A deleted event reads as gone.
    const found = await h.svc((svc) => svc.get(viewer(), id)).catch((cause: unknown) => cause)
    expect(found).toMatchObject({ _tag: "EventNotFound" })
  })

  it("is replay-safe: the same mutation id never writes twice", async () => {
    const h = makeHarness()
    const id = uuidV7() as EventId

    const first = await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-once", id, title: "قرار", timing: timed },
        NOW
      )
    )
    const replay = await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-once", id, title: "قرار دیگر", timing: timed },
        "2026-10-20T12:00:00.000Z"
      )
    )

    expect(replay.version).toBe(first.version)
    expect(replay.title).toBe("قرار")
    expect(h.feedCount()).toBe(1)
  })

  it("scopes an event to its household and its owner", async () => {
    const h = makeHarness()
    const id = uuidV7() as EventId

    await h.svc((svc) =>
      svc.create(
        viewer({ userId: USER_B }),
        {
          clientMutationId: "m-private",
          id,
          title: "قرار خصوصی",
          timing: timed,
          visibility: "private"
        },
        NOW
      )
    )

    // The other member of the same household may not read a private event.
    const forbidden = await h.svc((svc) => svc.get(viewer(), id)).catch((cause: unknown) => cause)
    expect(forbidden).toMatchObject({ _tag: "EventForbidden", reason: "private" })

    const listed = await h.svc((svc) => svc.list(viewer()))
    expect(listed.map((event) => event.id)).toEqual([])

    // The owner still sees it.
    const own = await h.svc((svc) => svc.get(viewer({ userId: USER_B }), id))
    expect(own.id).toBe(id)

    // Another household may not read it at all.
    const outsider = await h.svc((svc) =>
      svc.get(viewer({ householdId: OTHER_HOUSEHOLD }), id)
    ).catch((cause: unknown) => cause)
    expect(outsider).toMatchObject({ _tag: "EventForbidden", reason: "household" })
  })

  it("rejects an event without a title, with an inverted interval or a broken date", async () => {
    const h = makeHarness()

    const empty = await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "m-empty", title: "  ", timing: timed },
        NOW
      )
    ).catch((cause: unknown) => cause)
    expect(empty).toMatchObject({ _tag: "EventValidationError" })

    const inverted = await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-inverted",
          title: "قرار",
          timing: {
            _tag: "timed",
            start: "2026-10-21T12:00:00.000Z",
            end: "2026-10-21T10:00:00.000Z"
          }
        },
        NOW
      )
    ).catch((cause: unknown) => cause)
    expect(inverted).toMatchObject({ _tag: "EventValidationError" })

    const brokenDate = await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-broken",
          title: "قرار",
          timing: { _tag: "allDay", date: "1403/07/28" }
        },
        NOW
      )
    ).catch((cause: unknown) => cause)
    expect(brokenDate).toMatchObject({ _tag: "EventValidationError" })

    // A rule the shared recurrence schema rejects never reaches the row.
    const badRule = await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-rule",
          title: "قرار",
          timing: timed,
          recurrence: { frequency: "daily", interval: 1, byDay: [1], end: { _tag: "never" } }
        },
        NOW
      )
    ).catch((cause: unknown) => cause)
    expect(badRule).toMatchObject({ _tag: "EventValidationError" })
  })

  it("rejects two exceptions for the same occurrence", async () => {
    const h = makeHarness()
    const id = uuidV7() as EventId

    const rejected = await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-dup",
          id,
          title: "قرار",
          timing: timed,
          exceptions: [
            {
              id: uuidV7() as EventExceptionId,
              instanceId: "2026-10-28",
              action: "delete",
              overrides: null,
              createdAt: NOW
            },
            {
              id: uuidV7() as EventExceptionId,
              instanceId: "2026-10-28",
              action: "override",
              overrides: { title: "دیگر" },
              createdAt: NOW
            }
          ]
        },
        NOW
      )
    ).catch((cause: unknown) => cause)
    expect(rejected).toMatchObject({ _tag: "EventValidationError" })
  })

  it("lists the events of a date range in the viewer's zone", async () => {
    const h = makeHarness()
    const inRange = uuidV7() as EventId
    const outOfRange = uuidV7() as EventId

    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-in",
          id: inRange,
          title: "داخل بازه",
          timing: { _tag: "allDay", date: "2026-10-21" }
        },
        NOW
      )
    )
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          clientMutationId: "m-out",
          id: outOfRange,
          title: "بیرون بازه",
          timing: { _tag: "allDay", date: "2026-11-02" }
        },
        NOW
      )
    )

    const listed = await h.svc((svc) =>
      svc.list(viewer(), { from: "2026-10-20", before: "2026-10-27" })
    )
    expect(listed.map((event) => event.id)).toEqual([inRange])
  })
})
