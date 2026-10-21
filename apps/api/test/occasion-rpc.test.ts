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
import { OccasionServiceLive } from "../src/occasion-service.js"
import { PreferencesServiceLive } from "../src/preferences-service.js"
import { RpcHandlers } from "../src/rpc-handlers.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #59 at the RPC seam: the derived client drives the occasion aggregate
 * over the real handler map, with the session cookie in the request headers —
 * the path the browser takes.
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)
const NOW = new Date().toISOString()
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()

const TOKEN_A = "occasion-token-a"
const TOKEN_C = "occasion-token-c"
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

  seedUser(USER_A, "occasion-a@example.com")
  seedUser(USER_C, "occasion-c@example.com")
  db.prepare(
    `INSERT INTO households (id, name, invite_code, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(HOUSEHOLD, "خانه", "occasion-invite", USER_A, NOW)
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
    OccasionServiceLive,
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

describe("Occasion RPC round-trip", () => {
  it("creates, projects, reminds and prepares through the shared contract", async () => {
    const h = await makeHarness()
    const id = uuidV7()

    const result = await h.withClient(TOKEN_A, (client) =>
      Effect.gen(function*() {
        const created = yield* client.CreateOccasion({
          id,
          clientMutationId: "rpc-occasion-create",
          title: "تولد مامان",
          originDate: "1990-04-01",
          advanceReminderDays: 7,
          color: "#f4b6c2"
        })
        const occurrences = yield* client.ListOccasionOccurrences({
          from: "2026-04-01",
          to: "2026-04-30"
        })
        const reminders = yield* client.ListOccasionReminders({
          from: "2026-03-20",
          to: "2026-03-31"
        })
        const detail = yield* client.GetOccasion({ id })
        const prepared = yield* client.PrepareOccasionTask({
          id,
          clientMutationId: "rpc-occasion-prepare"
        })
        const listed = yield* client.ListOccasions()
        return { created, occurrences, reminders, detail, prepared, listed }
      })
    )

    expect(result.created).toMatchObject({
      id,
      title: "تولد مامان",
      originDate: "1990-04-01",
      yearly: true,
      advanceReminderDays: 7,
      color: "#f4b6c2",
      version: 1
    })
    expect(result.occurrences).toHaveLength(1)
    expect(result.occurrences[0]?.jalali).toEqual({ year: 1405, month: 1, day: 12 })
    expect(result.reminders[0]).toMatchObject({
      dueDate: "2026-03-25",
      fireAt: "2026-03-25T05:30:00Z",
      link: { _tag: "occasion", occasionId: id }
    })
    expect(result.detail.next?.jalali).toEqual({ year: 1406, month: 1, day: 12 })
    expect(result.prepared.created).toBe(true)
    expect(result.prepared.occasion.preparationTaskId).toBe(result.prepared.task.id)
    const nextDate = result.detail.next!.date
    const dueDate = result.prepared.task.dueDate!
    expect(Date.parse(`${dueDate}T00:00:00Z`) + 7 * 86_400_000).toBe(
      Date.parse(`${nextDate}T00:00:00Z`)
    )
    expect(result.listed.map((occasion) => occasion.id)).toEqual([id])
  })

  it("maps a member without a household to OccasionForbidden", async () => {
    const h = await makeHarness()

    const failure = await h
      .withClient(TOKEN_C, (client) =>
        client.CreateOccasion({
          clientMutationId: "rpc-occasion-no-household",
          title: "تولد",
          originDate: "1990-04-01"
        })
      )
      .catch((cause: unknown) => cause)

    expect(failure).toMatchObject({ _tag: "OccasionForbidden", reason: "noHousehold" })
  })
})
