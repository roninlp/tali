import { describe, expect, it } from 'vite-plus/test'

import {
  ACTIVITY_WINDOW_MS,
  ACTIVE_INTERVAL_MS,
  FAILURE_RETRY_MS,
  HIDDEN_INTERVAL_MS,
  IDLE_INTERVAL_MS,
  MAX_RETRY_MS,
  syncDelayMs,
  type SyncCadenceState,
} from '../src/sync-cadence'

const cadence = (
  overrides: Partial<SyncCadenceState> = {},
): SyncCadenceState => ({
  failures: 0,
  visibility: 'visible',
  lastActivity: 0,
  now: 10_000,
  ...overrides,
})

/** Midpoint random makes the jitter a no-op, so the table is exact. */
const noJitter = () => 0.5

describe('syncDelayMs', () => {
  it('pins the cadence table', () => {
    expect(ACTIVE_INTERVAL_MS).toBe(10_000)
    expect(IDLE_INTERVAL_MS).toBe(30_000)
    expect(HIDDEN_INTERVAL_MS).toBe(30_000)
    // The acceptance bar: an idle open tab polls no faster than every 10 s.
    expect(IDLE_INTERVAL_MS).toBeGreaterThanOrEqual(10_000)
    expect(ACTIVE_INTERVAL_MS).toBeGreaterThanOrEqual(10_000)
  })

  it('uses the healthy cadence while visible and recently active', () => {
    expect(syncDelayMs(cadence({ lastActivity: 8_000 }), noJitter)).toBe(
      ACTIVE_INTERVAL_MS,
    )
    expect(
      syncDelayMs(
        cadence({ lastActivity: 10_000 - ACTIVITY_WINDOW_MS + 1 }),
        noJitter,
      ),
    ).toBe(ACTIVE_INTERVAL_MS)
  })

  it('slows to the idle cadence once the activity window has passed', () => {
    expect(
      syncDelayMs(
        cadence({ lastActivity: 10_000 - ACTIVITY_WINDOW_MS }),
        noJitter,
      ),
    ).toBe(IDLE_INTERVAL_MS)
  })

  it('uses the slow hidden cadence regardless of activity', () => {
    expect(
      syncDelayMs(
        cadence({ visibility: 'hidden', lastActivity: 10_000 }),
        noJitter,
      ),
    ).toBe(HIDDEN_INTERVAL_MS)
  })

  it('doubles the failure delay up to the cap', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map(failures =>
      syncDelayMs(cadence({ failures }), noJitter),
    )
    expect(delays).toEqual([
      FAILURE_RETRY_MS,
      FAILURE_RETRY_MS * 2,
      FAILURE_RETRY_MS * 4,
      FAILURE_RETRY_MS * 8,
      FAILURE_RETRY_MS * 16,
      MAX_RETRY_MS,
      MAX_RETRY_MS,
    ])
  })

  it('keeps jitter inside ±20% and never above the cap', () => {
    for (let failures = 1; failures <= 8; failures += 1) {
      const base = Math.min(
        MAX_RETRY_MS,
        FAILURE_RETRY_MS * 2 ** (failures - 1),
      )
      const low = syncDelayMs(cadence({ failures }), () => 0)
      const high = syncDelayMs(cadence({ failures }), () => 1)
      expect(low).toBe(Math.round(base * 0.8))
      expect(high).toBe(Math.round(Math.min(MAX_RETRY_MS, base * 1.2)))
      expect(low).toBeLessThanOrEqual(high)
    }
  })

  it('lets failure backoff override the visibility and activity cadence', () => {
    expect(
      syncDelayMs(
        cadence({ failures: 3, visibility: 'hidden', lastActivity: 0 }),
        noJitter,
      ),
    ).toBe(FAILURE_RETRY_MS * 4)
  })
})
