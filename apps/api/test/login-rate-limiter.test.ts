import { describe, expect, it } from 'vite-plus/test'
import { Layer } from 'effect'
import {
  LoginRateLimiter,
  LoginRateLimiterLive,
} from '../src/login-rate-limiter.js'
import { makeServiceHarness } from './harness.js'

/**
 * The login limiter (ADR-0001) over the real migration chain.
 *
 * The upsert lives behind `@tali/sql`'s fixed-window factory; these cases pin
 * the externally visible behavior the auth routes depend on: five failures
 * pass, the sixth carries a Retry-After, a success clears the window, and an
 * expired window starts a fresh count.
 */

const makeHarness = () =>
  makeServiceHarness(
    ({ d1 }) => LoginRateLimiterLive.pipe(Layer.provide(d1)),
    LoginRateLimiter,
  )

/** One email+IP bucket, as `auth-service` composes it. */
const KEY = 'user@example.com|203.0.113.7'

const failuresOf = (h: ReturnType<typeof makeHarness>): number =>
  (
    h.db
      .prepare('SELECT failures FROM login_attempts WHERE key = ?')
      .get(KEY) as { readonly failures: number }
  ).failures

describe('LoginRateLimiter', () => {
  it('allows five failures and limits the sixth with a Retry-After', async () => {
    const h = makeHarness()

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const status = await h.svc(limiter => limiter.consume(KEY))
      expect(status.limited).toBe(false)
    }

    const limited = await h.svc(limiter => limiter.consume(KEY))
    expect(limited.limited).toBe(true)
    // Inside the 15-minute window and never the "0" the route would echo.
    expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(15 * 60)
    expect(failuresOf(h)).toBe(6)
  })

  it('clears the window so a success does not linger', async () => {
    const h = makeHarness()

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await h.svc(limiter => limiter.consume(KEY))
    }
    await h.svc(limiter => limiter.clear(KEY))

    const status = await h.svc(limiter => limiter.consume(KEY))
    expect(status.limited).toBe(false)
    expect(failuresOf(h)).toBe(1)
  })

  it('resets a stale window instead of accumulating it', async () => {
    const h = makeHarness()

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await h.svc(limiter => limiter.consume(KEY))
    }
    // Two windows out of date: the next attempt must start a fresh count.
    h.db
      .prepare('UPDATE login_attempts SET window_start = window_start - ?')
      .run(2 * 15 * 60 * 1000)

    const status = await h.svc(limiter => limiter.consume(KEY))
    expect(status.limited).toBe(false)
    expect(failuresOf(h)).toBe(1)
  })
})
