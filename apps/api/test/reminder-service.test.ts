import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  type HouseholdId,
  type ReminderId,
  type UserId,
  uuidV7
} from "@tali/domain"
import { ReminderDispatchRepoLive } from "@tali/sql"
import {
  ReminderService,
  ReminderServiceLive,
  type ReminderServiceApi,
  type ReminderViewer
} from "../src/reminder-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #60 at the service seam. These run the real service + repository +
 * sync-primitive SQL against SQLite (D1's engine), through a D1-shaped batch so
 * atomicity, `changes()` gating and the CAS behave like production.
 *
 * The exit criteria the tests pin down:
 * - a reminder created against a task fires at the right local time;
 * - the policy service holds/bypasses/suppresses at claim (pure tests) while the
 *   ledger records the answer;
 * - a snooze is one child row for this occurrence only;
 * - an unanswered dispatch lands in the missed inbox and rolls to history.
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

const makeHarness = () => {
  const db = new DatabaseSync(":memory:")
  for (const file of migrationFiles()) {
    db.exec(readFileSync(fileURLToPath(new URL(file, MIGRATIONS_DIR)), "utf8"))
  }
  seedUser(db, USER_A, "a@example.com")
  seedUser(db, USER_B, "b@example.com")
  db.prepare(
    `INSERT INTO households (id, name, invite_code, created_by, created_at)
     VALUES (?, 'خانه', 'rem-invite', ?, ?)`
  ).run(HOUSEHOLD, USER_A, NOW)

  const fake = new FakeD1(db)
  const d1 = D1Client.layer({
    db: fake.asD1Database(),
    transformQueryNames: Str.camelToSnake,
    transformResultNames: Str.snakeToCamel
  })
  const layer = Layer.mergeAll(
    ReminderServiceLive,
    ReminderDispatchRepoLive
  ).pipe(Layer.provide(d1))

  const run = <A, E>(effect: Effect.Effect<A, E, ReminderService | ReminderDispatchRepo>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, layer))

  const svc = <A, E>(
    f: (service: ReminderServiceApi) => Effect.Effect<A, E, never>
  ): Promise<A> =>
    run(
      Effect.gen(function*() {
        const service = yield* ReminderService
        return yield* f(service)
      })
    )

  /** Insert a task directly; the scheduling derivation only needs its columns. */
  const insertTask = (input: {
    readonly id?: string
    readonly dueAt?: string | null
    readonly dueDate?: string | null
    readonly ownerId?: string
    readonly visibility?: string
    readonly status?: string
    readonly recurrence?: string | null
    readonly recurrenceMode?: string | null
  }): string => {
    const id = input.id ?? uuidV7()
    db.prepare(
      `INSERT INTO tasks
        (id, type, title, owner_id, household_id, visibility, status, priority,
         due_at, due_date, time_zone, tag_ids, recurrence, recurrence_mode,
         created_at, updated_at, version)
       VALUES (?, 'task', 'کار', ?, ?, ?, ?, 'medium', ?, ?, ?, '[]', ?, ?, ?, ?, 1)`
    ).run(
      id,
      input.ownerId ?? USER_A,
      HOUSEHOLD,
      input.visibility ?? "shared",
      input.status ?? "todo",
      input.dueAt ?? null,
      input.dueDate ?? null,
      TZ,
      input.recurrence ?? null,
      input.recurrenceMode ?? null,
      NOW,
      NOW
    )
    return id
  }

  /** Insert an occasion directly; the link check only needs its columns. */
  const insertOccasion = (input: {
    readonly id?: string
    readonly ownerId?: string
    readonly householdId?: string
    readonly visibility?: string
  }): string => {
    const id = input.id ?? uuidV7()
    db.prepare(
      `INSERT INTO occasions
        (id, type, title, owner_id, household_id, visibility, color,
         origin_date, time_zone, yearly, advance_reminder_days,
         preparation_task_id, created_at, updated_at, version)
       VALUES (?, 'occasion', 'تولد', ?, ?, ?, NULL, '1990-04-01', ?, 1, 7,
               NULL, ?, ?, 1)`
    ).run(
      id,
      input.ownerId ?? USER_A,
      input.householdId ?? HOUSEHOLD,
      input.visibility ?? "shared",
      TZ,
      NOW,
      NOW
    )
    return id
  }

  /** Insert a claimed ledger row; the sweep that writes these is #61. */
  const insertDispatch = (input: {
    readonly reminderId: string
    readonly scheduledFor: string
    readonly rootScheduledFor?: string
    readonly deliverAt?: string
    readonly userId?: string
    readonly response?: string | null
    readonly respondedAt?: string | null
  }): string => {
    const id = uuidV7()
    db.prepare(
      `INSERT INTO reminder_dispatches
        (id, reminder_id, user_id, scheduled_for, deliver_at, root_scheduled_for,
         origin, push_outcome, attempts, response, responded_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'schedule', 'pending', 0, ?, ?, ?)`
    ).run(
      id,
      input.reminderId,
      input.userId ?? USER_A,
      input.scheduledFor,
      input.deliverAt ?? input.scheduledFor,
      input.rootScheduledFor ?? input.scheduledFor,
      input.response ?? null,
      input.respondedAt ?? null,
      NOW
    )
    return id
  }

  const feedCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM change_feed").get() as { readonly n: number }).n

  const reminderRow = (id: string): Record<string, unknown> | undefined =>
    db.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined

  const dispatchRow = (id: string): Record<string, unknown> | undefined =>
    db.prepare("SELECT * FROM reminder_dispatches WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined

  const taskRow = (id: string): Record<string, unknown> | undefined =>
    db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined

  return {
    db,
    fake,
    svc,
    insertTask,
    insertOccasion,
    insertDispatch,
    feedCount,
    reminderRow,
    dispatchRow,
    taskRow
  }
}

describe("ReminderService — create", () => {
  it("derives fireAt from a timed task's due instant minus the offset", async () => {
    const h = makeHarness()
    const taskId = h.insertTask({ dueAt: "2026-10-21T12:00:00.000Z" })

    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "create-linked",
        title: "زنگ کار",
        kind: "chore",
        repeat: { _tag: "once" },
        offsetMinutes: 30,
        link: { _tag: "task", taskId: taskId as never }
      }, NOW)
    )

    expect(reminder.fireAt).toBe("2026-10-21T11:30:00.000Z")
    expect(reminder.tier).toBe("normal")
    expect(reminder.link).toEqual({ _tag: "task", taskId })
    expect(reminder.version).toBe(1)
    expect(h.feedCount()).toBe(1)
    expect(h.reminderRow(reminder.id)).toMatchObject({
      fire_at: "2026-10-21T11:30:00.000Z",
      tier: "normal",
      link_type: "task",
      link_id: taskId,
      offset_minutes: 30
    })
  })

  it("fires an all-day task reminder at 09:00 in the task's zone", async () => {
    const h = makeHarness()
    const taskId = h.insertTask({ dueDate: "2026-10-21" })

    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "create-allday",
        title: "کار روز",
        kind: "general",
        repeat: { _tag: "once" },
        link: { _tag: "task", taskId: taskId as never }
      }, NOW)
    )

    // 09:00 Tehran (UTC+03:30).
    expect(reminder.fireAt).toBe("2026-10-21T05:30:00.000Z")
  })

  it("derives the first pattern occurrence and marks medication critical", async () => {
    const h = makeHarness()

    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "create-med",
        title: "دارو",
        kind: "medication",
        repeat: { _tag: "interval", hours: 8 }
      }, NOW)
    )

    expect(reminder.tier).toBe("critical")
    expect(reminder.fireAt).toBe("2026-10-20T17:30:00.000Z")
    expect(h.reminderRow(reminder.id)).toMatchObject({ tier: "critical" })
  })

  it("requires a fireAt for an unlinked one-off", async () => {
    const h = makeHarness()
    await expect(
      h.svc((svc) =>
        svc.create(viewer(), {
          clientMutationId: "create-missing",
          title: "یادآور",
          kind: "general",
          repeat: { _tag: "once" }
        }, NOW)
      )
    ).rejects.toMatchObject({ _tag: "ReminderValidationError" })
  })

  it("replays a duplicate clientMutationId without writing twice", async () => {
    const h = makeHarness()
    const id = uuidV7() as ReminderId
    const input = {
      id,
      clientMutationId: "create-replay",
      title: "یادآور",
      kind: "general" as const,
      repeat: { _tag: "once" as const },
      fireAt: "2026-10-21T08:00:00.000Z"
    }
    const first = await h.svc((svc) => svc.create(viewer(), input, NOW))
    const second = await h.svc((svc) => svc.create(viewer(), input, NOW))
    expect(second.id).toBe(first.id)
    expect(h.feedCount()).toBe(1)
    expect(
      (h.db.prepare("SELECT COUNT(*) AS n FROM reminders").get() as { readonly n: number }).n
    ).toBe(1)
  })
})

