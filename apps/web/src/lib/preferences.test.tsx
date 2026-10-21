import { render, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  defaultPreferences,
  todayInTimeZone,
  uuidV7,
  type SessionContext,
  type UserPreferences
} from "@tali/domain"
import { AuthProvider } from "./auth"
import { PreferencesProvider, usePreferences } from "./preferences"
import { cachePreferences, readCachedPreferences } from "./preferences-cache"
import { weekDaysFor } from "./preferences-format"

/**
 * Ticket #35 exit criteria at the client seam: an offline boot renders the
 * last-known week start and digits, a successful PATCH updates the cache and
 * re-renders the week without a reload, and a failed PATCH never queues a
 * preference (the cache keeps the last server value).
 */

const session: SessionContext = {
  user: {
    id: uuidV7() as SessionContext["user"]["id"],
    email: "owner@example.com" as SessionContext["user"]["email"],
    displayName: "مالک",
    timeZone: "Asia/Tehran",
    weekStart: "saturday",
    digits: "persian"
  },
  householdId: uuidV7() as NonNullable<SessionContext["householdId"]>
}

const preferencesFor = (overrides: Partial<UserPreferences> = {}): UserPreferences => ({
  ...defaultPreferences(session.user.id),
  timeZone: session.user.timeZone,
  ...overrides
})

interface RequestLog {
  readonly method: string
  readonly body: unknown
}

interface FetchPlan {
  /** `"fail"` simulates an offline/transport failure. */
  readonly get?: UserPreferences | "fail"
  readonly patch?: { readonly status: number; readonly preferences?: UserPreferences }
}

let requests: Array<RequestLog> = []

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

const stubFetch = (plan: FetchPlan): void => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/auth/me")) return json(200, session)
    if (!url.endsWith("/preferences")) throw new Error(`unexpected fetch: ${url}`)

    const method = init?.method ?? "GET"
    requests.push({
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    })

    if (method === "PATCH") {
      if (plan.patch === undefined || plan.patch.status !== 200) {
        return json(plan.patch?.status ?? 500, {
          error: { code: "InternalError", message: "boom", retryable: true, details: {} }
        })
      }
      return json(200, { preferences: plan.patch.preferences })
    }

    if (plan.get === "fail") throw new TypeError("network down")
    return json(200, { preferences: plan.get ?? preferencesFor() })
  }) as unknown as typeof fetch
}

function Probe() {
  const preferences = usePreferences()
  const week = () => weekDaysFor(todayInTimeZone(session.user.timeZone), preferences.preferences())

  return (
    <div>
      <span data-testid="source">{preferences.source()}</span>
      <span data-testid="time-zone">{preferences.preferences().timeZone}</span>
      <span data-testid="week-start">{preferences.preferences().weekStart}</span>
      <span data-testid="digits">{preferences.preferences().digits}</span>
      <span data-testid="error">{preferences.error() ?? ""}</span>
      <span data-testid="first-weekday">{week()[0]?.weekday}</span>
      <span data-testid="days">{week().map((day) => day.day).join("|")}</span>
      <button
        type="button"
        onClick={() =>
          void preferences.update({ weekStart: "monday", digits: "latin" })
        }
      >
        save
      </button>
    </div>
  )
}

const mount = () =>
  render(() => (
    <AuthProvider>
      <PreferencesProvider>
        <Probe />
      </PreferencesProvider>
    </AuthProvider>
  ))

describe("PreferencesProvider", () => {
  beforeEach(() => {
    localStorage.clear()
    requests = []
  })

  it("boots offline from the cached week start and digits, across a remount", async () => {
    const cached = preferencesFor({ weekStart: "monday", digits: "latin" })
    cachePreferences(cached)
    stubFetch({ get: "fail" })

    const first = mount()
    await waitFor(() => expect(first.getByTestId("source").textContent).toBe("cache"))
    await waitFor(() => expect(first.getByTestId("error").textContent).toBe("Network"))
    expect(first.getByTestId("week-start").textContent).toBe("monday")
    expect(first.getByTestId("digits").textContent).toBe("latin")
    // The week starts on Monday and its day numerals are Latin.
    expect(first.getByTestId("first-weekday").textContent).toBe("دوشنبه")
    expect(first.getByTestId("days").textContent).toMatch(/^[0-9]+(\|[0-9]+){6}$/)
    first.unmount()

    // A fresh boot (what a reload does) still has the values offline.
    const second = mount()
    await waitFor(() => expect(second.getByTestId("source").textContent).toBe("cache"))
    expect(second.getByTestId("week-start").textContent).toBe("monday")
    expect(second.getByTestId("digits").textContent).toBe("latin")
    expect(second.getByTestId("first-weekday").textContent).toBe("دوشنبه")
    second.unmount()
  })

  it("falls back to the profile/defaults offline when nothing is cached", async () => {
    stubFetch({ get: "fail" })

    const screen = mount()
    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("Network"))
    expect(screen.getByTestId("source").textContent).toBe("default")
    expect(screen.getByTestId("week-start").textContent).toBe("saturday")
    expect(screen.getByTestId("digits").textContent).toBe("persian")
    expect(screen.getByTestId("time-zone").textContent).toBe("Asia/Tehran")
    expect(screen.getByTestId("first-weekday").textContent).toBe("شنبه")
    expect(screen.getByTestId("days").textContent).toMatch(/^[۰-۹]+(\|[۰-۹]+){6}$/)
    screen.unmount()
  })

  it("applies a successful PATCH to the week grid and the cache without a reload", async () => {
    const updated = preferencesFor({ weekStart: "monday", digits: "latin" })
    stubFetch({ get: preferencesFor(), patch: { status: 200, preferences: updated } })

    const screen = mount()
    await waitFor(() => expect(screen.getByTestId("source").textContent).toBe("server"))
    expect(screen.getByTestId("week-start").textContent).toBe("saturday")

    screen.getByRole("button", { name: "save" }).click()

    await waitFor(() => expect(screen.getByTestId("week-start").textContent).toBe("monday"))
    expect(screen.getByTestId("digits").textContent).toBe("latin")
    expect(screen.getByTestId("first-weekday").textContent).toBe("دوشنبه")
    expect(screen.getByTestId("days").textContent).toMatch(/^[0-9]+(\|[0-9]+){6}$/)

    // The same tick updated the cache, so the next offline boot sees it.
    expect(readCachedPreferences(session.user.id)).toMatchObject({
      weekStart: "monday",
      digits: "latin"
    })
    const patch = requests.find((request) => request.method === "PATCH")
    expect(patch?.body).toEqual({ weekStart: "monday", digits: "latin" })
    screen.unmount()
  })

  it("keeps the last cached values when a PATCH fails and shows a retryable error", async () => {
    const cached = preferencesFor({ weekStart: "monday", digits: "latin" })
    cachePreferences(cached)
    stubFetch({ get: "fail", patch: { status: 500 } })

    const screen = mount()
    await waitFor(() => expect(screen.getByTestId("source").textContent).toBe("cache"))

    screen.getByRole("button", { name: "save" }).click()

    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("InternalError"))
    expect(screen.getByTestId("week-start").textContent).toBe("monday")
    expect(screen.getByTestId("digits").textContent).toBe("latin")
    expect(readCachedPreferences(session.user.id)).toMatchObject({
      weekStart: "monday",
      digits: "latin"
    })
    screen.unmount()
  })
})
