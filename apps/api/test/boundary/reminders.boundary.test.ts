import { describe, expect, it } from "vitest"
import {
  jsonRequest,
  seedDispatch,
  sessionWithHousehold,
  workerFetch
} from "./support.js"

/**
 * Reminder respond + history over the real Worker.
 *
 * These routes are the service worker's target: it posts a Done/Snooze answer
 * with the session cookie, then the app reads the inbox/history. The boundary
 * concerns are the path parameter (`/reminders/dispatches/:id/respond`), the
 * query string on `/reminders/inbox`, and the cookie-derived viewer.
 */

interface InboxBody {
  readonly items: ReadonlyArray<{
    readonly state: string
    readonly title: string
    readonly dispatch: { readonly id: string; readonly response: string | null }
  }>
}

interface RespondBody {
  readonly dispatch: {
    readonly id: string
    readonly response: string | null
    readonly respondedAt: string | null
  }
  readonly child: unknown
  readonly onTime: boolean
}

describe("GET /reminders/inbox", () => {
  it("reads the owner's unanswered dispatch", async () => {
    const { session, household } = await sessionWithHousehold()
    const { dispatchId } = await seedDispatch(session.userId, household.id)

    const response = await workerFetch("/reminders/inbox", {
      headers: { cookie: session.cookie }
    })

    expect(response.status).toBe(200)
    const body = await response.json() as InboxBody
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({
      state: "inbox",
      title: "داروی روزانه"
    })
    expect(body.items[0]?.dispatch.id).toBe(dispatchId)
  })

  it("rejects an out-of-range limit instead of coercing it", async () => {
    const { session } = await sessionWithHousehold()
    const response = await workerFetch("/reminders/inbox?limit=999", {
      headers: { cookie: session.cookie }
    })
    expect(response.status).toBe(400)
  })

  it("is 401 without a session", async () => {
    const response = await workerFetch("/reminders/inbox")
    expect(response.status).toBe(401)
  })
})

describe("POST /reminders/dispatches/:id/respond", () => {
  it("stores a Done answer and moves it into history", async () => {
    const { session, household } = await sessionWithHousehold()
    const { dispatchId } = await seedDispatch(session.userId, household.id)

    const responded = await workerFetch(
      `/reminders/dispatches/${dispatchId}/respond`,
      jsonRequest("POST", session.cookie, { response: "done" })
    )
    expect(responded.status).toBe(200)
    const body = await responded.json() as RespondBody
    expect(body.dispatch).toMatchObject({ id: dispatchId, response: "done" })
    expect(body.dispatch.respondedAt).toEqual(expect.any(String))

    // The inbox is now empty; the history read still carries the answer.
    const inbox = await workerFetch("/reminders/inbox", {
      headers: { cookie: session.cookie }
    })
    expect((await inbox.json() as InboxBody).items).toHaveLength(0)

    const history = await workerFetch("/reminders/inbox?history=1", {
      headers: { cookie: session.cookie }
    })
    const historyBody = await history.json() as InboxBody
    expect(historyBody.items).toHaveLength(1)
    expect(historyBody.items[0]).toMatchObject({
      state: "history",
      dispatch: { id: dispatchId, response: "done" }
    })
  })

  it("treats a double tap as a no-op that returns the stored answer", async () => {
    const { session, household } = await sessionWithHousehold()
    const { dispatchId } = await seedDispatch(session.userId, household.id)
    const path = `/reminders/dispatches/${dispatchId}/respond`

    const first = await workerFetch(path, jsonRequest("POST", session.cookie, { response: "done" }))
    const second = await workerFetch(path, jsonRequest("POST", session.cookie, { response: "snooze", snoozeMinutes: 5 }))

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const body = await second.json() as RespondBody
    expect(body.dispatch.response).toBe("done")
    expect(body.child).toBeNull()
  })

  it("queues a snooze child when the answer is snooze", async () => {
    const { session, household } = await sessionWithHousehold()
    const { dispatchId } = await seedDispatch(session.userId, household.id)

    const response = await workerFetch(
      `/reminders/dispatches/${dispatchId}/respond`,
      jsonRequest("POST", session.cookie, { response: "snooze", snoozeMinutes: 5 })
    )

    expect(response.status).toBe(200)
    const body = await response.json() as RespondBody & {
      readonly child: { readonly id: string; readonly origin: string } | null
    }
    expect(body.dispatch.response).toBe("snooze")
    expect(body.child).toMatchObject({ origin: `snooze:${dispatchId}` })
  })

  it("rejects a malformed dispatch id on the path", async () => {
    const { session } = await sessionWithHousehold()
    const response = await workerFetch(
      "/reminders/dispatches/not-a-uuid/respond",
      jsonRequest("POST", session.cookie, { response: "done" })
    )
    expect(response.status).toBe(400)
  })

  it("does not let another user answer the dispatch", async () => {
    const owner = await sessionWithHousehold()
    const stranger = await sessionWithHousehold()
    const { dispatchId } = await seedDispatch(owner.session.userId, owner.household.id)

    const response = await workerFetch(
      `/reminders/dispatches/${dispatchId}/respond`,
      jsonRequest("POST", stranger.session.cookie, { response: "done" })
    )
    expect(response.status).toBe(404)
  })
})
