import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { uuidV7 } from "@tali/domain"
import {
  jsonRequest,
  sessionWithHousehold,
  workerFetch
} from "./support.js"

/**
 * `/sync/pull|push|bootstrap` through the Worker.
 *
 * This is where #44 regressed: Effect v4 hands the route a **path-only**
 * `request.url`, so `new URL(request.url)` threw on every request with a query
 * string and every sync route answered 500. A service-direct test cannot see
 * that. The first test below is the permanent guard: it requires both a query
 * string and a 200, and it asserts that `limit` actually reached the service.
 */

interface SyncBody {
  readonly items: ReadonlyArray<{ readonly entityId: string }>
  readonly hasMore: boolean
  readonly nextCursor?: number
  readonly nextOffset?: number
  readonly cursor?: number
  readonly results: ReadonlyArray<{
    readonly _tag: string
    readonly entityId: string
    readonly version: number
  }>
}

const pushTask = (id: string, title: string, mutationId: string) => ({
  clientMutationId: mutationId,
  entityType: "task",
  entityId: id,
  baseVersion: 0,
  op: "upsert",
  patch: { title },
  clientUpdatedAt: new Date().toISOString()
})

const pushProject = (id: string, title: string, mutationId: string) => ({
  clientMutationId: mutationId,
  entityType: "project",
  entityId: id,
  baseVersion: 0,
  op: "upsert",
  patch: { title },
  clientUpdatedAt: new Date().toISOString()
})

/** A note write is the widest group: row + feed + ledger + two FTS statements. */
const pushNote = (id: string, title: string, mutationId: string) => ({
  clientMutationId: mutationId,
  entityType: "note",
  entityId: id,
  baseVersion: 0,
  op: "upsert",
  patch: { title, body: { type: "doc" }, plainText: title },
  clientUpdatedAt: new Date().toISOString()
})

const push = async (cookie: string, entries: ReadonlyArray<unknown>) => {
  const response = await workerFetch(
    "/sync/push",
    jsonRequest("POST", cookie, { entries })
  )
  return { response, body: await response.json() as SyncBody }
}

describe("GET /sync/pull", () => {
  it("parses the query string instead of crashing on the path-only request URL (#44)", async () => {
    const { session } = await sessionWithHousehold()
    const first = uuidV7()
    const second = uuidV7()

    const pushed = await push(session.cookie, [
      pushTask(first, "اول", "boundary-push-1"),
      pushTask(second, "دوم", "boundary-push-2")
    ])
    expect(pushed.response.status).toBe(200)
    expect(pushed.body.results.map((result) => result._tag)).toEqual([
      "applied",
      "applied"
    ])

    // Both the query string and `limit=1` have to survive the URL handling for
    // this assertion to hold: a 500 fails outright, an ignored limit returns 2.
    const response = await workerFetch(
      "/sync/pull?cursor=0&limit=1",
      { headers: { cookie: session.cookie } }
    )
    expect(response.status).toBe(200)
    const body = await response.json() as SyncBody
    expect(body.items).toHaveLength(1)
    expect(body.hasMore).toBe(true)
    expect(body.nextCursor).toBeGreaterThanOrEqual(1)
  })

  it("rejects a malformed cursor with 400, not an internal error", async () => {
    const { session } = await sessionWithHousehold()
    const response = await workerFetch(
      "/sync/pull?cursor=not-a-number",
      { headers: { cookie: session.cookie } }
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "BadRequest" }
    })
  })

  it("is 401 without a session", async () => {
    const response = await workerFetch("/sync/pull?cursor=0")
    expect(response.status).toBe(401)
  })
})