describe("ReminderService — update", () => {
  it("keeps fireAt when only the title changes", async () => {
    const h = makeHarness()
    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "daily",
        title: "دارو",
        kind: "medication",
        repeat: { _tag: "daily", time: "22:00" }
      }, NOW)
    )
    const updated = await h.svc((svc) =>
      svc.update(viewer(), {
        id: reminder.id,
        clientMutationId: "rename",
        patch: { title: "داروی فشار" }
      }, NOW)
    )
    expect(updated.title).toBe("داروی فشار")
    expect(updated.fireAt).toBe(reminder.fireAt)
    expect(updated.version).toBe(2)
  })

  it("lets an explicit fireAt override a linked item's derived instant", async () => {
    const h = makeHarness()
    const taskId = h.insertTask({ dueAt: "2026-10-21T12:00:00.000Z" })
    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "linked-once",
        title: "زنگ کار",
        kind: "chore",
        repeat: { _tag: "once" },
        offsetMinutes: 30,
        link: { _tag: "task", taskId: taskId as never }
      }, NOW)
    )
    expect(reminder.fireAt).toBe("2026-10-21T11:30:00.000Z")

    const moved = await h.svc((svc) =>
      svc.update(viewer(), {
        id: reminder.id,
        clientMutationId: "move",
        patch: { fireAt: "2026-10-21T10:00:00.000Z" }
      }, NOW)
    )
    expect(moved.fireAt).toBe("2026-10-21T10:00:00.000Z")
  })

  it("re-derives fireAt when the repeat pattern changes", async () => {
    const h = makeHarness()
    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "daily-22",
        title: "یادآور",
        kind: "general",
        repeat: { _tag: "daily", time: "22:00" }
      }, NOW)
    )
    expect(reminder.fireAt).toBe("2026-10-20T18:30:00.000Z")
    const changed = await h.svc((svc) =>
      svc.update(viewer(), {
        id: reminder.id,
        clientMutationId: "daily-08",
        patch: { repeat: { _tag: "daily", time: "08:00" } }
      }, NOW)
    )
    expect(changed.fireAt).toBe("2026-10-21T04:30:00.000Z")
  })
})

