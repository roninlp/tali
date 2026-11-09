import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  type CaptureDraft,
  type HouseholdId,
  ModelUnavailable,
  type UserId,
  localDateIn,
  reminderFireAt
} from "@tali/domain"
import { CaptureService, CaptureServiceLive, type CaptureServiceApi, type CaptureViewer } from "../src/capture-service.js"
import {
  Extractor,
  ExtractorReplay,
  noteDraftFromText
} from "../src/capture-extractor.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * CaptureService (ticket #101; ADR-0012 §5–§6, §9).
 *
 * Runs the real service, repositories and create services against SQLite
 * through the D1-shaped batch. The Extractor is always a replay/custom layer:
 * no test calls a model.
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)

const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort()

const USER_A = "user-a" as UserId
const HOUSEHOLD = "household-a" as HouseholdId
const TZ = "Asia/Tehran"
const NOW = "2026-11-08T09:00:00.000Z"

const viewer: CaptureViewer = {
  userId: USER_A,
  householdId: HOUSEHOLD,
  timeZone: TZ,
  weekStart: "saturday"
}

const FIVE_TEXT =
  "فردا ساعت ۵ دکتر دارم، خرید نان یادم نره، یک ایده‌ی تازه، هر روز پیاده‌روی، و قرص رو ساعت ۸ یادم باشه"

const fiveDrafts: ReadonlyArray<CaptureDraft> = [
  {
    _tag: "task",
    title: "خرید نان",
    dueDate: "2026-11-09",
    recurrence: { frequency: "weekly", interval: 1, byDay: [6], end: { _tag: "never" } },
    recurrenceMode: "onDueDate",
    sourceQuote: "خرید نان",
    missing: []
  },
  {
    _tag: "event",
    title: "نوبت دکتر",
    timing: { _tag: "allDay", date: "2026-11-09" },
    sourceQuote: "فردا ساعت ۵ دکتر دارم",
    missing: []
  },
  {
    _tag: "note",
    title: "ایده‌ی تازه",
    body: "یک ایده‌ی تازه",
    sourceQuote: "یک ایده‌ی تازه",
    missing: []
  },
  {
    _tag: "habit",
    title: "پیاده‌روی",
    frequency: { _tag: "daily" },
    sourceQuote: "هر روز پیاده‌روی",
    missing: []
  },
  {
    _tag: "reminder",
    title: "قرص",
    kind: "medication",
    repeat: { _tag: "daily", time: "08:00" },
    sourceQuote: "قرص رو ساعت ۸ یادم باشه",
    missing: []
  }
]

const makeHarness = (extractor: Layer.Layer<Extractor>) => {
  const db = new DatabaseSync(":memory:")
  for (const file of migrationFiles()) {
    db.exec(readFileSync(fileURLToPath(new URL(file, MIGRATIONS_DIR)), "utf8"))
  }

  const fake = new FakeD1(db)
  const layer = CaptureServiceLive.pipe(
    Layer.provide(extractor),
    Layer.provide(
      D1Client.layer({
        db: fake.asD1Database(),
        transformQueryNames: Str.camelToSnake,
        transformResultNames: Str.snakeToCamel
      })
    )
  )

  const run = <A, E>(effect: Effect.Effect<A, E, CaptureService>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, layer))

  const svc = <A, E>(
    f: (service: CaptureServiceApi) => Effect.Effect<A, E, never>
  ): Promise<A> =>
    run(
      Effect.gen(function*() {
        const service = yield* CaptureService
        return yield* f(service)
      })
    )

  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { readonly n: number }).n

  return { db, fake, run, svc, count }
}

const replayLayer = (text: string, drafts: ReadonlyArray<CaptureDraft>) =>
  ExtractorReplay([{ text, drafts }])

const failLayer = Layer.succeed(Extractor, {
  dissect: () =>
    Effect.fail(new ModelUnavailable({ message: "gateway unavailable" }))
})