describe("POST /sync/push", () => {
  it("applies a client mutation and makes it visible to the next pull", async () => {
    const { session } = await sessionWithHousehold()
    const id = uuidV7()

    const pushed = await push(session.cookie, [
      pushTask(id, "خرید نان", "boundary-visible")
    ])
    expect(pushed.response.status).toBe(200)
    expect(pushed.body.results[0]).toMatchObject({
      _tag: "applied",
      entityId: id,
      version: 1
    })

    const pulled = await workerFetch("/sync/pull?cursor=0", {
      headers: { cookie: session.cookie }
    })
    expect(pulled.status).toBe(200)
    const body = await pulled.json() as SyncBody
    expect(body.items.map((item) => item.entityId)).toContain(id)
  })

  it("dedupes a replayed mutation id", async () => {
    const { session } = await sessionWithHousehold()
    const id = uuidV7()
    const entry = pushTask(id, "یک‌بار", "boundary-replay")

    const first = await push(session.cookie, [entry])
    const replay = await push(session.cookie, [entry])

    expect(first.body.results[0]?._tag).toBe("applied")
    expect(replay.body.results[0]).toMatchObject({
      _tag: "alreadyApplied",
      entityId: id,
      version: 1
    })
  })

  it("answers a malformed body with 400", async () => {
    const { session } = await sessionWithHousehold()
    const response = await workerFetch(
      "/sync/push",
      jsonRequest("POST", session.cookie, { entries: [{ nope: true }] })
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "BadRequest" }
    })
  })

  it("applies a large mixed catch-up across statement-budgeted batches", async () => {
    const { session, household } = await sessionWithHousehold()

    // 20 projects (rank 0) + 60 notes and 100 tasks (rank 1) is 660 statements
    // — one batch before this change. Parents must land in earlier chunks than
    // the tasks that reference them, and a note's FTS statements must stay in
    // the same chunk as its row write.
    const projects = Array.from({ length: 20 }, () => uuidV7())
    const notes = Array.from({ length: 60 }, () => uuidV7())
    const tasks = Array.from({ length: 100 }, () => uuidV7())
    const entries = [
      ...projects.map((id, index) => pushProject(id, `پروژه ${index}`, `boundary-large-project-${index}`)),
      ...notes.map((id, index) => pushNote(id, `یادداشت ${index}`, `boundary-large-note-${index}`)),
      ...tasks.map((id, index) =>
        ({
          ...pushTask(id, `کار ${index}`, `boundary-large-task-${index}`),
          patch: { title: `کار ${index}`, projectId: projects[index % projects.length] }
        })
      )
    ]
    expect(entries).toHaveLength(180)

    const pushed = await push(session.cookie, entries)
    expect(pushed.response.status).toBe(200)
    // One result per entry, in input order, every write applied.
    expect(pushed.body.results.map((result) => result.entityId))
      .toEqual(entries.map((entry) => entry.entityId))
    expect(pushed.body.results.every((result) => result._tag === "applied")).toBe(true)

    // The feed carries exactly one row per entry, with no duplicates from a
    // chunk that had to be retried.
    const feed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM change_feed WHERE household_id = ?"
    ).bind(household.id).first<{ readonly n: number }>()
    expect(feed?.n).toBe(180)
    const duplicated = await env.DB.prepare(
      `SELECT entity_id FROM change_feed WHERE household_id = ?
       GROUP BY entity_id HAVING COUNT(*) > 1`
    ).bind(household.id).all<{ readonly entity_id: string }>()
    expect(duplicated.results).toEqual([])

    // Every note write also maintained its search index inside the chunk.
    const indexed = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM notes_fts f
       JOIN notes n ON n.id = f.note_id
       WHERE n.household_id = ?`
    ).bind(household.id).first<{ readonly n: number }>()
    expect(indexed?.n).toBe(60)

    const pulled = await workerFetch("/sync/pull?cursor=0&limit=1000", {
      headers: { cookie: session.cookie }
    })
    expect(pulled.status).toBe(200)
    const body = await pulled.json() as SyncBody
    expect(body.items.map((item) => item.entityId).sort())
      .toEqual([...projects, ...notes, ...tasks].sort())
  })
})

describe("GET /sync/bootstrap", () => {
  it("pages live rows using its own query parameters", async () => {
    const { session } = await sessionWithHousehold()
    await push(session.cookie, [
      pushTask(uuidV7(), "یک", "boundary-bootstrap-1"),
      pushTask(uuidV7(), "دو", "boundary-bootstrap-2")
    ])

    // This also guards the D1-specific limit the fake-d1 suite cannot see: a
    // single UNION ALL over every registry table is rejected with "too many
    // terms in compound SELECT" (D1 caps the compound at five terms).
    const response = await workerFetch(
      "/sync/bootstrap?offset=0&limit=1",
      { headers: { cookie: session.cookie } }
    )

    expect(response.status).toBe(200)
    const body = await response.json() as SyncBody
    expect(body.items).toHaveLength(1)
    expect(body.hasMore).toBe(true)
    expect(body.cursor).toBeGreaterThan(0)
  })

  it("honours offset when paging across the registry", async () => {
    const { session } = await sessionWithHousehold()
    const ids = [uuidV7(), uuidV7(), uuidV7()]
    await push(session.cookie, ids.map((id, index) =>
      pushTask(id, `صفحه ${index}`, `boundary-offset-${index}`)
    ))

    const page = async (offset: number) => {
      const response = await workerFetch(
        `/sync/bootstrap?offset=${offset}&limit=1`,
        { headers: { cookie: session.cookie } }
      )
      expect(response.status).toBe(200)
      return response.json() as Promise<SyncBody>
    }

    const [first, second, third] = await Promise.all([page(0), page(1), page(2)])
    expect(second.items).toHaveLength(1)
    expect(second.nextOffset).toBe(2)
    expect(second.hasMore).toBe(true)
    // Same timestamp for one push, so the stable tiebreak is id ascending.
    expect([...first.items, ...second.items, ...third.items].map((item) => item.entityId))
      .toEqual([...ids].sort())
  })

  it("refuses a malformed offset the same way as pull", async () => {
    const { session } = await sessionWithHousehold()
    const response = await workerFetch(
      "/sync/bootstrap?offset=-1",
      { headers: { cookie: session.cookie } }
    )
    expect(response.status).toBe(400)
  })
})

describe("sync household scoping", () => {
  it("does not leak another household's rows through pull", async () => {
    const alice = await sessionWithHousehold()
    const bob = await sessionWithHousehold()
    const aliceTask = uuidV7()
    const bobTask = uuidV7()

    await push(alice.session.cookie, [
      pushTask(aliceTask, "مال آلیس", "boundary-scope-alice")
    ])
    await push(bob.session.cookie, [
      pushTask(bobTask, "مال باب", "boundary-scope-bob")
    ])

    const response = await workerFetch("/sync/pull?cursor=0", {
      headers: { cookie: bob.session.cookie }
    })
    expect(response.status).toBe(200)
    const body = await response.json() as SyncBody
    expect(body.items.map((item) => item.entityId)).toContain(bobTask)
    expect(body.items.map((item) => item.entityId)).not.toContain(aliceTask)
  })
})

describe("POST /sync/push contention", () => {
  it("returns a retryable 409 when another writer wins the version race", async () => {
    const { session } = await sessionWithHousehold()
    const taskId = uuidV7()
    const projectId = uuidV7()
    await push(session.cookie, [pushTask(taskId, "قبل", "boundary-race-seed")])

    // The boundary layer cannot hook the repo between its pre-read and its
    // batch (the fake-d1 suite uses `beforeBatch` for this). A one-shot trigger
    // plays the concurrent writer: projects are dependency-ranked before tasks
    // in the same push, so this bumps the task's version after the pre-read and
    // before the task's compare-and-set.
    // D1 forbids bound variables inside a trigger body; `taskId` is a
    // generated UUID, never client input.
    await env.DB.prepare(
      `CREATE TRIGGER boundary_race AFTER INSERT ON projects
       BEGIN
         UPDATE tasks SET version = version + 1 WHERE id = '${taskId}';
       END`
    ).run()

    try {
      const response = await workerFetch(
        "/sync/push",
        jsonRequest("POST", session.cookie, {
          entries: [
            {
              clientMutationId: "boundary-race-project",
              entityType: "project",
              entityId: projectId,
              baseVersion: 0,
              op: "upsert",
              patch: { title: "پروژه" },
              clientUpdatedAt: new Date().toISOString()
            },
            { ...pushTask(taskId, "بعد", "boundary-race-task"), baseVersion: 1 }
          ]
        })
      )

      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        error: { code: "Conflict", retryable: true }
      })
    } finally {
      await env.DB.prepare("DROP TRIGGER boundary_race").run()
    }

    // The losing write left the row untouched; the client retries from fresh
    // state rather than overwriting the winner.
    const page = await workerFetch("/sync/pull?cursor=0", {
      headers: { cookie: session.cookie }
    })
    const body = await page.json() as { readonly items: ReadonlyArray<{ readonly entityId: string; readonly data: { readonly title: string } }> }
    expect(body.items.find((item) => item.entityId === taskId)?.data.title).toBe("قبل")
  })
})
