import { Effect } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { Email, LoginKey } from '@tali/domain'

import { sessionWithHousehold } from '../test-fixtures'
import { authApi } from './auth-api'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const stubFetch = (response: Response | Error) => {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => {
      if (response instanceof Error) {
        throw response
      }

      return response
    },
  )
  vi.stubGlobal('fetch', fetchMock)

  return fetchMock
}

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('auth api', () => {
  test('reads the session with the cookie included', async () => {
    const fetchMock = stubFetch(jsonResponse(200, sessionWithHousehold))

    const result = await run(authApi.me())

    expect(result).toStrictEqual({
      ok: true,
      value: sessionWithHousehold,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/me'),
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
      }),
    )
  })

  test('posts the login key as JSON', async () => {
    const fetchMock = stubFetch(jsonResponse(200, sessionWithHousehold))

    const result = await run(
      authApi.login({
        email: Email.make('owner@example.com'),
        loginKey: LoginKey.make('a'.repeat(43)),
      }),
    )

    expect(result.ok).toBe(true)
    const init = fetchMock.mock.calls[0]?.[1]
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
    })
    expect(JSON.parse(String(init?.body))).toMatchObject({
      email: 'owner@example.com',
      loginKey: 'a'.repeat(43),
    })
  })

  test('decodes the shared error envelope', async () => {
    stubFetch(
      jsonResponse(401, {
        error: {
          code: 'InvalidCredentials',
          message: 'Email or login key is incorrect',
          retryable: false,
          details: {},
        },
      }),
    )

    const result = await run(authApi.me())

    expect(result).toStrictEqual({
      ok: false,
      error: { code: 'InvalidCredentials', retryable: false },
    })
  })

  test('falls back to Unauthorized for a bare 401', async () => {
    stubFetch(jsonResponse(401, {}))

    const result = await run(authApi.me())

    expect(result).toStrictEqual({
      ok: false,
      error: { code: 'Unauthorized', retryable: false },
    })
  })

  test('reports a transport failure as a retryable network error', async () => {
    stubFetch(new TypeError('network down'))

    const result = await run(authApi.me())

    expect(result).toStrictEqual({
      ok: false,
      error: { code: 'Network', retryable: true },
    })
  })

  test('reports a server failure as a retryable internal error', async () => {
    stubFetch(new Response('boom', { status: 500 }))

    const result = await run(authApi.me())

    expect(result).toStrictEqual({
      ok: false,
      error: { code: 'InternalError', retryable: true },
    })
  })

  test('rejects a success body that does not decode', async () => {
    stubFetch(jsonResponse(200, { user: { id: 'x' } }))

    const result = await run(authApi.me())

    expect(result).toStrictEqual({
      ok: false,
      error: { code: 'InternalError', retryable: false },
    })
  })

  test('returns the decoded session context', async () => {
    stubFetch(jsonResponse(200, sessionWithHousehold))

    const result = await run(authApi.me())

    if (result.ok) {
      expect(result.value).toStrictEqual(sessionWithHousehold)
    } else {
      throw new Error('Expected the session to decode')
    }
  })
})
