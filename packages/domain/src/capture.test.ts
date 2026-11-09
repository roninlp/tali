import { Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  CaptureDraft,
  DraftIncomplete,
  InvalidDraft,
  captureDedupeKey,
  normalizeCaptureDraftInput,
  normalizeCaptureInstant,
  normalizeCaptureText,
  toCreateInput
} from "./capture.js"

/**
 * Capture domain (ADR-0012; ticket #101).
 *
 * These pin the draft union, the silent defaults, the "never invent" rule and
 * the one draft → real create input conversion. The service and RPC tests build
 * on these; the extractor tests exercise the model-facing normalization.
 */

const context = {
  draftIndex: 0,
  clientMutationId: "m-capture-0",
  timeZone: "Asia/Tehran"
} as const

const taskDraft = (overrides: Record<string, unknown> = {}) => ({
  _tag: "task",
  title: "خرید نان",
  sourceQuote: "خرید نان",
  missing: [],
  ...overrides
})

const decodeTask = (value: Record<string, unknown>) =>
  Schema.decodeUnknownSync(CaptureDraft)(value)

const run = <A, E>(effect: Effect.Effect<A, E>): Result.Result<A, E> =>
  Effect.runSync(
    Effect.match(effect, {
      onFailure: (error) => Result.fail(error),
      onSuccess: (value) => Result.succeed(value)
    })
  )

describe("CaptureDraft", () => {
  it("validates all five variants with a source quote", () => {
    const drafts = [
      taskDraft(),
      {
        _tag: "event",
        title: "دکتر",
        timing: { _tag: "allDay", date: "2026-11-09" },
        sourceQuote: "فردا دکتر",
        missing: []
      },
      {
        _tag: "note",
        title: "ایده",
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
        sourceQuote: "قرص رو یادم باشه",
        missing: []
      }
    ]

    for (const draft of drafts) {
      expect(Schema.decodeUnknownSync(CaptureDraft)(draft)).toMatchObject({
        sourceQuote: draft.sourceQuote,
        missing: []
      })
    }
  })

  it("requires a verbatim source quote", () => {
    expect(() =>
      Schema.decodeUnknownSync(CaptureDraft)(taskDraft({ sourceQuote: "" }))
    ).toThrow()
  })

  it("carries typed Needs Input entries", () => {
    const decoded = Schema.decodeUnknownSync(CaptureDraft)({
      _tag: "event",
      title: "مهمانی",
      sourceQuote: "پنجشنبه مهمونی ساراست",
      missing: [
        {
          field: "timing",
          shape: "localDate",
          question: "مهمانی چه روزی است؟"
        }
      ]
    })
    expect(decoded.missing).toEqual([
      {
        field: "timing",
        shape: "localDate",
        question: "مهمانی چه روزی است؟"
      }
    ])
  })

  it("accepts a free-form Needs Input field name (old rows stay readable)", () => {
    const decoded = Schema.decodeUnknownSync(CaptureDraft)({
      _tag: "event",
      title: "مصاحبه",
      sourceQuote: "ساعت ۷ مصاحبه دارم",
      missing: [
        {
          field: "endTime",
          shape: "clockTime",
          question: "تا چه ساعتی؟"
        }
      ]
    })
    expect(decoded.missing[0]?.field).toBe("endTime")
  })
})

describe("normalizeCaptureText", () => {
  it("trims and normalizes line endings without rewriting wording", () => {
    expect(normalizeCaptureText("  یک خط\r\nخط دوم  ")).toBe("یک خط\nخط دوم")
  })

  it("dedupes across Persian spelling variants", () => {
    expect(captureDedupeKey("می‌روم")).toBe(captureDedupeKey("میروم"))
  })
})

describe("normalizeCaptureDraftInput", () => {
  it("turns Persian digits and an ISO offset into validated ASCII/UTC values", () => {
    const normalized = normalizeCaptureDraftInput({
      dueAt: "۲۰۲۶-۱۱-۰۹T۱۷:۰۰:۰۰+03:30",
      reminderTime: "۰۸:۳۰",
      repeat: { _tag: "weekly", days: ["۵"], time: "۱۰:۰۰" },
      offsetMinutes: "۳۰",
      title: "قرص ۸ صبح"
    })

    expect(normalized.dueAt).toBe("2026-11-09T13:30:00.000Z")
    expect(normalized.reminderTime).toBe("08:30")
    expect(normalized.repeat).toEqual({ _tag: "weekly", days: [5], time: "10:00" })
    expect(normalized.offsetMinutes).toBe(30)
    // The user's own wording is never rewritten.
    expect(normalized.title).toBe("قرص ۸ صبح")
  })

  it("normalizes an already-UTC instant idempotently", () => {
    expect(normalizeCaptureInstant("2026-11-09T13:30:00.000Z"))
      .toBe("2026-11-09T13:30:00.000Z")
  })

  it("folds the model's Needs Input field aliases into canonical names", () => {
    const normalized = normalizeCaptureDraftInput({
      title: "مصاحبه",
      sourceQuote: "ساعت ۷ مصاحبه دارم",
      missing: [
        { field: "startTime", shape: "clockTime", question: "از چه ساعتی؟" },
        { field: "endTime", shape: "clockTime", question: "تا چه ساعتی؟" },
        { field: "repeat", shape: "repeat", question: "چند وقت یک‌بار؟" }
      ]
    })
    expect(normalized.missing).toEqual([
      { field: "timing.start", shape: "clockTime", question: "از چه ساعتی؟" },
      { field: "timing.end", shape: "clockTime", question: "تا چه ساعتی؟" },
      { field: "repeat", shape: "repeat", question: "چند وقت یک‌بار؟" }
    ])
  })
})

