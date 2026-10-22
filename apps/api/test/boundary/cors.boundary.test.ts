import { describe, expect, it } from "vitest"
import { jsonRequest, register, WEB_ORIGIN, workerFetch } from "./support.js"

/**
 * CORS-with-credentials at the Worker edge.
 *
 * The web app and API are different origins in dev, so the browser only sends
 * the session cookie when both the preflight and the actual response say
 * `access-control-allow-credentials: true` and echo the exact origin. This is
 * invisible to a service-direct test.
 */

const PREFLIGHT = {
  "access-control-request-method": "POST",
  "access-control-request-headers": "content-type, if-none-match"
} as const

describe("CORS with credentials", () => {
  it("answers a preflight for the allowed web origin", async () => {
    const response = await workerFetch("/auth/login", {
      method: "OPTIONS",
      headers: { origin: WEB_ORIGIN, ...PREFLIGHT }
    })

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN)
    expect(response.headers.get("access-control-allow-credentials")).toBe("true")
    expect(response.headers.get("access-control-allow-headers")).toContain("content-type")
    expect(response.headers.get("access-control-allow-headers")).toContain("if-none-match")
    expect(response.headers.get("vary")).toMatch(/origin/i)
  })

  it("adds the credential headers to the actual response without losing Set-Cookie", async () => {
    const init = jsonRequest("POST", undefined, {
      email: `cors-${crypto.randomUUID()}@example.com`,
      loginKey: "a".repeat(43),
      displayName: "کراس",
      timeZone: "UTC"
    })
    const response = await workerFetch("/auth/register", {
      ...init,
      headers: { ...init.headers, origin: WEB_ORIGIN }
    })

    expect(response.status).toBe(201)
    expect(response.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN)
    expect(response.headers.get("access-control-allow-credentials")).toBe("true")
    expect(response.headers.get("access-control-expose-headers")).toContain("etag")
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0)
  })

  it("does not echo an origin outside the allowlist", async () => {
    const preflight = await workerFetch("/auth/login", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", ...PREFLIGHT }
    })
    expect(preflight.status).toBe(403)
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull()

    const actual = await workerFetch("/health", {
      headers: { origin: "https://evil.example" }
    })
    expect(actual.status).toBe(200)
    expect(actual.headers.get("access-control-allow-origin")).toBeNull()
    expect(actual.headers.get("access-control-allow-credentials")).toBeNull()
  })

  it("serves the health route the CI smoke check reads", async () => {
    const response = await workerFetch("/health")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })
})
