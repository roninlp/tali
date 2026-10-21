import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, Schema, String as Str } from "effect"
import { HttpRouter } from "effect/http"
import { D1Client } from "@effect/sql-d1"
import { DEFAULT_DASHBOARD_SECTION_ORDER, PreferencesResponse, uuidV7 } from "@tali/domain"
import { AuthServiceLive } from "../src/auth-service.js"
import { PreferencesRoutes } from "../src/preferences-routes.js"
import { PreferencesServiceLive } from "../src/preferences-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #35, at the HTTP seam: real routes, real auth middleware, real D1
 * (SQLite) SQL. The suite pins the four things the ticket asks for — defaults
 * with no row, PATCH round-trip (including the ordered dashboard list), typed
 * validation, and per-user isolation — plus the migration-order guarantee.
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)

/**
 * Every migration, in the same numeric/lexicographic order D1 and Alchemy
 * apply them (the two `0003_*` files sort by their suffix). Reading the
 * directory instead of hard-coding a list is what makes this test prove the
 * *current* chain applies, not a snapshot of it.
 */
const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort()

const NOW = new Date().toISOString()
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex")

const USER_A = uuidV7() as string
const USER_B = uuidV7() as string
const TOKEN_A = "token-for-user-a"
const TOKEN_B = "token-for-user-b"

