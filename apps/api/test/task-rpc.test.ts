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
import { ListItemServiceLive } from "../src/list-item-service.js"
import { PreferencesServiceLive } from "../src/preferences-service.js"
import { RpcHandlers } from "../src/rpc-handlers.js"
import { TaskServiceLive } from "../src/task-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #36 exit criterion at the RPC seam: the derived client talks to the
 * real handler map over the in-memory RPC transport, with the session cookie
 * carried in the request headers — the same path the browser takes.
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

  const seedUser = (id: string, email: string, timeZone: string): void => {
    db.prepare(
      `INSERT INTO users
        (id, email, credential_verifier, credential_salt, kdf_version,
         display_name, time_zone, week_start, digits, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, 'saturday', 'persian', ?, ?)`
    ).run(id, email, "0".repeat(64), "0".repeat(32), email, timeZone, NOW, NOW)
  }
  const seedSession = (userId: string, token: string): void => {
    db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(uuidV7(), userId, sha256(token), FUTURE, NOW)
  }

  seedUser(USER_A, "a@example.com", "Asia/Tehran")
  seedUser(USER_B, "b@example.com", "Europe/Berlin")
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
    TaskServiceLive,
    ListItemServiceLive,
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

describe("Task RPC round-trip", () => {
  it("create → filter → move → complete → undo over the derived client", async () => {
    const h = await makeHarness()
    const id = uuidV7()

    const result = await h.withClient(TOKEN_A, (client) =>
      Effect.gen(function*() {
        const created = yield* client.CreateTask({
          id,
          clientMutationId: "rpc-create",
          title: "خرید نان"
        })
        const project = yield* client.CreateProject({
          clientMutationId: "rpc-project",
          title: "خانه"
        })
        const tag = yield* client.CreateTag({
          clientMutationId: "rpc-tag",
          name: "فوری"
        })
        const updated = yield* client.UpdateTask({
          id: created.id,
          clientMutationId: "rpc-update",
          patch: { projectId: project.id, tagIds: [tag.id], priority: "high" }
        })
        const listed = yield* client.ListTasks({
          filter: { projectId: project.id, tagIds: [tag.id] }
        })
        const moved = yield* client.MoveTask({
          id: created.id,
          clientMutationId: "rpc-move",
          dueDate: "2026-10-21"
        })
        const completed = yield* client.CompleteTask({
          id: created.id,
          clientMutationId: "rpc-complete"
        })
        const undone = yield* client.UndoTask({
          id: created.id,
          clientMutationId: "rpc-undo"
        })
        const buckets = yield* client.GetTaskBuckets()
        return { created, updated, listed, moved, completed, undone, buckets }
      })
    )

    expect(result.created.title).toBe("خرید نان")
    expect(result.created.status).toBe("todo")
    expect(result.created.timeZone).toBe("Asia/Tehran")
    expect(result.updated).toMatchObject({
      projectId: result.updated.projectId,
      priority: "high",
      version: 2
    })
    expect(result.listed.map((task) => task.id)).toEqual([id])
    expect(result.moved).toMatchObject({ dueDate: "2026-10-21", dueAt: null })
    expect(result.completed.status).toBe("done")
    expect(result.completed.completedAt).toEqual(expect.any(String))
    expect(result.undone.status).toBe("todo")
    expect(result.undone.completedAt).toBeNull()
    expect(result.undone.dueDate).toBe("2026-10-21")
    expect(result.buckets.timeZone).toBe("Asia/Tehran")
  })

  it("keeps another member's private task out of reads and writes", async () => {
    const h = await makeHarness()
    const id = uuidV7()

    await h.withClient(TOKEN_A, (client) =>
      client.CreateTask({
        id,
        clientMutationId: "rpc-private",
        title: "خصوصی",
        visibility: "private"
      })
    )

    const forB = await h.withClient(TOKEN_B, (client) =>
      Effect.gen(function*() {
        const listed = yield* client.ListTasks({})
        const failed = yield* client.GetTask({ id }).pipe(Effect.flip)
        return { listed, failed }
      })
    )
    expect(forB.listed.map((task) => task.id)).not.toContain(id)
    expect(forB.failed._tag).toBe("TaskForbidden")

    const missingSession = await h.withClient("not-a-session", (client) =>
      client.ListTasks({}).pipe(Effect.flip)
    )
    expect(missingSession._tag).toBe("Unauthorized")
  })

  it("replays the same mutation id without a second write", async () => {
    const h = await makeHarness()
    const id = uuidV7()
    const input = { id, clientMutationId: "rpc-replay", title: "یک‌بار" }

    const { first, replay } = await h.withClient(TOKEN_A, (client) =>
      Effect.gen(function*() {
        const first = yield* client.CreateTask(input)
        const replay = yield* client.CreateTask(input)
        return { first, replay }
      })
    )
    expect(replay.id).toBe(first.id)
    expect(replay.version).toBe(first.version)
    expect(
      (h.db.prepare("SELECT COUNT(*) AS n FROM change_feed").get() as { readonly n: number }).n
    ).toBe(1)
  })
})