describe("ReminderService — silence and delete expire owed dispatches", () => {
  const makeOnce = async (h: ReturnType<typeof makeHarness>) =>
    h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "once",
        title: "یادآور",
        kind: "general",
        repeat: { _tag: "once" },
        fireAt: "2026-10-21T08:00:00.000Z"
      }, NOW)
    )

  it("expires a pending dispatch and advances fireAt past the silence", async () => {
    const h = makeHarness()
    const reminder = await makeOnce(h)
    const dispatchId = h.insertDispatch({
      reminderId: reminder.id,
      scheduledFor: "2026-10-21T08:00:00.000Z"
    })

    const silenced = await h.svc((svc) =>
      svc.update(viewer(), {
        id: reminder.id,
        clientMutationId: "silence",
        patch: { silencedUntil: "2026-10-25T00:00:00.000Z" }
      }, NOW)
    )

    expect(silenced.silencedUntil).toBe("2026-10-25T00:00:00.000Z")
    expect(silenced.fireAt).toBe("2026-10-25T00:00:00.000Z")
    expect(h.dispatchRow(dispatchId)).toMatchObject({ push_outcome: "expired", response: null })
  })

  it("keeps a fire that already sits after the silence", async () => {
    const h = makeHarness()
    const reminder = await makeOnce(h)
    const silenced = await h.svc((svc) =>
      svc.update(viewer(), {
        id: reminder.id,
        clientMutationId: "short-silence",
        patch: { silencedUntil: "2026-10-20T12:00:00.000Z" }
      }, NOW)
    )
    // The silence ended before the 08:00 fire, so the schedule is untouched.
    expect(silenced.fireAt).toBe("2026-10-21T08:00:00.000Z")
  })

  it("expires owed rows when the reminder is deleted", async () => {
    const h = makeHarness()
    const reminder = await makeOnce(h)
    const dispatchId = h.insertDispatch({
      reminderId: reminder.id,
      scheduledFor: "2026-10-21T08:00:00.000Z"
    })

    const deleted = await h.svc((svc) =>
      svc.delete(viewer(), { id: reminder.id, clientMutationId: "delete" }, NOW)
    )

    expect(deleted.deletedAt).toBe(NOW)
    expect(h.dispatchRow(dispatchId)).toMatchObject({ push_outcome: "expired" })
    // One tombstone feed row (create + delete = 2).
    expect(h.feedCount()).toBe(2)
  })
})

