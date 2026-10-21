import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, Option, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  type HouseholdId,
  type ReminderId,
  type UserId,
  uuidV7
} from "@tali/domain"
import {
  PushSubscriptionRepoLive,
  ReminderDispatchRepo,
  ReminderDispatchRepoLive,
  SyncRepoLive
} from "@tali/sql"
import {
  PushGateway,
  type PushGatewayApi,
  type PushSendInput,
  type PushSendResult
} from "../src/push-gateway.js"
import { OccasionServiceLive } from "../src/occasion-service.js"
import { ReminderService, ReminderServiceLive, type ReminderViewer } from "../src/reminder-service.js"
import { ReminderSweep, ReminderSweepLive } from "../src/reminder-sweep.js"
import { runReminderSweep } from "../src/reminder-sweep-runner.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #61 at the delivery seam: claim → push → outcome, the missed inbox,
 * and the Done/Snooze path — against D1's own engine (SQLite) through a
 * D1-shaped batch, with a fake push gateway standing in for the push service.
 *
 * Time is always explicit. The sweep's clock is the tick's nominal instant, so
 * every case pins `now` and asserts the exact `deliverAt` the policy produced
 * (quiet hours, medication bypass) rather than "roughly when".
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)

const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort()

const USER_A = "user-a" as UserId
const USER_B = "user-b" as UserId
const HOUSEHOLD = "household-a" as HouseholdId
const TZ = "Asia/Tehran"
const NOW = "2026-10-20T09:30:00.000Z"
/** Tehran is UTC+03:30 (Iran dropped DST in 2022). */
const T = (localHour: string, day = "2026-10-21"): string =>
  new Date(`${day}T${localHour}+03:30`).toISOString()

const after = (instant: string, ms: number): string =>
  new Date(Date.parse(instant) + ms).toISOString()

const viewer = (overrides: Partial<ReminderViewer> = {}): ReminderViewer => ({
  userId: USER_A,
  householdId: HOUSEHOLD,
  timeZone: TZ,
  ...overrides
})

const seedUser = (db: DatabaseSync, id: string, email: string) => {
  db.prepare(
    `INSERT INTO users
      (id, email, credential_verifier, credential_salt, kdf_version,
       display_name, time_zone, week_start, digits, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, 'saturday', 'persian', ?, ?)`
  ).run(id, email, "0".repeat(64), "0".repeat(32), email, TZ, NOW, NOW)
}

interface SendRecord extends PushSendInput {
  readonly result: PushSendResult
}

