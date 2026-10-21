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
import { PreferencesServiceLive } from "../src/preferences-service.js"
import { ReminderServiceLive } from "../src/reminder-service.js"
import { RpcHandlers } from "../src/rpc-handlers.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #60 at the RPC seam: the derived client drives the reminder aggregate
 * over the real handler map with the session cookie in the request headers —
 * the path the browser takes for reminder CRUD. The ledger's inbox/response
 * routes are plain HTTP and are covered through the service tests.
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)
const NOW = new Date().toISOString()
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()

const TOKEN_A = "reminder-token-a"
const USER_A = uuidV7()
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

  db.prepare(
    `INSERT INTO users
      (id, email, credential_verifier, credential_salt, kdf_version,
       display_name, time_zone, week_start, digits, created_at, updated_at)
     VALUES (?, 'reminder@example.com', ?, ?, 1, 'یادآور', 'Asia/Tehran',
             'saturday', 'persian', ?, ?)`
  ).run(USER_A, "0".repeat(64), "0".repeat(32), NOW, NOW)
  db.prepare(
    `INSERT INTO households (id, name, invite_code, created_by, created_at)
     VALUES (?, 'خانه', 'rem-rpc-invite', ?, ?)`
  ).run(HOUSEHOLD, USER_A, NOW)
  db.prepare(
    `INSERT INTO memberships (id, household_id, user_id, role, joined_at)
     VALUES (?, ?, ?, 'owner', ?)`
  ).run(uuidV7(), HOUSEHOLD, USER_A, NOW)
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(uuidV7(), USER_A, sha256(TOKEN_A), FUTURE, NOW)

  const d1 = D1Client.layer({
    db: new FakeD1(db).asD1Database(),
    transformQueryNames: Str.camelToSnake,
    transformResultNames: Str.snakeToCamel
  })
  const layer = Layer.mergeAll(
    RpcHandlers,
    ReminderServiceLive,
    AuthServiceLive,
    PreferencesServiceLive
  ).pipe(Layer.provide(d1))

  const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, layer))

  type TestClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ApiRpcs>>

  const withClient = <A, E>(
    token: string | undefined,
    f: (client: TestClient) => Effect.Effect<A, E>
  ): Promise<A> =>
    run(
      Effect.scoped(
        Effect.gen(function*() {
          const client = yield* RpcTest.makeClient(ApiRpcs)
          return yield* token === undefined
            ? f(client)
            : RpcClient.withHeaders({ cookie: `tali_session=${token}` })(f(client))
        })
      )
    )

  return { db, withClient }
}

describe("Reminder RPC round-trip", () => {
  it("creates, lists, edits and deletes through the derived client", async () => {
    const h = await makeHarness()
    const id = uuidV7()

    const created = await h.withClient(TOKEN_A, (client) =>
      client.CreateReminder({
        id: id as never,
        clientMutationId: "rpc-create",
        title: "دارو",
        kind: "medication",
        repeat: { _tag: "interval", hours: 8 },
        fireAt: "2026-10-21T08:00:00.000Z"
      })
    )
    expect(created).toMatchObject({
      id,
      title: "دارو",
      kind: "medication",
      tier: "critical",
      version: 1
    })

    const listed = await h.withClient(TOKEN_A, (client) => client.ListReminders({}))
    expect(listed.map((reminder) => reminder.id)).toEqual([id])

    const updated = await h.withClient(TOKEN_A, (client) =>
      client.UpdateReminder({
        id: id as never,
        clientMutationId: "rpc-rename",
        patch: { title: "داروی فشار" }
      })
    )
    expect(updated).toMatchObject({ title: "داروی فشار", fireAt: created.fireAt, version: 2 })

    const deleted = await h.withClient(TOKEN_A, (client) =>
      client.DeleteReminder({ id: id as never, clientMutationId: "rpc-delete" })
    )
    expect(deleted.deletedAt).not.toBeNull()
    const after = await h.withClient(TOKEN_A, (client) => client.ListReminders({}))
    expect(after).toEqual([])
  })

  it("rejects an unauthenticated call with Unauthorized", async () => {
    const h = await makeHarness()
    await expect(
      h.withClient(undefined, (client) => client.ListReminders({}))
    ).rejects.toMatchObject({ _tag: "Unauthorized" })
  })
})