describe("ReminderService — responses", () => {
  const makeLinkedReminder = async (h: ReturnType<typeof makeHarness>) => {
    const taskId = h.insertTask({ dueAt: "2026-10-21T12:00:00.000Z" })
    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "linked",
        title: "زنگ کار",
        kind: "chore",
        repeat: { _tag: "once" },
        offsetMinutes: 30,
        link: { _tag: "task", taskId: taskId as never }
      }, NOW)
    )
    return { taskId, reminder }
  }

  it("Done completes a linked task once, in the response batch", async () => {
    const h = makeHarness()
    const { taskId, reminder } = await makeLinkedReminder(h)
    const dispatchId = h.insertDispatch({
      reminderId: reminder.id,
      scheduledFor: "2026-10-21T11:30:00.000Z"
    })

    const result = await h.svc((svc) =>
      svc.respond(viewer(), {
        dispatchId: dispatchId as never,
        response: "done"
      }, "2026-10-20T10:00:00.000Z")
    )

    expect(result.dispatch.response).toBe("done")
    expect(result.dispatch.respondedAt).toBe("2026-10-20T10:00:00.000Z")
    expect(result.child).toBeNull()
    expect(result.onTime).toBe(true)
    expect(h.taskRow(taskId)).toMatchObject({
      status: "done",
      completed_at: "2026-10-20T10:00:00.000Z",
      version: 2
    })
    expect(h.feedCount()).toBe(2) // reminder create + task completion

    // A double tap is a no-op: the same answer, no second task version bump.
    const again = await h.svc((svc) =>
      svc.respond(viewer(), { dispatchId: dispatchId as never, response: "done" }, "2026-10-20T10:05:00.000Z")
    )
    expect(again.dispatch.respondedAt).toBe("2026-10-20T10:00:00.000Z")
    expect(h.taskRow(taskId)).toMatchObject({ version: 2 })
    expect(h.feedCount()).toBe(2)
  })

  it("Snooze writes exactly one child for this occurrence and leaves fireAt alone", async () => {
    const h = makeHarness()
    const { reminder } = await makeLinkedReminder(h)
    const dispatchId = h.insertDispatch({
      reminderId: reminder.id,
      scheduledFor: "2026-10-21T11:30:00.000Z"
    })

    const result = await h.svc((svc) =>
      svc.respond(viewer(), {
        dispatchId: dispatchId as never,
        response: "snooze",
        snoozeMinutes: 10
      }, "2026-10-20T10:00:00.000Z")
    )

    expect(result.dispatch.response).toBe("snooze")
    expect(result.dispatch.snoozedUntil).toBe("2026-10-20T10:10:00.000Z")
    expect(result.child).not.toBeNull()
    expect(result.child).toMatchObject({
      scheduledFor: "2026-10-20T10:10:00.000Z",
      deliverAt: "2026-10-20T10:10:00.000Z",
      rootScheduledFor: "2026-10-21T11:30:00.000Z",
      origin: `snooze:${dispatchId}`,
      parentDispatchId: dispatchId,
      response: null
    })
    expect(
      (h.db.prepare("SELECT COUNT(*) AS n FROM reminder_dispatches").get() as { readonly n: number })
        .n
    ).toBe(2)
    expect(h.reminderRow(reminder.id)).toMatchObject({
      fire_at: "2026-10-21T11:30:00.000Z"
    })

    // A second tap does not queue a second re-fire.
    const again = await h.svc((svc) =>
      svc.respond(viewer(), {
        dispatchId: dispatchId as never,
        response: "snooze",
        snoozeMinutes: 10
      }, "2026-10-20T10:00:05.000Z")
    )
    expect(again.child).toBeNull()
    expect(
      (h.db.prepare("SELECT COUNT(*) AS n FROM reminder_dispatches").get() as { readonly n: number })
        .n
    ).toBe(2)
  })

  it("rejects a snooze outside the fixed presets", async () => {
    const h = makeHarness()
    const { reminder } = await makeLinkedReminder(h)
    const dispatchId = h.insertDispatch({
      reminderId: reminder.id,
      scheduledFor: "2026-10-21T11:30:00.000Z"
    })
    await expect(
      h.svc((svc) =>
        svc.respond(viewer(), {
          dispatchId: dispatchId as never,
          response: "snooze",
          snoozeMinutes: 7
        }, NOW)
      )
    ).rejects.toMatchObject({ _tag: "ReminderValidationError" })
    expect(h.dispatchRow(dispatchId)).toMatchObject({ response: null })
  })

  it("Dismiss is log-only and never on time", async () => {
    const h = makeHarness()
    const { taskId, reminder } = await makeLinkedReminder(h)
    const dispatchId = h.insertDispatch({
      reminderId: reminder.id,
      scheduledFor: "2026-10-21T11:30:00.000Z"
    })
    const result = await h.svc((svc) =>
      svc.respond(viewer(), {
        dispatchId: dispatchId as never,
        response: "dismiss"
      }, "2026-10-20T10:00:00.000Z")
    )
    expect(result.dispatch.response).toBe("dismiss")
    expect(result.onTime).toBe(false)
    expect(h.taskRow(taskId)).toMatchObject({ status: "todo" })
  })

  it("cannot answer another member's dispatch", async () => {
    const h = makeHarness()
    const { reminder } = await makeLinkedReminder(h)
    const dispatchId = h.insertDispatch({
      reminderId: reminder.id,
      scheduledFor: "2026-10-21T11:30:00.000Z",
      userId: USER_B
    })
    await expect(
      h.svc((svc) =>
        svc.respond(viewer(), { dispatchId: dispatchId as never, response: "done" }, NOW)
      )
    ).rejects.toMatchObject({ _tag: "ReminderDispatchNotFound" })
  })

  it("Done on a recurring linked task spawns the #38 successor in the same batch", async () => {
    const h = makeHarness()
    const taskId = h.insertTask({
      dueAt: "2026-10-21T12:00:00.000Z",
      recurrence: JSON.stringify({
        frequency: "daily",
        interval: 1,
        end: { _tag: "never" }
      }),
      recurrenceMode: "onCompletion"
    })
    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "linked-recurring",
        title: "زنگ کار",
        kind: "chore",
        repeat: { _tag: "once" },
        offsetMinutes: 30,
        link: { _tag: "task", taskId: taskId as never }
      }, NOW)
    )
    const dispatchId = h.insertDispatch({
      reminderId: reminder.id,
      scheduledFor: "2026-10-21T11:30:00.000Z"
    })

    await h.svc((svc) =>
      svc.respond(viewer(), { dispatchId: dispatchId as never, response: "done" }, NOW)
    )

    expect(h.taskRow(taskId)).toMatchObject({ status: "done", version: 2 })
    const successors = h.db
      .prepare("SELECT * FROM tasks WHERE recurrence_parent_id = ?")
      .all(taskId) as ReadonlyArray<Record<string, unknown>>
    expect(successors).toHaveLength(1)
    expect(successors[0]).toMatchObject({ status: "todo", version: 1 })
  })
})

