import { Effect, Ref, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  CaptureDraft,
  DraftIncomplete,
  captureDedupeKey,
  toCreateInput
} from "@tali/domain"
import { Extractor, ExtractorReplay } from "../src/capture-extractor.js"
import { makeDraftTools } from "../src/capture-tools.js"
import fixturesJson from "./fixtures/capture/fixtures.json"

/**
 * The recorded Dissect fixtures (ticket #101; ADR-0012 §1–§4, §8).
 *
 * 25 Persian inputs and the drafts a Dissect produced. They are replayed
 * through `ExtractorReplay`, so this suite never calls a model. Each fixture
 * pins:
 *
 * - the draft shape and the split (no under-splitting, no merge);
 * - a verbatim Source Quote;
 * - Needs Input firing for a date/time/recurrence the text does not supply,
 *   rather than an invented value;
 * - the commit gate: a draft with an unanswered entry is `DraftIncomplete`.
 */

const Fixture = Schema.Struct({
  text: Schema.String,
  drafts: Schema.Array(Schema.Unknown),
  expectedTags: Schema.Array(Schema.String),
  expectedMissing: Schema.Array(Schema.String),
  neverInventDate: Schema.Boolean
})

const fixtures = Schema.decodeUnknownSync(Schema.Array(Fixture))(fixturesJson)

const draftsOf = (fixture: typeof fixtures[number]) =>
  fixture.drafts.map((draft) => Schema.decodeUnknownSync(CaptureDraft)(draft))

const context = (draftIndex: number) => ({
  draftIndex,
  clientMutationId: `fixture-${draftIndex}`,
  timeZone: "Asia/Tehran"
})

describe("capture fixtures", () => {
  it("contains 25 Persian fixtures", () => {
    expect(fixtures).toHaveLength(25)
  })

  for (const fixture of fixtures) {
    it(`replays: ${fixture.text}`, async () => {
      const recorded = draftsOf(fixture)
      const layer = ExtractorReplay([{ text: fixture.text, drafts: recorded }])

      const drafts = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function*() {
            const extractor = yield* Extractor
            return yield* extractor.dissect({
              userId: "user-a" as never,
              text: fixture.text,
              now: "2026-11-08T09:00:00.000Z",
              timeZone: "Asia/Tehran",
              weekStart: "saturday"
            })
          }),
          layer
        )
      )

      // The cap and the split.
      expect(drafts.length).toBeLessThanOrEqual(12)
      expect(drafts.map((draft) => draft._tag)).toEqual(fixture.expectedTags)
      expect(drafts).toHaveLength(fixture.expectedTags.length)

      // Every Source Quote is a verbatim slice of the Capture text.
      for (const draft of drafts) {
        expect(fixture.text.includes(draft.sourceQuote)).toBe(true)
      }

      // Needs Input fires exactly where the text does not supply the value.
      const missing = drafts.flatMap((draft) =>
        draft.missing.map((entry) => entry.field)
      )
      expect([...missing].sort()).toEqual([...fixture.expectedMissing].sort())

      if (fixture.neverInventDate) {
        for (const draft of drafts) {
          if (draft._tag === "event" && draft.timing === undefined) {
            expect(draft.missing.map((entry) => entry.field)).toContain("timing")
          }
          if (draft._tag === "reminder" && draft.repeat === undefined) {
            expect(draft.missing.map((entry) => entry.field)).toContain("repeat")
          }
          if (
            draft._tag === "reminder" &&
            draft.repeat?._tag === "once" &&
            draft.fireAt === undefined
          ) {
            expect(draft.missing.map((entry) => entry.field)).toContain("fireAt")
          }
        }
      }

      // The commit gate: an unanswered card fails before anything is written.
      for (const [index, draft] of drafts.entries()) {
        const result = await Effect.runPromise(
          Effect.result(toCreateInput(draft, context(index)))
        )
        if (draft.missing.length > 0) {
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(DraftIncomplete)
          }
        } else {
          expect(Result.isSuccess(result)).toBe(true)
        }
      }
    })
  }

  it("keeps the dedupe key stable for the fixture text", () => {
    expect(captureDedupeKey(fixtures[0]!.text)).toBe(
      captureDedupeKey(fixtures[0]!.text)
    )
  })
})

describe("malformed tool repair", () => {
  it("a field-naming tool error is followed by a valid call in the same run", async () => {
    const collector = await Effect.runPromise(
      Ref.make<ReadonlyArray<CaptureDraft>>([])
    )
    const tools = makeDraftTools(collector, "فردا ساعت ۵ دکتر دارم")
    const tool = tools.find((candidate) => candidate.def.name === "draft_event")
    if (tool === undefined) throw new Error("missing draft_event")

    // First call: a number where the schema expects a title string. The tool
    // rejects it and names the field; TanStack AI hands that back to the model.
    const first = await Effect.runPromise(
      Effect.result(
        tool.execute(
          {
            title: 42,
            sourceQuote: "فردا ساعت ۵ دکتر دارم",
            missing: []
          } as never,
          {} as never
        )
      )
    )
    expect(Result.isFailure(first)).toBe(true)
    if (Result.isFailure(first)) {
      expect(String(first.failure)).toContain("title")
    }

    // The model repairs the call inside the same run.
    const second = await Effect.runPromise(
      Effect.result(
        tool.execute(
          {
            title: "نوبت دکتر",
            timing: {
              _tag: "timed",
              start: "2026-11-09T13:30:00.000Z",
              end: "2026-11-09T14:30:00.000Z"
            },
            timeZone: "Asia/Tehran",
            sourceQuote: "فردا ساعت ۵ دکتر دارم",
            missing: []
          } as never,
          {} as never
        )
      )
    )
    expect(Result.isSuccess(second)).toBe(true)

    const collected = await Effect.runPromise(Ref.get(collector))
    expect(collected).toHaveLength(1)
    expect(collected[0]?._tag).toBe("event")
  })
})