const makeHarness = () => {
  const db = new DatabaseSync(":memory:")
  for (const file of migrationFiles()) {
    db.exec(readFileSync(fileURLToPath(new URL(file, MIGRATIONS_DIR)), "utf8"))
  }
  seedUser(db, USER_A, "a@example.com")
  seedUser(db, USER_B, "b@example.com")
  db.prepare(
    `INSERT INTO households (id, name, invite_code, created_by, created_at)
     VALUES (?, 'خانه', 'delivery-invite', ?, ?)`
  ).run(HOUSEHOLD, USER_A, NOW)

  const fake = new FakeD1(db)
  const sends: Array<SendRecord> = []
  /** Scripted push-service answer; defaults to accepted. */
  let answer: (input: PushSendInput) => PushSendResult = () => ({ _tag: "accepted", status: 201 })

  const gateway: PushGatewayApi = {
    send: (input) =>
      Effect.sync(() => {
        const result = answer(input)
        sends.push({ ...input, result })
        return result
      })
  }

  const d1 = D1Client.layer({
    db: fake.asD1Database(),
    transformQueryNames: Str.camelToSnake,
    transformResultNames: Str.snakeToCamel
  })

  // The sweep now materialises occasion advance reminders before claiming
  // (#61), so its layer includes the occasion service.
  const services = Layer.mergeAll(ReminderServiceLive, OccasionServiceLive)
  const layer = Layer.mergeAll(
    ReminderSweepLive.pipe(Layer.provide(services)),
    // The tests also answer dispatches directly, so the service is an output
    // as well as the sweep's dependency.
    services
  ).pipe(
    Layer.provide(Layer.succeed(PushGateway, gateway)),
    Layer.provide(
      Layer.mergeAll(ReminderDispatchRepoLive, PushSubscriptionRepoLive, SyncRepoLive)
    ),
    Layer.provide(d1)
  )

  // The ledger repo as a test output, for the answered-mid-tick guard check.
  const ledger = ReminderDispatchRepoLive.pipe(Layer.provide(d1))

  const run = <A, E>(
    effect: Effect.Effect<A, E, ReminderSweep | ReminderService | ReminderDispatchRepo>
  ): Promise<A> => Effect.runPromise(Effect.provide(effect, Layer.merge(layer, ledger)))

  const sweep = (now: string) =>
    run(
      Effect.gen(function*() {
        const service = yield* ReminderSweep
        return yield* service.sweep(now)
      })
    )

  const respond = (
    input: { readonly dispatchId: string; readonly response: "done" | "snooze" | "dismiss"; readonly snoozeMinutes?: number },
    now: string
  ) =>
    run(
      Effect.gen(function*() {
        const service = yield* ReminderService
        return yield* service.respond(
          viewer(),
          {
            dispatchId: input.dispatchId as never,
            response: input.response,
            snoozeMinutes: input.snoozeMinutes
          },
          now
        )
      })
    )

  /** The sweep's pre-send guard, exercised directly (it runs between two ticks). */
  const takeAttempts = (dispatchId: string, now: string) =>
    run(
      Effect.gen(function*() {
        const repo = yield* ReminderDispatchRepo
        return yield* repo.takeAttempts({ dispatchIds: [dispatchId as never], now })
      })
    )

  const inbox = (now: string) =>
    run(
      Effect.gen(function*() {
        const service = yield* ReminderService
        return yield* service.inbox(viewer(), undefined, now)
      })
    )

  const history = (now: string) =>
    run(
      Effect.gen(function*() {
        const service = yield* ReminderService
        return yield* service.inbox(viewer(), { history: true }, now)
      })
    )

  /** Insert a reminder exactly as the aggregate would store it. */
  const insertReminder = (input: {
    readonly id?: string
    readonly title?: string
    readonly note?: string | null
    readonly kind?: "medication" | "exercise" | "chore" | "general"
    readonly fireAt: string
    readonly repeat?: unknown
    readonly timeZone?: string
    readonly ownerId?: string
    readonly silencedUntil?: string | null
    readonly deletedAt?: string | null
  }): string => {
    const id = input.id ?? uuidV7()
    const kind = input.kind ?? "general"
    db.prepare(
      `INSERT INTO reminders
        (id, type, title, note, owner_id, household_id, visibility, color, kind, tier,
         repeat, offset_minutes, fire_at, link_type, link_id, silenced_until, time_zone,
         created_at, updated_at, version, deleted_at)
       VALUES (?, 'reminder', ?, ?, ?, ?, 'shared', NULL, ?, ?, ?, 0, ?, 'none', NULL, ?, ?, ?, ?, 1, ?)`
    ).run(
      id,
      input.title ?? "یادآوری",
      input.note ?? null,
      input.ownerId ?? USER_A,
      HOUSEHOLD,
      kind,
      kind === "medication" ? "critical" : "normal",
      JSON.stringify(input.repeat ?? { _tag: "once" }),
      input.fireAt,
      input.silencedUntil ?? null,
      input.timeZone ?? TZ,
      NOW,
      NOW,
      input.deletedAt ?? null
    )
    return id
  }

  /** Insert an occasion exactly as #59 stores it (annual unless `yearly: false`). */
  const insertOccasion = (input: {
    readonly id?: string
    readonly title?: string
    readonly originDate: string
    readonly advanceDays: number | null
    readonly timeZone?: string
    readonly ownerId?: string
    readonly visibility?: "shared" | "private"
    readonly yearly?: boolean
    readonly deletedAt?: string | null
  }): string => {
    const id = input.id ?? uuidV7()
    db.prepare(
      `INSERT INTO occasions
        (id, type, title, owner_id, household_id, visibility, color, origin_date,
         time_zone, yearly, advance_reminder_days, preparation_task_id,
         created_at, updated_at, version, deleted_at)
       VALUES (?, 'occasion', ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, 1, ?)`
    ).run(
      id,
      input.title ?? "سالگرد",
      input.ownerId ?? USER_A,
      HOUSEHOLD,
      input.visibility ?? "shared",
      input.originDate,
      input.timeZone ?? TZ,
      (input.yearly ?? true) ? 1 : 0,
      input.advanceDays,
      NOW,
      NOW,
      input.deletedAt ?? null
    )
    return id
  }

  const reminderRows = (): ReadonlyArray<Record<string, unknown>> =>
    db.prepare("SELECT * FROM reminders ORDER BY fire_at ASC, id ASC").all() as
      ReadonlyArray<Record<string, unknown>>

  const insertSubscription = (input: {
    readonly userId?: string
    readonly endpoint?: string
    readonly id?: string
  } = {}): string => {
    const id = input.id ?? uuidV7()
    db.prepare(
      `INSERT INTO push_subscriptions
        (id, user_id, endpoint, p256dh, auth, expiration_time, user_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
    ).run(
      id,
      input.userId ?? USER_A,
      input.endpoint ?? `https://push.example.net/${id}`,
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      "BTBZMqHH6r4Tts7J_aSIgg",
      NOW,
      NOW
    )
    return id
  }

  const dispatchRows = (): ReadonlyArray<Record<string, unknown>> =>
    db.prepare("SELECT * FROM reminder_dispatches ORDER BY scheduled_for ASC").all() as
      ReadonlyArray<Record<string, unknown>>

  const subscriptions = (): ReadonlyArray<Record<string, unknown>> =>
    db.prepare("SELECT * FROM push_subscriptions").all() as ReadonlyArray<Record<string, unknown>>

  const reminderRow = (id: string): Record<string, unknown> =>
    db.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as Record<string, unknown>

  return {
    db,
    fake,
    sends,
    setAnswer: (next: (input: PushSendInput) => PushSendResult) => {
      answer = next
    },
    sweep,
    respond,
    takeAttempts,
    inbox,
    history,
    insertReminder,
    insertOccasion,
    insertSubscription,
    dispatchRows,
    reminderRows,
    subscriptions,
    reminderRow
  }
}

