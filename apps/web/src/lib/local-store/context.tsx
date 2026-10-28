import {
  createContext,
  createEffect,
  createSignal,
  useContext,
  type ParentProps
} from "solid-js"
import { useAuth } from "../auth"
import { openLocalStore } from "./store"
import type { LocalStore } from "./types"

/**
 * Solid wiring around the IndexedDB mirror.
 *
 * The store opens once the session is restored (it is per-user) and closes
 * when that session ends. The provider also owns the two signals the UI needs
 * from outside the store: whether the browser is online, and how many
 * mutations are still queued.
 *
 * `registerSync` is the seam the sync engine (#18) plugs into. When a handler
 * is registered, reconnecting (or `syncNow()`) runs it against the open store.
 * Until then the outbox simply accumulates — no transport is invented here.
 */

export type LocalStoreStatus = "idle" | "opening" | "ready" | "error"

export type SyncHandler = (store: LocalStore) => Promise<void>

export interface LocalStoreContextValue {
  /** `idle` before a session, `opening` while IndexedDB opens, `ready` after. */
  status: () => LocalStoreStatus
  store: () => LocalStore | undefined
  online: () => boolean
  /** Mutations waiting in the outbox. */
  pending: () => number
  /** Rows whose last push was rejected; they need an explicit retry. */
  failed: () => number
  syncing: () => boolean
  /** True once a sync handler is registered (the engine lands in #18). */
  canSync: () => boolean
  error: () => string | undefined
  /** Run the registered sync handler now; no-op when offline or unregistered. */
  syncNow: () => Promise<void>
  registerSync: (handler: SyncHandler | undefined) => void
}

const LocalStoreContext = createContext<LocalStoreContextValue>()

const readOnline = (): boolean =>
  typeof navigator === "undefined" ? true : navigator.onLine

export function LocalStoreProvider(props: ParentProps) {
  const auth = useAuth()

  const [status, setStatus] = createSignal<LocalStoreStatus>("idle")
  const [store, setStore] = createSignal<LocalStore>()
  const [online, setOnline] = createSignal(readOnline())
  const [pending, setPending] = createSignal(0)
  const [failed, setFailed] = createSignal(0)
  const [syncing, setSyncing] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [syncHandler, setSyncHandler] = createSignal<SyncHandler>()

  let generation = 0
  let unsubscribe: (() => void) | undefined

  /**
   * The pending count is cheap (`count()` on the outbox) and it can change on
   * every local write, so the subscribe callback refreshes only this one.
   */
  const refreshPendingOf = async (current: LocalStore) => {
    if (current.closed) return
    try {
      setPending(await current.pendingCount())
    } catch {
      // The store closed mid-read (sign-out); the next open resets the count.
    }
  }

  /**
   * Failure markers only move inside a push result, a pull replacement or a
   * retry. Counting them is a mirror scan, so do it on open and after a pass,
   * never on every keystroke's store notification.
   */
  const refreshFailedOf = async (current: LocalStore) => {
    if (current.closed) return
    try {
      setFailed(await current.failedCount())
    } catch {
      // The store closed mid-read (sign-out); the next open resets the count.
    }
  }

  const refreshCountsOf = async (current: LocalStore) => {
    await Promise.all([refreshPendingOf(current), refreshFailedOf(current)])
  }

  const closeStore = () => {
    generation += 1
    unsubscribe?.()
    unsubscribe = undefined
    const current = store()
    if (current !== undefined) current.close()
    setStore(undefined)
    setPending(0)
    setFailed(0)
    setStatus("idle")
    setError(undefined)
  }

  /**
   * A trigger that lands while a pass is running is queued, not dropped: the
   * pass in flight may have read the outbox before that write landed, so
   * returning early would leave it waiting for the next poll (up to 3.5 s).
   * Exactly one trailing pass is run, and the same guards as the entry check
   * apply to it.
   */
  let trailingRun = false

  const syncNow = async (): Promise<void> => {
    const handler = syncHandler()
    const current = store()
    if (handler === undefined || current === undefined || current.closed) return
    if (!online()) return
    if (syncing()) {
      trailingRun = true
      return
    }
    const ticket = generation
    setSyncing(true)
    setError(undefined)
    try {
      for (;;) {
        // Cleared before the pass, so any trigger during it queues one more.
        trailingRun = false
        await handler(current)
        if (
          !trailingRun ||
          generation !== ticket ||
          current.closed ||
          !online() ||
          syncHandler() === undefined
        ) {
          break
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sync failed")
    } finally {
      trailingRun = false
      setSyncing(false)
      await refreshCountsOf(current)
    }
  }

  // Open a mirror per signed-in user; the previous one closes first.
  createEffect(
    () => ({ authStatus: auth.status(), userId: auth.session()?.user.id }),
    ({ authStatus, userId }) => {
      if (authStatus !== "signedIn" || userId === undefined) return

      const ticket = ++generation
      setStatus("opening")
      setError(undefined)

      void (async () => {
        try {
          const opened = await openLocalStore(userId)
          if (ticket !== generation) {
            opened.close()
            return
          }
          setStore(opened)
          unsubscribe = opened.subscribe(() => void refreshPendingOf(opened))
          setStatus("ready")
          await refreshCountsOf(opened)
        } catch (cause) {
          if (ticket !== generation) return
          setError(cause instanceof Error ? cause.message : "IndexedDB unavailable")
          setStatus("error")
        }
      })()

      return () => closeStore()
    }
  )

  // Connectivity is browser state, not store state; the provider owns it so
  // every screen shares one answer. Reconnecting is the auto-sync trigger.
  createEffect(
    () => null,
    () => {
      if (typeof window === "undefined") return
      const goOnline = () => {
        setOnline(true)
        void syncNow()
      }
      const goOffline = () => setOnline(false)
      window.addEventListener("online", goOnline)
      window.addEventListener("offline", goOffline)
      return () => {
        window.removeEventListener("online", goOnline)
        window.removeEventListener("offline", goOffline)
      }
    }
  )

  const value: LocalStoreContextValue = {
    status,
    store,
    online,
    pending,
    failed,
    syncing,
    canSync: () => syncHandler() !== undefined,
    error,
    syncNow,
    registerSync: (handler) => setSyncHandler(() => handler)
  }

  return <LocalStoreContext value={value}>{props.children}</LocalStoreContext>
}

export function useLocalStore(): LocalStoreContextValue {
  return useContext(LocalStoreContext)
}