describe("CaptureService.dissect", () => {
  it("stores the text and drafts, and writes no aggregate row, feed entry or version", async () => {
    const h = makeHarness(replayLayer(FIVE_TEXT, fiveDrafts))

    const capture = await h.svc((svc) => svc.dissect(viewer, { text: FIVE_TEXT }, NOW))

    expect(capture.status).toBe("parsed")
    expect(capture.drafts).toHaveLength(5)
    expect(capture.createdIds).toEqual([])

    // The Capture row is the server's record; nothing else was written.
    expect(h.count("capture")).toBe(1)
    for (const table of ["tasks", "events", "notes", "habits", "reminders"]) {
      expect(h.count(table)).toBe(0)
    }
    expect(h.count("change_feed")).toBe(0)
    expect(h.count("applied_mutations")).toBe(0)
  })

  it("marks a model failure failed and keeps the text", async () => {
    const h = makeHarness(failLayer)

    const capture = await h.svc((svc) => svc.dissect(viewer, { text: FIVE_TEXT }, NOW))

    expect(capture.status).toBe("failed")
    expect(capture.error).toContain("gateway unavailable")
    const row = h.db
      .prepare("SELECT status, text FROM capture WHERE id = ?")
      .get(capture.id) as { readonly status: string; readonly text: string }
    expect(row.status).toBe("failed")
    expect(row.text).toBe(FIVE_TEXT)
  })

  it("returns the existing capture for identical text inside 60 seconds", async () => {
    const h = makeHarness(replayLayer(FIVE_TEXT, fiveDrafts))

    const first = await h.svc((svc) => svc.dissect(viewer, { text: FIVE_TEXT }, NOW))
    const second = await h.svc((svc) => svc.dissect(viewer, { text: FIVE_TEXT }, NOW))

    expect(second.id).toBe(first.id)
    expect(h.count("capture")).toBe(1)
  })

  it("rejects empty and over-long text before writing", async () => {
    const h = makeHarness(replayLayer(FIVE_TEXT, fiveDrafts))

    const empty = await h.svc((svc) =>
      Effect.flip(svc.dissect(viewer, { text: "   " }, NOW))
    )
    expect(empty._tag).toBe("CaptureEmpty")

    const tooLong = await h.svc((svc) =>
      Effect.flip(svc.dissect(viewer, { text: "x".repeat(4001) }, NOW))
    )
    expect(tooLong._tag).toBe("CaptureTooLong")
    expect(h.count("capture")).toBe(0)
  })

  it("rate-limits the 21st distinct run in the hour", async () => {
    const h = makeHarness(
      Layer.succeed(Extractor, {
        dissect: () => Effect.succeed([noteDraftFromText("یادداشت")])
      })
    )

    for (let index = 0; index < 20; index += 1) {
      const capture = await h.svc((svc) =>
        svc.dissect(viewer, { text: `متن شماره ${index}` }, NOW)
      )
      expect(capture.status).toBe("parsed")
    }

    const limited = await h.svc((svc) =>
      Effect.flip(svc.dissect(viewer, { text: "متن بیست‌ویکم" }, NOW))
    )
    expect(limited._tag).toBe("CaptureRateLimited")
    expect(h.count("capture")).toBe(20)
  })
})

