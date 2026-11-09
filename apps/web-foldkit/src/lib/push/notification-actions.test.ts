import { Effect } from 'effect'
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  PUSH_ACTIONS_STORE,
  PUSH_DB_NAME,
  type QueuedReminderAction,
  flushQueuedReminderActions,
  readQueuedReminderActions,
  respondToDispatch,
} from './notification-actions'

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
    request.onerror = () => reject(request.error ?? new Error('delete failed'))
  })

const seed = (
  records: ReadonlyArray<Omit<QueuedReminderAction, 'seq'>>,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(PUSH_DB_NAME, 1)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(PUSH_ACTIONS_STORE)) {
        db.createObjectStore(PUSH_ACTIONS_STORE, {
          keyPath: 'seq',
          autoIncrement: true,
        })
      }
    }

    request.onerror = () => reject(request.error ?? new Error('open failed'))
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction(PUSH_ACTIONS_STORE, 'readwrite')

      records.forEach(record => {
        transaction.objectStore(PUSH_ACTIONS_STORE).add(record)
      })

      transaction.oncomplete = () => {
        db.close()
        resolve()
      }

      transaction.onerror = () =>
        reject(transaction.error ?? new Error('seed failed'))
    }
  })

afterEach(async () => {
  vi.unstubAllGlobals()
  await deleteDatabase()
})

describe('queued reminder actions', () => {
  test('reads an empty queue', async () => {
    expect(await Effect.runPromise(readQueuedReminderActions)).toStrictEqual([])
  })

  test('reads Done/Snooze taps oldest first, keyed by dispatch id', async () => {
    await seed([
      {
        dispatchId: 'dispatch-1',
        action: 'done',
        at: '2026-10-19T08:00:00.000Z',
      },
      {
        dispatchId: 'dispatch-2',
        action: 'snooze',
        snoozeMinutes: 10,
        at: '2026-10-19T08:05:00.000Z',
      },
    ])

    const queued = await Effect.runPromise(readQueuedReminderActions)
    expect(queued).toHaveLength(2)
    expect(queued[0]).toMatchObject({
      dispatchId: 'dispatch-1',
      action: 'done',
    })
    expect(queued[1]).toMatchObject({
      dispatchId: 'dispatch-2',
      action: 'snooze',
      snoozeMinutes: 10,
    })
  })

  test('drains answers through the respond call and deletes only accepted ones', async () => {
    await seed([
      {
        dispatchId: 'dispatch-1',
        action: 'done',
        at: '2026-10-19T08:00:00.000Z',
      },
      {
        dispatchId: 'dispatch-2',
        action: 'snooze',
        snoozeMinutes: 5,
        at: '2026-10-19T08:05:00.000Z',
      },
    ])
    const posted: Array<QueuedReminderAction> = []

    const result = await Effect.runPromise(
      flushQueuedReminderActions(record => {
        posted.push(record)

        // The second one is offline: keep it queued for the next open.
        return Effect.succeed(record.dispatchId === 'dispatch-1')
      }),
    )

    expect(result).toStrictEqual({ drained: 1, remaining: 1 })
    expect(posted.map(record => record.dispatchId)).toStrictEqual([
      'dispatch-1',
      'dispatch-2',
    ])
    const left = await Effect.runPromise(readQueuedReminderActions)
    expect(left).toHaveLength(1)
    expect(left[0]).toMatchObject({
      dispatchId: 'dispatch-2',
      action: 'snooze',
      snoozeMinutes: 5,
    })
  })

  test('is idempotent: a second drain posts nothing once the queue is empty', async () => {
    await seed([
      {
        dispatchId: 'dispatch-1',
        action: 'done',
        at: '2026-10-19T08:00:00.000Z',
      },
    ])
    let calls = 0

    const send = () => {
      calls += 1

      return Effect.succeed(true)
    }

    expect(
      await Effect.runPromise(flushQueuedReminderActions(send)),
    ).toStrictEqual({ drained: 1, remaining: 0 })
    expect(
      await Effect.runPromise(flushQueuedReminderActions(send)),
    ).toStrictEqual({ drained: 0, remaining: 0 })
    expect(calls).toBe(1)
  })
})

describe('respondToDispatch', () => {
  const record: QueuedReminderAction = {
    seq: 1,
    dispatchId: 'dispatch/with spaces',
    action: 'snooze',
    snoozeMinutes: 5,
    at: '2026-10-19T08:05:00.000Z',
  }

  const respond = (response: Response) => {
    const fetchStub = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => response,
    )

    vi.stubGlobal('fetch', fetchStub)

    return fetchStub
  }

  test('posts the snooze minutes to the encoded respond route', async () => {
    const fetchStub = respond(new Response('{}', { status: 200 }))

    expect(await Effect.runPromise(respondToDispatch(record))).toBe(true)

    const [url, init] = fetchStub.mock.calls[0] ?? []
    expect(String(url)).toContain(
      '/reminders/dispatches/dispatch%2Fwith%20spaces/respond',
    )
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ response: 'snooze', snoozeMinutes: 5 }),
    })
  })

  test('a gone or malformed dispatch is finished with', async () => {
    respond(new Response('{}', { status: 404 }))
    expect(await Effect.runPromise(respondToDispatch(record))).toBe(true)

    respond(new Response('{}', { status: 400 }))
    expect(await Effect.runPromise(respondToDispatch(record))).toBe(true)
  })

  test('a server or network failure keeps the record for the next open', async () => {
    respond(new Response('{}', { status: 500 }))
    expect(await Effect.runPromise(respondToDispatch(record))).toBe(false)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down')
      }),
    )
    expect(await Effect.runPromise(respondToDispatch(record))).toBe(false)
  })
})
