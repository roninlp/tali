import { describe, expect, it } from "vitest"
import {
  createHousehold,
  jsonRequest,
  LOGIN_KEY,
  register,
  SESSION_COOKIE,
  sessionCookieOf,
  sessionWithHousehold,
  workerFetch
} from "./support.js"

/**
 * `/auth/*` and `/household*` over the real Worker.
 *
 * Service-direct tests already prove the credential and household logic. What
 * only this layer can prove is the HTTP contract: status codes, the error
 * envelope, and the session cookie the browser depends on.
 */

interface ErrorEnvelope {
  readonly error: { readonly code: string; readonly retryable?: boolean }
}

/** The cookie's `Max-Age` in seconds, or `NaN` when the attribute is absent. */
const maxAgeOf = (setCookie: string | undefined): number =>
  Number(/max-age=(\d+)/i.exec(setCookie ?? "")?.[1])

describe("POST /auth/register", () => {
  it("mints an HTTP-only session cookie alongside the created user", async () => {
    const response = await workerFetch(
      "/auth/register",
      jsonRequest("POST", undefined, {
        email: "cookie@example.com",
        loginKey: LOGIN_KEY,
        displayName: "کوکی",
        timeZone: "Asia/Tehran"
      })
    )

    expect(response.status).toBe(201)
    expect(response.headers.get("cache-control")).toBe("no-store")

    const setCookie = response.headers.getSetCookie()
    const session = setCookie.find((value) => value.startsWith(`${SESSION_COOKIE}=`))
    expect(session).toBeDefined()
    expect(session).toMatch(/httponly/i)
    expect(session).toMatch(/samesite=lax/i)
    expect(session).toMatch(/path=\//i)
    expect(maxAgeOf(session)).toBeGreaterThan(0)

    const body = await response.json() as {
      readonly user: { readonly id: string; readonly displayName: string }
      readonly householdId: null
    }
    expect(body.user.displayName).toBe("کوکی")
    expect(body.householdId).toBeNull()
  })

  it("answers a duplicate email with the 409 error envelope", async () => {
    const email = "duplicate@example.com"
    await register(email)

    const response = await workerFetch(
      "/auth/register",
      jsonRequest("POST", undefined, {
        email,
        loginKey: LOGIN_KEY,
        displayName: "دوباره",
        timeZone: "UTC"
      })
    )

    expect(response.status).toBe(409)
    expect(await response.json<ErrorEnvelope>()).toMatchObject({
      error: { code: "EmailAlreadyRegistered", retryable: false }
    })
  })
})

describe("GET /auth/me", () => {
  it("resolves the cookie's session and re-stamps the cookie", async () => {
    const session = await register()
    const response = await workerFetch("/auth/me", {
      headers: { cookie: session.cookie }
    })

    expect(response.status).toBe(200)
    expect(sessionCookieOf(response)).toMatch(new RegExp(`^${SESSION_COOKIE}=`))
    const body = await response.json() as {
      readonly user: { readonly id: string }
      readonly householdId: null
    }
    expect(body.user.id).toBe(session.userId)
    expect(body.householdId).toBeNull()
  })

  it("is 401 without a session cookie", async () => {
    const response = await workerFetch("/auth/me")
    expect(response.status).toBe(401)
    expect(await response.json<ErrorEnvelope>()).toMatchObject({
      error: { code: "Unauthorized" }
    })
  })
})

describe("POST /auth/login", () => {
  it("mints a session cookie for the right login key", async () => {
    const registered = await register()
    const response = await workerFetch(
      "/auth/login",
      jsonRequest("POST", undefined, {
        email: registered.email,
        loginKey: LOGIN_KEY
      })
    )

    expect(response.status).toBe(200)
    const header = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${SESSION_COOKIE}=`))
    expect(maxAgeOf(header)).toBeGreaterThan(0)
    const cookie = sessionCookieOf(response)
    if (cookie === undefined) throw new Error("login did not mint a session cookie")
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`))

    const me = await workerFetch("/auth/me", { headers: { cookie } })
    expect(me.status).toBe(200)
    expect((await me.json() as { readonly user: { readonly id: string } }).user.id).toBe(
      registered.userId
    )
  })

  it("rejects a wrong login key without leaking which field failed", async () => {
    const session = await register()
    const response = await workerFetch(
      "/auth/login",
      jsonRequest("POST", undefined, {
        email: session.email,
        loginKey: "b".repeat(43)
      })
    )

    expect(response.status).toBe(401)
    expect(await response.json<ErrorEnvelope>()).toMatchObject({
      error: { code: "InvalidCredentials" }
    })
  })
})

describe("POST /auth/logout", () => {
  it("expires the session cookie", async () => {
    const session = await register()
    const response = await workerFetch("/auth/logout", {
      method: "POST",
      headers: { cookie: session.cookie }
    })

    expect(response.status).toBe(200)
    const expired = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${SESSION_COOKIE}=`))
    expect(expired).toMatch(/max-age=0/i)
  })
})

describe("household routes", () => {
  it("creates a household and lets a second account join by invite", async () => {
    const owner = await register("owner@example.com")
    const household = await createHousehold(owner, "خانهٔ ما")
    expect(household.inviteCode.length).toBeGreaterThan(0)

    const partner = await register("partner@example.com")
    const join = await workerFetch(
      "/household/join",
      jsonRequest("POST", partner.cookie, { inviteCode: household.inviteCode })
    )

    expect(join.status).toBe(200)
    const body = await join.json() as { readonly household: { readonly id: string } }
    expect(body.household.id).toBe(household.id)

    // The join response re-stamps the cookie, so the client keeps its session.
    expect(sessionCookieOf(join)).toBeDefined()
  })

  it("rejects an unknown invite code with the InviteInvalid envelope", async () => {
    const stranger = await register("stranger@example.com")
    const response = await workerFetch(
      "/household/join",
      jsonRequest("POST", stranger.cookie, { inviteCode: "not-a-real-invite" })
    )

    expect(response.status).toBe(404)
    expect(await response.json<ErrorEnvelope>()).toMatchObject({
      error: { code: "InviteInvalid" }
    })
  })

  it("refuses a household create without a session", async () => {
    const response = await workerFetch("/household", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "بی‌صاحب" })
    })
    expect(response.status).toBe(401)
  })

  it("reports the household on the session context", async () => {
    const { session, household } = await sessionWithHousehold()

    const response = await workerFetch("/auth/me", {
      headers: { cookie: session.cookie }
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { readonly householdId: string | null }
    expect(body.householdId).toBe(household.id)
  })
})
