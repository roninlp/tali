import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { noReminderLink } from '@tali/domain'

import { jsonResponse, stubFetch } from '../../test-http'
import { API_URL } from '../config'
import { fetchReminderInbox, respondToReminder } from './api'
import {
  CHILD_DISPATCH_ID,
  DISPATCH_ID,
  REMINDER_ID,
  dispatchRow,
} from './fixtures'

/**
 * The plain-HTTP ledger client, ported from
 * `apps/web/src/lib/reminders/api.test.ts`. These pin the contracts the inbox
 * and the service-worker drain rely on: the inbox URL/query shape, the respond
 * body (including the preset snooze minutes), and error classification.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchReminderInbox', () => {
  it('requests the inbox with history/limit and decodes the items', async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, {
        items: [
          {
            dispatch: dispatchRow(),
            reminderId: REMINDER_ID,
            title: 'دارو',
            note: 'یک قرص',
            kind: 'medication',
            tier: 'critical',
            link: noReminderLink(),
            visibility: 'private',
            state: 'inbox',
          },
        ],
      }),
    )

    const result = await Effect.runPromise(
      fetchReminderInbox({ history: true, limit: 25 }),
    )

    expect(result.ok).toBe(true)

    if (!result.ok) {
      return
    }

    expect(result.value).toHaveLength(1)
    expect(result.value[0]).toMatchObject({
      title: 'دارو',
      tier: 'critical',
      state: 'inbox',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]
    expect(call?.[0]).toBe(`${API_URL}/reminders/inbox?history=1&limit=25`)
    expect(call?.[1]?.credentials).toBe('include')
  })

  it('maps a 401 to a non-retryable Unauthorized failure', async () => {
    stubFetch(jsonResponse(401, {}))
    const result = await Effect.runPromise(fetchReminderInbox())
    expect(result).toEqual({
      ok: false,
      error: { code: 'Unauthorized', retryable: false },
    })
  })

  it('maps a transport failure to a retryable Network failure', async () => {
    stubFetch(new TypeError('offline'))
    const result = await Effect.runPromise(fetchReminderInbox())
    expect(result).toEqual({
      ok: false,
      error: { code: 'Network', retryable: true },
    })
  })
})

describe('respondToReminder', () => {
  it('posts Done and decodes the answered dispatch', async () => {
    const answered = dispatchRow({
      response: 'done',
      respondedAt: '2026-10-20T08:10:00.000Z',
    })

    const fetchMock = stubFetch(
      jsonResponse(200, { dispatch: answered, child: null, onTime: true }),
    )

    const result = await Effect.runPromise(
      respondToReminder({ dispatchId: answered.id, response: 'done' }),
    )

    expect(result.ok).toBe(true)

    if (!result.ok) {
      return
    }

    expect(result.value.dispatch.response).toBe('done')
    expect(result.value.onTime).toBe(true)
    const call = fetchMock.mock.calls[0]
    expect(call?.[0]).toBe(
      `${API_URL}/reminders/dispatches/${encodeURIComponent(answered.id)}/respond`,
    )
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ response: 'done' })
  })

  it('sends the snooze preset in the body', async () => {
    const parent = dispatchRow({
      response: 'snooze',
      snoozedUntil: '2026-10-20T08:15:00.000Z',
    })

    const child = dispatchRow({
      id: CHILD_DISPATCH_ID,
      scheduledFor: '2026-10-20T08:15:00.000Z',
      deliverAt: '2026-10-20T08:15:00.000Z',
      origin: `snooze:${parent.id}`,
      parentDispatchId: parent.id,
    })

    const fetchMock = stubFetch(
      jsonResponse(200, { dispatch: parent, child, onTime: false }),
    )

    const result = await Effect.runPromise(
      respondToReminder({
        dispatchId: parent.id,
        response: 'snooze',
        snoozeMinutes: 15,
      }),
    )

    expect(result.ok).toBe(true)
    const call = fetchMock.mock.calls[0]
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      response: 'snooze',
      snoozeMinutes: 15,
    })
  })

  it('maps a 404 to NotFound', async () => {
    stubFetch(jsonResponse(404, {}))

    const result = await Effect.runPromise(
      respondToReminder({
        dispatchId: DISPATCH_ID,
        response: 'dismiss',
      }),
    )

    expect(result).toEqual({
      ok: false,
      error: { code: 'NotFound', retryable: false },
    })
  })
})
