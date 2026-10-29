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
  /** Consecutive passes that threw; zero after a pass that completed. */
  failures: () => number
  /** Epoch ms of the last local write or applied server change. */
  lastActivity: () => number
  /**
   * True after the server reported the session gone (401). The poll loop stays
   * stopped until a new session opens, because retrying cannot fix it.
   */
  halted: () => boolean
  error: () => string | undefined
  /** Run the registered sync handler now; no-op when offline or unregistered. */
  syncNow: () => Promise<void>
  registerSync: (handler: SyncHandler | undefined) => void
}

const LocalStoreContext = createContext<LocalStoreContextValue>()

const readOnline = (): boolean =>
  typeof navigator === "undefined" ? true : navigator.onLine

/**
 * How often a sync pass may re-scan the mirror for rejected rows. Failure
 * counts are advisory; the poll is not allowed to read every row for them.
 */
const FAILED_REFRESH_INTERVAL_MS = 60_000

export function LocalStoreProvider(props: ParentProps) {
  const auth = useAuth()

  const [status, setStatus] = createSignal<LocalStoreStatus>("idle")
  const [store, setStore] = createSignal<LocalStore>()
  const [online, setOnline] = createSignal(readOnline())
  const [pending, setPending] = createSignal(0)
  const [failed, setFailed] = createSignal(0)
  const [syncing, setSyncing] = createSignal(false)
  const [failures, setFailures] = createSignal(0)
  const [lastActivity, setLastActivity] = createSignal(Date.now())
  const [halted, setHalted] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [syncHandler, setSyncHandler] = createSignal<SyncHandler>()

  let generation = 0
  let unsubscribe: (() => void) | undefined

  /**
   * The pending count is cheap (`count()` on the outbox) and it can change on
   * every local write, so the subscribe callback refreshes only this one.
   * Returns the count it read, so a pass can tell whether the outbox shrank.
   */
  const refreshPendingOf = async (current: LocalStore): Promise<number | undefined> => {
    if (current.closed) return undefined
    try {
      const count = await current.pendingCount()
      setPending(count)
      return count
    } catch {
      // The store closed mid-read (sign-out); the next open resets the count.
      return undefined
    }
  }

  /**
   * Failure markers only move inside a push result, a pull replacement, a
   * retry or an ack that resolves a rejected row. Counting them is a full
   * mirror scan (`failedCount()` = `getAll()`), so unlike the outbox count it
   * must not ride along with every poll — that read the whole mirror every few
   * seconds. It is refreshed on store open, when a pass drains the outbox (the
   * one moment a push result can have marked rows), and otherwise at most once
   * per `FAILED_REFRESH_INTERVAL_MS`. Trade-off: a marker resolved by a pull
   * while the outbox is empty can leave `failed()` stale for up to a minute.
   * The badge is advisory and a rejected write still appears as soon as its
   * push result lands, which is the case the status UI has to get right.
   */
  let failedRefreshedAt = 0

  const refreshFailedOf = async (current: LocalStore) => {
    if (current.closed) return
    failedRefreshedAt = Date.now()
    try {
      setFailed(await current.failedCount())
    } catch {
      // The store closed mid-read (sign-out); the next open resets the count.
    }
  }

  /** The outbox count is an index `count()`, cheap enough for every pass. */
  const refreshCountsOf = async (current: LocalStore, refreshFailed: boolean) => {
    const reads: Array<Promise<unknown>> = [refreshPendingOf(current)]
    if (refreshFailed) reads.push(refreshFailedOf(current))
    await Promise.all(reads)
  }

  const failedRefreshDue = (): boolean =>
    Date.now() - failedRefreshedAt >= FAILED_REFRESH_INTERVAL_MS

  const closeStore = () => {
    generation += 1
    unsubscribe?.()
    unsubscribe = undefined
    failedRefreshedAt = 0
    const current = store()
    if (current !== undefined) current.close()
    setStore(undefined)
    setPending(0)
    setFailed(0)
    setFailures(0)
    setHalted(false)
    setStatus("idle")
    setError(undefined)
  }

  /**
   * A 401 is a session-gone signal, not a transient network failure. The
   * engine surfaces it as `SyncRejected("Unauthorized")`; retrying can only
   * burn polls until auth restores a store, which resets `halted`.
   */
  const isSessionGone = (cause: unknown): boolean =>
    typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly code?: unknown }).code === "Unauthorized"

  /**
   * A trigger that lands while a pass is running is queued, not dropped: the
   * pass in flight may have read the outbox before that write landed, so
   * returning early would leave it waiting for the next poll (up to the
   * cadence delay in `sync-cadence.ts`). Exactly one trailing pass is run, and
   * the same guards as the entry check apply to it.
   */
  let trailingRun = false

  const syncNow = async (): Promise<void> => {
    const handler = syncHandler()
    const current = store()
    if (handler === undefined || current === undefined || current.closed) return
    if (!online()) return
    // A session-gone store stays quiet until auth opens a new one.
    if (halted()) return
    if (syncing()) {
      trailingRun = true
      return
    }
    const ticket = generation
    setSyncing(true)
    setError(undefined)
    // One cheap outbox `count()` before the pass: if the queue shrinks while
    // the handler runs, a push result may have marked a row, which is the only
    // per-pass reason to read the mirror for failures.
    const queuedBefore = await current.pendingCount().catch(() => pending())
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
      setFailures(0)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sync failed")
      setFailures((count) => count + 1)
      if (isSessionGone(cause)) setHalted(true)
    } finally {
      trailingRun = false
      setSyncing(false)
      // Pending is cheap and stays per-pass. The mirror scan behind `failed()`
      // does not: run it only when a push result may have marked a row (the
      // outbox shrank during the pass) or when the minute has elapsed.
      const queuedAfter = await refreshPendingOf(current)
      if (
        (queuedAfter !== undefined && queuedAfter < queuedBefore) ||
        failedRefreshDue()
      ) {
        await refreshFailedOf(current)
      }
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
          // A new store means a live session: any previous 401 is gone.
          setFailures(0)
          setHalted(false)
          setLastActivity(Date.now())
          unsubscribe = opened.subscribe(() => {
            // Every committed change is a sign of life: a local write, a pull
            // that applied rows, or an ack. The cadence treats all three as
            // activity and lets a quiet mirror idle.
            setLastActivity(Date.now())
            void refreshPendingOf(opened)
          })
          setStatus("ready")
          // A fresh store is the one time the failure count is guaranteed
          // stale, so seed both badges here.
          await refreshCountsOf(opened, true)
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
    failures,
    lastActivity,
    halted,
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
