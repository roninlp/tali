import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"

/**
 * D1 fixed-window Capture limiter (ADR-0012 §9; ticket #101).
 *
 * Twenty Dissect runs per user per hour. It follows the login limiter's shape:
 * one `INSERT … RETURNING` both increments and reads the counter, so
 * concurrent submissions serialise on the row and the 21st sees 21 rather than
 * every request passing a separate pre-check.
 *
 * The key is the owner id, never the text: the 60-second identical-text
 * dedupe runs before this and does not consume a slot.
 */

const WINDOW_MS = 60 * 60 * 1000
export const CAPTURE_MAX_PER_WINDOW = 20

const Attempt = Schema.Struct({
  windowStart: Schema.Int,
  count: Schema.Int
})

export interface CaptureLimitStatus {
  readonly limited: boolean
  /** Only meaningful when `limited`; at least 1. */
  readonly retryAfterSeconds: number
}

export class CaptureRateLimiter extends Context.Service<CaptureRateLimiter>()(
  "CaptureRateLimiter",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const windowStartOf = (now: number): number => Math.floor(now / WINDOW_MS) * WINDOW_MS

      const consumeAttempt = SqlSchema.findOne({
        Request: Schema.Struct({ key: Schema.String, windowStart: Schema.Int }),
        Result: Attempt,
        execute: ({ key, windowStart }) => sql`
          INSERT INTO capture_attempts (key, window_start, count)
          VALUES (${key}, ${windowStart}, 1)
          ON CONFLICT (key) DO UPDATE SET
            count = CASE
              WHEN capture_attempts.window_start = excluded.window_start
                THEN capture_attempts.count + 1
              ELSE 1
            END,
            window_start = excluded.window_start
          RETURNING window_start, count
        `
      })

      const consume = (key: string): Effect.Effect<CaptureLimitStatus> =>
        Effect.gen(function*() {
          const now = Date.now()
          const windowStart = windowStartOf(now)
          const { count } = yield* consumeAttempt({ key, windowStart }).pipe(
            Effect.orDie
          )
          if (count <= CAPTURE_MAX_PER_WINDOW) {
            return { limited: false, retryAfterSeconds: 0 }
          }
          return {
            limited: true,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((windowStart + WINDOW_MS - now) / 1000)
            )
          }
        })

      return { consume } as const
    })
  }
) {}

export const CaptureRateLimiterLive = Layer.effect(
  CaptureRateLimiter,
  CaptureRateLimiter.make
)