describe("sweep — occasion advance reminders (#59/#74's trigger)", () => {
  it("materialises one row inside the window and dispatches it on that tick, once", async () => {
    const h = makeHarness()
    h.insertSubscription()
    // Annual birthday on 24 Oct, remind 3 days before at 09:00 Tehran.
    const occasionId = h.insertOccasion({ originDate: "2026-10-24", advanceDays: 3 })
    const fireAt = T("09:00", "2026-10-21")

    const first = await h.sweep(fireAt)
    expect(first).toMatchObject({ claimed: 1, pushed: 1, accepted: 1 })

    const materialised = h.reminderRows().filter((row) => row.link_type === "occasion")
    expect(materialised).toHaveLength(1)
    expect(materialised[0]).toMatchObject({
      fire_at: fireAt,
      owner_id: USER_A,
      household_id: HOUSEHOLD,
      visibility: "shared",
      link_id: occasionId
    })
    expect(h.dispatchRows()).toHaveLength(1)
    expect(h.sends).toHaveLength(1)

    // The next tick's materialisation is a no-op and the ledger is the mutex.
    const second = await h.sweep(new Date(Date.parse(fireAt) + 60_000).toISOString())
    expect(second).toMatchObject({ claimed: 0, pushed: 0 })
    expect(h.reminderRows().filter((row) => row.link_type === "occasion")).toHaveLength(1)
    expect(h.dispatchRows()).toHaveLength(1)
    expect(h.sends).toHaveLength(1)
  })

  it("inherits the occasion's own-or-shared visibility and owner", async () => {
    const h = makeHarness()
    h.insertSubscription({ userId: USER_B })
    // A private occasion owned by the other member: the system materialiser
    // must still create its reminder, under that owner, as private.
    const occasionId = h.insertOccasion({
      originDate: "2026-10-22",
      advanceDays: 0,
      ownerId: USER_B,
      visibility: "private",
      title: "خصوصی"
    })
    const fireAt = T("09:00", "2026-10-22")

    await h.sweep(fireAt)

    const [created] = h.reminderRows().filter((row) => row.link_type === "occasion")
    expect(created).toMatchObject({
      link_id: occasionId,
      owner_id: USER_B,
      visibility: "private",
      fire_at: fireAt
    })
    // USER_A's inbox must not see USER_B's private reminder.
    expect(await h.inbox(after(fireAt, 60_000))).toHaveLength(0)
  })

  it("keeps a busy tick inside D1's 50-statement Free-plan ceiling (ADR-0005 §9)", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("09:00")
    for (let index = 0; index < 10; index += 1) {
      h.insertReminder({ title: `یادآوری ${index}`, fireAt })
    }
    // Also materialise one occasion reminder on the same tick.
    h.insertOccasion({ originDate: "2026-10-22", advanceDays: 1 })

    h.fake.statementCalls = 0
    const result = await h.sweep(fireAt)

    expect(result.claimed).toBe(10)
    expect(result.pushed).toBe(10)
    expect(h.fake.statementCalls).toBeGreaterThan(0)
    // One claim batch, one outcome batch, the take-attempts statement and the
    // fixed reads must all fit in D1's Free-plan 50-queries-per-invocation.
    expect(h.fake.statementCalls).toBeLessThanOrEqual(50)
  })

  it("does not resurrect an occasion reminder the owner deleted", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const occasionId = h.insertOccasion({ originDate: "2026-10-24", advanceDays: 3 })
    const fireAt = T("09:00", "2026-10-21")
    h.insertReminder({
      title: "حذف‌شده",
      fireAt,
      deletedAt: NOW
    })
    h.db.prepare(
      `UPDATE reminders SET link_type = 'occasion', link_id = ? WHERE title = 'حذف‌شده'`
    ).run(occasionId)

    expect(await h.sweep(fireAt)).toMatchObject({ claimed: 0, pushed: 0 })
    expect(h.reminderRows().filter((row) => row.link_type === "occasion")).toHaveLength(1)
    expect(h.dispatchRows()).toHaveLength(0)
  })
})

