import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref } from "effect"
import {
  type CaptureDraft,
  ModelUnavailable,
  type UserId
} from "@tali/domain"
import {
  CAPTURE_MODEL_OPTIONS,
  CaptureConfig,
  DEFAULT_CAPTURE_BASE_URL,
  DEFAULT_CAPTURE_MODEL,
  Extractor,
  ExtractorLive,
  ExtractorReplay,
  captureSystemPrompt,
  ensureCaptureDrafts,
  noteDraftFromText
} from "../src/capture-extractor.js"
import { makeDraftTools } from "../src/capture-tools.js"

/**
 * Extractor + draft tools (ticket #101; ADR-0012 §1–§2, §7–§9).
 *
 * Everything here is offline: the replay layer returns recorded drafts and the
 * live layer is only asked for its missing-key behaviour. The tool tests call
 * the tool execute functions directly, which is the same code TanStack AI runs
 * inside a model run.
 */

const input = {
  userId: "user-a" as UserId,
  text: "فردا ساعت ۵ دکتر دارم و یادم باشه قرص رو بگیرم",
  now: "2026-11-08T09:00:00.000Z",
  timeZone: "Asia/Tehran",
  weekStart: "saturday" as const
}

const taskDraft: CaptureDraft = {
  _tag: "task",
  title: "نوبت دکتر",
  dueAt: "2026-11-09T13:30:00.000Z",
  sourceQuote: "فردا ساعت ۵ دکتر دارم",
  missing: []
}

const reminderDraft: CaptureDraft = {
  _tag: "reminder",
  title: "قرص",
  kind: "medication",
  repeat: { _tag: "daily", time: "08:00" },
  sourceQuote: "یادم باشه قرص رو بگیرم",
  missing: []
}

const replay = (fixtures: ReadonlyArray<{ text: string; drafts: ReadonlyArray<CaptureDraft> }>) =>
  ExtractorReplay(fixtures)

describe("ExtractorReplay", () => {
  it("returns the recorded drafts for a text, folding Persian spellings", async () => {
    const layer = replay([
      { text: "می‌روم", drafts: [taskDraft] },
      { text: "فردا ساعت ۵ دکتر دارم و یادم باشه قرص رو بگیرم", drafts: [taskDraft, reminderDraft] }
    ])

    const drafts = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const extractor = yield* Extractor
          return yield* extractor.dissect(input)
        }),
        layer
      )
    )

    expect(drafts).toHaveLength(2)
    expect(drafts.map((draft) => draft._tag)).toEqual(["task", "reminder"])
  })

  it("fails typed when no recording matches", async () => {
    const layer = replay([])
    const error = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const extractor = yield* Extractor
          return yield* Effect.flip(extractor.dissect(input))
        }),
        layer
      )
    )
    expect(error).toBeInstanceOf(ModelUnavailable)
  })
})

describe("ExtractorLive", () => {
  it("sends thinking off on the Chat Completions wire", () => {
    expect(CAPTURE_MODEL_OPTIONS).toEqual({ reasoning_effort: "none" })
  })

  it("constructs without a key and fails typed at call time", async () => {
    const layer = ExtractorLive.pipe(
      Layer.provide(
        Layer.succeed(CaptureConfig, {
          apiKey: undefined,
          baseUrl: DEFAULT_CAPTURE_BASE_URL,
          model: DEFAULT_CAPTURE_MODEL
        })
      )
    )

    const error = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const extractor = yield* Extractor
          return yield* Effect.flip(extractor.dissect(input))
        }),
        layer
      )
    )

    expect(error).toBeInstanceOf(ModelUnavailable)
    expect((error as ModelUnavailable).message).toContain("OPENCODE_API_KEY")
  })
})

describe("captureSystemPrompt", () => {
  it("carries today's local/Jalali date, the zone and the week start", () => {
    const prompt = captureSystemPrompt(input)
    // 09:00 UTC is 12:30 in Tehran on 2026-11-08 (17 Aban 1405).
    expect(prompt).toContain("2026-11-08")
    expect(prompt).toContain("Asia/Tehran")
    expect(prompt).toContain("شنبه")
    expect(prompt).toContain("آبان")
    expect(prompt).toContain("یک فراخوانی ابزار")
  })
})

describe("draft tools", () => {
  const runTool = async (
    name: string,
    value: Record<string, unknown>,
    text = input.text
  ) => {
    const collector = await Effect.runPromise(Ref.make<ReadonlyArray<CaptureDraft>>([]))
    const tools = makeDraftTools(collector, text)
    const tool = tools.find((candidate) => candidate.def.name === name)
    if (tool === undefined) throw new Error(`missing tool ${name}`)
    const result = await Effect.runPromise(
      Effect.match(
        tool.execute(value as never, {} as never),
        {
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: () => ({ ok: true as const })
        }
      )
    )
    const drafts = await Effect.runPromise(Ref.get(collector))
    return { result, drafts }
  }

  it("appends a valid task and normalizes its offset to UTC", async () => {
    const { result, drafts } = await runTool("draft_task", {
      title: "نوبت دکتر",
      dueAt: "2026-11-09T17:00:00+03:30",
      sourceQuote: "فردا ساعت ۵ دکتر دارم",
      missing: []
    })

    expect(result.ok).toBe(true)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      _tag: "task",
      title: "نوبت دکتر",
      dueAt: "2026-11-09T13:30:00.000Z"
    })
  })

  it("names the failing field so the model can repair the call", async () => {
    const { result, drafts } = await runTool("draft_task", {
      title: "",
      sourceQuote: "فردا ساعت ۵ دکتر دارم",
      missing: []
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(String(result.error)).toContain("title")
    }
    expect(drafts).toHaveLength(0)
  })

  it("rejects a paraphrased source quote", async () => {
    const { result } = await runTool("draft_task", {
      title: "نوبت دکتر",
      sourceQuote: "یک جمله‌ی دیگر",
      missing: []
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(String(result.error)).toContain("sourceQuote")
    }
  })

  it("keeps the user's words while normalizing a Persian-digit time", async () => {
    const { result, drafts } = await runTool("draft_reminder", {
      title: "قرص ۸ صبح",
      repeat: { _tag: "daily", time: "۰۸:۰۰" },
      sourceQuote: "یادم باشه قرص رو بگیرم",
      missing: []
    })

    expect(result.ok).toBe(true)
    expect(drafts[0]).toMatchObject({
      _tag: "reminder",
      title: "قرص ۸ صبح",
      repeat: { _tag: "daily", time: "08:00" }
    })
  })
})

describe("ensureCaptureDrafts", () => {
  it("turns silence into a Note rather than a drop", () => {
    const drafts = ensureCaptureDrafts("یک ایده‌ی خام", [])
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      _tag: "note",
      title: "یک ایده‌ی خام",
      body: "یک ایده‌ی خام"
    })
  })

  it("caps a runaway run at 12 drafts", () => {
    const many = Array.from({ length: 20 }, () => taskDraft)
    expect(ensureCaptureDrafts("متن", many)).toHaveLength(12)
  })

  it("builds a note title from the first non-empty line", () => {
    expect(noteDraftFromText("\n\nخط اول\nخط دوم")).toMatchObject({
      title: "خط اول",
      body: "خط اول\nخط دوم"
    })
  })
})
