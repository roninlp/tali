import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ACTIVITY_WINDOW_MS,
  ACTIVE_INTERVAL_MS,
  FAILURE_RETRY_MS,
  HIDDEN_INTERVAL_MS,
  IDLE_INTERVAL_MS,
  MAX_RETRY_MS,
  createSyncLoop,
  syncDelayMs,
  type SyncCadenceState
} from "./sync-cadence"

const cadence = (overrides: Partial<SyncCadenceState> = {}): SyncCadenceState => ({
  failures: 0,
  visibility: "visible",
  lastActivity: 0,
  now: 10_000,
  ...overrides
})

/** Midpoint random makes the jitter a no-op, so the table is exact. */
const noJitter = () => 0.5

describe("syncDelayMs", () => {
  it("pins the cadence table", () => {
    expect(ACTIVE_INTERVAL_MS).toBe(10_000)
    expect(IDLE_INTERVAL_MS).toBe(30_000)
    expect(HIDDEN_INTERVAL_MS).toBe(30_000)
    // The acceptance bar: an idle open tab polls no faster than every 10 s.
    expect(IDLE_INTERVAL_MS).toBeGreaterThanOrEqual(10_000)
    expect(ACTIVE_INTERVAL_MS).toBeGreaterThanOrEqual(10_000)
  })

  it("uses the healthy cadence while visible and recently active", () => {
    expect(syncDelayMs(cadence({ lastActivity: 8_000 }), noJitter)).toBe(
      ACTIVE_INTERVAL_MS
    )
    expect(
      syncDelayMs(
        cadence({ lastActivity: 10_000 - ACTIVITY_WINDOW_MS + 1 }),
        noJitter
      )
    ).toBe(ACTIVE_INTERVAL_MS)
  })

  it("slows to the idle cadence once the activity window has passed", () => {
    expect(
      syncDelayMs(cadence({ lastActivity: 10_000 - ACTIVITY_WINDOW_MS }), noJitter)
    ).toBe(IDLE_INTERVAL_MS)
  })

  it("uses the slow hidden cadence regardless of activity", () => {
    expect(
      syncDelayMs(cadence({ visibility: "hidden", lastActivity: 10_000 }), noJitter)
    ).toBe(HIDDEN_INTERVAL_MS)
  })

  it("doubles the failure delay up to the cap", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((failures) =>
      syncDelayMs(cadence({ failures }), noJitter)
    )
    expect(delays).toEqual([
      FAILURE_RETRY_MS,
      FAILURE_RETRY_MS * 2,
      FAILURE_RETRY_MS * 4,
      FAILURE_RETRY_MS * 8,
      FAILURE_RETRY_MS * 16,
      MAX_RETRY_MS,
      MAX_RETRY_MS
    ])
  })

  it("keeps jitter inside ±20% and never above the cap", () => {
    for (let failures = 1; failures <= 8; failures += 1) {
      const base = Math.min(MAX_RETRY_MS, FAILURE_RETRY_MS * 2 ** (failures - 1))
      const low = syncDelayMs(cadence({ failures }), () => 0)
      const high = syncDelayMs(cadence({ failures }), () => 1)
      expect(low).toBe(Math.round(base * 0.8))
      expect(high).toBe(Math.round(Math.min(MAX_RETRY_MS, base * 1.2)))
      expect(low).toBeLessThanOrEqual(high)
    }
  })

  it("lets failure backoff override the visibility and activity cadence", () => {
    expect(
      syncDelayMs(
        cadence({ failures: 3, visibility: "hidden", lastActivity: 0 }),
        noJitter
      )
    ).toBe(FAILURE_RETRY_MS * 4)
  })
})

/**
 * The loop tests drive the same controller `SyncRunner` mounts, with the
 * document's visibility stubbed and time faked. That keeps the cadence table
 * above honest: the delays are what the timer chain actually waits.
 */
