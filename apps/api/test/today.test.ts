import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { Layer, Schema, String as Str } from "effect"
import { HttpRouter } from "effect/http"
import { D1Client } from "@effect/sql-d1"
import {
  addJalaliDays,
  taskBucketBounds,
  toIsoDate,
  toJalaliDate,
  TodayReadModel,
  uuidV7
} from "@tali/domain"
import { AppLayer } from "../src/http-layer.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #42 at the HTTP seam: the real `GET /today` route, the real #36/#40
 * services, and real SQLite behind D1's batch-shaped client.
 *
 * The suite pins the read model's contents and order, household/private
 * authorization, the ETag 200↔304 exchange (plus cache headers), the empty
 * flags/counts, and the 401/403 edges.
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)

const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort()

const NOW = new Date().toISOString()
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()
const TZ = "Asia/Tehran"
const bounds = taskBucketBounds(TZ, NOW)
const YESTERDAY = toIsoDate(addJalaliDays(toJalaliDate(bounds.today), -1))

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex")

const USER_A = uuidV7()
const USER_B = uuidV7()
const USER_C = uuidV7()
const USER_EMPTY = uuidV7()
const USER_NO_HOUSEHOLD = uuidV7()
const TOKEN_A = "today-token-a"
const TOKEN_B = "today-token-b"
const TOKEN_C = "today-token-c"
const TOKEN_EMPTY = "today-token-empty"
const TOKEN_NO_HOUSEHOLD = "today-token-no-household"
const HOUSEHOLD = uuidV7()
const OTHER_HOUSEHOLD = uuidV7()
const EMPTY_HOUSEHOLD = uuidV7()

const REORDERED = ["notes", "tasks", "events", "reminders", "habits"] as const

interface Harness {
  readonly db: DatabaseSync
  readonly fake: FakeD1
  readonly handler: (request: Request) => Promise<Response>
  readonly dispose: () => Promise<void>
}