const makeHarness = async () => {
  const db = new DatabaseSync(":memory:")
  for (const file of migrationFiles()) {
    db.exec(readFileSync(fileURLToPath(new URL(file, MIGRATIONS_DIR)), "utf8"))
  }

  const d1 = D1Client.layer({
    db: new FakeD1(db).asD1Database(),
    transformQueryNames: Str.camelToSnake,
    transformResultNames: Str.snakeToCamel
  })
  const layer = PreferencesRoutes.pipe(
    Layer.provide(PreferencesServiceLive),
    Layer.provide(AuthServiceLive),
    Layer.provide(d1)
  )
  const { handler, dispose } = HttpRouter.toWebHandler(layer, { disableLogger: true })

  const seedUser = (id: string, email: string, timeZone: string): void => {
    db.prepare(
      `INSERT INTO users
        (id, email, credential_verifier, credential_salt, kdf_version,
         display_name, time_zone, week_start, digits, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, 'saturday', 'persian', ?, ?)`
    ).run(id, email, "0".repeat(64), "0".repeat(32), email, timeZone, NOW, NOW)
  }

  const seedSession = (userId: string, token: string): void => {
    db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(uuidV7(), userId, sha256(token), FUTURE, NOW)
  }

  seedUser(USER_A, "a@example.com", "Europe/Berlin")
  seedUser(USER_B, "b@example.com", "Asia/Tehran")
  seedSession(USER_A, TOKEN_A)
  seedSession(USER_B, TOKEN_B)

  const request = async (
    method: "GET" | "PATCH",
    token?: string,
    body?: unknown
  ): Promise<{ readonly status: number; readonly body: unknown }> => {
    const headers: Record<string, string> = {}
    if (token !== undefined) headers.cookie = `tali_session=${token}`
    if (body !== undefined) headers["content-type"] = "application/json"
    const response = await handler(
      new Request("http://localhost/preferences", {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    )
    return { status: response.status, body: await response.json() }
  }

  const preferencesOf = async (token: string) => {
    const response = await request("GET", token)
    const decoded = Schema.decodeUnknownSync(PreferencesResponse)(response.body)
    return { status: response.status, preferences: decoded.preferences }
  }

  return { db, handler, dispose, request, preferencesOf }
}

describe("preferences migrations", () => {
  it("applies every migration in numeric order to scratch SQLite", () => {
    const files = migrationFiles()
    expect(files[0]).toBe("0001_list_items.sql")
    expect(files.at(-1)).toBe("0011_habits.sql")
    expect(files).toContain("0006_user_preferences.sql")
    expect(files).toContain("0007_task_recurrence.sql")
    expect(files).toContain("0008_list_last_writer.sql")
    expect(files).toContain("0009_note_search.sql")
    expect(files).toContain("0010_events.sql")
    expect(files).toContain("0011_habits.sql")

    const db = new DatabaseSync(":memory:")
    for (const file of files) {
      expect(() =>
        db.exec(readFileSync(fileURLToPath(new URL(file, MIGRATIONS_DIR)), "utf8"))
      ).not.toThrow()
    }
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_preferences'")
      .get() as { readonly name?: string } | undefined
    expect(table?.name).toBe("user_preferences")
  })
})

describe("GET/PATCH /preferences", () => {
  it("serves Persian-first defaults from the profile when no row exists", async () => {
    const harness = await makeHarness()

    const { status, preferences } = await harness.preferencesOf(TOKEN_A)
    expect(status).toBe(200)
    // The registered profile's zone wins over the household default.
    expect(preferences.timeZone).toBe("Europe/Berlin")
    expect(preferences.weekStart).toBe("saturday")
    expect(preferences.digits).toBe("persian")
    expect(preferences.dashboardSectionOrder).toEqual([
      ...DEFAULT_DASHBOARD_SECTION_ORDER
    ])
    expect(preferences.checkedItemPlacement).toBe("bottom")
    // A read never writes a row just to answer with defaults.
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM user_preferences").get()).toEqual({
      count: 0
    })

    await harness.dispose()
  })

  it("round-trips every field and preserves the ordered dashboard list across partial patches", async () => {
    const harness = await makeHarness()
    const reordered = ["notes", "habits", "reminders", "events", "tasks"]

    const patched = await harness.request("PATCH", TOKEN_A, {
      timeZone: "America/New_York",
      weekStart: "monday",
      digits: "latin",
      dashboardSectionOrder: reordered,
      checkedItemPlacement: "inPlace"
    })
    expect(patched.status).toBe(200)
    const decoded = Schema.decodeUnknownSync(PreferencesResponse)(patched.body)
    expect(decoded.preferences.timeZone).toBe("America/New_York")
    expect(decoded.preferences.weekStart).toBe("monday")
    expect(decoded.preferences.digits).toBe("latin")
    expect(decoded.preferences.dashboardSectionOrder).toEqual(reordered)
    expect(decoded.preferences.checkedItemPlacement).toBe("inPlace")

    // A later patch that only touches digits must not reset the order.
    const partial = await harness.request("PATCH", TOKEN_A, { digits: "persian" })
    expect(partial.status).toBe(200)
    expect(Schema.decodeUnknownSync(PreferencesResponse)(partial.body).preferences.dashboardSectionOrder)
      .toEqual(reordered)

    const reread = await harness.preferencesOf(TOKEN_A)
    expect(reread.preferences).toMatchObject({
      timeZone: "America/New_York",
      weekStart: "monday",
      digits: "persian",
      dashboardSectionOrder: reordered,
      checkedItemPlacement: "inPlace"
    })

    await harness.dispose()
  })

  it("rejects invalid values with the shared BadRequest envelope and writes nothing", async () => {
    const harness = await makeHarness()

    const invalidPatches = [
      { timeZone: "Mars/Olympus" },
      { timeZone: "Not/AZone" },
      { weekStart: "tuesday" },
      { digits: "arabic" },
      { checkedItemPlacement: "top" },
      { dashboardSectionOrder: ["tasks", "events"] },
      { dashboardSectionOrder: ["tasks", "tasks", "events", "reminders", "habits"] },
      { dashboardSectionOrder: ["tasks", "events", "reminders", "habits", "search"] }
    ]

    for (const body of invalidPatches) {
      const response = await harness.request("PATCH", TOKEN_A, body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(response.body).toMatchObject({ error: { code: "BadRequest" } })
    }

    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM user_preferences").get()).toEqual({
      count: 0
    })
    const { preferences } = await harness.preferencesOf(TOKEN_A)
    expect(preferences.weekStart).toBe("saturday")
    expect(preferences.digits).toBe("persian")

    await harness.dispose()
  })

  it("is per-user: one account cannot read or write another's row", async () => {
    const harness = await makeHarness()

    const patched = await harness.request("PATCH", TOKEN_A, {
      timeZone: "America/New_York",
      digits: "latin",
      weekStart: "sunday"
    })
    expect(patched.status).toBe(200)

    const other = await harness.preferencesOf(TOKEN_B)
    expect(other.preferences.timeZone).toBe("Asia/Tehran")
    expect(other.preferences.weekStart).toBe("saturday")
    expect(other.preferences.digits).toBe("persian")

    // B's write must not leak back into A's row.
    await harness.request("PATCH", TOKEN_B, { weekStart: "monday", digits: "persian" })
    const first = await harness.preferencesOf(TOKEN_A)
    expect(first.preferences).toMatchObject({
      timeZone: "America/New_York",
      weekStart: "sunday",
      digits: "latin"
    })

    await harness.dispose()
  })

  it("requires a session", async () => {
    const harness = await makeHarness()

    const read = await harness.request("GET")
    expect(read.status).toBe(401)
    expect(read.body).toMatchObject({ error: { code: "Unauthorized" } })

    const write = await harness.request("PATCH", undefined, { digits: "latin" })
    expect(write.status).toBe(401)

    await harness.dispose()
  })
})
