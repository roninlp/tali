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
import { NoteServiceLive } from "../src/note-service.js"
import { PreferencesServiceLive } from "../src/preferences-service.js"
import { RpcHandlers } from "../src/rpc-handlers.js"
import { TaskServiceLive } from "../src/task-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #40 at the RPC seam: the derived client talks to the real handler
 * map over the in-memory RPC transport with the session cookie in the request
 * headers — the same path the browser takes.
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

const doc = (text: string): unknown => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }]
})

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
    NoteServiceLive,
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

describe("Note RPC round-trip", () => {
  it("quick create → save → pin → archive → trash → restore", async () => {
    const h = await makeHarness()
    const id = uuidV7()

    const result = await h.withClient(TOKEN_A, (client) =>
      Effect.gen(function*() {
        const created = yield* client.CreateNote({ id, clientMutationId: "n-create" })
        const saved = yield* client.SaveNote({
          id: created.id,
          clientMutationId: "n-save",
          baseVersion: created.version,
          body: doc("یادداشت تازه")
        })
        const repeated = yield* client.SaveNote({
          id: created.id,
          clientMutationId: "n-save-2",
          baseVersion: saved.version,
          body: doc("یادداشت تازه")
        })
        const conflict = yield* client
          .SaveNote({
            id: created.id,
            clientMutationId: "n-stale",
            baseVersion: 1,
            body: doc("متن قدیمی")
          })
          .pipe(Effect.flip)
        const pinned = yield* client.SetNotePinned({
          id: created.id,
          clientMutationId: "n-pin",
          value: true
        })
        const dashboard = yield* client.ListPinnedNotes()
        const archived = yield* client.SetNoteArchived({
          id: created.id,
          clientMutationId: "n-archive",
          value: true
        })
        const active = yield* client.ListNotes({})
        const archivedList = yield* client.ListNotes({ includeArchived: true })
        const trashed = yield* client.TrashNote({ id: created.id, clientMutationId: "n-trash" })
        const trash = yield* client.ListTrashNotes()
        const restored = yield* client.RestoreNote({
          id: created.id,
          clientMutationId: "n-restore"
        })
        return {
          created,
          saved,
          repeated,
          conflict,
          pinned,
          dashboard,
          archived,
          active,
          archivedList,
          trashed,
          trash,
          restored
        }
      })
    )

    expect(result.created).toMatchObject({ title: "", body: null, version: 1 })
    expect(result.saved).toMatchObject({ plainText: "یادداشت تازه", version: 2 })
    // Identical autosave is a no-op, not a duplicate version.
    expect(result.repeated.version).toBe(2)
    expect(result.conflict).toMatchObject({ _tag: "NoteConflict", version: 2 })
    expect(result.pinned).toMatchObject({ isPinned: true, version: 3 })
    expect(result.dashboard.map((note) => note.id)).toEqual([id])
    expect(result.archived).toMatchObject({ isArchived: true, version: 4 })
    expect(result.active).toEqual([])
    expect(result.archivedList.map((note) => note.id)).toEqual([id])
    expect(result.trashed.deletedAt).not.toBeNull()
    expect(result.trash.map((note) => note.id)).toEqual([id])
    expect(result.restored.deletedAt).toBeNull()
  })

  it("keeps another member's private note out of reads and requires a session", async () => {
    const h = await makeHarness()
    const sharedId = uuidV7()
    const privateId = uuidV7()

    await h.withClient(TOKEN_A, (client) =>
      Effect.gen(function*() {
        yield* client.CreateNote({
          id: sharedId,
          clientMutationId: "p-shared",
          title: "مشترک",
          body: doc("مشترک")
        })
        yield* client.CreateNote({
          id: privateId,
          clientMutationId: "p-private",
          title: "خصوصی",
          visibility: "private"
        })
      })
    )

    const forB = await h.withClient(TOKEN_B, (client) =>
      Effect.gen(function*() {
        const listed = yield* client.ListNotes({})
        const pinned = yield* client.ListPinnedNotes()
        const failed = yield* client.GetNote({ id: privateId }).pipe(Effect.flip)
        return { listed, pinned, failed }
      })
    )
    expect(forB.listed.map((note) => note.id)).toEqual([sharedId])
    expect(forB.pinned).toEqual([])
    expect(forB.failed._tag).toBe("NoteForbidden")

    const missingSession = await h.withClient("not-a-session", (client) =>
      client.ListNotes({}).pipe(Effect.flip)
    )
    expect(missingSession._tag).toBe("Unauthorized")
  })

  it("replays the same mutation id without a second version", async () => {
    const h = await makeHarness()
    const id = uuidV7()
    const input = { id, clientMutationId: "rpc-replay", title: "یک‌بار" }

    const { first, replay } = await h.withClient(TOKEN_A, (client) =>
      Effect.gen(function*() {
        const first = yield* client.CreateNote(input)
        const replay = yield* client.CreateNote(input)
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
