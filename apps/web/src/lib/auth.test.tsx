import { Show } from "solid-js"
import { render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { uuidV7, type SessionContext } from "@tali/domain"
import { AuthProvider, useAuth } from "./auth"
import { BootScreen } from "../components/boot"
import { cacheSession, readCachedSession } from "./session-cache"

/**
 * Optimistic boot at the client seam: a cached session is visible on the first
 * synchronous render (no splash while `/auth/me` is in flight), `Unauthorized`
 * still clears, a transport failure keeps the cache and records `bootFailure`,
 * and a boot restores the session exactly once.
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

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

const deferredResponse = () => {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

let meCalls = 0
const originalFetch = globalThis.fetch

const stubMe = (respond: () => Promise<Response>): void => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.endsWith("/auth/me")) throw new Error(`unexpected fetch: ${url}`)
    meCalls += 1
    return respond()
  }) as unknown as typeof fetch
}

/**
 * Stands in for `Guard` without pulling in the router: the guarded content is
 * gated exactly as `household` access gates it, and the real boot screen is the
 * fallback so a stray splash is visible to the assertions.
 */
function Probe() {
  const auth = useAuth()

  return (
    <div>
      <span data-testid="status">{auth.status()}</span>
      <span data-testid="session">{auth.session()?.user.email ?? ""}</span>
      <span data-testid="failure">{auth.bootFailure()?.code ?? ""}</span>
      <Show
        when={auth.status() === "signedIn" && auth.householdId() !== undefined}
        fallback={<BootScreen />}
      >
        <main data-testid="guarded">guarded</main>
      </Show>
    </div>
  )
}

const mount = () => render(() => <AuthProvider><Probe /></AuthProvider>)

describe("AuthProvider boot", () => {
  beforeEach(() => {
    localStorage.clear()
    meCalls = 0
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("renders guarded content from the cached session while /auth/me is in flight", async () => {
    const me = deferredResponse()
    stubMe(() => me.promise)
    cacheSession(session)

    const screen = mount()

    // The very first render already knows the user: no splash, no `checking`.
    expect(screen.getByTestId("status").textContent).toBe("signedIn")
    expect(screen.getByTestId("session").textContent).toBe(session.user.email)
    expect(screen.getByTestId("guarded")).toBeTruthy()
    expect(screen.queryByText("در حال بارگذاری…")).toBeNull()

    // The reconcile request is in flight, and the shell stays signed in.
    await waitFor(() => expect(meCalls).toBe(1))
    expect(screen.getByTestId("status").textContent).toBe("signedIn")
    expect(screen.getByTestId("guarded")).toBeTruthy()

    me.resolve(json(200, session))

    await waitFor(() => expect(screen.getByTestId("failure").textContent).toBe(""))
    expect(screen.getByTestId("status").textContent).toBe("signedIn")
    screen.unmount()
  })

  it("clears the cached session when /auth/me answers Unauthorized", async () => {
    stubMe(async () => json(401, {}))
    cacheSession(session)

    const screen = mount()
    expect(screen.getByTestId("status").textContent).toBe("signedIn")

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signedOut"))
    expect(screen.queryByTestId("guarded")).toBeNull()
    expect(readCachedSession()).toBeUndefined()
    screen.unmount()
  })

  it("keeps the cached session signed in when the boot request fails, and records bootFailure", async () => {
    stubMe(async () => {
      throw new TypeError("network down")
    })
    cacheSession(session)

    const screen = mount()

    await waitFor(() => expect(screen.getByTestId("failure").textContent).toBe("Network"))
    expect(screen.getByTestId("status").textContent).toBe("signedIn")
    expect(screen.getByTestId("session").textContent).toBe(session.user.email)
    expect(screen.getByTestId("guarded")).toBeTruthy()
    // The cache survives a transient failure so the next boot stays instant.
    expect(readCachedSession()).toMatchObject({ user: { email: session.user.email } })
    screen.unmount()
  })

  it("restores the session with exactly one /auth/me call per boot", async () => {
    stubMe(async () => json(200, session))
    cacheSession(session)

    const screen = mount()

    await waitFor(() => expect(meCalls).toBe(1))
    await Promise.resolve()
    await Promise.resolve()

    expect(meCalls).toBe(1)
    expect(screen.getByTestId("status").textContent).toBe("signedIn")
    screen.unmount()
  })
})
