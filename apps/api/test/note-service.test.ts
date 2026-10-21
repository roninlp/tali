import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  extractNotePlainText,
  uuidV7,
  type HouseholdId,
  type NoteId,
  type TagId,
  type UserId
} from "@tali/domain"
import { NoteService, NoteServiceLive, type NoteServiceApi, type NoteViewer } from "../src/note-service.js"
import { SyncService, SyncServiceLive } from "../src/sync-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #40, at the service seam. These run the real service, repository and
 * sync-primitive SQL against SQLite (D1's engine) through a D1-shaped batch, so
 * version CAS, `changes()` gating and feed ordering behave like production.
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
const NOW = "2026-10-20T09:30:00.000Z"

/** The editor's fallback doc: paragraphs of plain text inside the JSON column. */
const doc = (text: string): unknown => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: text === "" ? [] : [{ type: "text", text }]
    }
  ]
})

const viewer = (overrides: Partial<NoteViewer> = {}): NoteViewer => ({
  userId: USER_A,
  householdId: HOUSEHOLD,
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
  const layer = Layer.mergeAll(NoteServiceLive, SyncServiceLive).pipe(Layer.provide(d1))

  const run = <A, E>(effect: Effect.Effect<A, E, NoteService | SyncService>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, layer))

  const svc = <A, E>(f: (service: NoteServiceApi) => Effect.Effect<A, E, never>): Promise<A> =>
    run(
      Effect.gen(function*() {
        const service = yield* NoteService
        return yield* f(service)
      })
    )

  const pull = (
    userId: UserId,
    householdId: HouseholdId = HOUSEHOLD,
    cursor = 0
  ): Promise<Awaited<ReturnType<SyncService["pull"]>>> =>
    run(
      Effect.gen(function*() {
        const service = yield* SyncService
        return yield* service.pull({ userId, householdId, cursor, limit: 100 })
      })
    )

  const feedCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM change_feed").get() as { readonly n: number }).n

  const joinTagIds = (noteId: NoteId): ReadonlyArray<string> =>
    (
      db
        .prepare("SELECT tag_id AS tagId FROM item_tags WHERE item_type = 'note' AND item_id = ?")
        .all(noteId) as ReadonlyArray<{ readonly tagId: string }>
    ).map((row) => row.tagId)

  const seedTag = (input: {
    readonly ownerId?: UserId
    readonly householdId?: HouseholdId
    readonly name: string
    readonly visibility?: "private" | "shared"
    readonly deletedAt?: string | null
  }): TagId => {
    const id = uuidV7() as TagId
    db.prepare(
      `INSERT INTO tags
        (id, type, name, owner_id, household_id, visibility, color,
         created_at, updated_at, version, deleted_at)
       VALUES (?, 'tag', ?, ?, ?, ?, NULL, ?, ?, 1, ?)`
    ).run(
      id,
      input.name,
      input.ownerId ?? USER_A,
      input.householdId ?? HOUSEHOLD,
      input.visibility ?? "shared",
      NOW,
      NOW,
      input.deletedAt ?? null
    )
    return id
  }

  return { db, run, svc, pull, pullFeed: feedCount, joinTagIds, seedTag, fake }
}

const noteIn = (
  page: Awaited<ReturnType<SyncService["pull"]>>,
  id: string
) => page.items.find((item) => item.entityType === "note" && item.entityId === id)

