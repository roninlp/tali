import { Context, Effect, Layer } from 'effect'
import { makeFixedWindowLimiter, type FixedWindowLimitStatus } from '@tali/sql'

/**
 * D1 fixed-window login limiter (ADR-0001).
 *
 * The browser KDF replaced the server-side one, so rate limiting is now the
 * only thing standing between a leaked verifier and online guessing. Five
 * failed attempts for one email+IP are allowed per 15-minute window; the sixth
 * is answered with `429` before any comparison runs.
 *
 * `login_attempts.key` is `${normalizeEmail(email)}|${ip}`. A fixed (not
 * sliding) window keeps the write path to one upsert per attempt and is exact
 * enough for a two-user household. The upsert itself is the shared
 * `@tali/sql` fixed-window factory, which owns the table's migrations.
 */

const WINDOW_MS = 15 * 60 * 1000
export const LOGIN_MAX_FAILURES = 5

/** The shared fixed-window status, under the name the auth surface always used. */
export type LimitStatus = FixedWindowLimitStatus

const {
  FixedWindowLimiter: LoginAttempts,
  FixedWindowLimiterLive: LoginAttemptsLive,
} = makeFixedWindowLimiter({
  table: 'login_attempts',
  counter: 'failures',
  windowMs: WINDOW_MS,
  max: LOGIN_MAX_FAILURES,
})

export class LoginRateLimiter extends Context.Service<LoginRateLimiter>()(
  'LoginRateLimiter',
  {
    make: Effect.gen(function* () {
      const { consume, clear } = yield* LoginAttempts
      return { consume, clear }
    }),
  },
) {}

export const LoginRateLimiterLive = Layer.effect(
  LoginRateLimiter,
  LoginRateLimiter.make,
).pipe(Layer.provide(LoginAttemptsLive))
