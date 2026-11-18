import { Context, Effect, Layer, Schema } from 'effect'
import { SqlClient, SqlSchema } from 'effect/sql'

/**
 * A fixed-window rate counter over one `*_attempts` table (ticket #113).
 *
 * The login (ADR-0001) and Capture (ADR-0012 §9) limiters are the same upsert
 * with different constants, and this package owns the tables' migrations — so
 * the SQL lives here too, next to the DDL it belongs to.
 *
 * One `INSERT … RETURNING` both increments and reads the counter, so
 * concurrent requests serialise on the row: the (max+1)th request sees max+1
 * and is blocked instead of every request passing a separate pre-check. A
 * fixed (not sliding) window keeps the write path to one upsert per attempt,
 * and a window rollover resets the counter instead of accumulating it.
 */

/** The shared result of reserving one attempt against a window. */
export interface FixedWindowLimitStatus {
  readonly limited: boolean
  /** Only meaningful when `limited`; at least 1. */
  readonly retryAfterSeconds: number
}

export interface FixedWindowLimiterOptions {
  /** The counter table: `key` TEXT PRIMARY KEY, `window_start`, `counter`. */
  readonly table: string
  /**
   * The counter column. The two tables predate this factory and name it
   * differently (`login_attempts.failures`, `capture_attempts.count`); it is
   * aliased to `count` on the way out so the statement is one.
   */
  readonly counter: string
  /** The fixed window length in milliseconds. */
  readonly windowMs: number
  /** Attempts allowed per window; the (max+1)th is `limited`. */
  readonly max: number
}

/**
 * Build the limiter service for one table/window/max triple.
 *
 * Each call yields a fresh service tag, so the login and Capture limiters (and
 * any future window) coexist in one Context without colliding.
 */
export const makeFixedWindowLimiter = (options: FixedWindowLimiterOptions) => {
  class FixedWindowLimiter extends Context.Service<FixedWindowLimiter>()(
    `FixedWindowLimiter(${options.table})`,
    {
      make: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        const windowStartOf = (now: number): number =>
          Math.floor(now / options.windowMs) * options.windowMs

        /**
         * Reserve one attempt for `key` and return the updated counter.
         * Incrementing and reading are the same statement, so concurrent
         * requests serialise on the row; a key last seen in an older window
         * starts a fresh count instead of adding to it.
         */
        const consumeAttempt = SqlSchema.findOne({
          Request: Schema.Struct({
            key: Schema.String,
            windowStart: Schema.Int,
          }),
          Result: Schema.Struct({
            windowStart: Schema.Int,
            count: Schema.Int,
          }),
          execute: ({ key, windowStart }) => sql`
            INSERT INTO ${sql(options.table)}
            VALUES (${key}, ${windowStart}, 1)
            ON CONFLICT (key) DO UPDATE SET
              ${sql(options.counter)} = CASE
                WHEN ${sql(options.table)}.window_start = excluded.window_start
                  THEN ${sql(options.table)}.${sql(options.counter)} + 1
                ELSE 1
              END,
              window_start = excluded.window_start
            RETURNING window_start, ${sql(options.counter)} AS count
          `,
        })

        /** Count this attempt and report whether the window is exhausted. */
        const consume = (key: string) =>
          Effect.gen(function* () {
            const now = Date.now()
            const windowStart = windowStartOf(now)
            const { count } = yield* consumeAttempt({ key, windowStart })
            if (count <= options.max) {
              return { limited: false, retryAfterSeconds: 0 }
            }
            return {
              limited: true,
              retryAfterSeconds: Math.max(
                1,
                Math.ceil((windowStart + options.windowMs - now) / 1000),
              ),
            }
          })

        /** A success clears the window so a hiccup does not linger. */
        const clear = SqlSchema.void({
          Request: Schema.String,
          execute: key =>
            sql`DELETE FROM ${sql(options.table)} WHERE key = ${key}`,
        })

        return { consume, clear }
      }),
    },
  ) {}

  const FixedWindowLimiterLive = Layer.effect(
    FixedWindowLimiter,
    FixedWindowLimiter.make,
  )

  return { FixedWindowLimiter, FixedWindowLimiterLive }
}