describe("sweep — claim, push, outcome (ADR-0005)", () => {
  it("pushes a medication reminder on time inside quiet hours, with `Urgency: high`", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("23:30")
    const reminderId = h.insertReminder({
      kind: "medication",
      title: "داروی فشار",
      note: "یک قرص",
      fireAt,
      repeat: { _tag: "daily", time: "23:30" }
    })

    const result = await h.sweep(fireAt)

    expect(result).toMatchObject({ claimed: 1, pushed: 1, accepted: 1, expired: 0 })
    const [dispatch] = h.dispatchRows()
    expect(dispatch).toMatchObject({
      reminder_id: reminderId,
      scheduled_for: fireAt,
      // Critical bypasses quiet hours: deliver-at is the fire instant.
      deliver_at: fireAt,
      push_outcome: "accepted",
      attempts: 1,
      last_attempt_at: fireAt
    })
    expect(h.sends).toHaveLength(1)
    const send = h.sends[0]!
    expect(send.urgency).toBe("high")
    expect(send.ttlSeconds).toBe(15 * 60)
    expect(send.topic.length).toBeLessThanOrEqual(32)

    const payload = JSON.parse(send.payload) as Record<string, unknown>
    expect(payload).toMatchObject({
      type: "reminder",
      id: dispatch!.id,
      reminderId,
      title: "داروی فشار",
      body: "یک قرص",
      tier: "critical",
      url: "/reminders"
    })
    expect(payload.actions).toEqual([
      { action: "done", title: "انجام شد" },
      { action: "snooze", title: "بعداً", minutes: 10 }
    ])
  })

  it("holds a normal reminder at 23:30 until 07:00 and never pushes early", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("23:30")
    h.insertReminder({ fireAt, repeat: { _tag: "daily", time: "23:30" } })

    const first = await h.sweep(fireAt)
    expect(first).toMatchObject({ claimed: 1, pushed: 0, expired: 0 })

    const [held] = h.dispatchRows()
    expect(held).toMatchObject({
      scheduled_for: fireAt,
      // The next local 07:00 — the ledger is the quiet-hours queue.
      deliver_at: T("07:00", "2026-10-22"),
      push_outcome: "pending",
      attempts: 0
    })
    expect(h.sends).toHaveLength(0)

    // One minute before the flush: still held, still nothing sent.
    expect(await h.sweep(new Date(Date.parse(T("07:00", "2026-10-22")) - 60_000).toISOString()))
      .toMatchObject({ claimed: 0, pushed: 0 })
    expect(h.sends).toHaveLength(0)

    // A held fire is still a ledger row: an app opened at 23:31 sees it in the
    // inbox instead of waiting for 07:00 (ADR-0005 §7).
    expect(await h.inbox(after(fireAt, 60_000))).toMatchObject([
      { title: "یادآوری", state: "inbox" }
    ])

    // The 07:00 tick carries it, and lateness is measured from deliver_at.
    expect(await h.sweep(T("07:00", "2026-10-22"))).toMatchObject({ pushed: 1, accepted: 1 })
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]!.urgency).toBe("normal")
    expect(h.dispatchRows()[0]).toMatchObject({ push_outcome: "accepted", attempts: 1 })
  })

  it("re-fires a snooze inside quiet hours instead of holding it to 07:00", async () => {
    const h = makeHarness()
    h.insertSubscription()
    // 20:00 local: outside quiet hours, so the first dispatch goes out.
    const fireAt = T("20:00")
    h.insertReminder({ fireAt })
    await h.sweep(fireAt)
    const [parent] = h.dispatchRows()

    // "بعداً" at 23:25 → 23:35, inside quiet hours. ADR-0005 §5's recorded
    // default keeps the snooze exemption: asking again is consent.
    const snoozedAt = T("23:25")
    const snoozed = await h.respond(
      { dispatchId: parent!.id as string, response: "snooze", snoozeMinutes: 10 },
      snoozedAt
    )
    expect(snoozed.child!.deliverAt).toBe(T("23:35"))

    expect(await h.sweep(T("23:35"))).toMatchObject({ pushed: 1, accepted: 1 })
    expect(h.sends).toHaveLength(2)
    expect(h.sends[1]!.urgency).toBe("normal")
  })

  it("makes the ledger row the mutex: a repeated tick neither claims nor sends twice", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("09:00")
    h.insertReminder({ fireAt })

    expect(await h.sweep(fireAt)).toMatchObject({ claimed: 1, accepted: 1 })
    expect(await h.sweep(fireAt)).toMatchObject({ claimed: 0, pushed: 0 })
    expect(h.sends).toHaveLength(1)
    expect(h.dispatchRows()).toHaveLength(1)
  })

  it("suppresses a silenced fire without a ledger row and advances the series", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("09:00")
    const reminderId = h.insertReminder({ fireAt, silencedUntil: T("12:00") })

    const result = await h.sweep(fireAt)

    // Silence is not a hold: no dispatch, no push, the series moves on.
    expect(result).toMatchObject({ claimed: 0, pushed: 0, expired: 0 })
    expect(h.dispatchRows()).toHaveLength(0)
    expect(h.sends).toHaveLength(0)
    expect(h.reminderRow(reminderId).fire_at).toBe(T("12:00"))
  })

  it("never claims a fire before its instant", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("09:00")
    h.insertReminder({ fireAt })

    expect(await h.sweep(new Date(Date.parse(fireAt) - 60_000).toISOString()))
      .toMatchObject({ claimed: 0, pushed: 0 })
    expect(h.dispatchRows()).toHaveLength(0)
  })

  it("advances a repeating series past the tick, so each fire claims once", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("09:00")
    const reminderId = h.insertReminder({ fireAt, repeat: { _tag: "daily", time: "09:00" } })

    await h.sweep(fireAt)
    expect(h.reminderRow(reminderId).fire_at).toBe(T("09:00", "2026-10-22"))
  })
})