describe("toCreateInput", () => {
  it("fills the task's silent defaults and normalizes its due instant", () => {
    const draft = decodeTask(
      taskDraft({ dueAt: "2026-11-09T17:00:00+03:30" })
    )

    const result = run(toCreateInput(draft, context))
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success._tag).toBe("task")
      if (result.success._tag === "task") {
        expect(result.success.input).toMatchObject({
          clientMutationId: "m-capture-0",
          title: "خرید نان",
          status: "todo",
          timeZone: "Asia/Tehran",
          dueAt: "2026-11-09T13:30:00.000Z"
        })
      }
    }
  })

  it("refuses an event without a timing instead of inventing a date", () => {
    const draft = Schema.decodeUnknownSync(CaptureDraft)({
      _tag: "event",
      title: "دکتر",
      sourceQuote: "دکتر",
      missing: []
    })

    const result = run(toCreateInput(draft, context))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(DraftIncomplete)
      expect(result.failure).toMatchObject({ draftIndex: 0, fields: ["timing"] })
    }
  })

  it("defaults a habit with no stated rhythm to daily", () => {
    const draft = Schema.decodeUnknownSync(CaptureDraft)({
      _tag: "habit",
      title: "کتاب",
      sourceQuote: "هر روز کتاب بخونم",
      missing: []
    })

    const result = run(toCreateInput(draft, context))
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result) && result.success._tag === "habit") {
      expect(result.success.input.frequency).toEqual({ _tag: "daily" })
    }
  })

  it("defaults a reminder's kind to general but still asks for its repeat", () => {
    const draft = Schema.decodeUnknownSync(CaptureDraft)({
      _tag: "reminder",
      title: "زنگ",
      sourceQuote: "زنگ",
      missing: []
    })

    const result = run(toCreateInput(draft, context))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ fields: ["repeat"] })
    }

    const withRepeat = Schema.decodeUnknownSync(CaptureDraft)({
      _tag: "reminder",
      title: "زنگ",
      repeat: { _tag: "daily", time: "08:00" },
      sourceQuote: "هر روز ساعت ۸",
      missing: []
    })
    const ok = run(toCreateInput(withRepeat, context))
    expect(Result.isSuccess(ok)).toBe(true)
    if (Result.isSuccess(ok) && ok.success._tag === "reminder") {
      expect(ok.success.input.kind).toBe("general")
    }
  })

  it("asks for a fire time on a one-off reminder", () => {
    const draft = Schema.decodeUnknownSync(CaptureDraft)({
      _tag: "reminder",
      title: "زنگ",
      repeat: { _tag: "once" },
      sourceQuote: "زنگ",
      missing: []
    })
    const result = run(toCreateInput(draft, context))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ fields: ["fireAt"] })
    }
  })

  it("wraps a note's plain text into the minimal ProseMirror document", () => {
    const draft = Schema.decodeUnknownSync(CaptureDraft)({
      _tag: "note",
      body: "خط اول\nخط دوم",
      sourceQuote: "خط اول\nخط دوم",
      missing: []
    })

    const result = run(toCreateInput(draft, context))
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result) && result.success._tag === "note") {
      expect(result.success.input.title).toBe("خط اول")
      expect(result.success.input.plainText).toBe("خط اول\nخط دوم")
      expect(result.success.input.body).toEqual({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "خط اول" }] },
          { type: "paragraph", content: [{ type: "text", text: "خط دوم" }] }
        ]
      })
    }
  })

  it("names the field when a draft fails the real create schema", () => {
    // The RPC edge validates the draft schema, but the commit still re-runs
    // the real create schema: this is the last line of defence against a
    // malformed reviewed value.
    const draft = {
      _tag: "task",
      title: "خرید نان",
      dueDate: "2026/11/09",
      sourceQuote: "خرید نان",
      missing: []
    } as unknown as CaptureDraft

    const result = run(toCreateInput(draft, context))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InvalidDraft)
      expect(result.failure).toMatchObject({ draftIndex: 0, field: "dueDate" })
    }
  })
})
