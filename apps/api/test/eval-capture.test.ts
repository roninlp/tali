import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { CaptureDraft } from "@tali/domain"
import {
  CaptureConfig,
  DEFAULT_CAPTURE_BASE_URL,
  DEFAULT_CAPTURE_MODEL,
  Extractor,
  ExtractorLive
} from "../src/capture-extractor.js"
import fixturesJson from "./fixtures/capture/fixtures.json"

/**
 * The live Capture eval (ticket #101; ADR-0012 §9).
 *
 * This is the only suite that calls a model. It is env-gated on
 * `OPENCODE_API_KEY`, so `pnpm test` and CI stay offline and key-free. Run it
 * with `pnpm eval:capture`; each fixture is one test, so a regression names the
 * exact Persian sentence that broke.
 */

const Fixture = Schema.Struct({
  text: Schema.String,
  drafts: Schema.Array(Schema.Unknown),
  expectedTags: Schema.Array(Schema.String),
  expectedMissing: Schema.Array(Schema.String),
  neverInventDate: Schema.Boolean
})

const fixtures = Schema.decodeUnknownSync(Schema.Array(Fixture))(fixturesJson)

const hasKey =
  process.env.OPENCODE_API_KEY !== undefined &&
  process.env.OPENCODE_API_KEY.trim() !== ""

const layer = ExtractorLive.pipe(
  Layer.provide(
    Layer.succeed(CaptureConfig, {
      apiKey: process.env.OPENCODE_API_KEY,
      baseUrl: process.env.CAPTURE_BASE_URL ?? DEFAULT_CAPTURE_BASE_URL,
      model: process.env.CAPTURE_MODEL ?? DEFAULT_CAPTURE_MODEL
    })
  )
)

const dissect = (text: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function*() {
        const extractor = yield* Extractor
        return yield* extractor.dissect({
          userId: "eval-user" as never,
          text,
          // A pinned clock keeps the prompt reproducible across eval runs.
          now: "2026-11-08T09:00:00.000Z",
          timeZone: "Asia/Tehran",
          weekStart: "saturday"
        })
      }),
      layer
    )
  )

describe.skipIf(!hasKey)("live capture eval", () => {
  for (const fixture of fixtures) {
    it(`live: ${fixture.text}`, { timeout: 60_000 }, async () => {
      const drafts = await dissect(fixture.text)

      expect(drafts.length).toBeLessThanOrEqual(12)
      expect(drafts.map((draft) => draft._tag)).toEqual(fixture.expectedTags)

      for (const draft of drafts) {
        expect(fixture.text.includes(draft.sourceQuote)).toBe(true)
      }

      const missing = drafts.flatMap((draft) =>
        draft.missing.map((entry) => entry.field)
      )
      expect([...missing].sort()).toEqual([...fixture.expectedMissing].sort())

      // Re-decode the live output: a draft that does not fit the domain schema
      // is a fail even if the tool call looked plausible.
      for (const draft of drafts) {
        expect(() => Schema.decodeUnknownSync(CaptureDraft)(draft)).not.toThrow()
      }
    })
  }
})
