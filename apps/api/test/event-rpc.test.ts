import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import { RpcClient, RpcGroup } from "effect/rpc"
import * as RpcTest from "effect/rpc/RpcTest"
import { ApiRpcs } from "@tali/rpc"
import { uuidV7 } from "@tali/domain"
import { AuthServiceLive } from "../src/auth-service.js"
import { EventServiceLive } from "../src/event-service.js"
import { PreferencesServiceLive } from "../src/preferences-service.js"
import { RpcHandlers } from "../src/rpc-handlers.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #58 at the RPC seam: the derived client drives the event aggregate and
 * the occurrence edits over the real handler map, with the session cookie in the
 * request headers — the path the browser takes.
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)
const NOW = new Date().toISOString()
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()

const TOKEN_A = "event-token-a"
const TOKEN_C = "event-token-c"
const USER_A = uuidV7()
const USER_C = uuidV7()
const HOUSEHOLD = uuidV7()

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex")

const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort()

const makeHarness = async () => {
  const db = new DatabaseSync(":memory:")
  for (const file of migrationFiles()) {
    db.exec(readFileSync(fileURLToPath(new URL(file, MIGRATIONS_DIR)), "utf8"))
  }

  const seedUser = (id: string, email: string): void => {
    db.prepare(
      `INSERT INTO users
        (id, email, credential_verifier, credential_salt, kdf_version,
         display_name, time_zone, week_start, digits, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, 'Asia/Tehran', 'saturday', 'persian', ?, ?)`
    ).run(id, email, "0".repeat(64), "0".repeat(32), email, NOW, NOW)
  }
  const seedSession = (userId: string, token: string): void => {
    db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(uuidV7(), userId, sha256(token), FUTURE, NOW)
  }

  seedUser(USER_A, "event-a@example.com")
  seedUser(USER_C, "event-c@example.com")
  db.prepare(
    `INSERT INTO households (id, name, invite_code, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(HOUSEHOLD, "خانه", "event-invite", USER_A, NOW)
  db.prepare(
    `INSERT INTO memberships (id, household_id, user_id, role, joined_at)
     VALUES (?, ?, ?, 'owner', ?)`
  ).run(uuidV7(), HOUSEHOLD, USER_A, NOW)
  seedSession(USER_A, TOKEN_A)
  seedSession(USER_C, TOKEN_C)

  const d1 = D1Client.layer({
    db: new FakeD1(db).asD1Database(),
    transformQueryNames: Str.camelToSnake,
    transformResultNames: Str.snakeToCamel
  })
  const layer = Layer.mergeAll(
    RpcHandlers,
    EventServiceLive,
    AuthServiceLive,
    PreferencesServiceLive
  ).pipe(Layer.provide(d1))

  const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, layer))

  type TestClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ApiRpcs>>

  const withClient = <A, E>(
    token: string,
    f: (client: TestClient) => Effect.Effect<A, E>
  ): Promise<A> =>
    run(
      Effect.scoped(
        Effect.gen(function*() {
          const client = yield* RpcTest.makeClient(ApiRpcs)
          return yield* RpcClient.withHeaders({ cookie: `tali_session=${token}` })(f(client))
        })
      )
    )

  return { db, withClient }
}

const timed = {
  _tag: "timed" as const,
  start: "2026-10-21T06:30:00.000Z",
  end: "2026-10-21T07:30:00.000Z"
}

describe("Event RPC round-trip", () => {
  it("creates a series, moves one occurrence and splits the rest", async () => {
    const h = await makeHarness()
    const id = uuidV7()
    const followingId = uuidV7()

    const result = await h.withClient(TOKEN_A, (client) =>
      Effect.gen(function*() {
        const created = yield* client.CreateEvent({
          id,
          clientMutationId: "rpc-event-create",
          title: "جلسهٔ هفتگی",
          timing: timed,
          location: "خانه",
          recurrence: {
            frequency: "weekly",
            interval: 1,
            byDay: [3],
            end: { _tag: "count", count: 10 }
          }
        })
        const week = yield* client.ListEventOccurrences({
          from: "2026-10-18",
          before: "2026-11-01"
        })
        const moved = yield* client.EditEventOccurrence({
          id,
          instanceId: "2026-10-21",
          clientMutationId: "rpc-event-move",
          scope: "thisOccurrence",
          overrides: { title: "جلسهٔ کوتاه" }
        })
        const skipped = yield* client.DeleteEventOccurrence({
          id,
          instanceId: "2026-10-28",
          clientMutationId: "rpc-event-skip",
          scope: "thisOccurrence"
        })
        const split = yield* client.EditEventOccurrence({
          id,
          instanceId: "2026-11-04",
          clientMutationId: "rpc-event-split",
          followingId,
          followingMutationId: "rpc-event-split-tail",
          scope: "thisAndFollowing",
          overrides: { title: "جلسهٔ تازه", location: "دفتر" }
        })
        const listed = yield* client.ListEvents({})
        const current = yield* client.GetEvent({ id: followingId })
        return { created, week, moved, skipped, split, listed, current }
      })
    )

    expect(result.created.version).toBe(1)
    expect(result.week.map((occurrence) => occurrence.instanceId)).toEqual([
      "2026-10-21",
      "2026-10-28"
    ])
    expect(result.moved.series.exceptions[0]).toMatchObject({
      instanceId: "2026-10-21",
      action: "override",
      overrides: { title: "جلسهٔ کوتاه" }
    })
    expect(result.skipped.series.exceptions.map((exception) => exception.action)).toEqual([
      "override",
      "delete"
    ])
    expect(result.split.series.recurrence?.end).toEqual({
      _tag: "until",
      date: "2026-11-03"
    })
    expect(result.split.following).toMatchObject({
      id: followingId,
      title: "جلسهٔ تازه",
      location: "دفتر",
      version: 1
    })
    expect(result.listed.map((event) => event.id).sort()).toEqual([id, followingId].sort())
    expect(result.current.id).toBe(followingId)
  })

  it("maps a member without a household to EventForbidden", async () => {
    const h = await makeHarness()

    const failure = await h
      .withClient(TOKEN_C, (client) =>
        client.CreateEvent({
          clientMutationId: "rpc-event-no-household",
          title: "قرار",
          timing: timed
        })
      )
      .catch((cause: unknown) => cause)

    expect(failure).toMatchObject({ _tag: "EventForbidden", reason: "noHousehold" })
  })
})