describe("sweep — failures land in the inbox", () => {
  it("deletes an expired subscription on 410 and keeps the dispatch inbox-only", async () => {
    const h = makeHarness()
    const subscriptionId = h.insertSubscription()
    const fireAt = T("09:00")
    h.insertReminder({ title: "دارو", kind: "medication", fireAt })
    h.setAnswer(() => ({ _tag: "gone", status: 410 }))

    const result = await h.sweep(fireAt)

    expect(result).toMatchObject({ claimed: 1, pushed: 1, accepted: 0, expired: 1 })
    expect(result.subscriptionsDeleted).toBe(1)
    expect(h.subscriptions()).toHaveLength(0)
    expect(h.dispatchRows()[0]).toMatchObject({ push_outcome: "expired" })

    // The inbox is `scheduled_for < now` — one minute after the fire it is missed.
    const [item] = await h.inbox(after(fireAt, 60_000))
    expect(item).toMatchObject({ title: "دارو", state: "inbox", tier: "critical" })
    expect(item!.dispatch.pushOutcome).toBe("expired")
    expect(subscriptionId).toBeTruthy()
  })

  it("treats a permanent 4xx as inbox-only without retrying", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("09:00")
    h.insertReminder({ fireAt })
    h.setAnswer(() => ({ _tag: "permanent", status: 400 }))

    expect(await h.sweep(fireAt)).toMatchObject({ expired: 1 })
    expect(h.dispatchRows()[0]).toMatchObject({ push_outcome: "expired", attempts: 1 })
    expect(await h.inbox(after(fireAt, 60_000))).toHaveLength(1)
    // A second tick has nothing owed and sends nothing.
    expect(await h.sweep(fireAt)).toMatchObject({ pushed: 0, claimed: 0 })
    expect(h.sends).toHaveLength(1)
  })

  it("retries a transient failure three times, then expires it into the inbox", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("09:00")
    h.insertReminder({ fireAt })
    h.setAnswer(() => ({ _tag: "transient", status: 503 }))

    const first = await h.sweep(fireAt)
    const second = await h.sweep(new Date(Date.parse(fireAt) + 60_000).toISOString())
    const third = await h.sweep(new Date(Date.parse(fireAt) + 120_000).toISOString())

    expect(first).toMatchObject({ failed: 1 })
    expect(second).toMatchObject({ failed: 1 })
    // Attempt 3 is the budget: `failed` becomes `expired` (inbox-only).
    expect(third).toMatchObject({ expired: 1, failed: 0 })
    expect(h.dispatchRows()[0]).toMatchObject({ push_outcome: "expired", attempts: 3 })
    expect(h.sends).toHaveLength(3)
    expect(await h.inbox(new Date(Date.parse(fireAt) + 121_000).toISOString())).toHaveLength(1)
  })

  it("expires a dispatch whose first deliverable tick is past the 15-minute horizon", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("09:00")
    h.insertReminder({ fireAt })
    // First tick fails transiently so the row survives with a real attempt.
    h.setAnswer(() => ({ _tag: "transient", status: 429 }))
    await h.sweep(fireAt)
    expect(h.dispatchRows()[0]).toMatchObject({ push_outcome: "failed", attempts: 1 })

    // The Worker is down; the next tick is 16 minutes late.
    h.setAnswer(() => ({ _tag: "accepted", status: 201 }))
    const late = new Date(Date.parse(fireAt) + 16 * 60_000).toISOString()
    expect(await h.sweep(late)).toMatchObject({ expired: 1, pushed: 0 })
    expect(h.sends).toHaveLength(1)
    expect(h.dispatchRows()[0]).toMatchObject({ push_outcome: "expired", attempts: 1 })
  })

  it("keeps the reminder in the inbox when the owner has no subscription at all", async () => {
    const h = makeHarness()
    const fireAt = T("09:00")
    h.insertReminder({ title: "بدون دستگاه", fireAt })

    expect(await h.sweep(fireAt)).toMatchObject({ claimed: 1, pushed: 0, expired: 1 })
    expect(h.sends).toHaveLength(0)
    const [item] = await h.inbox(after(fireAt, 60_000))
    expect(item).toMatchObject({ title: "بدون دستگاه", state: "inbox" })
    expect(item!.dispatch.pushOutcome).toBe("expired")
  })

  it("fans out to every device of the owner and accepts if one does", async () => {
    const h = makeHarness()
    h.insertSubscription({ endpoint: "https://push.example.net/one" })
    h.insertSubscription({ endpoint: "https://push.example.net/two" })
    const fireAt = T("09:00")
    h.insertReminder({ fireAt })
    let calls = 0
    h.setAnswer(() => {
      calls += 1
      return calls === 1 ? { _tag: "gone", status: 404 } : { _tag: "accepted", status: 201 }
    })

    expect(await h.sweep(fireAt)).toMatchObject({ accepted: 1, subscriptionsDeleted: 1 })
    expect(h.sends).toHaveLength(2)
    expect(h.subscriptions()).toHaveLength(1)
    expect(h.dispatchRows()[0]).toMatchObject({ push_outcome: "accepted" })
  })

  it("caps fetches per tick and rolls the remainder to the next tick", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("09:00")
    for (let index = 0; index < 12; index += 1) {
      h.insertReminder({ title: `یادآوری ${index}`, fireAt })
    }

    const first = await h.sweep(fireAt)
    expect(first.claimed).toBe(10)
    expect(h.sends.length).toBeLessThanOrEqual(10)

    const second = await h.sweep(new Date(Date.parse(fireAt) + 60_000).toISOString())
    expect(first.claimed + second.claimed).toBe(12)
    expect(h.dispatchRows()).toHaveLength(12)
  })
})

