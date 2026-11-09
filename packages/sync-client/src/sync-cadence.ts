/**
 * The wake rhythm for cursor-wake polling.
 *
 * There is no SSE channel yet (`docs/sync-protocol-draft.md` DP-5), so this
 * poll is the *only* way a remote edit reaches an open tab. Every interval is
 * therefore a latency/volume trade:
 *
 * - visible + recently active: the healthy 10s poll. A local write wakes an
 *   immediate pass, so the user's own edits never wait for it; 10s is the
 *   ceiling for *another* device's edit while the tab is in use.
 * - visible but idle: 30s. Nobody is watching, but the tab is still a target
 *   for a remote edit, so it must not stop entirely.
 * - hidden: 30s. A background tab's polls are pure cost; returning to the tab
 *   wakes an immediate pass, so the extra latency is only paid while unseen.
 * - failures: 1s doubling to a 30s cap, with jitter. A network outage, a 500
 *   or a `SyncContended` 409 must not be hammered at the healthy rate, and
 *   two devices that lost the same CAS must not retry in lockstep.
 *
 * The Foldkit runtime owns the timer chain: a Subscription restarts its sleep
 * whenever the Model's cadence dependencies change, and the `tick` counter
 * makes every emitted pass restart the cycle. This module only derives the
 * delay, so the table is testable without a clock or a browser.
 */

export type SyncVisibility = 'visible' | 'hidden'

export const ACTIVE_INTERVAL_MS = 10_000
export const IDLE_INTERVAL_MS = 30_000
export const HIDDEN_INTERVAL_MS = 30_000
export const FAILURE_RETRY_MS = 1_000
export const MAX_RETRY_MS = 30_000
/** How long a local write (or an applied sync) keeps the fast cadence. */
export const ACTIVITY_WINDOW_MS = 2 * 60_000
/** ±20% on the failure delay; enough to break a two-device lockstep. */
export const JITTER_RATIO = 0.2
/**
 * How often a sync pass may re-scan the mirror for rejected rows. Failure
 * counts are advisory; the poll is not allowed to read every row for them.
 */
export const FAILED_REFRESH_INTERVAL_MS = 60_000

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
  random: () => number = Math.random,
): number => {
  if (state.failures > 0) {
    const base = failureBaseMs(state.failures)
    const jittered = base * (1 + (random() * 2 - 1) * JITTER_RATIO)
    // Clamp the result, not just the base: the cap is a promise about how long
    // a retry can take, not about the pre-jitter number.
    return Math.round(Math.min(MAX_RETRY_MS, jittered))
  }
  if (state.visibility === 'hidden') return HIDDEN_INTERVAL_MS
  const active = state.now - state.lastActivity < ACTIVITY_WINDOW_MS
  return active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS
}
