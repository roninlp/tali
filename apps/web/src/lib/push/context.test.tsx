import { render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { uuidV7, type LoginInput, type SessionContext } from "@tali/domain"
import { AuthProvider, useAuth, type AuthStore } from "../auth"
import { PushProvider } from "./context"

/**
 * The boot contract for the push shell: registering the service worker is part
 * of every boot (installability), but the VAPID key has one consumer — the
 * signed-in `POST /push/register` — so a signed-out boot must not ask the API
 * for it, and a sign-in must ask exactly once.
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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

/** A minimal `ServiceWorkerContainer`: no push support, no existing subscription. */
const stubServiceWorker = () => {
  const registration = {
    active: { postMessage: vi.fn() },
    pushManager: { getSubscription: vi.fn(async () => null) }
  }
  const container = {
    register: vi.fn(async () => registration),
    ready: Promise.resolve(registration),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: container
  })
  return container
}

let auth: AuthStore | undefined

function Probe() {
  auth = useAuth()
  return null
}

const mount = () =>
  render(() => (
    <AuthProvider>
      <PushProvider>
        <Probe />
      </PushProvider>
    </AuthProvider>
  ))

describe("PushProvider boot", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  const vapidRequests = (): number =>
    fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/push/vapid")).length

  beforeEach(() => {
    localStorage.clear()
    auth = undefined
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/auth/me")) return json({}, 401)
      if (url.endsWith("/auth/login")) return json(session)
      if (url.endsWith("/push/vapid")) return json({ publicKey: "test-public-key" })
      throw new Error(`unexpected request: ${url}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    Reflect.deleteProperty(navigator, "serviceWorker")
  })

  it("registers the worker but makes no VAPID request while signed out", async () => {
    const container = stubServiceWorker()
    const view = mount()

    await waitFor(() => expect(container.register).toHaveBeenCalled())
    await waitFor(() => expect(auth?.status()).toBe("signedOut"))
    // Let the boot effect's registration promise settle before asserting.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(vapidRequests()).toBe(0)
    view.unmount()
  })

  it("makes exactly one VAPID request when a sign-in arrives", async () => {
    stubServiceWorker()
    const view = mount()

    await waitFor(() => expect(auth?.status()).toBe("signedOut"))
    expect(vapidRequests()).toBe(0)

    const result = await auth!.signIn({
      email: "owner@example.com",
      loginKey: "test-login-key"
    } as unknown as LoginInput)
    expect(result.ok).toBe(true)
    await waitFor(() => expect(auth?.status()).toBe("signedIn"))

    await waitFor(() => expect(vapidRequests()).toBe(1))
    // Give a duplicate boot refresh the chance to show up before pinning it.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(vapidRequests()).toBe(1)

    view.unmount()
  })
})