describe("done / snooze against the ledger", () => {
  it("answers Done from the inbox-less path and clears the inbox", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("09:00")
    h.insertReminder({ kind: "medication", title: "دارو", fireAt })
    await h.sweep(fireAt)
    expect(await h.inbox(after(fireAt, 60_000))).toHaveLength(1)

    const [dispatch] = h.dispatchRows()
    const respondedAt = new Date(Date.parse(fireAt) + 5 * 60_000).toISOString()
    const result = await h.respond({ dispatchId: dispatch!.id as string, response: "done" }, respondedAt)

    expect(result.dispatch.response).toBe("done")
    expect(result.onTime).toBe(true)
    expect(await h.inbox(respondedAt)).toHaveLength(0)
    expect(await h.history(respondedAt)).toHaveLength(1)
  })

  it("answers Done on a snoozed child and keeps the on-time grace rooted", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("09:00")
    h.insertReminder({ kind: "medication", fireAt })
    await h.sweep(fireAt)
    const [parent] = h.dispatchRows()

    const snoozedAt = new Date(Date.parse(fireAt) + 10 * 60_000).toISOString()
    const snoozed = await h.respond(
      { dispatchId: parent!.id as string, response: "snooze", snoozeMinutes: 10 },
      snoozedAt
    )
    expect(snoozed.dispatch.response).toBe("snooze")
    expect(snoozed.child).not.toBeNull()
    // The child re-fires at respondedAt + 10 and keeps the root fire instant.
    expect(snoozed.child!.scheduledFor).toBe(new Date(Date.parse(snoozedAt) + 10 * 60_000).toISOString())
    expect(snoozed.child!.deliverAt).toBe(snoozed.child!.scheduledFor)
    expect(snoozed.child!.rootScheduledFor).toBe(fireAt)

    // Before its deliver-at the child is not pushed.
    expect(await h.sweep(new Date(Date.parse(snoozedAt) + 9 * 60_000).toISOString()))
      .toMatchObject({ pushed: 0 })
    expect(h.sends).toHaveLength(1)

    const childAt = new Date(Date.parse(snoozedAt) + 10 * 60_000).toISOString()
    expect(await h.sweep(childAt)).toMatchObject({ pushed: 1, accepted: 1 })
    expect(h.sends).toHaveLength(2)
    const childSend = JSON.parse(h.sends[1]!.payload) as { readonly id: string }
    expect(childSend.id).toBe(snoozed.child!.id)

    // 25 minutes after the ROOT fire is still within the 30-minute grace.
    const done = await h.respond(
      { dispatchId: snoozed.child!.id, response: "done" },
      new Date(Date.parse(fireAt) + 25 * 60_000).toISOString()
    )
    expect(done.onTime).toBe(true)

    // 31 minutes after the root fire is late, even though the child was recent.
    const late = makeHarness()
    late.insertSubscription()
    late.insertReminder({ fireAt })
    await late.sweep(fireAt)
    const [root] = late.dispatchRows()
    const lateResponded = await late.respond(
      { dispatchId: root!.id as string, response: "done" },
      new Date(Date.parse(fireAt) + 31 * 60_000).toISOString()
    )
    expect(lateResponded.onTime).toBe(false)
  })

  it("does not answer the same dispatch twice from a double tap", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("09:00")
    h.insertReminder({ fireAt })
    await h.sweep(fireAt)
    const [dispatch] = h.dispatchRows()

    const first = await h.respond({ dispatchId: dispatch!.id as string, response: "done" }, fireAt)
    const second = await h.respond({ dispatchId: dispatch!.id as string, response: "snooze", snoozeMinutes: 5 }, fireAt)
    expect(first.dispatch.response).toBe("done")
    expect(second.dispatch.response).toBe("done")
    expect(second.child).toBeNull()
    expect(h.dispatchRows()).toHaveLength(1)
  })

  it("refuses the send slot once the dispatch is answered (answered-mid-tick guard)", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("09:00")
    h.insertReminder({ fireAt })
    // First tick leaves a retryable row: not answered, still sendable.
    h.setAnswer(() => ({ _tag: "transient", status: 503 }))
    await h.sweep(fireAt)
    const [row] = h.dispatchRows()
    const dispatchId = row!.id as string

    // The guard takes the slot while the row is unanswered.
    expect(await h.takeAttempts(dispatchId, after(fireAt, 60_000))).toEqual([dispatchId])
    // The owner answers, still inside what would have been the retry window.
    await h.respond({ dispatchId, response: "done" }, after(fireAt, 61_000))
    // The pre-send guard now refuses: no push may leave after the answer.
    expect(await h.takeAttempts(dispatchId, after(fireAt, 62_000))).toEqual([])

    const next = await h.sweep(after(fireAt, 120_000))
    expect(next).toMatchObject({ pushed: 0, claimed: 0 })
    expect(h.sends).toHaveLength(1)
    expect(h.dispatchRows()[0]).toMatchObject({ response: "done" })
  })

  it("keeps another member's dispatch out of reach", async () => {
    const h = makeHarness()
    h.insertSubscription({ userId: USER_B })
    const fireAt = T("09:00")
    h.insertReminder({ fireAt, ownerId: USER_B })
    await h.sweep(fireAt)
    const [dispatch] = h.dispatchRows()

    await expect(
      h.respond({ dispatchId: dispatch!.id as string, response: "done" }, fireAt)
    ).rejects.toMatchObject({ _tag: "ReminderDispatchNotFound" })
  })
})

