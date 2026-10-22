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

    await push(alice.session.cookie, [
      pushTask(aliceTask, "خصوصی خانه", "boundary-scope")
    ])

    const response = await workerFetch("/sync/pull?cursor=0", {
      headers: { cookie: bob.session.cookie }
    })
    expect(response.status).toBe(200)
    const body = await response.json() as SyncBody
    expect(body.items.map((item) => item.entityId)).not.toContain(aliceTask)
  })
})
