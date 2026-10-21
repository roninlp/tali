import { afterEach, describe, expect, it, vi } from "vitest"
import { uuidV7 } from "@tali/domain"
import { fetchReminderInbox, respondToReminder } from "./api"

/**
 * The plain-HTTP ledger client (#60). These pin the two contracts #61's
 * service-worker/outbox drain will rely on: the inbox URL/query shape and the
 * respond body (including the preset snooze minutes), plus error classification.
 */

const dispatch = (overrides: Record<string, unknown> = {}) => ({
  id: uuidV7(),
  reminderId: uuidV7(),
  userId: uuidV7(),
  scheduledFor: "2026-10-20T08:00:00.000Z",
  deliverAt: "2026-10-20T08:00:00.000Z",
  rootScheduledFor: "2026-10-20T08:00:00.000Z",
  origin: "schedule",
  pushOutcome: "accepted",
  attempts: 1,
  lastAttemptAt: "2026-10-20T08:00:05.000Z",
  parentDispatchId: null,
  response: null,
  respondedAt: null,
  snoozedUntil: null,
  createdAt: "2026-10-20T08:00:00.000Z",
  ...overrides
})

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchReminderInbox", () => {
  it("requests the inbox with history/limit and decodes the items", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        items: [
          {
            dispatch: dispatch(),
            reminderId: uuidV7(),
            title: "دارو",
            note: "یک قرص",
            kind: "medication",
            tier: "critical",
            link: { _tag: "none" },
            state: "inbox"
          }
        ]
      })
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await fetchReminderInbox({ history: true, limit: 25 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(result.value[0]).toMatchObject({ title: "دارو", tier: "critical", state: "inbox" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("http://localhost:8787/reminders/inbox?history=1&limit=25")
    expect(init.credentials).toBe("include")
  })

  it("maps a 401 to a non-retryable Unauthorized failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 401)))
    const result = await fetchReminderInbox()
    expect(result).toEqual({ ok: false, error: { code: "Unauthorized", retryable: false } })
  })

  it("maps a transport failure to a retryable Network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline")
    }))
    const result = await fetchReminderInbox()
    expect(result).toEqual({ ok: false, error: { code: "Network", retryable: true } })
  })
})

describe("respondToReminder", () => {
  it("posts Done and decodes the answered dispatch", async () => {
    const answered = dispatch({
      response: "done",
      respondedAt: "2026-10-20T08:10:00.000Z"
    })
    const fetchMock = vi.fn(async () =>
      jsonResponse({ dispatch: answered, child: null, onTime: true })
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await respondToReminder({ dispatchId: answered.id, response: "done" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.dispatch.response).toBe("done")
    expect(result.value.onTime).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(
      `http://localhost:8787/reminders/dispatches/${encodeURIComponent(answered.id)}/respond`
    )
    expect(JSON.parse(String(init.body))).toEqual({ response: "done" })
  })

  it("sends the snooze preset in the body", async () => {
    const parent = dispatch({ response: "snooze", snoozedUntil: "2026-10-20T08:15:00.000Z" })
    const child = dispatch({
      scheduledFor: "2026-10-20T08:15:00.000Z",
      deliverAt: "2026-10-20T08:15:00.000Z",
      origin: `snooze:${parent.id}`,
      parentDispatchId: parent.id
    })
    const fetchMock = vi.fn(async () =>
      jsonResponse({ dispatch: parent, child, onTime: false })
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await respondToReminder({
      dispatchId: parent.id,
      response: "snooze",
      snoozeMinutes: 15
    })
    expect(result.ok).toBe(true)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ response: "snooze", snoozeMinutes: 15 })
  })

  it("maps a 404 to NotFound", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 404)))
    const result = await respondToReminder({ dispatchId: uuidV7(), response: "dismiss" })
    expect(result).toEqual({ ok: false, error: { code: "NotFound", retryable: false } })
  })
})
