import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  uuidV7,
  type HouseholdId,
  type NoteId,
  type SyncPushEntry,
  type UserId
} from "@tali/domain"
import { NoteSearchService, NoteSearchServiceLive } from "../src/note-search-service.js"
import { NoteService, NoteServiceLive } from "../src/note-service.js"
import { SyncService, SyncServiceLive } from "../src/sync-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #41, at the search seam.
 *
 * The tests run the real service, repository and sync-primitive SQL against
 * SQLite (D1's engine) through a D1-shaped batch, so the FTS5 index, the
 * `changes()` gating and the version CAS behave like production.
 *
 * The three things the ticket asks for are pinned here:
 *
 * 1. a note written in one Persian spelling is found by the other;
 * 2. the match is marked in the snippet;
 * 3. the query stays well under the 300 ms budget.
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)

const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort()

const USER_A = "user-a" as UserId
const USER_B = "user-b" as UserId
const HOUSEHOLD = "household-a" as HouseholdId
const NOW = "2026-10-20T09:30:00.000Z"

/** The editor's fallback doc: paragraphs of plain text inside the JSON column. */
const doc = (text: string): unknown => ({
  type: "doc",
  content: [{
    type: "paragraph",
    content: text === "" ? [] : [{ type: "text", text }]
  }]
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
  const layer = Layer.mergeAll(NoteServiceLive, NoteSearchServiceLive, SyncServiceLive).pipe(
    Layer.provide(d1)
  )

  const run = <A, E>(
    effect: Effect.Effect<A, E, NoteService | NoteSearchService | SyncService>
  ): Promise<A> => Effect.runPromise(Effect.provide(effect, layer))

  const notes = <A, E>(
    f: (service: NoteService["Service"]) => Effect.Effect<A, E, never>
  ): Promise<A> =>
    run(
      Effect.gen(function*() {
        const service = yield* NoteService
        return yield* f(service)
      })
    )

  const search = (
    query: string,
    userId: UserId = USER_A,
    householdId: HouseholdId = HOUSEHOLD
  ): Promise<Awaited<ReturnType<NoteSearchService["search"]>>> =>
    run(
      Effect.gen(function*() {
        const service = yield* NoteSearchService
        return yield* service.search({ userId, householdId }, query)
      })
    )

  const push = (
    entries: ReadonlyArray<SyncPushEntry>,
    userId: UserId = USER_A,
    householdId: HouseholdId = HOUSEHOLD
  ): Promise<unknown> =>
    run(
      Effect.gen(function*() {
        const service = yield* SyncService
        return yield* service.push({ userId, householdId, entries })
      })
    )

  /** A note written through the sync path (the way the web app writes). */
  const pushNote = (input: {
    readonly id: string
    readonly title?: string
    readonly plainText: string
    readonly visibility?: "private" | "shared"
    readonly userId?: UserId
    readonly householdId?: HouseholdId
  }): Promise<unknown> =>
    push(
      [
        {
          clientMutationId: `push-${input.id}`,
          entityType: "note",
          entityId: input.id,
          baseVersion: 0,
          op: "upsert",
          patch: {
            title: input.title ?? "",
            plainText: input.plainText,
            body: doc(input.plainText),
            visibility: input.visibility ?? "shared"
          },
          clientUpdatedAt: NOW
        }
      ],
      input.userId ?? USER_A,
      input.householdId ?? HOUSEHOLD
    )

  const indexRows = (): ReadonlyArray<{ noteId: string }> =>
    db
      .prepare("SELECT note_id AS noteId FROM notes_fts")
      .all() as ReadonlyArray<{ readonly noteId: string }>

  return { db, run, notes, search, push, pushNote, indexRows }
}

describe("note search", () => {
  it("finds a note written in another Persian spelling", async () => {
    const h = makeHarness()
    const id = uuidV7() as NoteId
    await h.notes((svc) =>
      svc.create(
        { userId: USER_A, householdId: HOUSEHOLD },
        { id, clientMutationId: "n-1", title: "خريد دارو", body: doc("ميروم به داروخانه") },
        NOW
      )
    )

    // The Arabic yeh finds the note written with the Farsi yeh.
    const hits = await h.search("میروم")
    expect(hits.hits.map((hit) => hit.id)).toEqual([id])

    // …and the other way round.
    const reverse = await h.search("ميروم")
    expect(reverse.hits.map((hit) => hit.id)).toEqual([id])
  })

  it("finds a note written with the half-space", async () => {
    const h = makeHarness()
    const id = uuidV7() as NoteId
    await h.notes((svc) =>
      svc.create(
        { userId: USER_A, householdId: HOUSEHOLD },
        { id, clientMutationId: "n-1", body: doc("می‌روم خانه") },
        NOW
      )
    )

    const hits = await h.search("میروم")
    expect(hits.hits.map((hit) => hit.id)).toEqual([id])
  })

  it("marks the match in the snippet", async () => {
    const h = makeHarness()
    const id = uuidV7() as NoteId
    await h.notes((svc) =>
      svc.create(
        { userId: USER_A, householdId: HOUSEHOLD },
        { id, clientMutationId: "n-1", body: doc("هر شب دارو می‌خورم") },
        NOW
      )
    )

    const hits = await h.search("دارو")
    expect(hits.hits).toHaveLength(1)
    const segments = hits.hits[0]!.segments
    expect(segments.some((segment) => segment.match && segment.text.includes("دارو"))).toBe(true)
    expect(segments.map((segment) => segment.text).join("")).toContain("دارو")
  })

  it("never returns another member's private note", async () => {
    const h = makeHarness()
    const id = uuidV7()
    await h.pushNote({
      id,
      plainText: "رمز خانواده",
      visibility: "private",
      userId: USER_B
    })

    expect((await h.search("رمز")).hits).toHaveLength(0)
    // The owner sees it.
    expect((await h.search("رمز", USER_B)).hits.map((hit) => hit.id)).toEqual([id])
  })

  it("returns the notes shared with the viewer", async () => {
    const h = makeHarness()
    const id = uuidV7()
    await h.pushNote({
      id,
      plainText: "نان و پنیر",
      visibility: "shared",
      userId: USER_B
    })

    expect((await h.search("پنیر")).hits.map((hit) => hit.id)).toEqual([id])
  })

  it("never returns a note from another household", async () => {
    const h = makeHarness()
    const id = uuidV7()
    await h.pushNote({
      id,
      plainText: "محرمانه",
      householdId: "household-b" as HouseholdId
    })

    expect((await h.search("محرمانه")).hits).toHaveLength(0)
  })

  it("indexes a note written through the sync push", async () => {
    const h = makeHarness()
    const id = uuidV7()
    await h.push([
      {
        clientMutationId: "push-1",
        entityType: "note",
        entityId: id,
        baseVersion: 0,
        op: "upsert",
        patch: { title: "سفر", plainText: "بلیط هواپیما", body: doc("بلیط هواپیما") },
        clientUpdatedAt: NOW
      }
    ])

    const hits = await h.search("بلیط")
    expect(hits.hits.map((hit) => hit.id)).toEqual([id])
    expect(h.indexRows().map((row) => row.noteId)).toEqual([id])
  })

  it("re-indexes a note when it is edited", async () => {
    const h = makeHarness()
    const id = uuidV7() as NoteId
    await h.notes((svc) =>
      svc.create(
        { userId: USER_A, householdId: HOUSEHOLD },
        { id, clientMutationId: "n-1", body: doc("قرص سرماخوردگی") },
        NOW
      )
    )
    expect((await h.search("سرماخوردگی")).hits).toHaveLength(1)

    await h.notes((svc) =>
      svc.save(
        { userId: USER_A, householdId: HOUSEHOLD },
        { id, clientMutationId: "n-2", baseVersion: 1, body: doc("قرص تب") },
        NOW
      )
    )

    expect((await h.search("سرماخوردگی")).hits).toHaveLength(0)
    expect((await h.search("تب")).hits.map((hit) => hit.id)).toEqual([id])
    // The index holds one row per note, never a duplicate.
    expect(h.indexRows()).toHaveLength(1)
  })

  it("drops a trashed note from the results", async () => {
    const h = makeHarness()
    const id = uuidV7() as NoteId
    await h.notes((svc) =>
      svc.create(
        { userId: USER_A, householdId: HOUSEHOLD },
        { id, clientMutationId: "n-1", body: doc("زباله قرمز") },
        NOW
      )
    )
    expect((await h.search("قرمز")).hits).toHaveLength(1)

    await h.notes((svc) =>
      svc.trash(
        { userId: USER_A, householdId: HOUSEHOLD },
        { id, clientMutationId: "n-2" },
        NOW
      )
    )

    expect((await h.search("قرمز")).hits).toHaveLength(0)
  })

  it("returns nothing for an empty query", async () => {
    const h = makeHarness()
    await h.notes((svc) =>
      svc.create(
        { userId: USER_A, householdId: HOUSEHOLD },
        { id: uuidV7() as NoteId, clientMutationId: "n-1", body: doc("هر چیزی") },
        NOW
      )
    )

    expect((await h.search("")).hits).toHaveLength(0)
    expect((await h.search("   ")).hits).toHaveLength(0)
    expect((await h.search("---")).hits).toHaveLength(0)
  })

  it("treats a query as text, never as FTS5 syntax", async () => {
    const h = makeHarness()
    await h.notes((svc) =>
      svc.create(
        { userId: USER_A, householdId: HOUSEHOLD },
        { id: uuidV7() as NoteId, clientMutationId: "n-1", body: doc("قرص و دارو") },
        NOW
      )
    )

    // A stray quote or operator must not blow the query up.
    expect((await h.search('"')).hits).toHaveLength(0)
    expect((await h.search("NEAR(a b)")).hits).toHaveLength(0)
    expect((await h.search("دارو")).hits).toHaveLength(1)
  })

  it("answers a query over a few hundred notes well under 300 ms", async () => {
    const h = makeHarness()
    const ids: Array<string> = []
    for (let index = 0; index < 200; index += 1) {
      const id = uuidV7() as NoteId
      ids.push(id)
      await h.notes((svc) =>
        svc.create(
          { userId: USER_A, householdId: HOUSEHOLD },
          {
            id,
            clientMutationId: `n-${index}`,
            body: doc(`یادداشت شماره ${index} درباره خرید نان و پنیر در بازار`)
          },
          NOW
        )
      )
    }

    const started = performance.now()
    const hits = await h.search("نان")
    const elapsed = performance.now() - started

    expect(hits.hits.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(300)
  })
})
