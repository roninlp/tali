import { Context, Effect, Layer } from 'effect'
import { makeFixedWindowLimiter, type FixedWindowLimitStatus } from '@tali/sql'

/**
 * D1 fixed-window Capture limiter (ADR-0012 §9; ticket #101).
 *
 * Twenty Dissect runs per user per hour. It follows the login limiter's shape:
 * one `INSERT … RETURNING` both increments and reads the counter, so
 * concurrent submissions serialise on the row and the 21st sees 21 rather than
 * every request passing a separate pre-check.
 *
 * The key is the owner id, never the text: the 60-second identical-text
 * dedupe runs before this and does not consume a slot. The upsert itself is
 * the shared `@tali/sql` fixed-window factory, which owns the table's
 * migrations.
 */

const WINDOW_MS = 60 * 60 * 1000
export const CAPTURE_MAX_PER_WINDOW = 20

/** The shared fixed-window status, under the name the capture surface always used. */
export type CaptureLimitStatus = FixedWindowLimitStatus

const {
  FixedWindowLimiter: CaptureAttempts,
  FixedWindowLimiterLive: CaptureAttemptsLive,
} = makeFixedWindowLimiter({
  table: 'capture_attempts',
  counter: 'count',
  windowMs: WINDOW_MS,
  max: CAPTURE_MAX_PER_WINDOW,
})

export class CaptureRateLimiter extends Context.Service<CaptureRateLimiter>()(
  'CaptureRateLimiter',
  {
    make: Effect.gen(function* () {
      const { consume } = yield* CaptureAttempts

      /**
       * `CaptureRateLimited` is a typed failure before any row exists; a SQL
       * defect is not part of that contract, so it dies here instead of
       * leaking into `dissect`'s error channel.
       */
      const consumeKey = (key: string): Effect.Effect<CaptureLimitStatus> =>
        consume(key).pipe(Effect.orDie)

      return { consume: consumeKey }
    }),
  },
) {}

export const CaptureRateLimiterLive = Layer.effect(
  CaptureRateLimiter,
  CaptureRateLimiter.make,
).pipe(Layer.provide(CaptureAttemptsLive))