describe("NoteService round-trip", () => {
  it("quick create → autosave → pin/archive → trash → restore", async () => {
    const h = makeHarness()
    const id = uuidV7() as NoteId

    // Quick create: no title, no body, one click.
    const created = await h.svc((svc) =>
      svc.create(viewer(), { id, clientMutationId: "n-create" }, NOW)
    )
    expect(created).toMatchObject({
      id,
      title: "",
      body: null,
      plainText: "",
      isPinned: false,
      isArchived: false,
      tagIds: [],
      version: 1,
      deletedAt: null
    })

    const saved = await h.svc((svc) =>
      svc.save(
        viewer(),
        { id, clientMutationId: "n-save-1", baseVersion: 1, body: doc("نان سنگک") },
        NOW
      )
    )
    expect(saved).toMatchObject({ plainText: "نان سنگک", version: 2 })
    expect(extractNotePlainText(saved.body)).toBe("نان سنگک")

    // Per-mutation version/feed: every write appears on /sync/pull.
    const afterSave = await h.pull(USER_A)
    expect(noteIn(afterSave, id)?.version).toBe(2)
    expect(noteIn(afterSave, id)?.data.plainText).toBe("نان سنگک")

    // Repeated autosave of identical text mints no version and no feed row.
    const feedBefore = h.pullFeed()
    const repeated = await h.svc((svc) =>
      svc.save(
        viewer(),
        { id, clientMutationId: "n-save-2", baseVersion: 2, body: doc("نان سنگک") },
        NOW
      )
    )
    expect(repeated.version).toBe(2)
    expect(h.pullFeed()).toBe(feedBefore)

    // Replaying the same mutation id is exactly-once.
    const replay = await h.svc((svc) =>
      svc.save(
        viewer(),
        { id, clientMutationId: "n-save-1", baseVersion: 1, body: doc("نان سنگک") },
        NOW
      )
    )
    expect(replay.version).toBe(2)
    expect(h.pullFeed()).toBe(feedBefore)

    // A stale base version must not clobber newer text.
    const conflict = await h.svc((svc) =>
      svc
        .save(
          viewer(),
          { id, clientMutationId: "n-save-3", baseVersion: 1, body: doc("متن قدیمی") },
          NOW
        )
        .pipe(Effect.flip)
    )
    expect(conflict._tag).toBe("NoteConflict")
    expect(conflict).toMatchObject({ version: 2 })
    const unchanged = await h.svc((svc) => svc.get(viewer(), id))
    expect(unchanged.plainText).toBe("نان سنگک")

    const pinned = await h.svc((svc) =>
      svc.setPinned(viewer(), { id, clientMutationId: "n-pin", value: true }, NOW)
    )
    expect(pinned).toMatchObject({ isPinned: true, version: 3 })
    const pinnedAgain = await h.svc((svc) =>
      svc.setPinned(viewer(), { id, clientMutationId: "n-pin-2", value: true }, NOW)
    )
    expect(pinnedAgain.version).toBe(3)

    // The dashboard seam returns it, at the same version the feed carries.
    const pinnedNotes = await h.svc((svc) => svc.listPinned(viewer()))
    expect(pinnedNotes.map((note) => note.id)).toEqual([id])
    expect(noteIn(await h.pull(USER_A), id)?.version).toBe(3)

    const archived = await h.svc((svc) =>
      svc.setArchived(viewer(), { id, clientMutationId: "n-archive", value: true }, NOW)
    )
    expect(archived).toMatchObject({ isArchived: true, version: 4 })
    expect(noteIn(await h.pull(USER_A), id)?.version).toBe(4)
    expect((await h.svc((svc) => svc.list(viewer(), {}))).map((note) => note.id)).toEqual([])
    expect(
      (await h.svc((svc) => svc.list(viewer(), { includeArchived: true }))).map((note) => note.id)
    ).toEqual([id])
    // An archived note is not a dashboard pin.
    expect(await h.svc((svc) => svc.listPinned(viewer()))).toEqual([])

    const trashed = await h.svc((svc) =>
      svc.trash(viewer(), { id, clientMutationId: "n-trash" }, NOW)
    )
    expect(trashed.deletedAt).not.toBeNull()
    expect(trashed.version).toBe(5)
    expect((await h.svc((svc) => svc.list(viewer(), { includeArchived: true })))).toEqual([])
    expect((await h.svc((svc) => svc.listTrash(viewer()))).map((note) => note.id)).toEqual([id])
    expect((await h.svc((svc) => svc.get(viewer(), id).pipe(Effect.flip)))._tag).toBe("NoteNotFound")

    const trashFeed = await h.pull(USER_A)
    expect(noteIn(trashFeed, id)).toMatchObject({ version: 5, deletedAt: NOW })
    // The tombstone reaches the other member's feed too (shared note).
    expect(noteIn(await h.pull(USER_B), id)).toMatchObject({ version: 5, deletedAt: NOW })

    const restored = await h.svc((svc) =>
      svc.restore(viewer(), { id, clientMutationId: "n-restore" }, NOW)
    )
    expect(restored.deletedAt).toBeNull()
    expect(restored.version).toBe(6)
    expect((await h.svc((svc) => svc.listTrash(viewer())))).toEqual([])
    expect(
      (await h.svc((svc) => svc.list(viewer(), { includeArchived: true }))).map((note) => note.id)
    ).toEqual([id])

    const restoredFeed = await h.pull(USER_A)
    expect(noteIn(restoredFeed, id)?.version).toBe(6)
    // Restore is a normal versioned upsert, so the other device converges.
    expect(noteIn(await h.pull(USER_B), id)).toMatchObject({ version: 6, deletedAt: null })
  })

  it("keeps the 30-day trash window and rejects an older restore", async () => {
    const h = makeHarness()
    const id = uuidV7() as NoteId
    await h.svc((svc) => svc.create(viewer(), { id, clientMutationId: "r-create" }, NOW))
    await h.svc((svc) => svc.trash(viewer(), { id, clientMutationId: "r-trash" }, NOW))

    const late = new Date(Date.parse(NOW) + 31 * 24 * 60 * 60 * 1000).toISOString()
    const failed = await h.svc((svc) =>
      svc.restore(viewer(), { id, clientMutationId: "r-late" }, late).pipe(Effect.flip)
    )
    expect(failed._tag).toBe("NoteNotRestorable")
    expect((await h.svc((svc) => svc.listTrash(viewer()))).map((note) => note.id)).toEqual([id])
  })

  it("scopes reads by household and private visibility in the service and the feed", async () => {
    const h = makeHarness()
    const sharedId = uuidV7() as NoteId
    const privateId = uuidV7() as NoteId

    await h.svc((svc) =>
      svc.create(
        viewer(),
        { id: sharedId, clientMutationId: "v-shared", title: "مشترک", body: doc("مشترک") },
        NOW
      )
    )
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          id: privateId,
          clientMutationId: "v-private",
          title: "خصوصی",
          visibility: "private"
        },
        NOW
      )
    )

    // Member B sees the shared note, not A's private one.
    const listForB = await h.svc((svc) => svc.list(viewer({ userId: USER_B }), {}))
    expect(listForB.map((note) => note.id)).toEqual([sharedId])
    const privateForB = await h.svc((svc) =>
      svc.get(viewer({ userId: USER_B }), privateId).pipe(Effect.flip)
    )
    expect(privateForB._tag).toBe("NoteForbidden")
    expect(privateForB).toMatchObject({ reason: "private" })

    // Other households see nothing, and cannot read by id.
    const otherViewer = viewer({ userId: USER_B, householdId: OTHER_HOUSEHOLD })
    expect(await h.svc((svc) => svc.list(otherViewer, {}))).toEqual([])
    const householdForbidden = await h.svc((svc) =>
      svc.get(otherViewer, sharedId).pipe(Effect.flip)
    )
    expect(householdForbidden).toMatchObject({ _tag: "NoteForbidden", reason: "household" })

    // The feed carries the same visibility rule.
    const feedForA = await h.pull(USER_A)
    expect(noteIn(feedForA, sharedId)).toBeDefined()
    expect(noteIn(feedForA, privateId)).toBeDefined()
    const feedForB = await h.pull(USER_B)
    expect(noteIn(feedForB, sharedId)).toBeDefined()
    expect(noteIn(feedForB, privateId)).toBeUndefined()
  })

  it("assigns tags through the shared tag primitives and filters by them", async () => {
    const h = makeHarness()
    const work = h.seedTag({ name: "کار" })
    const home = h.seedTag({ name: "خانه" })

    const first = await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "t-create-1", title: "خرید", tagIds: [work], body: doc("خرید نان") },
        NOW
      )
    )
    const second = await h.svc((svc) =>
      svc.create(viewer(), { clientMutationId: "t-create-2", title: "خانه", tagIds: [home] }, NOW)
    )

    expect(h.joinTagIds(first.id)).toEqual([work])
    expect(h.joinTagIds(second.id)).toEqual([home])
    expect(
      (await h.svc((svc) => svc.list(viewer(), { tagIds: [work] }))).map((note) => note.id)
    ).toEqual([first.id])

    const retagged = await h.svc((svc) =>
      svc.setTags(
        viewer(),
        { id: first.id, clientMutationId: "t-retag", tagIds: [work, home] },
        NOW
      )
    )
    expect(retagged.tagIds).toEqual([work, home])
    expect(h.joinTagIds(first.id).sort()).toEqual([work, home].sort())

    const cleared = await h.svc((svc) =>
      svc.setTags(viewer(), { id: first.id, clientMutationId: "t-clear", tagIds: [] }, NOW)
    )
    expect(cleared.tagIds).toEqual([])
    expect(h.joinTagIds(first.id)).toEqual([])

    // Another member's private tag cannot be assigned.
    const foreignPrivate = h.seedTag({ name: "خصوصی", ownerId: USER_B, visibility: "private" })
    const rejected = await h.svc((svc) =>
      svc
        .update(
          viewer(),
          {
            id: first.id,
            clientMutationId: "t-foreign",
            patch: { tagIds: [foreignPrivate] }
          },
          NOW
        )
        .pipe(Effect.flip)
    )
    expect(rejected._tag).toBe("NoteValidationError")
    expect(rejected.issues[0]?.field).toBe("tagIds")

    // A deleted tag is not assignable either.
    const deleted = h.seedTag({ name: "حذف‌شده", deletedAt: NOW })
    const deletedRejected = await h.svc((svc) =>
      svc
        .update(
          viewer(),
          { id: first.id, clientMutationId: "t-deleted", patch: { tagIds: [deleted] } },
          NOW
        )
        .pipe(Effect.flip)
    )
    expect(deletedRejected._tag).toBe("NoteValidationError")
  })

  it("keeps the tag join in step when a tag write loses the CAS", async () => {
    const h = makeHarness()
    const work = h.seedTag({ name: "کار" })
    const home = h.seedTag({ name: "خانه" })
    const note = await h.svc((svc) =>
      svc.create(
        viewer(),
        { clientMutationId: "tc-create", title: "خرید", tagIds: [work] },
        NOW
      )
    )
    expect(h.joinTagIds(note.id)).toEqual([work])

    // Every retry loses the CAS after the service's pre-read. The version-gated
    // join statements must not touch item_tags when the note row did not move
    // to this mutation's version — otherwise the join and tag_ids drift.
    let bumps = 0
    h.fake.beforeBatch = () => {
      bumps += 1
      h.db
        .prepare("UPDATE notes SET version = version + 1, updated_at = ? WHERE id = ?")
        .run(new Date(Date.parse(NOW) + bumps * 1000).toISOString(), note.id)
    }

    const failed = await h.svc((svc) =>
      svc
        .setTags(
          viewer(),
          { id: note.id, clientMutationId: "tc-retag", tagIds: [home] },
          NOW
        )
        .pipe(Effect.flip)
    )
    expect(failed._tag).toBe("NoteConflict")
    h.fake.beforeBatch = undefined

    expect(h.joinTagIds(note.id)).toEqual([work])
    const stored = await h.svc((svc) => svc.get(viewer(), note.id))
    expect(stored.tagIds).toEqual([work])
  })

  it("scopes the pinned and trash queries and restore to the viewer", async () => {
    const h = makeHarness()
    const sharedPinned = uuidV7() as NoteId
    const privatePinned = uuidV7() as NoteId
    const sharedTrashed = uuidV7() as NoteId
    const privateTrashed = uuidV7() as NoteId

    await h.svc((svc) =>
      svc.create(
        viewer(),
        { id: sharedPinned, clientMutationId: "s-pin", title: "مشترک", isPinned: true },
        NOW
      )
    )
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          id: privatePinned,
          clientMutationId: "p-pin",
          title: "خصوصی",
          isPinned: true,
          visibility: "private"
        },
        NOW
      )
    )
    await h.svc((svc) =>
      svc.create(
        viewer(),
        { id: sharedTrashed, clientMutationId: "s-trash", title: "مشترک حذف‌شده" },
        NOW
      )
    )
    await h.svc((svc) =>
      svc.trash(viewer(), { id: sharedTrashed, clientMutationId: "s-trash-2" }, NOW)
    )
    await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          id: privateTrashed,
          clientMutationId: "p-trash",
          title: "خصوصی حذف‌شده",
          visibility: "private"
        },
        NOW
      )
    )
    await h.svc((svc) =>
      svc.trash(viewer(), { id: privateTrashed, clientMutationId: "p-trash-2" }, NOW)
    )

    // The other member sees only household-shared pinned/trashed rows.
    const viewerB = viewer({ userId: USER_B })
    expect((await h.svc((svc) => svc.listPinned(viewerB))).map((note) => note.id)).toEqual([
      sharedPinned
    ])
    expect((await h.svc((svc) => svc.listTrash(viewerB))).map((note) => note.id)).toEqual([
      sharedTrashed
    ])
    // A trashed private row cannot be revealed or resurrected by id.
    const forbidden = await h.svc((svc) =>
      svc.restore(viewerB, { id: privateTrashed, clientMutationId: "p-restore" }).pipe(Effect.flip)
    )
    expect(forbidden).toMatchObject({ _tag: "NoteForbidden", reason: "private" })
    expect(
      await h.svc((svc) => svc.listTrash(viewer())).then((rows) => rows.map((note) => note.id))
    ).toEqual(expect.arrayContaining([privateTrashed, sharedTrashed]))
    // The private row is still trashed, not restored by the failed attempt.
    const stillTrashed = await h.svc((svc) => svc.listTrash(viewer()))
    expect(stillTrashed.map((note) => note.id)).toContain(privateTrashed)
  })

  it("rejects a mutation id already spent on another aggregate", async () => {
    const h = makeHarness()
    h.db
      .prepare(
        `INSERT INTO applied_mutations
          (client_mutation_id, household_id, entity_type, entity_id, server_version, seq, created_at)
         VALUES ('cross-aggregate', ?, 'task', 'task-1', 1, 0, ?)`
      )
      .run(HOUSEHOLD, NOW)
    const feedBefore = h.pullFeed()

    const failed = await h.svc((svc) =>
      svc
        .create(viewer(), { clientMutationId: "cross-aggregate", title: "نباید نوشته شود" })
        .pipe(Effect.flip)
    )
    expect(failed._tag).toBe("NoteValidationError")
    expect(failed.issues[0]?.field).toBe("clientMutationId")
    // Nothing was written: no feed row and no note row.
    expect(h.pullFeed()).toBe(feedBefore)
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { readonly n: number }).n).toBe(0)
  })

  it("orders the pinned query and reuses mutation ids exactly once per row", async () => {
    const h = makeHarness()
    const a = uuidV7() as NoteId
    const b = uuidV7() as NoteId
    const c = uuidV7() as NoteId

    // Seed via the local-style sync patch path? Here everything goes through
    // the service, so each note has a real version/feed row.
    await h.svc((svc) => svc.create(viewer(), { id: a, clientMutationId: "o-a", title: "الف" }, NOW))
    await h.svc((svc) =>
      svc.create(viewer(), { id: b, clientMutationId: "o-b", title: "ب" }, "2026-10-20T10:00:00.000Z")
    )
    await h.svc((svc) => svc.create(viewer(), { id: c, clientMutationId: "o-c", title: "ج" }, NOW))
    await h.svc((svc) =>
      svc.setPinned(viewer(), { id: a, clientMutationId: "o-pin-a", value: true }, NOW)
    )
    await h.svc((svc) =>
      svc.setPinned(
        viewer(),
        { id: b, clientMutationId: "o-pin-b", value: true },
        "2026-10-20T11:00:00.000Z"
      )
    )
    // c stays unpinned: the dashboard must not surface it.
    const pinned = await h.svc((svc) => svc.listPinned(viewer()))
    expect(pinned.map((note) => note.id)).toEqual([b, a])
    expect(pinned.map((note) => note.id)).not.toContain(c)

    // Reusing a mutation id on another row is a validation error, not a
    // silent replay that could return the wrong note.
    const reused = await h.svc((svc) =>
      svc
        .update(
          viewer(),
          { id: b, clientMutationId: "o-pin-a", patch: { title: "دزدی" } },
          NOW
        )
        .pipe(Effect.flip)
    )
    expect(reused._tag).toBe("NoteValidationError")
  })
})
