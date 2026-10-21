import { afterEach, describe, expect, it } from "vitest"
import "fake-indexeddb/auto"
import {
  PUSH_ACTIONS_STORE,
  PUSH_DB_NAME,
  flushQueuedReminderActions,
  readQueuedReminderActions,
  type QueuedReminderAction
} from "./notification-actions"

/**
 * The page-side reader/drain must agree with the service worker's queue. These
 * tests open the same database/store shape `public/sw.js` creates, and pin the
 * ticket #61 rule: a queued Done/Snooze is posted to the respond route and
 * deleted only when the caller says it is finished with.
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

  it("reads Done/Snooze taps oldest first, keyed by dispatch id", async () => {
    await seed([
      { dispatchId: "dispatch-1", action: "done", at: "2026-10-19T08:00:00.000Z" },
      {
        dispatchId: "dispatch-2",
        action: "snooze",
        snoozeMinutes: 10,
        at: "2026-10-19T08:05:00.000Z"
      }
    ])

    const queued = await readQueuedReminderActions()
    expect(queued).toHaveLength(2)
    expect(queued[0]).toMatchObject({ dispatchId: "dispatch-1", action: "done" })
    expect(queued[1]).toMatchObject({ dispatchId: "dispatch-2", action: "snooze", snoozeMinutes: 10 })
  })

  it("drains answers through the respond call and deletes only accepted ones", async () => {
    await seed([
      { dispatchId: "dispatch-1", action: "done", at: "2026-10-19T08:00:00.000Z" },
      { dispatchId: "dispatch-2", action: "snooze", snoozeMinutes: 5, at: "2026-10-19T08:05:00.000Z" }
    ])
    const posted: Array<QueuedReminderAction> = []

    const result = await flushQueuedReminderActions(async (record) => {
      posted.push(record)
      // The second one is offline: keep it queued for the next open.
      return record.dispatchId === "dispatch-1"
    })

    expect(result).toEqual({ drained: 1, remaining: 1 })
    expect(posted.map((record) => record.dispatchId)).toEqual(["dispatch-1", "dispatch-2"])
    const left = await readQueuedReminderActions()
    expect(left).toHaveLength(1)
    expect(left[0]).toMatchObject({ dispatchId: "dispatch-2", action: "snooze", snoozeMinutes: 5 })
  })

  it("is idempotent: a second drain posts nothing once the queue is empty", async () => {
    await seed([{ dispatchId: "dispatch-1", action: "done", at: "2026-10-19T08:00:00.000Z" }])
    let calls = 0
    const send = async () => {
      calls += 1
      return true
    }
    expect(await flushQueuedReminderActions(send)).toEqual({ drained: 1, remaining: 0 })
    expect(await flushQueuedReminderActions(send)).toEqual({ drained: 0, remaining: 0 })
    expect(calls).toBe(1)
  })
})