describe("ReminderService — missed inbox", () => {
  it("returns unanswered rows under 24 h and rolls older ones to history", async () => {
    const h = makeHarness()
    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "inbox",
        title: "دارو",
        kind: "medication",
        repeat: { _tag: "once" },
        fireAt: "2026-10-20T08:00:00.000Z"
      }, NOW)
    )
    const recent = h.insertDispatch({
      reminderId: reminder.id,
      scheduledFor: "2026-10-20T08:00:00.000Z"
    })
    const old = h.insertDispatch({
      reminderId: reminder.id,
      scheduledFor: "2026-10-18T08:00:00.000Z"
    })
    const answered = h.insertDispatch({
      reminderId: reminder.id,
      scheduledFor: "2026-10-20T08:30:00.000Z",
      response: "done",
      respondedAt: "2026-10-20T08:35:00.000Z"
    })

    const inbox = await h.svc((svc) => svc.inbox(viewer(), undefined, "2026-10-20T10:00:00.000Z"))
    expect(inbox.map((item) => item.dispatch.id)).toEqual([recent])
    expect(inbox[0]).toMatchObject({ title: "دارو", kind: "medication", tier: "critical", state: "inbox" })

    const history = await h.svc((svc) =>
      svc.inbox(viewer(), { history: true }, "2026-10-20T10:00:00.000Z")
    )
    expect(history.map((item) => item.dispatch.id).sort()).toEqual([old, answered].sort())
    expect(history.every((item) => item.state === "history")).toBe(true)
  })

  it("scopes the inbox to the viewer", async () => {
    const h = makeHarness()
    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "inbox-scope",
        title: "یادآور",
        kind: "general",
        repeat: { _tag: "once" },
        fireAt: "2026-10-20T08:00:00.000Z"
      }, NOW)
    )
    h.insertDispatch({ reminderId: reminder.id, scheduledFor: "2026-10-20T08:00:00.000Z" })
    const other = await h.svc((svc) =>
      svc.inbox(viewer({ userId: USER_B }), undefined, "2026-10-20T10:00:00.000Z")
    )
    expect(other).toEqual([])
  })
})