describe("the scheduled() entry point", () => {
  it("runs one tick against the Worker's env with no VAPID keys: ledger only", async () => {
    const h = makeHarness()
    const fireAt = T("09:00")
    h.insertReminder({ title: "بدون کلید", fireAt })

    // Exactly what `scheduled()` calls — same layer, same env shape.
    const result = await runReminderSweep({ DB: h.fake.asD1Database() }, fireAt)

    expect(result).toMatchObject({ claimed: 1, pushed: 0, expired: 1 })
    expect(h.dispatchRows()[0]).toMatchObject({ push_outcome: "expired" })
    expect(await h.inbox(after(fireAt, 60_000))).toHaveLength(1)
  })

  it("returns Option.none from claim for an already-claimed fire", async () => {
    const h = makeHarness()
    h.insertSubscription()
    const fireAt = T("09:00")
    const reminderId = h.insertReminder({ fireAt })
    await h.sweep(fireAt)

    const again = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const service = yield* ReminderService
          return yield* service.claim({
            reminderId: reminderId as ReminderId,
            scheduledFor: fireAt,
            ownerTimeZone: TZ,
            now: fireAt
          })
        }),
        ReminderServiceLive.pipe(
          Layer.provide(
            Layer.mergeAll(ReminderDispatchRepoLive, SyncRepoLive)
          ),
          Layer.provide(
            D1Client.layer({
              db: h.fake.asD1Database(),
              transformQueryNames: Str.camelToSnake,
              transformResultNames: Str.snakeToCamel
            })
          )
        )
      )
    )
    expect(Option.isNone(again)).toBe(true)
  })
})
