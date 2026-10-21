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
import { ListForbidden, uuidV7 } from "@tali/domain"
import { AuthServiceLive } from "../src/auth-service.js"
import { ListServiceLive } from "../src/list-service.js"
import { PreferencesServiceLive } from "../src/preferences-service.js"
import { RpcHandlers } from "../src/rpc-handlers.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #39 at the RPC seam: the derived client talks to the real handler map
 * over the in-memory transport with the session cookie in the request headers.
 * The viewer is derived from the cookie; a payload can never choose a user or
 * household.
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)
const NOW = new Date().toISOString()
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()

const TOKEN_A = "token-for-user-a"
const TOKEN_B = "token-for-user-b"
const USER_A = uuidV7()
const USER_B = uuidV7()
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

  seedUser(USER_A, "a@example.com")
  seedUser(USER_B, "b@example.com")
  db.prepare(
    `INSERT INTO households (id, name, invite_code, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(HOUSEHOLD, "خانه", "invite-code", USER_A, NOW)
  db.prepare(
    `INSERT INTO memberships (id, household_id, user_id, role, joined_at)
     VALUES (?, ?, ?, 'owner', ?)`
  ).run(uuidV7(), HOUSEHOLD, USER_A, NOW)
  db.prepare(
    `INSERT INTO memberships (id, household_id, user_id, role, joined_at)
     VALUES (?, ?, ?, 'member', ?)`
  ).run(uuidV7(), HOUSEHOLD, USER_B, NOW)
  seedSession(USER_A, TOKEN_A)
  seedSession(USER_B, TOKEN_B)

  const d1 = D1Client.layer({
    db: new FakeD1(db).asD1Database(),
    transformQueryNames: Str.camelToSnake,
    transformResultNames: Str.snakeToCamel
  })
  const layer = Layer.mergeAll(
    RpcHandlers,
    ListServiceLive,
    AuthServiceLive,
    PreferencesServiceLive
  ).pipe(Layer.provide(d1))

  const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, layer))

  const as = <A, E>(token: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    RpcClient.withHeaders({ cookie: `tali_session=${token}` })(effect)

  type TestClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ApiRpcs>>

  const withClient = <A, E>(
    token: string,
    f: (client: TestClient) => Effect.Effect<A, E>
  ): Promise<A> =>
    run(
      Effect.scoped(
        Effect.gen(function*() {
          const client = yield* RpcTest.makeClient(ApiRpcs)
          return yield* as(token, f(client))
        })
      )
    )

  return { db, withClient }
}

describe("List RPC round-trip", () => {
  it("creates, lists, appends, checks, reorders and renames over the derived client", async () => {
    const h = await makeHarness()
    const listId = uuidV7()
    const itemIds = [uuidV7(), uuidV7(), uuidV7()]

    const created = await h.withClient(TOKEN_A, (client) =>
      client.CreateList({
        id: listId as never,
        clientMutationId: "create-list",
        title: "خرید",
        color: "#0f9d8f",
        icon: "🛒",
        checkedPlacement: "bottom"
      })
    )
    expect(created).toMatchObject({ id: listId, title: "خرید", version: 1 })

    const lists = await h.withClient(TOKEN_B, (client) => client.ListLists())
    expect(lists.map((entry) => entry.id)).toContain(listId)

    const appended = await h.withClient(TOKEN_A, (client) =>
      client.AppendListItems({
        listId: listId as never,
        clientMutationId: "append",
        items: [
          { id: itemIds[0] as never, name: "نان" },
          { id: itemIds[1] as never, name: "شیر" },
          { id: itemIds[2] as never, name: "پنیر" }
        ]
      })
    )
    expect(appended.map((item) => item.name)).toEqual(["نان", "شیر", "پنیر"])

    const checked = await h.withClient(TOKEN_B, (client) =>
      client.SetListItemChecked({
        id: itemIds[1] as never,
        clientMutationId: "b-check",
        checked: true
      })
    )
    expect(checked.done).toBe(true)
    expect(checked.checkedAt).not.toBeNull()

    const reordered = await h.withClient(TOKEN_A, (client) =>
      client.ReorderListItems({
        listId: listId as never,
        clientMutationId: "reorder",
        itemIds: [itemIds[2], itemIds[0], itemIds[1]] as never
      })
    )
    expect(reordered.map((item) => item.id)).toEqual([itemIds[2], itemIds[0], itemIds[1]])

    const renamed = await h.withClient(TOKEN_B, (client) =>
      client.UpdateList({
        id: listId as never,
        clientMutationId: "rename",
        patch: { title: "خرید هفتگی", sort: "alpha" }
      })
    )
    expect(renamed).toMatchObject({ title: "خرید هفتگی", sort: "alpha" })

    const items = await h.withClient(TOKEN_A, (client) =>
      client.ListListItems({ listId: listId as never })
    )
    expect(items.map((item) => item.name)).toEqual(["پنیر", "نان", "شیر"])
  })

  it("returns the list-specific forbidden tag for another member's private list", async () => {
    const h = await makeHarness()
    const privateId = uuidV7()
    await h.withClient(TOKEN_A, (client) =>
      client.CreateList({
        id: privateId as never,
        clientMutationId: "private",
        title: "خصوصی",
        visibility: "private"
      })
    )

    const failure = await h
      .withClient(TOKEN_B, (client) => client.GetList({ id: privateId as never }))
      .catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(ListForbidden)
    expect((failure as ListForbidden).reason).toBe("private")
  })

  it("rejects an unauthenticated call", async () => {
    const h = await makeHarness()
    const failure = await h
      .withClient("not-a-session", (client) => client.ListLists())
      .catch((cause: unknown) => cause)
    expect((failure as { _tag?: string })._tag).toBe("Unauthorized")
  })
})
