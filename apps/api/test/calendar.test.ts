import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { Layer, Schema, String as Str } from "effect"
import { HttpRouter } from "effect/http"
import { D1Client } from "@effect/sql-d1"
import {
  MonthReadModel,
  uuidV7,
  WeekReadModel,
  type RecurrenceRule
} from "@tali/domain"
import { AppLayer } from "../src/http-layer.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #43 at the HTTP seam: the real `GET /week` / `GET /month` routes, the
 * real repositories and SQLite behind D1's client.
 *
 * The suite pins the pieces the ticket calls out: the seven-day window and
 * configurable week start, Jalali month edges, DST-safe timed placement,
 * recurring expansion without occurrence writes, busy counts and day
 * drill-down, household/private authorization, and the ETag 200↔304 exchange.
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)

const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort()

const NOW = new Date().toISOString()
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()
const TZ = "Asia/Tehran"

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex")

const USER_A = uuidV7()
const USER_B = uuidV7()
const USER_C = uuidV7()
const USER_SUNDAY = uuidV7()
const USER_MONDAY = uuidV7()
const USER_NO_HOUSEHOLD = uuidV7()
const TOKEN_A = "calendar-token-a"
const TOKEN_B = "calendar-token-b"
const TOKEN_C = "calendar-token-c"
const TOKEN_SUNDAY = "calendar-token-sunday"
const TOKEN_MONDAY = "calendar-token-monday"
const TOKEN_NO_HOUSEHOLD = "calendar-token-no-household"
const HOUSEHOLD = uuidV7()
const OTHER_HOUSEHOLD = uuidV7()

const ANCHOR = "2026-03-25"

const weekly: RecurrenceRule = {
  frequency: "weekly",
  interval: 1,
  byDay: [2, 4],
  end: { _tag: "never" }
}
const daily: RecurrenceRule = {
  frequency: "daily",
  interval: 1,
  end: { _tag: "never" }
}

interface Harness {
  readonly db: DatabaseSync
  readonly handler: (request: Request) => Promise<Response>
  readonly dispose: () => Promise<void>
}

interface TaskSeed {
  readonly id: string
  readonly title: string
  readonly ownerId?: string
  readonly householdId?: string
  readonly visibility?: "shared" | "private"
  readonly status?: "todo" | "doing" | "done"
  readonly priority?: "high" | "medium" | "low"
  readonly dueDate?: string | null
  readonly dueAt?: string | null
  readonly timeZone?: string
  readonly recurrence?: RecurrenceRule | null
  readonly recurrenceMode?: "onDueDate" | "onCompletion" | null
  readonly completedAt?: string | null
}

const seedTask = (db: DatabaseSync, task: TaskSeed): void => {
  db.prepare(
    `INSERT INTO tasks
      (id, title, owner_id, household_id, visibility, status, priority,
       due_at, due_date, time_zone, tag_ids, recurrence, recurrence_mode,
       completed_at, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, 1)`
  ).run(
    task.id,
    task.title,
    task.ownerId ?? USER_A,
    task.householdId ?? HOUSEHOLD,
    task.visibility ?? "shared",
    task.status ?? "todo",
    task.priority ?? "medium",
    task.dueAt ?? null,
    task.dueDate ?? null,
    task.timeZone ?? TZ,
    task.recurrence === undefined || task.recurrence === null
      ? null
      : JSON.stringify(task.recurrence),
    task.recurrenceMode ?? null,
    task.completedAt ?? null,
    NOW,
    NOW
  )
}

interface EventSeed {
  readonly id: string
  readonly title: string
  readonly ownerId?: string
  readonly householdId?: string
  readonly visibility?: "shared" | "private"
  readonly startAt?: string | null
  readonly endAt?: string | null
  readonly allDayDate?: string | null
  readonly timeZone?: string
  readonly recurrence?: RecurrenceRule | null
}

const seedEvent = (db: DatabaseSync, event: EventSeed): void => {
  db.prepare(
    `INSERT INTO events
      (id, title, owner_id, household_id, visibility, start_at, end_at,
       all_day_date, time_zone, recurrence, exceptions, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 1)`
  ).run(
    event.id,
    event.title,
    event.ownerId ?? USER_A,
    event.householdId ?? HOUSEHOLD,
    event.visibility ?? "shared",
    event.startAt ?? null,
    event.endAt ?? null,
    event.allDayDate ?? null,
    event.timeZone ?? TZ,
    event.recurrence === undefined || event.recurrence === null
      ? null
      : JSON.stringify(event.recurrence),
    NOW,
    NOW
  )
}