const makeHarness = async (): Promise<Harness> => {
  const db = new DatabaseSync(":memory:")
  for (const file of migrationFiles()) {
    db.exec(readFileSync(fileURLToPath(new URL(file, MIGRATIONS_DIR)), "utf8"))
  }

  const fake = new FakeD1(db)
  const d1 = D1Client.layer({
    db: fake.asD1Database(),
    transformQueryNames: Str.camelToSnake,
    transformResultNames: Str.snakeToCamel
  })
  const { handler, dispose } = HttpRouter.toWebHandler(
    AppLayer.pipe(Layer.provide(d1)),
    { disableLogger: true }
  )

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

  const seedHousehold = (id: string, creator: string, invite: string): void => {
    db.prepare(
      `INSERT INTO households (id, name, invite_code, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, invite, invite, creator, NOW)
  }

  const seedMembership = (userId: string, householdId: string): void => {
    db.prepare(
      `INSERT INTO memberships (id, household_id, user_id, role, joined_at)
       VALUES (?, ?, ?, 'owner', ?)`
    ).run(uuidV7(), householdId, userId, NOW)
  }

  interface TaskSeed {
    readonly id: string
    readonly title: string
    readonly ownerId: string
    readonly householdId: string
    readonly visibility?: "shared" | "private"
    readonly status?: "todo" | "doing" | "done"
    readonly priority?: "high" | "medium" | "low"
    readonly dueDate?: string | null
    readonly dueAt?: string | null
    readonly completedAt?: string | null
    readonly updatedAt?: string
  }

  const seedTask = (task: TaskSeed): void => {
    db.prepare(
      `INSERT INTO tasks
        (id, title, owner_id, household_id, visibility, status, priority,
         due_at, due_date, time_zone, tag_ids, completed_at,
         created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 1)`
    ).run(
      task.id,
      task.title,
      task.ownerId,
      task.householdId,
      task.visibility ?? "shared",
      task.status ?? "todo",
      task.priority ?? "medium",
      task.dueAt ?? null,
      task.dueDate ?? null,
      TZ,
      task.completedAt ?? null,
      task.updatedAt ?? NOW,
      task.updatedAt ?? NOW
    )
  }

  interface NoteSeed {
    readonly id: string
    readonly title: string
    readonly ownerId: string
    readonly householdId: string
    readonly visibility?: "shared" | "private"
    readonly pinned?: boolean
    readonly archived?: boolean
    readonly deletedAt?: string | null
    readonly updatedAt?: string
  }

  const seedNote = (note: NoteSeed): void => {
    db.prepare(
      `INSERT INTO notes
        (id, title, body, plain_text, owner_id, household_id, visibility,
         is_pinned, is_archived, tag_ids, created_at, updated_at, version, deleted_at)
       VALUES (?, ?, NULL, '', ?, ?, ?, ?, ?, '[]', ?, ?, 1, ?)`
    ).run(
      note.id,
      note.title,
      note.ownerId,
      note.householdId,
      note.visibility ?? "shared",
      note.pinned === false ? 0 : 1,
      note.archived === true ? 1 : 0,
      note.updatedAt ?? NOW,
      note.updatedAt ?? NOW,
      note.deletedAt ?? null
    )
  }

  seedUser(USER_A, "today-a@example.com", TZ)
  seedUser(USER_B, "today-b@example.com", TZ)
  seedUser(USER_C, "today-c@example.com", TZ)
  seedUser(USER_EMPTY, "today-e@example.com", TZ)
  seedUser(USER_NO_HOUSEHOLD, "today-d@example.com", TZ)
  seedHousehold(HOUSEHOLD, USER_A, "TODAY-A")
  seedHousehold(OTHER_HOUSEHOLD, USER_C, "TODAY-C")
  seedHousehold(EMPTY_HOUSEHOLD, USER_EMPTY, "TODAY-E")
  seedMembership(USER_A, HOUSEHOLD)
  seedMembership(USER_B, HOUSEHOLD)
  seedMembership(USER_C, OTHER_HOUSEHOLD)
  seedMembership(USER_EMPTY, EMPTY_HOUSEHOLD)
  seedSession(USER_A, TOKEN_A)
  seedSession(USER_B, TOKEN_B)
  seedSession(USER_C, TOKEN_C)
  seedSession(USER_EMPTY, TOKEN_EMPTY)
  seedSession(USER_NO_HOUSEHOLD, TOKEN_NO_HOUSEHOLD)

  db.prepare(
    `INSERT INTO user_preferences
      (user_id, time_zone, week_start, digits, dashboard_section_order,
       checked_item_placement, created_at, updated_at)
     VALUES (?, ?, 'saturday', 'persian', ?, 'bottom', ?, ?)`
  ).run(USER_A, TZ, JSON.stringify(REORDERED), NOW, NOW)

  const overdue = { id: uuidV7(), title: "عقب‌افتاده" }
  seedTask({
    id: overdue.id,
    title: overdue.title,
    ownerId: USER_A,
    householdId: HOUSEHOLD,
    priority: "high",
    dueDate: YESTERDAY,
    updatedAt: "2026-01-05T00:00:00.000Z"
  })
  seedTask({
    id: uuidV7(),
    title: "کار مشترک امروز",
    ownerId: USER_A,
    householdId: HOUSEHOLD,
    priority: "low",
    dueDate: bounds.today,
    updatedAt: "2026-01-04T00:00:00.000Z"
  })
  seedTask({
    id: uuidV7(),
    title: "کار خصوصی الف",
    ownerId: USER_A,
    householdId: HOUSEHOLD,
    visibility: "private",
    priority: "high",
    dueDate: bounds.today,
    updatedAt: "2026-01-03T00:00:00.000Z"
  })
  seedTask({
    id: uuidV7(),
    title: "کار خصوصی ب",
    ownerId: USER_B,
    householdId: HOUSEHOLD,
    visibility: "private",
    dueDate: bounds.today,
    updatedAt: "2026-01-02T00:00:00.000Z"
  })
  seedTask({
    id: uuidV7(),
    title: "فردا",
    ownerId: USER_A,
    householdId: HOUSEHOLD,
    dueDate: bounds.tomorrow,
    updatedAt: "2026-01-01T00:00:00.000Z"
  })
  seedTask({
    id: uuidV7(),
    title: "بدون تاریخ",
    ownerId: USER_A,
    householdId: HOUSEHOLD,
    updatedAt: "2025-12-31T00:00:00.000Z"
  })
  seedTask({
    id: uuidV7(),
    title: "انجام‌شده",
    ownerId: USER_A,
    householdId: HOUSEHOLD,
    status: "done",
    dueDate: bounds.today,
    completedAt: NOW,
    updatedAt: "2025-12-30T00:00:00.000Z"
  })
  seedTask({
    id: uuidV7(),
    title: "خانه دیگر",
    ownerId: USER_C,
    householdId: OTHER_HOUSEHOLD,
    dueDate: bounds.today,
    updatedAt: "2025-12-29T00:00:00.000Z"
  })

  seedNote({
    id: uuidV7(),
    title: "یادداشت مشترک",
    ownerId: USER_A,
    householdId: HOUSEHOLD,
    updatedAt: "2026-01-05T00:00:00.000Z"
  })
  seedNote({
    id: uuidV7(),
    title: "یادداشت خصوصی الف",
    ownerId: USER_A,
    householdId: HOUSEHOLD,
    visibility: "private",
    updatedAt: "2026-01-04T00:00:00.000Z"
  })
  seedNote({
    id: uuidV7(),
    title: "یادداشت خصوصی ب",
    ownerId: USER_B,
    householdId: HOUSEHOLD,
    visibility: "private",
    updatedAt: "2026-01-03T00:00:00.000Z"
  })
  seedNote({
    id: uuidV7(),
    title: "بدون پین",
    ownerId: USER_A,
    householdId: HOUSEHOLD,
    pinned: false,
    updatedAt: "2026-01-02T00:00:00.000Z"
  })
  seedNote({
    id: uuidV7(),
    title: "بایگانی‌شده",
    ownerId: USER_A,
    householdId: HOUSEHOLD,
    archived: true,
    updatedAt: "2026-01-01T00:00:00.000Z"
  })
  seedNote({
    id: uuidV7(),
    title: "زباله",
    ownerId: USER_A,
    householdId: HOUSEHOLD,
    deletedAt: NOW,
    updatedAt: "2025-12-31T00:00:00.000Z"
  })
  seedNote({
    id: uuidV7(),
    title: "یادداشت خانه دیگر",
    ownerId: USER_C,
    householdId: OTHER_HOUSEHOLD,
    updatedAt: "2025-12-30T00:00:00.000Z"
  })

  return { db, fake, handler, dispose }
}

const getToday = async (
  harness: Harness,
  token?: string,
  ifNoneMatch?: string
): Promise<{
  readonly status: number
  readonly etag: string | null
  readonly cacheControl: string | null
  readonly vary: string | null
  readonly body: unknown
  readonly text: string
}> => {
  const headers: Record<string, string> = {}
  if (token !== undefined) headers.cookie = `tali_session=${token}`
  if (ifNoneMatch !== undefined) headers["if-none-match"] = ifNoneMatch
  const response = await harness.handler(
    new Request("http://localhost/today", { headers })
  )
  const text = await response.text()
  return {
    status: response.status,
    etag: response.headers.get("etag"),
    cacheControl: response.headers.get("cache-control"),
    vary: response.headers.get("vary"),
    body: text === "" ? undefined : JSON.parse(text),
    text
  }
}

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const setup = async (): Promise<Harness> => {
  harness = await makeHarness()
  return harness
}

describe("GET /today", () => {
  it("serves today's tasks and pinned notes in the saved section order", async () => {
    const h = await setup()
    const response = await getToday(h, TOKEN_A)
    expect(response.status).toBe(200)

    const model = Schema.decodeUnknownSync(TodayReadModel)(response.body)
    expect(model.today).toBe(bounds.today)
    expect(model.tomorrow).toBe(bounds.tomorrow)
    expect(model.timeZone).toBe(TZ)
    expect(model.sectionOrder).toEqual([...REORDERED])

    // Overdue first, then today's tasks (priority order within each bucket).
    expect(model.tasks.map((task) => task.title)).toEqual([
      "عقب‌افتاده",
      "کار خصوصی الف",
      "کار مشترک امروز"
    ])
    expect(model.notes.map((note) => note.title)).toEqual([
      "یادداشت مشترک",
      "یادداشت خصوصی الف"
    ])
    expect(model.counts).toEqual({
      tasks: 3,
      overdue: 1,
      events: 0,
      reminders: 0,
      habits: 0,
      notes: 2
    })
    expect(model.empty).toEqual({
      tasks: false,
      events: true,
      reminders: true,
      habits: true,
      notes: false
    })
  })

  it("scopes by household and hides another member's private rows", async () => {
    const h = await setup()

    const b = Schema.decodeUnknownSync(TodayReadModel)(
      (await getToday(h, TOKEN_B)).body
    )
    expect(b.tasks.map((task) => task.title)).toEqual([
      "عقب‌افتاده",
      "کار خصوصی ب",
      "کار مشترک امروز"
    ])
    expect(b.notes.map((note) => note.title)).toEqual([
      "یادداشت مشترک",
      "یادداشت خصوصی ب"
    ])
    expect(b.counts.tasks).toBe(3)
    expect(b.counts.overdue).toBe(1)
    expect(b.counts.notes).toBe(2)
    // B never saved a preference row, so the product order applies.
    expect(b.sectionOrder).toEqual(["tasks", "events", "reminders", "habits", "notes"])

    const c = Schema.decodeUnknownSync(TodayReadModel)(
      (await getToday(h, TOKEN_C)).body
    )
    // C owns the other household's rows, so they see their own — and only theirs.
    expect(c.tasks.map((task) => task.title)).toEqual(["خانه دیگر"])
    expect(c.notes.map((note) => note.title)).toEqual(["یادداشت خانه دیگر"])
    expect(c.counts.tasks).toBe(1)
    expect(c.counts.notes).toBe(1)

    const empty = Schema.decodeUnknownSync(TodayReadModel)(
      (await getToday(h, TOKEN_EMPTY)).body
    )
    expect(empty.tasks).toEqual([])
    expect(empty.notes).toEqual([])
    expect(empty.empty).toEqual({
      tasks: true,
      events: true,
      reminders: true,
      habits: true,
      notes: true
    })
    expect(empty.counts).toEqual({
      tasks: 0,
      overdue: 0,
      events: 0,
      reminders: 0,
      habits: 0,
      notes: 0
    })
  })

  it("answers 304 for a matching If-None-Match and 200 after the data changes", async () => {
    const h = await setup()
    const first = await getToday(h, TOKEN_A)
    expect(first.status).toBe(200)
    expect(first.etag).toMatch(/^"[a-f0-9]{64}"$/)
    expect(first.cacheControl).toContain("private")
    expect(first.cacheControl).toContain("no-cache")
    expect(first.vary?.toLowerCase()).toContain("cookie")

    const cached = await getToday(h, TOKEN_A, first.etag!)
    expect(cached.status).toBe(304)
    expect(cached.text).toBe("")
    expect(cached.etag).toBe(first.etag)

    // Weak comparison and a list are both valid If-None-Match forms.
    const weak = await getToday(h, TOKEN_A, `W/${first.etag}, "something-else"`)
    expect(weak.status).toBe(304)

    const stale = await getToday(h, TOKEN_A, '"not-the-current-tag"')
    expect(stale.status).toBe(200)

    h.db
      .prepare(
        `INSERT INTO tasks
          (id, title, owner_id, household_id, visibility, status, priority,
           due_date, time_zone, tag_ids, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, 'shared', 'todo', 'medium', ?, ?, '[]', ?, ?, 1)`
      )
      .run(uuidV7(), "کار تازه", USER_A, HOUSEHOLD, bounds.today, TZ, NOW, NOW)

    const changed = await getToday(h, TOKEN_A, first.etag!)
    expect(changed.status).toBe(200)
    expect(changed.etag).not.toBe(first.etag)
    const model = Schema.decodeUnknownSync(TodayReadModel)(changed.body)
    expect(model.tasks.map((task) => task.title)).toContain("کار تازه")
    expect(model.counts.tasks).toBe(4)
  })

  it("requires a session and a household", async () => {
    const h = await setup()

    const anonymous = await getToday(h)
    expect(anonymous.status).toBe(401)
    expect(anonymous.body).toMatchObject({ error: { code: "Unauthorized" } })

    const noHousehold = await getToday(h, TOKEN_NO_HOUSEHOLD)
    expect(noHousehold.status).toBe(403)
    expect(noHousehold.body).toMatchObject({ error: { code: "Forbidden" } })
  })

  /**
   * The browser only sees an `ETag` that CORS exposes, and only sends an
   * `If-None-Match` that CORS allows. The dev web app (:3000) calls the Worker
   * (:8787) cross-origin, so without those headers revalidation never happens
   * in the one environment where the dashboard is exercised by hand.
   */
  it("exposes the ETag cross-origin and never answers 304 from another user's body", async () => {
    const h = await setup()
    const worker = (await import("../src/index.js")).default
    const env = { DB: new FakeD1(h.db).asD1Database() }
    const call = async (headers: Record<string, string>) => {
      const response = await worker.fetch(
        new Request("http://localhost/today", {
          headers: { origin: "http://localhost:3000", ...headers }
        }),
        env as never,
        {} as never
      )
      const text = await response.text()
      return { response, status: response.status, text }
    }

    const self = await call({ cookie: `tali_session=${TOKEN_A}` })
    expect(self.status).toBe(200)
    expect(self.response.headers.get("access-control-expose-headers")).toContain("etag")
    expect(self.response.headers.get("access-control-allow-headers")).toContain("if-none-match")
    const etag = self.response.headers.get("etag")
    expect(etag).toBeTruthy()

    // The other household member's picture differs, so their revalidation must
    // not be answered with A's (private) body.
    const other = await call({
      cookie: `tali_session=${TOKEN_B}`,
      "if-none-match": etag!
    })
    expect(other.status).toBe(200)
    const otherModel = Schema.decodeUnknownSync(TodayReadModel)(JSON.parse(other.text))
    expect(otherModel.tasks.map((task) => task.title)).toContain("کار خصوصی ب")
    expect(other.text).not.toContain("کار خصوصی الف")

    // ...while the same viewer revalidating the same picture does get a 304.
    const revalidated = await call({
      cookie: `tali_session=${TOKEN_A}`,
      "if-none-match": etag!
    })
    expect(revalidated.status).toBe(304)
    expect(revalidated.text).toBe("")
  })
})

describe("GET /today D1 budget", () => {
  it("serves the dashboard without growing the statement count", async () => {
    const h = await setup()
    h.fake.statementCalls = 0
    const response = await getToday(h, TOKEN_A)
    expect(response.status).toBe(200)
    // The read fan-out changes wall time, not the SQL: the route stays at the
    // pre-fan-out baseline (auth + five bucket ranges + pinned notes). A new
    // statement here is a regression the plan's latency budget cannot absorb.
    expect(h.fake.statementCalls).toBeLessThanOrEqual(10)
  })
})
