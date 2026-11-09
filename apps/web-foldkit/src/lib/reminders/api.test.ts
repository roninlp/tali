import { Effect, Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { noReminderLink } from '@tali/domain'

import { API_URL } from '../config'
import type { ReminderDispatch } from './api'
import { fetchReminderInbox, respondToReminder } from './api'

/**
 * The plain-HTTP ledger client, ported from
 * `apps/web/src/lib/reminders/api.test.ts`. These pin the contracts the inbox
 * and the service-worker drain rely on: the inbox URL/query shape, the respond
 * body (including the preset snooze minutes), and error classification.
 */

const dispatch = (
  overrides: Partial<ReminderDispatch> = {},
): ReminderDispatch => ({
  id: '0192f0a0-0000-7000-8000-000000000101',
  reminderId: '0192f0a0-0000-7000-8000-000000000102',
  userId: '0192f0a0-0000-7000-8000-000000000001',
  scheduledFor: '2026-10-20T08:00:00.000Z',
  deliverAt: '2026-10-20T08:00:00.000Z',
  rootScheduledFor: '2026-10-20T08:00:00.000Z',
  origin: 'schedule',
  pushOutcome: 'accepted',
  attempts: 1,
  lastAttemptAt: '2026-10-20T08:00:05.000Z',
  parentDispatchId: null,
  response: null,
  respondedAt: null,
  snoozedUntil: null,
  createdAt: '2026-10-20T08:00:00.000Z',
  ...overrides,
})

const jsonResponse = (body: Schema.Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchReminderInbox', () => {
  it('requests the inbox with history/limit and decodes the items', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({
        items: [
          {
            dispatch: dispatch(),
            reminderId: '0192f0a0-0000-7000-8000-000000000102',
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

    vi.stubGlobal('fetch', fetchMock)

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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 401)),
    )
    const result = await Effect.runPromise(fetchReminderInbox())
    expect(result).toEqual({
      ok: false,
      error: { code: 'Unauthorized', retryable: false },
    })
  })

  it('maps a transport failure to a retryable Network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    const result = await Effect.runPromise(fetchReminderInbox())
    expect(result).toEqual({
      ok: false,
      error: { code: 'Network', retryable: true },
    })
  })
})

describe('respondToReminder', () => {
  it('posts Done and decodes the answered dispatch', async () => {
    const answered = dispatch({
      response: 'done',
      respondedAt: '2026-10-20T08:10:00.000Z',
    })

    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ dispatch: answered, child: null, onTime: true }),
    )

    vi.stubGlobal('fetch', fetchMock)

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
    const parent = dispatch({
      response: 'snooze',
      snoozedUntil: '2026-10-20T08:15:00.000Z',
    })

    const child = dispatch({
      id: '0192f0a0-0000-7000-8000-000000000103',
      scheduledFor: '2026-10-20T08:15:00.000Z',
      deliverAt: '2026-10-20T08:15:00.000Z',
      origin: `snooze:${parent.id}`,
      parentDispatchId: parent.id,
    })

    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ dispatch: parent, child, onTime: false }),
    )

    vi.stubGlobal('fetch', fetchMock)

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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 404)),
    )

    const result = await Effect.runPromise(
      respondToReminder({
        dispatchId: '0192f0a0-0000-7000-8000-000000000101',
        response: 'dismiss',
      }),
    )

    expect(result).toEqual({
      ok: false,
      error: { code: 'NotFound', retryable: false },
    })
  })
})
