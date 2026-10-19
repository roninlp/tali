import type { ReminderNotificationAction } from "@tali/domain"

/**
 * The stub half of the "Done / Snooze" wiring (ticket #20).
 *
 * The service worker cannot call the sync outbox directly (the mirror is
 * per-user and the SW does not know the signed-in user), so it appends each
 * notification response to a tiny device-local queue. This module reads that
 * queue so the permission panel can prove the action reached a handler; the
 * reminder slice will drain it into the real outbox / `ReminderDispatch` ledger.
 *
 * Keep the database and store names in sync with `apps/web/public/sw.js`.
 */

export const PUSH_DB_NAME = "tali.push.v1"
export const PUSH_ACTIONS_STORE = "actions"

export interface QueuedReminderAction {
  /** IndexedDB auto-increment key (absent on freshly written records). */
  readonly seq?: number
  readonly reminderId: string
  readonly action: ReminderNotificationAction
  /** ISO-8601 timestamp written by the service worker. */
  readonly at: string
}

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(PUSH_DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PUSH_ACTIONS_STORE)) {
        db.createObjectStore(PUSH_ACTIONS_STORE, { keyPath: "seq", autoIncrement: true })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error("Could not open the push queue"))
  })

/** Every queued notification response, oldest first. Non-destructive. */
export const readQueuedReminderActions = async (): Promise<ReadonlyArray<QueuedReminderAction>> => {
  if (globalThis.indexedDB === undefined) return []
  const db = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const request = db
        .transaction(PUSH_ACTIONS_STORE, "readonly")
        .objectStore(PUSH_ACTIONS_STORE)
        .getAll()
      request.onsuccess = () => resolve(request.result as QueuedReminderAction[])
      request.onerror = () => reject(request.error ?? new Error("Could not read the push queue"))
    })
  } finally {
    db.close()
  }
}
