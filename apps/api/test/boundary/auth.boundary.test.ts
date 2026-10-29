import { describe, expect, it } from "vitest"
import { env } from "cloudflare:workers"
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

/** The stored expiry — the row the hot path used to rewrite on every request. */
const expiresAtOf = async (userId: string): Promise<string | null> => {
  const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE user_id = ?")
    .bind(userId)
    .first<{ readonly expires_at: string }>()
  return row?.expires_at ?? null
}

const setExpiresAt = (userId: string, expiresAt: string): Promise<unknown> =>
  env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?")
    .bind(expiresAt, userId)
    .run()

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
  it("resolves the cookie's session without writing or re-stamping a fresh one", async () => {
    const session = await register()
    const before = await expiresAtOf(session.userId)
    expect(before).not.toBeNull()

    const first = await workerFetch("/auth/me", { headers: { cookie: session.cookie } })
    const second = await workerFetch("/auth/me", { headers: { cookie: session.cookie } })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    // Regression: the old hot path extended the row (a D1 write) and re-stamped
    // the cookie on every call. A healthy session must leave both untouched.
    expect(sessionCookieOf(first)).toBeUndefined()
    expect(sessionCookieOf(second)).toBeUndefined()
    expect(await expiresAtOf(session.userId)).toBe(before)

    const body = await second.json() as {
      readonly user: { readonly id: string }
      readonly householdId: null
    }
    expect(body.user.id).toBe(session.userId)
    expect(body.householdId).toBeNull()
  })

  it("does not extend a session that is not close to expiry", async () => {
    const session = await register()
    // 20 days left: well above the 7-day renewal threshold, and a fixed value
    // so the old per-request `extend` would be visible no matter how fast the
    // two calls run.
    const pinned = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString()
    await setExpiresAt(session.userId, pinned)

    await workerFetch("/auth/me", { headers: { cookie: session.cookie } })
    const second = await workerFetch("/auth/me", { headers: { cookie: session.cookie } })

    expect(second.status).toBe(200)
    expect(await expiresAtOf(session.userId)).toBe(pinned)
    expect(sessionCookieOf(second)).toBeUndefined()
  })

  it("slides the row and re-stamps the cookie when the session is close to expiry", async () => {
    const session = await register()
    await setExpiresAt(
      session.userId,
      new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
    )

    const response = await workerFetch("/auth/me", { headers: { cookie: session.cookie } })
    expect(response.status).toBe(200)

    const renewedAt = await expiresAtOf(session.userId)
    if (renewedAt === null) throw new Error("session row disappeared")
    expect(Date.parse(renewedAt)).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000)

    const setCookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${SESSION_COOKIE}=`))
    expect(setCookie).toBeDefined()
    // Same token (no rotation), full TTL again.
    expect(sessionCookieOf(response)).toBe(session.cookie)
    expect(maxAgeOf(setCookie)).toBe(30 * 24 * 60 * 60)
  })

  it("rejects and deletes an expired session", async () => {
    const session = await register()
    await setExpiresAt(session.userId, new Date(Date.now() - 60 * 1000).toISOString())

    const response = await workerFetch("/auth/me", { headers: { cookie: session.cookie } })

    expect(response.status).toBe(401)
    expect(await response.json<ErrorEnvelope>()).toMatchObject({
      error: { code: "Unauthorized" }
    })
    expect(await expiresAtOf(session.userId)).toBeNull()
  })

  it("rejects a malformed expiry instead of accepting it forever", async () => {
    const session = await register()
    await setExpiresAt(session.userId, "not-a-date")

    const response = await workerFetch("/auth/me", { headers: { cookie: session.cookie } })

    expect(response.status).toBe(401)
    expect(await expiresAtOf(session.userId)).toBeNull()
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

    // A fresh session is already at full TTL, so the join does not re-stamp it.
    expect(sessionCookieOf(join)).toBeUndefined()
  })

  it("renews the row and the cookie together when a mutation runs near expiry", async () => {
    const owner = await register()
    const household = await createHousehold(owner, "خانهٔ نزدیک انقضا")
    const partner = await register()
    await setExpiresAt(
      partner.userId,
      new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
    )

    const join = await workerFetch(
      "/household/join",
      jsonRequest("POST", partner.cookie, { inviteCode: household.inviteCode })
    )

    expect(join.status).toBe(200)
    const renewedAt = await expiresAtOf(partner.userId)
    if (renewedAt === null) throw new Error("session row disappeared")
    expect(Date.parse(renewedAt)).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000)
    // The response must carry the same token with a fresh 30-day max-age.
    expect(sessionCookieOf(join)).toBe(partner.cookie)
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
