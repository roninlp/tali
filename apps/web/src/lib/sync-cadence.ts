/**
 * The wake rhythm for cursor-wake polling.
 *
 * There is no SSE channel yet (`docs/sync-protocol-draft.md` DP-5), so this
 * poll is the *only* way a remote edit reaches an open tab. Every interval is
 * therefore a latency/volume trade:
 *
 * - visible + recently active: the healthy 3.5s poll. This is the cadence a
 *   person typing expects, and it is also what a second device sees.
 * - visible but idle: 15s. Nobody is watching, but the tab is still a target
 *   for a remote edit, so it must not stop entirely.
 * - hidden: 30s. A background tab's polls are pure cost; returning to the tab
 *   wakes an immediate pass, so the extra latency is only paid while unseen.
 * - failures: 1s doubling to a 30s cap, with jitter. A network outage, a 500
 *   or a `SyncContended` 409 must not be hammered at the healthy rate, and
 *   two devices that lost the same CAS must not retry in lockstep.
 *
 * The store closing, going offline, or a session-gone 401 stops the loop; the
 * controller below never schedules a pass it knows cannot succeed.
 */

export type SyncVisibility = "visible" | "hidden"

export const ACTIVE_INTERVAL_MS = 3_500
export const IDLE_INTERVAL_MS = 15_000
export const HIDDEN_INTERVAL_MS = 30_000
export const FAILURE_RETRY_MS = 1_000
export const MAX_RETRY_MS = 30_000
/** How long a local write (or an applied sync) keeps the fast cadence. */
export const ACTIVITY_WINDOW_MS = 2 * 60_000
/** ±20% on the failure delay; enough to break a two-device lockstep. */
export const JITTER_RATIO = 0.2

export interface SyncCadenceState {
  /** Consecutive passes that threw; reset by a pass that completed. */
  readonly failures: number
  readonly visibility: SyncVisibility
  /** Epoch ms of the last local write or applied sync. */
  readonly lastActivity: number
  readonly now: number
}

/** The failure delay before jitter: 1s, 2s, 4s, … capped at 30s. */
const failureBaseMs = (failures: number): number =>
  Math.min(MAX_RETRY_MS, FAILURE_RETRY_MS * 2 ** (failures - 1))

/**
 * The one place the delay is derived. Pure so the table can be tested without
 * a clock or a browser; `random` exists only to make jitter deterministic in
 * tests.
 */
export const syncDelayMs = (
  state: SyncCadenceState,
  random: () => number = Math.random
): number => {
  if (state.failures > 0) {
    const base = failureBaseMs(state.failures)
    const jittered = base * (1 + (random() * 2 - 1) * JITTER_RATIO)
    // Clamp the result, not just the base: the cap is a promise about how long
    // a retry can take, not about the pre-jitter number.
    return Math.round(Math.min(MAX_RETRY_MS, jittered))
  }
  if (state.visibility === "hidden") return HIDDEN_INTERVAL_MS
  const active = state.now - state.lastActivity < ACTIVITY_WINDOW_MS
  return active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS
}

export interface SyncLoopDeps {
  /** One pass; resolves when the engine has finished (or thrown). */
  readonly syncNow: () => Promise<void>
  readonly failures: () => number
  readonly lastActivity: () => number
  /** True after a session-gone 401; the loop must not reschedule. */
  readonly halted: () => boolean
  readonly now?: () => number
  readonly random?: () => number
}

export interface SyncLoop {
  /** Start with an immediate pass, then keep the timer chain alive. */
  readonly start: () => void
  /** Stop polling and drop the pending timer. */
  readonly stop: () => void
  /** Run now instead of waiting out the current delay. */
  readonly wake: () => void
}

const readVisibility = (): SyncVisibility =>
  typeof document !== "undefined" && document.visibilityState === "hidden"
    ? "hidden"
    : "visible"

/**
 * Owns the setTimeout chain. A pass is never overlapped: a wake that lands
 * while one is running is remembered and produces exactly one trailing pass,
 * mirroring `syncNow`'s own trailing-run rule (#92).
 */
export const createSyncLoop = (deps: SyncLoopDeps): SyncLoop => {
  const now = deps.now ?? Date.now
  let running = false
  let inFlight = false
  let wakePending = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const schedule = () => {
    if (!running || deps.halted()) return
    clearTimer()
    const delay = syncDelayMs(
      {
        failures: deps.failures(),
        visibility: readVisibility(),
        lastActivity: deps.lastActivity(),
        now: now()
      },
      deps.random
    )
    timer = setTimeout(() => {
      timer = undefined
      void pass()
    }, delay)
  }

  const pass = async (): Promise<void> => {
    if (!running) return
    if (inFlight) {
      wakePending = true
      return
    }
    inFlight = true
    clearTimer()
    try {
      await deps.syncNow()
    } catch {
      // `syncNow` already records the failure and its message; the loop only
      // needs the streak, which it reads below, to pick the next delay.
    } finally {
      inFlight = false
    }
    if (!running || deps.halted()) return
    if (wakePending) {
      wakePending = false
      void pass()
      return
    }
    schedule()
  }

  const onVisibilityChange = () => {
    if (!running) return
    if (readVisibility() === "visible") {
      // A returning tab must not wait out a long hidden timer.
      clearTimer()
      void pass()
      return
    }
    // Going hidden only changes the wait; a pass in flight schedules itself
    // from the new visibility when it finishes.
    if (!inFlight) schedule()
  }

  return {
    start: () => {
      if (running) return
      running = true
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibilityChange)
      }
      void pass()
    },
    stop: () => {
      running = false
      wakePending = false
      clearTimer()
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange)
      }
    },
    wake: () => {
      if (!running) return
      clearTimer()
      void pass()
    }
  }
}