describe("CaptureService.commit", () => {
  it("commits five drafts with the services' defaults and rules", async () => {
    const h = makeHarness(replayLayer(FIVE_TEXT, fiveDrafts))
    const capture = await h.svc((svc) => svc.dissect(viewer, { text: FIVE_TEXT }, NOW))

    const result = await h.svc((svc) =>
      svc.commit(viewer, { captureId: capture.id, drafts: capture.drafts }, NOW)
    )

    expect(result.failure).toBeNull()
    expect(result.remaining).toBe(0)
    expect(result.capture.status).toBe("committed")
    expect(result.created).toHaveLength(5)
    expect(result.created.map((row) => row.type)).toEqual([
      "task",
      "event",
      "note",
      "habit",
      "reminder"
    ])

    const task = h.db.prepare("SELECT * FROM tasks").get() as Record<string, unknown>
    expect(task.visibility).toBe("shared")
    expect(task.status).toBe("todo")
    expect(JSON.parse(task.recurrence as string)).toEqual({
      frequency: "weekly",
      interval: 1,
      byDay: [6],
      end: { _tag: "never" }
    })

    const event = h.db.prepare("SELECT * FROM events").get() as Record<string, unknown>
    expect(event.visibility).toBe("shared")

    const note = h.db.prepare("SELECT * FROM notes").get() as Record<string, unknown>
    expect(note.visibility).toBe("private")

    const habit = h.db.prepare("SELECT * FROM habits").get() as Record<string, unknown>
    expect(habit.visibility).toBe("private")
    expect(habit.started_on).toBe(localDateIn(NOW, TZ))

    const reminder = h.db.prepare("SELECT * FROM reminders").get() as Record<string, unknown>
    expect(reminder.visibility).toBe("private")
    expect(reminder.tier).toBe("critical")
    expect(reminder.fire_at).toBe(
      reminderFireAt({
        repeat: { _tag: "daily", time: "08:00" },
        timeZone: TZ,
        now: NOW
      })
    )
  })

  it("blocks while a visible card has an unanswered Needs Input", async () => {
    const h = makeHarness(replayLayer(FIVE_TEXT, fiveDrafts))
    const capture = await h.svc((svc) => svc.dissect(viewer, { text: FIVE_TEXT }, NOW))
    const blocked: CaptureDraft = {
      ...fiveDrafts[1]!,
      timing: undefined,
      missing: [
        { field: "timing", shape: "localDate", question: "این رویداد چه روزی است؟" }
      ]
    }

    const error = await h.svc((svc) =>
      Effect.flip(
        svc.commit(
          viewer,
          { captureId: capture.id, drafts: [fiveDrafts[0]!, blocked] },
          NOW
        )
      )
    )

    expect(error._tag).toBe("DraftIncomplete")
    expect(h.count("tasks")).toBe(0)
    expect(h.count("events")).toBe(0)
  })

  it("validates every draft before writing any row", async () => {
    const h = makeHarness(replayLayer(FIVE_TEXT, fiveDrafts))
    const capture = await h.svc((svc) => svc.dissect(viewer, { text: FIVE_TEXT }, NOW))
    const malformed = {
      ...fiveDrafts[0]!,
      dueDate: "2026/11/09"
    } as unknown as CaptureDraft

    const error = await h.svc((svc) =>
      Effect.flip(
        svc.commit(
          viewer,
          { captureId: capture.id, drafts: [fiveDrafts[1]!, malformed] },
          NOW
        )
      )
    )

    expect(error._tag).toBe("InvalidDraft")
    expect(h.count("tasks")).toBe(0)
    expect(h.count("events")).toBe(0)
  })

  it("is idempotent: a second commit creates no duplicate rows", async () => {
    const h = makeHarness(replayLayer(FIVE_TEXT, fiveDrafts))
    const capture = await h.svc((svc) => svc.dissect(viewer, { text: FIVE_TEXT }, NOW))

    const first = await h.svc((svc) =>
      svc.commit(viewer, { captureId: capture.id, drafts: capture.drafts }, NOW)
    )
    const second = await h.svc((svc) =>
      svc.commit(viewer, { captureId: capture.id, drafts: capture.drafts }, NOW)
    )

    expect(second.created.map((row) => row.id)).toEqual(first.created.map((row) => row.id))
    expect(h.count("tasks")).toBe(1)
    expect(h.count("events")).toBe(1)
    expect(h.count("notes")).toBe(1)
    expect(h.count("habits")).toBe(1)
    expect(h.count("reminders")).toBe(1)
  })

  it("reports a mid-way failure and replays the earlier rows on retry", async () => {
    const h = makeHarness(replayLayer(FIVE_TEXT, fiveDrafts))
    const capture = await h.svc((svc) => svc.dissect(viewer, { text: FIVE_TEXT }, NOW))

    const drafts: ReadonlyArray<CaptureDraft> = [
      { _tag: "task", title: "اول", sourceQuote: "خرید نان", missing: [] },
      { _tag: "task", title: "دوم", sourceQuote: "خرید نان", missing: [] },
      {
        _tag: "task",
        title: "سوم",
        dueAt: "2026-11-09T13:30:00.000Z",
        dueDate: "2026-11-09",
        sourceQuote: "خرید نان",
        missing: []
      },
      { _tag: "note", title: "چهارم", body: "متن", sourceQuote: "یک ایده‌ی تازه", missing: [] }
    ]

    const partial = await h.svc((svc) =>
      svc.commit(viewer, { captureId: capture.id, drafts }, NOW)
    )
    expect(partial.failure).toMatchObject({ draftIndex: 2 })
    expect(partial.remaining).toBe(2)
    expect(partial.created).toHaveLength(2)
    expect(partial.capture.status).toBe("parsed")
    expect(h.count("tasks")).toBe(2)
    expect(h.count("notes")).toBe(0)

    const repaired: ReadonlyArray<CaptureDraft> = [
      drafts[0]!,
      drafts[1]!,
      { _tag: "task", title: "سوم", dueDate: "2026-11-09", sourceQuote: "خرید نان", missing: [] },
      drafts[3]!
    ]
    const retried = await h.svc((svc) =>
      svc.commit(viewer, { captureId: capture.id, drafts: repaired }, NOW)
    )

    expect(retried.failure).toBeNull()
    expect(retried.capture.status).toBe("committed")
    expect(retried.created).toHaveLength(4)
    // The two earlier rows were replayed, not duplicated.
    expect(h.count("tasks")).toBe(3)
    expect(h.count("notes")).toBe(1)
  })

  it("refuses another owner's capture", async () => {
    const h = makeHarness(replayLayer(FIVE_TEXT, fiveDrafts))
    const capture = await h.svc((svc) => svc.dissect(viewer, { text: FIVE_TEXT }, NOW))

    const error = await h.svc((svc) =>
      Effect.flip(
        svc.commit(
          { ...viewer, userId: "user-b" as UserId },
          { captureId: capture.id, drafts: capture.drafts },
          NOW
        )
      )
    )
    expect(error._tag).toBe("CaptureNotFound")
  })
})

