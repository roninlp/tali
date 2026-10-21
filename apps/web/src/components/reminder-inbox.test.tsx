import "fake-indexeddb/auto"
import { flush } from "solid-js"
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { uuidV7 } from "@tali/domain"
import { ReminderInbox } from "./reminder-inbox"

/**
 * Ticket #61 at the inbox seam: a dispatch the browser never saw renders on
 * `/reminders` with Done/Snooze/Dismiss, and answering it posts to the existing
 * respond route and takes the row out of the list.
 *
 * The network is stubbed; the queue drain runs against `fake-indexeddb`. What
 * this pins is that the UI is driven by the server ledger (never by "did a push
 * arrive") and that an answer is a real request, not just a local hide.
 */

const dispatch = () => ({
  id: uuidV7(),
  reminderId: uuidV7(),
  userId: uuidV7(),
  scheduledFor: "2026-10-20T08:00:00.000Z",
  deliverAt: "2026-10-20T08:00:00.000Z",
  rootScheduledFor: "2026-10-20T08:00:00.000Z",
  origin: "schedule",
  pushOutcome: "expired",
  attempts: 0,
  lastAttemptAt: null,
  parentDispatchId: null,
  response: null,
  respondedAt: null,
  snoozedUntil: null,
  createdAt: "2026-10-20T08:00:00.000Z"
})

const missedItem = (title: string) => ({
  dispatch: dispatch(),
  reminderId: uuidV7(),
  title,
  note: "یک قرص",
  kind: "medication",
  tier: "critical",
  link: { _tag: "none" },
  state: "inbox"
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

const stubNetwork = (inbox: () => ReadonlyArray<unknown>) => {
  const calls: Array<{ readonly url: string; readonly method: string; readonly body: string }> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : "" })
    if (method === "POST" && url.includes("/reminders/dispatches/")) {
      return json({ dispatch: { ...dispatch(), response: "done" }, child: null, onTime: true })
    }
    return json({ items: inbox() })
  })
  vi.stubGlobal("fetch", fetchMock)
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ReminderInbox", () => {
  it("renders a missed dispatch and answers Done through the respond route", async () => {
    let items: ReadonlyArray<unknown> = [missedItem("داروی فشار")]
    const calls = stubNetwork(() => items)

    const { getByText, queryByText, findAllByText } = render(() => <ReminderInbox />)
    await findAllByText("داروی فشار")

    const done = getByText("انجام شد")
    items = []
    fireEvent.click(done)

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST")).toBe(true)
    })
    const post = calls.find((call) => call.method === "POST")!
    expect(post.url).toContain("/reminders/dispatches/")
    expect(post.url).toContain("/respond")
    expect(JSON.parse(post.body)).toEqual({ response: "done" })

    await waitFor(() => {
      expect(queryByText("داروی فشار")).toBeNull()
    })
  })

  it("shows the calm empty state when the ledger has no unanswered rows", async () => {
    stubNetwork(() => [])
    const { findAllByText } = render(() => <ReminderInbox />)
    await findAllByText(/یادآوری بی‌پاسخی نیست/)
  })

  it("snoozes with the selected preset", async () => {
    let items: ReadonlyArray<unknown> = [missedItem("ورزش صبح")]
    const calls = stubNetwork(() => items)

    const { getByText, findAllByText, container } = render(() => <ReminderInbox />)
    await findAllByText("ورزش صبح")

    const select = container.querySelector("select")!
    select.value = "30"
    fireEvent.change(select)
    flush()

    items = []
    fireEvent.click(getByText("بعداً"))

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST")
      expect(post).toBeDefined()
      expect(JSON.parse(post!.body)).toEqual({ response: "snooze", snoozeMinutes: 30 })
    })
  })
})
