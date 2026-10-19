import { afterEach, describe, expect, it } from "vitest"
import "fake-indexeddb/auto"
import {
  PUSH_ACTIONS_STORE,
  PUSH_DB_NAME,
  readQueuedReminderActions,
  type QueuedReminderAction
} from "./notification-actions"

/**
 * The page-side reader must agree with the service worker's queue. These tests
 * open the same database/store shape `public/sw.js` creates.
 */

const deleteDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.deleteDatabase(PUSH_DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error("delete failed"))
  })

const seed = (records: ReadonlyArray<Omit<QueuedReminderAction, "seq">>): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(PUSH_DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PUSH_ACTIONS_STORE)) {
        db.createObjectStore(PUSH_ACTIONS_STORE, { keyPath: "seq", autoIncrement: true })
      }
    }
    request.onerror = () => reject(request.error ?? new Error("open failed"))
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction(PUSH_ACTIONS_STORE, "readwrite")
      for (const record of records) transaction.objectStore(PUSH_ACTIONS_STORE).add(record)
      transaction.oncomplete = () => {
        db.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error ?? new Error("seed failed"))
    }
  })

afterEach(async () => {
  await deleteDatabase()
})

describe("queued reminder actions", () => {
  it("reads an empty queue", async () => {
    expect(await readQueuedReminderActions()).toEqual([])
  })

  it("reads Done/Snooze taps oldest first", async () => {
    await seed([
      { reminderId: "reminder-1", action: "done", at: "2026-10-19T08:00:00.000Z" },
      { reminderId: "reminder-2", action: "snooze", at: "2026-10-19T08:05:00.000Z" }
    ])

    const queued = await readQueuedReminderActions()
    expect(queued).toHaveLength(2)
    expect(queued[0]).toMatchObject({ reminderId: "reminder-1", action: "done" })
    expect(queued[1]).toMatchObject({ reminderId: "reminder-2", action: "snooze" })
  })
})
