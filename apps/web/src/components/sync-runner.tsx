import { createEffect, untrack } from "solid-js"
import { useLocalStore, type SyncHandler } from "../lib/local-store"
import { createSyncLoop } from "../lib/sync-cadence"
import { syncHandler } from "../lib/sync-engine"

/**
 * Wires the sync engine into the `registerSync` seam and owns the wake rhythm.
 *
 * There is no SSE channel yet (deferred in `docs/sync-protocol-draft.md`
 * DP-5), so the client uses cursor-wake polling. The delay is not fixed: it
 * backs off after failures, slows while idle or hidden, and is cut short by a
 * visible tab, a reconnect, or a local write. `sync-cadence.ts` owns the
 * derivation and the setTimeout chain; this component only supplies the
 * providers and lifecycle.
 */
export interface SyncRunnerProps {
  /** Override for tests; defaults to the real engine. */
  readonly handler?: SyncHandler
}

export function SyncRunner(props: SyncRunnerProps = {}) {
  const local = useLocalStore()
  let wake: () => void = () => {}

  createEffect(
    () => null,
    () => {
      local.registerSync(props.handler ?? syncHandler)
      return () => local.registerSync(undefined)
    }
  )

  /**
   * One loop per ready, online, un-halted session. Starting the loop is also
   * the first pass and the reconnect pass: a status/online transition tears the
   * old timer down and the new loop starts with an immediate pass. A 401 stops
   * it because a dead session cannot sync until auth opens a fresh store.
   */
  createEffect(
    () => ({ status: local.status(), online: local.online(), halted: local.halted() }),
    ({ status, online, halted }) => {
      if (typeof window === "undefined" || status !== "ready" || !online || halted) return
      const loop = createSyncLoop({
        syncNow: local.syncNow,
        failures: local.failures,
        lastActivity: local.lastActivity,
        halted: local.halted
      })
      wake = loop.wake
      loop.start()
      return () => {
        wake = () => {}
        loop.stop()
      }
    }
  )

  /**
   * A new local write should not wait for the poll. Pending also drops when an
   * ack lands, but the `> 0` guard stops that from waking a drained queue; a
   * wake while a pass is running becomes exactly one trailing pass.
   */
  createEffect(
    () => ({
      pending: local.pending(),
      online: local.online(),
      status: local.status(),
      halted: local.halted()
    }),
    ({ pending, online, status, halted }) => {
      if (pending > 0 && online && status === "ready" && !halted) untrack(wake)
    }
  )

  return null
}
