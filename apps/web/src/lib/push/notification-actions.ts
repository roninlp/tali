import type { ReminderNotificationAction } from "@tali/domain"

/**
 * The page half of the Done/Snooze wiring (tickets #20, #61).
 *
 * The service worker cannot own the signed-in session's UI state, so on a
 * notification action it appends a durable record to this device-local queue
 * and tries to flush it immediately. This module is the **page drain**: on
 * boot, on `visibilitychange`, and when the worker messages that a tap landed,
 * the app reads the queue and posts each answer to the existing
 * `POST /reminders/dispatches/:id/respond` route.
 *
 * `id` in the queue is the **dispatch id**, not the reminder id: one fire is
 * one ledger row and one answer, and a snoozed occurrence must not answer the
 * earlier one. A record is deleted only after the server accepted it (or said
 * the dispatch does not exist), so an offline tap survives until the next open.
 *
 * Keep the database/store names in sync with `apps/web/public/sw.js`.
 */

export const PUSH_DB_NAME = "tali.push.v1"
export const PUSH_ACTIONS_STORE = "actions"

export interface QueuedReminderAction {
  /** IndexedDB auto-increment key (absent on freshly written records). */
  readonly seq?: number
  /** The ledger row the notification represented. */
  readonly dispatchId: string
  readonly action: ReminderNotificationAction
  /** Preset minutes for a `snooze` tap (the notification's default is 10). */
  readonly snoozeMinutes?: number
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

const deleteQueuedReminderAction = async (seq: number): Promise<void> => {
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(PUSH_ACTIONS_STORE, "readwrite")
      transaction.objectStore(PUSH_ACTIONS_STORE).delete(seq)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not drain the queue"))
    })
  } finally {
    db.close()
  }
}

export interface FlushResult {
  /** Records the caller's `send` accepted (and that are now deleted). */
  readonly drained: number
  /** Records left for the next open (network/server failure). */
  readonly remaining: number
}

/**
 * Drain the queue through `send`.
 *
 * `send` returns `true` when the record is finished with (accepted, or
 * permanently unanswerable) and `false` to keep it. The default page wiring
 * passes `respondToReminder`; tests pass a fake, so the ordering and the
 * delete-on-success rule are provable without a server.
 */
export const flushQueuedReminderActions = async (
  send: (record: QueuedReminderAction) => Promise<boolean>
): Promise<FlushResult> => {
  const queued = await readQueuedReminderActions()
  let drained = 0
  for (const record of queued) {
    if (record.seq === undefined) continue
    const handled = await send(record)
    if (!handled) continue
    await deleteQueuedReminderAction(record.seq)
    drained += 1
  }
  return { drained, remaining: queued.length - drained }
}
