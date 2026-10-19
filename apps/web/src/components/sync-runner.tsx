import { createEffect, untrack } from "solid-js"
import { useLocalStore } from "../lib/local-store"
import { syncHandler } from "../lib/sync-engine"

/**
 * Wires the sync engine into the `registerSync` seam and owns the wake rhythm.
 *
 * There is no SSE channel yet (deferred in `docs/sync-protocol-draft.md`
 * DP-5), so the client uses cursor-wake polling: a 3.5s nudge plus an
 * immediate pass when the browser reconnects or a local write enters the
 * outbox. The poll only wakes; data always flows through `/sync/pull`.
 */
export function SyncRunner() {
  const local = useLocalStore()

  createEffect(
    () => null,
    () => {
      local.registerSync(syncHandler)
      return () => local.registerSync(undefined)
    }
  )

  // First pass when the mirror opens; the provider already re-syncs on reconnect.
  createEffect(
    () => ({ status: local.status(), online: local.online() }),
    ({ status, online }) => {
      if (status === "ready" && online) untrack(() => void local.syncNow())
    }
  )

  // A new local write should not wait for the poll.
  createEffect(
    () => ({ pending: local.pending(), online: local.online() }),
    ({ pending, online }) => {
      if (pending > 0 && online) untrack(() => void local.syncNow())
    }
  )

  // Poll for remote changes; SSE stays deferred. Cleanup runs when the store
  // closes or connectivity changes, so no timer outlives its session.
  createEffect(
    () => ({ status: local.status(), online: local.online() }),
    ({ status, online }) => {
      if (typeof window === "undefined" || status !== "ready" || !online) return
      const timer = setInterval(() => untrack(() => void local.syncNow()), 3_500)
      return () => clearInterval(timer)
    }
  )

  return null
}