describe("ReminderService — list and visibility", () => {
  it("lists shared reminders but hides another member's private one", async () => {
    const h = makeHarness()
    await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "shared",
        title: "مشترک",
        kind: "general",
        repeat: { _tag: "once" },
        fireAt: "2026-10-21T08:00:00.000Z",
        visibility: "shared"
      }, NOW)
    )
    const privateId = uuidV7() as ReminderId
    await h.svc((svc) =>
      svc.create(viewer({ userId: USER_B }), {
        id: privateId,
        clientMutationId: "private",
        title: "خصوصی",
        kind: "general",
        repeat: { _tag: "once" },
        fireAt: "2026-10-21T09:00:00.000Z",
        visibility: "private"
      }, NOW)
    )

    const mine = await h.svc((svc) => svc.list(viewer()))
    expect(mine.map((reminder) => reminder.title)).toEqual(["مشترک"])
  })

  it("refuses a link to another household's task", async () => {
    const h = makeHarness()
    h.db.prepare(
      `INSERT INTO households (id, name, invite_code, created_by, created_at)
       VALUES ('household-b', 'دیگر', 'other', ?, ?)`
    ).run(USER_B, NOW)
    const foreignTask = uuidV7()
    h.db.prepare(
      `INSERT INTO tasks
        (id, type, title, owner_id, household_id, visibility, status, priority,
         due_at, time_zone, tag_ids, created_at, updated_at, version)
       VALUES (?, 'task', 'دیگر', ?, 'household-b', 'shared', 'todo', 'medium',
               '2026-10-21T12:00:00.000Z', ?, '[]', ?, ?, 1)`
    ).run(foreignTask, USER_B, TZ, NOW, NOW)

    await expect(
      h.svc((svc) =>
        svc.create(viewer(), {
          clientMutationId: "foreign",
          title: "یادآور",
          kind: "general",
          repeat: { _tag: "once" },
          link: { _tag: "task", taskId: foreignTask as never }
        }, NOW)
      )
    ).rejects.toMatchObject({ _tag: "ReminderForbidden" })
  })

  it("links an occasion with an explicit fire time and refuses a private one", async () => {
    const h = makeHarness()
    const shared = h.insertOccasion({})

    const created = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "occasion-link",
        title: "یادآور تولد",
        kind: "general",
        repeat: { _tag: "once" },
        fireAt: "2026-03-25T05:30:00.000Z",
        link: { _tag: "occasion", occasionId: shared as never }
      }, NOW)
    )
    expect(created.link).toEqual({ _tag: "occasion", occasionId: shared })
    expect(h.reminderRow(created.id)).toMatchObject({
      link_type: "occasion",
      link_id: shared
    })

    // An occasion's advance instant is a projection, so a one-off link must
    // carry its own fire time rather than defaulting to "now".
    await expect(
      h.svc((svc) =>
        svc.create(viewer(), {
          clientMutationId: "occasion-no-fire",
          title: "یادآور",
          kind: "general",
          repeat: { _tag: "once" },
          link: { _tag: "occasion", occasionId: shared as never }
        }, NOW)
      )
    ).rejects.toMatchObject({ _tag: "ReminderValidationError" })

    // Another member's private occasion is not linkable.
    const privateOccasion = h.insertOccasion({ ownerId: USER_B, visibility: "private" })
    await expect(
      h.svc((svc) =>
        svc.create(viewer(), {
          clientMutationId: "occasion-private",
          title: "یادآور",
          kind: "general",
          repeat: { _tag: "once" },
          fireAt: "2026-03-25T05:30:00.000Z",
          link: { _tag: "occasion", occasionId: privateOccasion as never }
        }, NOW)
      )
    ).rejects.toMatchObject({ _tag: "ReminderForbidden" })
  })
})

