import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"

/**
 * D1 fixed-window login limiter (ADR-0001).
 *
 * The browser KDF replaced the server-side one, so rate limiting is now the
 * only thing standing between a leaked verifier and online guessing. Five
 * failed attempts for one email+IP are allowed per 15-minute window; the sixth
 * is answered with `429` before any comparison runs.
 *
 * `login_attempts.key` is `${normalizeEmail(email)}|${ip}`. A fixed (not
 * sliding) window keeps the write path to one upsert per failure and is exact
 * enough for a two-user household.
 */

const WINDOW_MS = 15 * 60 * 1000
export const LOGIN_MAX_FAILURES = 5

const Attempt = Schema.Struct({
  windowStart: Schema.Int,
  failures: Schema.Int
})

export interface LimitStatus {
  readonly limited: boolean
  /** Only meaningful when `limited`; at least 1. */
  readonly retryAfterSeconds: number
}

export class LoginRateLimiter extends Context.Service<LoginRateLimiter>()("LoginRateLimiter", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const windowStartOf = (now: number): number => Math.floor(now / WINDOW_MS) * WINDOW_MS

    const findAttempt = SqlSchema.findOneOption({
      Request: Schema.Struct({ key: Schema.String, windowStart: Schema.Int }),
      Result: Attempt,
      execute: ({ key, windowStart }) => sql`
        SELECT window_start, failures
        FROM login_attempts
        WHERE key = ${key} AND window_start = ${windowStart}
      `
    })

    /** Block the next attempt once the current window already has 5 failures. */
    const status = (key: string, now: number) =>
      Effect.gen(function*() {
        const windowStart = windowStartOf(now)
        const found = yield* findAttempt({ key, windowStart })
        if (Option.isNone(found) || found.value.failures < LOGIN_MAX_FAILURES) {
          return { limited: false, retryAfterSeconds: 0 }
        }
        return {
          limited: true,
          retryAfterSeconds: Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000))
        }
      })

    /**
     * Record one failure, resetting the counter when the window has rolled
     * over. The upsert is a single statement, so concurrent attempts cannot
     * lose an increment.
     */
    const recordFailure = SqlSchema.void({
      Request: Schema.Struct({ key: Schema.String, windowStart: Schema.Int }),
      execute: ({ key, windowStart }) => sql`
        INSERT INTO login_attempts (key, window_start, failures)
        VALUES (${key}, ${windowStart}, 1)
        ON CONFLICT (key) DO UPDATE SET
          failures = CASE
            WHEN login_attempts.window_start = excluded.window_start
              THEN login_attempts.failures + 1
            ELSE 1
          END,
          window_start = excluded.window_start
      `
    })

    /** A successful login clears the window so a hiccup does not linger. */
    const clear = SqlSchema.void({
      Request: Schema.String,
      execute: (key) => sql`DELETE FROM login_attempts WHERE key = ${key}`
    })

    return {
      status: (key: string) => status(key, Date.now()),
      recordFailure: (key: string) =>
        recordFailure({ key, windowStart: windowStartOf(Date.now()) }),
      clear
    } as const
  })
}) {}

export const LoginRateLimiterLive = Layer.effect(LoginRateLimiter, LoginRateLimiter.make)