describe("createSyncLoop", () => {
  const setVisibility = (value: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value
    })
    document.dispatchEvent(new Event("visibilitychange"))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible"
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("backs off on consecutive failures and resets after a clean pass", async () => {
    let failures = 0
    let failNext = true
    const starts: Array<number> = []
    const loop = createSyncLoop({
      syncNow: async () => {
        starts.push(Date.now())
        if (failNext) {
          failures += 1
          throw new Error("boom")
        }
        failures = 0
      },
      failures: () => failures,
      lastActivity: () => Date.now(),
      halted: () => false,
      random: noJitter
    })

    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(starts.length).toBe(1)
    expect(failures).toBe(1)

    // First retry is ~1 s, the next ~2 s, then ~4 s.
    await vi.advanceTimersByTimeAsync(999)
    expect(starts.length).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(starts.length).toBe(2)

    await vi.advanceTimersByTimeAsync(1_999)
    expect(starts.length).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(starts.length).toBe(3)

    // A pass that completes resets the streak and returns to the fast cadence.
    failNext = false
    await vi.advanceTimersByTimeAsync(3_999)
    expect(starts.length).toBe(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(starts.length).toBe(4)
    expect(failures).toBe(0)

    await vi.advanceTimersByTimeAsync(ACTIVE_INTERVAL_MS - 1)
    expect(starts.length).toBe(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(starts.length).toBe(5)
    expect(starts[4]! - starts[3]!).toBe(ACTIVE_INTERVAL_MS)

    loop.stop()
  })

  it("uses the hidden cadence and wakes an immediate pass when visible again", async () => {
    const starts: Array<number> = []
    const loop = createSyncLoop({
      syncNow: async () => {
        starts.push(Date.now())
      },
      failures: () => 0,
      lastActivity: () => Date.now(),
      halted: () => false,
      random: noJitter
    })

    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(starts.length).toBe(1)

    setVisibility("hidden")
    await vi.advanceTimersByTimeAsync(HIDDEN_INTERVAL_MS - 1)
    expect(starts.length).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(starts.length).toBe(2)

    // A returning tab must not wait out the hidden timer.
    setVisibility("visible")
    await vi.advanceTimersByTimeAsync(0)
    expect(starts.length).toBe(3)

    // …and it is back on the healthy cadence.
    await vi.advanceTimersByTimeAsync(ACTIVE_INTERVAL_MS - 1)
    expect(starts.length).toBe(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(starts.length).toBe(4)

    loop.stop()
  })

  it("slows to the idle cadence and a local write wakes it back to fast", async () => {
    // A poll is not activity: the last write is already outside the window.
    let lastActivity = Date.now() - ACTIVITY_WINDOW_MS - 1
    const starts: Array<number> = []
    const loop = createSyncLoop({
      syncNow: async () => {
        starts.push(Date.now())
      },
      failures: () => 0,
      lastActivity: () => lastActivity,
      halted: () => false,
      random: noJitter
    })

    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(starts.length).toBe(1)

    // Idle waits 30 s, not the healthy 10 s.
    await vi.advanceTimersByTimeAsync(IDLE_INTERVAL_MS - 1)
    expect(starts.length).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(starts.length).toBe(2)

    // A local write is activity and wakes immediately, not on the idle timer.
    lastActivity = Date.now()
    loop.wake()
    await vi.advanceTimersByTimeAsync(0)
    const afterWrite = starts.length
    expect(starts[afterWrite - 1]).toBe(Date.now())

    await vi.advanceTimersByTimeAsync(ACTIVE_INTERVAL_MS - 1)
    expect(starts.length).toBe(afterWrite)
    await vi.advanceTimersByTimeAsync(1)
    expect(starts.length).toBe(afterWrite + 1)

    loop.stop()
  })

  it("stops scheduling once the session is halted by a 401", async () => {
    let halted = false
    const starts: Array<number> = []
    const loop = createSyncLoop({
      syncNow: async () => {
        starts.push(Date.now())
        halted = true
        throw Object.assign(new Error("Unauthorized"), { code: "Unauthorized" })
      },
      failures: () => 1,
      lastActivity: () => Date.now(),
      halted: () => halted,
      random: noJitter
    })

    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(starts.length).toBe(1)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(starts.length).toBe(1)
  })

  it("runs exactly one trailing pass for wakes that land mid-pass", async () => {
    let calls = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const loop = createSyncLoop({
      syncNow: async () => {
        calls += 1
        if (calls === 1) await gate
      },
      failures: () => 0,
      lastActivity: () => Date.now(),
      halted: () => false,
      random: noJitter
    })

    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)

    loop.wake()
    loop.wake()
    loop.wake()
    expect(calls).toBe(1)

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(2)

    await vi.advanceTimersByTimeAsync(ACTIVE_INTERVAL_MS)
    expect(calls).toBe(3)

    loop.stop()
  })
})