describe("ReminderService — claim (the #61 sweep seam)", () => {
  it("holds a normal quiet-hours fire and advances the series", async () => {
    const h = makeHarness()
    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "quiet",
        title: "یادآور",
        kind: "general",
        repeat: { _tag: "daily", time: "23:30" }
      }, NOW)
    )
    expect(reminder.fireAt).toBe("2026-10-20T20:00:00.000Z") // 23:30 Tehran

    const claimed = await h.svc((svc) =>
      svc.claim({
        reminderId: reminder.id,
        scheduledFor: reminder.fireAt,
        ownerTimeZone: TZ,
        now: reminder.fireAt
      })
    )
    expect(claimed._tag).toBe("Some")
    if (claimed._tag !== "Some") return
    expect(claimed.value).toMatchObject({
      scheduledFor: "2026-10-20T20:00:00.000Z",
      deliverAt: "2026-10-21T03:30:00.000Z", // 07:00 Tehran
      rootScheduledFor: "2026-10-20T20:00:00.000Z",
      origin: "schedule",
      pushOutcome: "pending",
      response: null
    })
    // The series moved to tomorrow's 23:30.
    expect(h.reminderRow(reminder.id)).toMatchObject({
      fire_at: "2026-10-21T20:00:00.000Z"
    })
  })

  it("delivers a critical medication fire during quiet hours", async () => {
    const h = makeHarness()
    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "med-quiet",
        title: "دارو",
        kind: "medication",
        repeat: { _tag: "daily", time: "23:30" }
      }, NOW)
    )
    const claimed = await h.svc((svc) =>
      svc.claim({
        reminderId: reminder.id,
        scheduledFor: reminder.fireAt,
        ownerTimeZone: TZ,
        now: reminder.fireAt
      })
    )
    expect(claimed._tag).toBe("Some")
    if (claimed._tag !== "Some") return
    expect(claimed.value.deliverAt).toBe("2026-10-20T20:00:00.000Z")
  })

  it("suppresses a silenced fire into the series advance, with no ledger row", async () => {
    const h = makeHarness()
    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "silenced",
        title: "یادآور",
        kind: "general",
        repeat: { _tag: "once" },
        fireAt: "2026-10-20T20:00:00.000Z"
      }, NOW)
    )
    const silenced = await h.svc((svc) =>
      svc.update(viewer(), {
        id: reminder.id,
        clientMutationId: "silence",
        patch: { silencedUntil: "2026-10-25T00:00:00.000Z" }
      }, NOW)
    )
    // A silence written through sync does not advance fireAt (the registry
    // only expires owed rows), so the claim must suppress it. Reproduce that
    // shape by putting the row's next fire back inside the silence.
    h.db.prepare("UPDATE reminders SET fire_at = ? WHERE id = ?")
      .run("2026-10-20T20:00:00.000Z", reminder.id)

    const claimed = await h.svc((svc) =>
      svc.claim({
        reminderId: reminder.id,
        scheduledFor: "2026-10-20T20:00:00.000Z",
        ownerTimeZone: TZ,
        now: NOW
      })
    )
    expect(claimed._tag).toBe("None")
    expect(
      (h.db.prepare("SELECT COUNT(*) AS n FROM reminder_dispatches").get() as { readonly n: number })
        .n
    ).toBe(0)
    expect(h.reminderRow(reminder.id)).toMatchObject({
      fire_at: "2026-10-25T00:00:00.000Z"
    })
  })

  it("claims once only, and the unanswered row is the missed inbox", async () => {
    const h = makeHarness()
    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "once-claim",
        title: "یادآور",
        kind: "general",
        repeat: { _tag: "once" },
        fireAt: "2026-10-20T08:00:00.000Z"
      }, NOW)
    )
    const first = await h.svc((svc) =>
      svc.claim({
        reminderId: reminder.id,
        scheduledFor: reminder.fireAt,
        ownerTimeZone: TZ,
        now: "2026-10-20T08:00:02.000Z"
      })
    )
    expect(first._tag).toBe("Some")

    // An overlapping/second tick for the same fire writes nothing.
    const second = await h.svc((svc) =>
      svc.claim({
        reminderId: reminder.id,
        scheduledFor: reminder.fireAt,
        ownerTimeZone: TZ,
        now: "2026-10-20T08:00:03.000Z"
      })
    )
    expect(second._tag).toBe("None")
    expect(
      (h.db.prepare("SELECT COUNT(*) AS n FROM reminder_dispatches").get() as { readonly n: number })
        .n
    ).toBe(1)

    // Unanswered + past = the inbox, with no second cron/nightly job.
    const inbox = await h.svc((svc) =>
      svc.inbox(viewer(), undefined, "2026-10-20T10:00:00.000Z")
    )
    expect(inbox).toHaveLength(1)
    expect(inbox[0]?.dispatch.id).toBe(
      first._tag === "Some" ? first.value.id : ""
    )
  })

  it("catches up past an outage in one claim, not one stale row per tick", async () => {
    const h = makeHarness()
    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "catch-up",
        title: "یادآور",
        kind: "general",
        repeat: { _tag: "daily", time: "08:00" }
      }, NOW)
    )
    // 08:00 Tehran on 2026-10-21.
    expect(reminder.fireAt).toBe("2026-10-21T04:30:00.000Z")

    const claimed = await h.svc((svc) =>
      svc.claim({
        reminderId: reminder.id,
        scheduledFor: reminder.fireAt,
        ownerTimeZone: TZ,
        now: "2026-10-24T09:30:00.000Z"
      })
    )
    expect(claimed._tag).toBe("Some")
    // The tick is three days late: the series jumps to the first 08:00 after
    // the tick, so the next tick has nothing left to catch up.
    expect(h.reminderRow(reminder.id)).toMatchObject({
      fire_at: "2026-10-25T04:30:00.000Z"
    })
  })

  it("keeps the interval anchor while catching up", async () => {
    const h = makeHarness()
    const reminder = await h.svc((svc) =>
      svc.create(viewer(), {
        clientMutationId: "catch-up-interval",
        title: "دارو",
        kind: "medication",
        repeat: { _tag: "interval", hours: 8 }
      }, NOW)
    )
    expect(reminder.fireAt).toBe("2026-10-20T17:30:00.000Z")

    await h.svc((svc) =>
      svc.claim({
        reminderId: reminder.id,
        scheduledFor: reminder.fireAt,
        ownerTimeZone: TZ,
        now: "2026-10-22T09:30:00.000Z"
      })
    )
    expect(h.reminderRow(reminder.id)).toMatchObject({
      fire_at: "2026-10-22T17:30:00.000Z"
    })
  })
})