interface OccasionSeed {
  readonly id: string
  readonly title: string
  readonly originDate: string
  readonly ownerId?: string
  readonly householdId?: string
  readonly visibility?: "shared" | "private"
  readonly timeZone?: string
  readonly yearly?: boolean
  readonly advanceReminderDays?: number | null
}

const seedOccasion = (db: DatabaseSync, occasion: OccasionSeed): void => {
  db.prepare(
    `INSERT INTO occasions
      (id, title, owner_id, household_id, visibility, origin_date, time_zone,
       yearly, advance_reminder_days, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(
    occasion.id,
    occasion.title,
    occasion.ownerId ?? USER_A,
    occasion.householdId ?? HOUSEHOLD,
    occasion.visibility ?? "shared",
    occasion.originDate,
    occasion.timeZone ?? TZ,
    occasion.yearly === false ? 0 : 1,
    occasion.advanceReminderDays ?? null,
    NOW,
    NOW
  )
}

const makeHarness = async (): Promise<Harness> => {
  const db = new DatabaseSync(":memory:")
  for (const file of migrationFiles()) {
    db.exec(readFileSync(fileURLToPath(new URL(file, MIGRATIONS_DIR)), "utf8"))
  }

  const d1 = D1Client.layer({
    db: new FakeD1(db).asD1Database(),
    transformQueryNames: Str.camelToSnake,
    transformResultNames: Str.snakeToCamel
  })
  const { handler, dispose } = HttpRouter.toWebHandler(
    AppLayer.pipe(Layer.provide(d1)),
    { disableLogger: true }
  )

  const seedUser = (
    id: string,
    email: string,
    timeZone: string,
    weekStart = "saturday"
  ): void => {
    db.prepare(
      `INSERT INTO users
        (id, email, credential_verifier, credential_salt, kdf_version,
         display_name, time_zone, week_start, digits, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'persian', ?, ?)`
    ).run(id, email, "0".repeat(64), "0".repeat(32), email, timeZone, weekStart, NOW, NOW)
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

  seedUser(USER_A, "cal-a@example.com", TZ)
  seedUser(USER_B, "cal-b@example.com", TZ)
  seedUser(USER_C, "cal-c@example.com", TZ)
  seedUser(USER_SUNDAY, "cal-sun@example.com", TZ, "sunday")
  seedUser(USER_MONDAY, "cal-mon@example.com", TZ, "monday")
  seedUser(USER_NO_HOUSEHOLD, "cal-n@example.com", TZ)
  seedHousehold(HOUSEHOLD, USER_A, "CAL-A")
  seedHousehold(OTHER_HOUSEHOLD, USER_C, "CAL-C")
  for (const user of [USER_A, USER_B, USER_SUNDAY, USER_MONDAY]) {
    seedMembership(user, HOUSEHOLD)
  }
  seedMembership(USER_C, OTHER_HOUSEHOLD)
  seedSession(USER_A, TOKEN_A)
  seedSession(USER_B, TOKEN_B)
  seedSession(USER_C, TOKEN_C)
  seedSession(USER_SUNDAY, TOKEN_SUNDAY)
  seedSession(USER_MONDAY, TOKEN_MONDAY)
  seedSession(USER_NO_HOUSEHOLD, TOKEN_NO_HOUSEHOLD)

  return { db, handler, dispose }
}

interface CallOptions {
  readonly token?: string
  readonly anchor?: string
  readonly day?: string
  readonly ifNoneMatch?: string
}

const call = async (
  harness: Harness,
  path: "/week" | "/month",
  options: CallOptions = {}
): Promise<{
  readonly status: number
  readonly etag: string | null
  readonly cacheControl: string | null
  readonly body: unknown
  readonly text: string
}> => {
  const url = new URL(`http://localhost${path}`)
  if (options.anchor !== undefined) url.searchParams.set("anchor", options.anchor)
  if (options.day !== undefined) url.searchParams.set("day", options.day)
  const headers: Record<string, string> = {}
  if (options.token !== undefined) headers.cookie = `tali_session=${options.token}`
  if (options.ifNoneMatch !== undefined) headers["if-none-match"] = options.ifNoneMatch
  const response = await harness.handler(new Request(url, { headers }))
  const text = await response.text()
  return {
    status: response.status,
    etag: response.headers.get("etag"),
    cacheControl: response.headers.get("cache-control"),
    body: text === "" ? undefined : JSON.parse(text),
    text
  }
}

const week = async (harness: Harness, options: CallOptions = {}) => {
  const response = await call(harness, "/week", options)
  return {
    ...response,
    model: response.status === 200
      ? Schema.decodeUnknownSync(WeekReadModel)(response.body)
      : undefined
  }
}

const month = async (harness: Harness, options: CallOptions = {}) => {
  const response = await call(harness, "/month", options)
  return {
    ...response,
    model: response.status === 200
      ? Schema.decodeUnknownSync(MonthReadModel)(response.body)
      : undefined
  }
}

const dayOf = (model: WeekReadModel, date: string) =>
  model.days.find((day) => day.date === date)!

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const setup = async (): Promise<Harness> => {
  harness = await makeHarness()
  return harness
}

/** The shared fixture: all-day, private, timed, recurring and hidden rows. */
const seedWeek = (h: Harness): {
  readonly shared: string
  readonly privateA: string
  readonly privateB: string
  readonly timed: string
  readonly dailySeries: string
  readonly weeklySeries: string
  readonly onCompletion: string
} => {
  const shared = uuidV7()
  const privateA = uuidV7()
  const privateB = uuidV7()
  const timed = uuidV7()
  const dailySeries = uuidV7()
  const weeklySeries = uuidV7()
  const onCompletion = uuidV7()

  seedTask(h.db, {
    id: shared,
    title: "کار مشترک یکشنبه",
    dueDate: "2026-03-22"
  })
  seedTask(h.db, {
    id: privateA,
    title: "کار خصوصی الف",
    visibility: "private",
    dueDate: "2026-03-22"
  })
  seedTask(h.db, {
    id: privateB,
    title: "کار خصوصی ب",
    ownerId: USER_B,
    visibility: "private",
    dueDate: "2026-03-22"
  })
  seedTask(h.db, {
    id: timed,
    title: "کار زمانی",
    // 00:00 Tehran on 26 March (UTC+3:30).
    dueAt: "2026-03-25T20:30:00.000Z",
    dueDate: null
  })
  seedTask(h.db, {
    id: dailySeries,
    title: "روزانه",
    dueDate: "2026-03-22",
    recurrence: daily,
    recurrenceMode: "onDueDate"
  })
  seedTask(h.db, {
    id: weeklySeries,
    title: "سه‌شنبه و پنجشنبه",
    dueDate: "2026-03-24",
    recurrence: weekly,
    recurrenceMode: "onDueDate"
  })
  seedTask(h.db, {
    id: onCompletion,
    title: "پس از انجام",
    dueDate: "2026-03-22",
    recurrence: daily,
    recurrenceMode: "onCompletion"
  })
  seedTask(h.db, {
    id: uuidV7(),
    title: "انجام‌شده",
    dueDate: "2026-03-22",
    status: "done",
    completedAt: NOW
  })
  seedTask(h.db, {
    id: uuidV7(),
    title: "خانه دیگر",
    ownerId: USER_C,
    householdId: OTHER_HOUSEHOLD,
    dueDate: "2026-03-22"
  })
  return {
    shared,
    privateA,
    privateB,
    timed,
    dailySeries,
    weeklySeries,
    onCompletion
  }
}

describe("GET /week", () => {
  it("returns seven days from the saved week start with tasks in place", async () => {
    const h = await setup()
    const ids = seedWeek(h)

    const response = await week(h, { token: TOKEN_A, anchor: ANCHOR })
    expect(response.status).toBe(200)
    const model = response.model!
    expect(model.start).toBe("2026-03-21")
    expect(model.end).toBe("2026-03-27")
    expect(model.weekStart).toBe("saturday")
    expect(model.timeZone).toBe(TZ)
    expect(model.days.map((day) => day.date)).toEqual([
      "2026-03-21",
      "2026-03-22",
      "2026-03-23",
      "2026-03-24",
      "2026-03-25",
      "2026-03-26",
      "2026-03-27"
    ])

    const sunday = dayOf(model, "2026-03-22")
    const sundayTitles = sunday.tasks.map((item) => item.title)
    for (const title of [
      "روزانه",
      "کار خصوصی الف",
      "کار مشترک یکشنبه",
      "پس از انجام"
    ]) {
      expect(sundayTitles).toContain(title)
    }
    expect(sundayTitles).toHaveLength(4)
    expect(sunday.tasks.every((item) => !item.projected)).toBe(true)
    expect(sunday.counts).toEqual({ tasks: 4, events: 0, occasions: 0, reminders: 0, habits: 0 })

    // A timed task is placed by the viewer's wall date, not the UTC date.
    expect(dayOf(model, "2026-03-26").tasks.map((item) => item.id)).toContain(ids.timed)

    // Another member's private row and another household never leak.
    const titles = model.days.flatMap((day) => day.tasks.map((item) => item.title))
    expect(titles).not.toContain("کار خصوصی ب")
    expect(titles).not.toContain("خانه دیگر")
    expect(titles).not.toContain("انجام‌شده")
  })

  it("expands on-due-date recurrences read-only and leaves on-completion series alone", async () => {
    const h = await setup()
    const ids = seedWeek(h)
    const before = h.db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as {
      readonly count: number
    }

    const model = (await week(h, { token: TOKEN_A, anchor: ANCHOR })).model!

    const thursday = dayOf(model, "2026-03-26")
    const projectedWeekly = thursday.tasks.find(
      (item) => item.id === ids.weeklySeries && item.projected
    )
    expect(projectedWeekly).toMatchObject({
      projected: true,
      recurring: true,
      key: `${ids.weeklySeries}@2026-03-26`
    })

    // A daily series contributes one projected item to each later day of the
    // week, plus its real row on its anchor day.
    const projectedDaily = model.days
      .flatMap((day) => day.tasks)
      .filter((item) => item.id === ids.dailySeries)
    expect(projectedDaily.filter((item) => item.projected)).toHaveLength(5)
    expect(projectedDaily.filter((item) => !item.projected)).toHaveLength(1)

    // `onCompletion` cannot be projected: only its live instance exists.
    const onCompletionItems = model.days
      .flatMap((day) => day.tasks)
      .filter((item) => item.id === ids.onCompletion)
    expect(onCompletionItems).toHaveLength(1)
    expect(onCompletionItems[0]!.projected).toBe(false)

    // Projection is a read: no occurrence rows were written.
    const after = h.db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as {
      readonly count: number
    }
    expect(after.count).toBe(before.count)
  })

  it("expands a recurring event series into the week's event lane", async () => {
    const h = await setup()
    const series = uuidV7()
    const privateB = uuidV7()
    const weekly: RecurrenceRule = {
      frequency: "weekly",
      interval: 1,
      byDay: [1, 3, 5],
      end: { _tag: "never" }
    }
    // Monday 10:00 Tehran (06:30Z); Mon/Wed/Fri occurrences.
    seedEvent(h.db, {
      id: series,
      title: "جلسهٔ هفتگی",
      startAt: "2026-10-19T06:30:00.000Z",
      endAt: "2026-10-19T07:30:00.000Z",
      recurrence: weekly
    })
    seedEvent(h.db, {
      id: privateB,
      title: "قرار خصوصی ب",
      ownerId: USER_B,
      visibility: "private",
      allDayDate: "2026-10-20"
    })

    const before = h.db.prepare("SELECT version FROM events WHERE id = ?").get(series) as {
      readonly version: number
    }
    const model = (await week(h, { token: TOKEN_A, anchor: "2026-10-19" })).model!
    expect(model.start).toBe("2026-10-17")

    const eventDays = model.days.flatMap((day) =>
      day.events.map((event) => [day.date, event.instanceId, event.projected])
    )
    expect(eventDays).toEqual([
      ["2026-10-19", "2026-10-19", false],
      ["2026-10-21", "2026-10-21", true],
      ["2026-10-23", "2026-10-23", true]
    ])
    expect(dayOf(model, "2026-10-21").counts).toEqual({
      tasks: 0,
      events: 1,
      occasions: 0,
      reminders: 0,
      habits: 0
    })
    expect(dayOf(model, "2026-10-21").empty).toMatchObject({ tasks: true, events: false })

    // B's private event is not visible to A, but is visible to B.
    expect(model.days.flatMap((day) => day.events.map((event) => event.title))).not.toContain(
      "قرار خصوصی ب"
    )
    const b = (await week(h, { token: TOKEN_B, anchor: "2026-10-19" })).model!
    expect(dayOf(b, "2026-10-20").events.map((event) => event.title)).toContain("قرار خصوصی ب")

    // Projection is a read: the series row was not versioned or rewritten.
    const after = h.db.prepare("SELECT version FROM events WHERE id = ?").get(series) as {
      readonly version: number
    }
    expect(after.version).toBe(before.version)
  })

  it("keeps the week readable when a stored row carries an unreadable value", async () => {
    const h = await setup()
    const healthy = uuidV7()
    const poisoned = uuidV7()

    seedEvent(h.db, {
      id: healthy,
      title: "جلسهٔ هفتگی",
      startAt: "2026-10-19T06:30:00.000Z",
      endAt: "2026-10-19T07:30:00.000Z",
      recurrence: { frequency: "weekly", interval: 1, byDay: [1], end: { _tag: "never" } }
    })
    // A sync push can store a date the wire pattern accepts but no calendar can
    // read (`LocalDate` is a pattern). One such row must not 500 the household's
    // whole week.
    seedEvent(h.db, {
      id: poisoned,
      title: "ردیف خراب",
      startAt: "2026-10-19T08:30:00.000Z",
      endAt: "2026-10-19T09:30:00.000Z",
      recurrence: { frequency: "weekly", interval: 1, byDay: [1], end: { _tag: "never" } }
    })
    h.db
      .prepare("UPDATE events SET exceptions = ? WHERE id = ?")
      .run(
        JSON.stringify([
          {
            id: uuidV7(),
            instanceId: "2026-02-30",
            action: "delete",
            overrides: null,
            createdAt: NOW
          }
        ]),
        poisoned
      )

    const response = await week(h, { token: TOKEN_A, anchor: "2026-10-19" })
    expect(response.status).toBe(200)
    expect(dayOf(response.model!, "2026-10-19").events.map((event) => event.id)).toEqual([
      healthy,
      poisoned
    ])
  })

  it("honors Saturday, Sunday and Monday week starts from preferences", async () => {
    const h = await setup()
    seedWeek(h)

    const sunday = (await week(h, { token: TOKEN_SUNDAY, anchor: ANCHOR })).model!
    expect(sunday.weekStart).toBe("sunday")
    expect(sunday.start).toBe("2026-03-22")
    expect(sunday.end).toBe("2026-03-28")
    expect(sunday.days[0]!.date).toBe("2026-03-22")

    const monday = (await week(h, { token: TOKEN_MONDAY, anchor: ANCHOR })).model!
    expect(monday.weekStart).toBe("monday")
    expect(monday.start).toBe("2026-03-23")
    expect(monday.end).toBe("2026-03-29")
    expect(monday.days[0]!.date).toBe("2026-03-23")
  })

  it("places timed tasks across a DST transition", async () => {
    const h = await setup()
    h.db.prepare(
      `INSERT INTO user_preferences
        (user_id, time_zone, week_start, digits, dashboard_section_order,
         checked_item_placement, created_at, updated_at)
       VALUES (?, 'America/New_York', 'sunday', 'persian', '["tasks","events","reminders","habits","notes"]', 'bottom', ?, ?)`
    ).run(USER_A, NOW, NOW)
    const beforeDst = uuidV7()
    const afterDst = uuidV7()
    seedTask(h.db, {
      id: beforeDst,
      title: "۲۳:۳۰ قبل از تغییر",
      dueAt: "2026-03-09T03:30:00.000Z",
      timeZone: "America/New_York"
    })
    seedTask(h.db, {
      id: afterDst,
      title: "۰۰:۳۰ بعد از تغییر",
      dueAt: "2026-03-09T04:30:00.000Z",
      timeZone: "America/New_York"
    })

    const model = (await week(h, { token: TOKEN_A, anchor: "2026-03-08" })).model!
    expect(model.start).toBe("2026-03-08")
    const sunday = dayOf(model, "2026-03-08")
    const monday = dayOf(model, "2026-03-09")
    expect(sunday.tasks.map((item) => item.id)).toEqual([beforeDst])
    expect(monday.tasks.map((item) => item.id)).toEqual([afterDst])
  })

  it("answers 304 for a matching ETag and 200 after the data changes", async () => {
    const h = await setup()
    seedWeek(h)
    const first = await week(h, { token: TOKEN_A, anchor: ANCHOR })
    expect(first.status).toBe(200)
    expect(first.etag).toMatch(/^"[a-f0-9]{64}"$/)
    expect(first.cacheControl).toContain("private")
    expect(first.cacheControl).toContain("no-cache")

    const cached = await week(h, {
      token: TOKEN_A,
      anchor: ANCHOR,
      ifNoneMatch: first.etag!
    })
    expect(cached.status).toBe(304)
    expect(cached.text).toBe("")
    expect(cached.etag).toBe(first.etag)

    seedTask(h.db, { id: uuidV7(), title: "تازه", dueDate: "2026-03-23" })
    const changed = await week(h, {
      token: TOKEN_A,
      anchor: ANCHOR,
      ifNoneMatch: first.etag!
    })
    expect(changed.status).toBe(200)
    expect(changed.etag).not.toBe(first.etag)
    expect(
      changed.model!.days.flatMap((day) => day.tasks.map((item) => item.title))
    ).toContain("تازه")

    // The event lane is part of the body too: adding one invalidates the
    // validator, and removing it invalidates the new one as well (#62).
    const eventId = uuidV7()
    seedEvent(h.db, { id: eventId, title: "رویداد تازه", allDayDate: "2026-03-24" })
    const afterEvent = await week(h, {
      token: TOKEN_A,
      anchor: ANCHOR,
      ifNoneMatch: changed.etag!
    })
    expect(afterEvent.status).toBe(200)
    expect(afterEvent.etag).not.toBe(changed.etag)
    expect(
      afterEvent.model!.days.flatMap((day) => day.events.map((item) => item.title))
    ).toContain("رویداد تازه")

    h.db.prepare("UPDATE events SET deleted_at = ? WHERE id = ?").run(NOW, eventId)
    const afterEventRemoval = await week(h, {
      token: TOKEN_A,
      anchor: ANCHOR,
      ifNoneMatch: afterEvent.etag!
    })
    expect(afterEventRemoval.status).toBe(200)
    expect(afterEventRemoval.etag).not.toBe(afterEvent.etag)
    expect(
      afterEventRemoval.model!.days.flatMap((day) => day.events.map((item) => item.title))
    ).not.toContain("رویداد تازه")
  })

  it("requires a session, a household and a real anchor", async () => {
    const h = await setup()

    const anonymous = await week(h, { anchor: ANCHOR })
    expect(anonymous.status).toBe(401)
    expect(anonymous.body).toMatchObject({ error: { code: "Unauthorized" } })

    const noHousehold = await week(h, {
      token: TOKEN_NO_HOUSEHOLD,
      anchor: ANCHOR
    })
    expect(noHousehold.status).toBe(403)
    expect(noHousehold.body).toMatchObject({ error: { code: "Forbidden" } })

    const bad = await week(h, { token: TOKEN_A, anchor: "2026-02-30" })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: { code: "BadRequest" } })
  })
})