describe("CaptureService.list", () => {
  it("lists only the owner's captures, newest first", async () => {
    const h = makeHarness(replayLayer(FIVE_TEXT, fiveDrafts))
    await h.svc((svc) => svc.dissect(viewer, { text: FIVE_TEXT }, NOW))
    await h.svc((svc) =>
      svc.dissect(
        { ...viewer, userId: "user-b" as UserId },
        { text: FIVE_TEXT },
        NOW
      )
    )

    const rows = await h.svc((svc) => svc.list(viewer, {}))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.ownerId).toBe(USER_A)
  })
})

describe("CaptureService.remove", () => {
  it("drops the owner's history row", async () => {
    const h = makeHarness(replayLayer(FIVE_TEXT, fiveDrafts))
    const capture = await h.svc((svc) => svc.dissect(viewer, { text: FIVE_TEXT }, NOW))

    const removed = await h.svc((svc) =>
      svc.remove(viewer, { captureId: capture.id })
    )

    expect(removed.id).toBe(capture.id)
    expect(h.count("capture")).toBe(0)
    expect(await h.svc((svc) => svc.list(viewer, {}))).toEqual([])
  })

  it("refuses another owner's capture and keeps it", async () => {
    const h = makeHarness(replayLayer(FIVE_TEXT, fiveDrafts))
    const capture = await h.svc((svc) => svc.dissect(viewer, { text: FIVE_TEXT }, NOW))

    const error = await h.svc((svc) =>
      Effect.flip(
        svc.remove(
          { ...viewer, userId: "user-b" as UserId },
          { captureId: capture.id }
        )
      )
    )

    expect(error._tag).toBe("CaptureNotFound")
    expect(h.count("capture")).toBe(1)
  })
})