describe("GET /month", () => {
  it("returns a Jalali month grid with busy marks and a day drill-down", async () => {
    const h = await setup()
    seedWeek(h)

    const response = await month(h, {
      token: TOKEN_A,
      anchor: "2026-03-21",
      day: "2026-03-22"
    })
    expect(response.status).toBe(200)
    const model = response.model!
    expect(model.year).toBe(1405)
    expect(model.month).toBe(1)
    expect(model.start).toBe("2026-03-21")
    expect(model.end).toBe("2026-04-24")
    // Farvardin has 31 days; the grid pads to whole weeks.
    expect(model.days).toHaveLength(35)
    expect(model.days.filter((day) => day.inMonth)).toHaveLength(31)

    const sunday = model.days.find((day) => day.date === "2026-03-22")!
    expect(sunday).toMatchObject({ inMonth: true, isBusy: true, tasks: 4 })
    expect(sunday.busyLevel).toBe(2)
    expect(sunday.counts.tasks).toBe(4)

    // The drill-down is part of the same payload: the four real rows visible
    // to A (B's private row is still hidden in the detail).
    expect(model.day?.date).toBe("2026-03-22")
    expect(model.day?.tasks).toHaveLength(4)
    expect(model.day?.tasks.every((item) => !item.projected)).toBe(true)
    expect(model.totals.busyDays).toBeGreaterThan(5)
    expect(model.totals.tasks).toBeGreaterThan(10)
  })

  it("counts events in the busy marks and the day drill-down", async () => {
    const h = await setup()
    const series = uuidV7()
    seedEvent(h.db, {
      id: series,
      title: "جلسهٔ هفتگی",
      startAt: "2026-10-19T06:30:00.000Z",
      endAt: "2026-10-19T07:30:00.000Z",
      recurrence: { frequency: "weekly", interval: 1, byDay: [1, 3, 5], end: { _tag: "never" } }
    })

    const model = (await month(h, {
      token: TOKEN_A,
      anchor: "2026-10-19",
      day: "2026-10-21"
    })).model!

    const cell = model.days.find((day) => day.date === "2026-10-21")!
    expect(cell).toMatchObject({ inMonth: true, isBusy: true, tasks: 0, events: 1 })
    expect(cell.busyLevel).toBe(1)
    expect(cell.counts).toEqual({ tasks: 0, events: 1, occasions: 0, reminders: 0, habits: 0 })

    // 10-19 and 10-21 are inside Mehr; 10-23 is a borrowed trailing cell.
    expect(model.totals.events).toBe(2)
    expect(model.days.find((day) => day.date === "2026-10-23")).toMatchObject({
      inMonth: false,
      events: 1
    })

    expect(model.day?.date).toBe("2026-10-21")
    expect(model.day?.events).toHaveLength(1)
    expect(model.day?.events[0]).toMatchObject({
      instanceId: "2026-10-21",
      projected: true,
      title: "جلسهٔ هفتگی"
    })
  })


  it("paints a yearly occasion on its Jalali date and counts it as busy", async () => {
    const h = await setup()
    // Nowruz 1399 (2020-03-20). The month read for a later year must paint the
    // same Jalali month/day, not the same Gregorian date.
    seedOccasion(h.db, { id: uuidV7(), title: "سالگرد", originDate: "2020-03-20" })

    const first = (await month(h, { token: TOKEN_A, anchor: "2026-03-21" })).model!
    const chip = first.days.find((cell) => cell.occasions === 1)!
    expect(chip.date).not.toBe("2020-03-20")
    expect(chip).toMatchObject({ tasks: 0, events: 0, occasions: 1, isBusy: true })
    expect(first.totals.occasions).toBe(1)

    const drilled = (await month(h, {
      token: TOKEN_A,
      anchor: "2026-03-21",
      day: chip.date
    })).model!
    expect(drilled.day?.occasions).toHaveLength(1)
    expect(drilled.day?.occasions[0]).toMatchObject({
      title: "سالگرد",
      projected: true,
      jalali: { year: 1405, month: 1, day: 1 }
    })
    expect(drilled.day?.occasions[0]!.gregorian).toMatchObject({ month: 3 })

    // A private occasion belongs to its owner only.
    const mine = uuidV7()
    seedOccasion(h.db, {
      id: mine,
      title: "خصوصی",
      originDate: "2020-03-20",
      ownerId: USER_A,
      visibility: "private"
    })
    const a = (await week(h, { token: TOKEN_A, anchor: "2026-03-21" })).model!
    const b = (await week(h, { token: TOKEN_B, anchor: "2026-03-21" })).model!
    expect(a.occasions.map((row) => row.title)).toContain("خصوصی")
    expect(b.occasions.map((row) => row.title)).not.toContain("خصوصی")
  })

  it("does not expand a series twice when the drill-down day is outside the grid", async () => {
    const h = await setup()
    const series = uuidV7()
    // Mondays from 2026-03-16, so both Farvardin's grid and the far drill-down
    // day (a Monday in June) have occurrences.
    seedEvent(h.db, {
      id: series,
      title: "جلسهٔ هفتگی",
      startAt: "2026-03-16T06:30:00.000Z",
      endAt: "2026-03-16T07:30:00.000Z",
      recurrence: { frequency: "weekly", interval: 1, byDay: [1], end: { _tag: "never" } }
    })

    // 2026-06-01 is outside Farvardin 1405's grid, so the route unions a second
    // read for that day. That read returns every live recurring row again, and
    // the builder has to collapse the duplicate instead of painting the series
    // twice.
    const model = (await month(h, {
      token: TOKEN_A,
      anchor: "2026-03-21",
      day: "2026-06-01"
    })).model!

    const monday = model.days.find((day) => day.events > 0)!
    expect(monday.events).toBe(1)
    expect(monday.counts.events).toBe(1)
    expect(model.day?.date).toBe("2026-06-01")
    expect(model.day?.events.map((event) => event.instanceId)).toEqual(["2026-06-01"])
  })

  it("crosses a Jalali month edge and counts adjacent-month cells separately", async () => {
    const h = await setup()
    // Esfand 1404 ends 2026-03-20; Nowruz starts Farvardin on 2026-03-21.
    seedTask(h.db, { id: uuidV7(), title: "اسفند", dueDate: "2026-03-20" })
    seedTask(h.db, { id: uuidV7(), title: "فروردین", dueDate: "2026-03-21" })
    // 2026-04-22 is borrowed by Farvardin's trailing week (Ordibehesht starts
    // on 2026-04-21).
    seedTask(h.db, { id: uuidV7(), title: "اردیبهشت", dueDate: "2026-04-22" })

    const esfand = (await month(h, { token: TOKEN_A, anchor: "2026-03-20" })).model!
    expect(esfand.year).toBe(1404)
    expect(esfand.month).toBe(12)
    expect(esfand.days.find((day) => day.date === "2026-03-20")).toMatchObject({
      inMonth: true,
      isBusy: true
    })

    const farvardin = (await month(h, { token: TOKEN_A, anchor: "2026-03-21" })).model!
    expect(farvardin.year).toBe(1405)
    expect(farvardin.month).toBe(1)
    expect(farvardin.days.find((day) => day.date === "2026-04-22")).toMatchObject({
      inMonth: false,
      isBusy: true
    })
    // Totals ignore cells borrowed from either neighbour.
    expect(farvardin.totals).toEqual({ busyDays: 1, tasks: 1, events: 0, occasions: 0 })
  })

  it("scopes by household and hides another member's private rows", async () => {
    const h = await setup()
    seedWeek(h)

    const b = (await month(h, {
      token: TOKEN_B,
      anchor: "2026-03-21",
      day: "2026-03-22"
    })).model!
    const titles = b.day!.tasks.map((item) => item.title)
    expect(titles).toContain("کار خصوصی ب")
    expect(titles).not.toContain("کار خصوصی الف")

    const c = (await month(h, {
      token: TOKEN_C,
      anchor: "2026-03-21",
      day: "2026-03-22"
    })).model!
    expect(c.day!.tasks.map((item) => item.title)).toEqual(["خانه دیگر"])
  })

  it("reads the drill-down day even when it falls outside the month grid", async () => {
    const h = await setup()
    // Nothing else is seeded, so only the out-of-grid day's own rows can show.
    const far = uuidV7()
    seedTask(h.db, { id: far, title: "روز دور", dueDate: "2026-06-01" })

    // Farvardin 1405's grid ends on 2026-04-24, so 2026-06-01 is not loaded by
    // the grid query. A drill-down for it must still be answered, not silently
    // empty (and the month totals must not absorb it).
    const model = (await month(h, {
      token: TOKEN_A,
      anchor: "2026-03-21",
      day: "2026-06-01"
    })).model!

    expect(model.day?.date).toBe("2026-06-01")
    expect(model.day?.tasks.map((item) => item.title)).toEqual(["روز دور"])
    expect(model.totals).toEqual({ busyDays: 0, tasks: 0, events: 0, occasions: 0 })
    expect(model.days.some((cell) => cell.date === "2026-06-01")).toBe(false)
  })

  it("answers 304 for a matching ETag and validates query dates", async () => {
    const h = await setup()
    seedWeek(h)
    const first = await month(h, { token: TOKEN_A, anchor: "2026-03-21" })
    expect(first.status).toBe(200)
    const cached = await month(h, {
      token: TOKEN_A,
      anchor: "2026-03-21",
      ifNoneMatch: first.etag!
    })
    expect(cached.status).toBe(304)

    // The occasion lane is part of the encoded body: a new occasion invalidates
    // the validator, and the next read carries the chip's data (#62).
    const occasionId = uuidV7()
    seedOccasion(h.db, {
      id: occasionId,
      title: "سالگرد تازه",
      originDate: "2020-03-21"
    })
    const afterOccasion = await month(h, {
      token: TOKEN_A,
      anchor: "2026-03-21",
      ifNoneMatch: first.etag!
    })
    expect(afterOccasion.status).toBe(200)
    expect(afterOccasion.model!.totals.occasions).toBe(1)
    expect(
      afterOccasion.model!.days.find((day) => day.date === "2026-03-22")?.occasions
    ).toBe(1)

    // Removing the occasion changes the body as well; the old validator must
    // not turn that into a 304 that hides the chip's disappearance.
    h.db.prepare("UPDATE occasions SET deleted_at = ? WHERE id = ?").run(NOW, occasionId)
    const afterRemoval = await month(h, {
      token: TOKEN_A,
      anchor: "2026-03-21",
      ifNoneMatch: afterOccasion.etag!
    })
    expect(afterRemoval.status).toBe(200)
    expect(afterRemoval.etag).not.toBe(afterOccasion.etag)
    expect(afterRemoval.model!.totals.occasions).toBe(0)

    // A drill-down is a different body, so an ETag without it cannot revalidate.
    const withDay = await month(h, {
      token: TOKEN_A,
      anchor: "2026-03-21",
      day: "2026-03-22",
      ifNoneMatch: first.etag!
    })
    expect(withDay.status).toBe(200)
    expect(withDay.model!.day).not.toBeNull()

    const bad = await month(h, {
      token: TOKEN_A,
      anchor: "2026-03-21",
      day: "not-a-date"
    })
    expect(bad.status).toBe(400)
  })

  it("requires a session and a household", async () => {
    const h = await setup()
    const anonymous = await month(h, { anchor: "2026-03-21" })
    expect(anonymous.status).toBe(401)
    const noHousehold = await month(h, {
      token: TOKEN_NO_HOUSEHOLD,
      anchor: "2026-03-21"
    })
    expect(noHousehold.status).toBe(403)
  })
})
