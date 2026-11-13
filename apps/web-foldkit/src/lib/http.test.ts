import { Effect, Option, Schema } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { jsonResponse, stubFetch } from '../test-http'
import { API_URL } from './config'
import { requestCachedJson, requestJson } from './http'

/**
 * The shared plain-HTTP client. These pin the contract every migrated module
 * relies on: the cookie and timeout on every call, the JSON body only when one
 * was given, the status classifier fed the decoded body, and the conditional
 * GET answered from a 304 (or its ETag header) before any decode.
 */

const Payload = Schema.Struct({ value: Schema.String })

interface TestFailure {
  readonly reason: string
}

const networkFailure: TestFailure = { reason: 'network' }
const decodeFailure: TestFailure = { reason: 'decode' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('requestJson', () => {
  test('decodes a success body and sends the cookie', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { value: 'hello' }))

    const result = await Effect.runPromise(
      requestJson({
        path: '/thing',
        schema: Payload,
        classify: () => ({ reason: 'unexpected' }),
        networkFailure,
        decodeFailure,
      }),
    )

    expect(result).toStrictEqual({ ok: true, value: { value: 'hello' } })
    const call = fetchMock.mock.calls[0]
    expect(call?.[0]).toBe(`${API_URL}/thing`)
    expect(call?.[1]).toMatchObject({
      method: 'GET',
      credentials: 'include',
    })
    expect(call?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(call?.[1]?.headers).toStrictEqual({})
  })

  test('sends a JSON body and content type only when one is given', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { value: 'hello' }))

    await Effect.runPromise(
      requestJson({
        method: 'POST',
        path: '/thing',
        schema: Payload,
        body: { value: 'sent' },
        classify: () => ({ reason: 'unexpected' }),
        networkFailure,
        decodeFailure,
      }),
    )

    const init = fetchMock.mock.calls[0]?.[1]
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    expect(JSON.parse(String(init?.body))).toStrictEqual({ value: 'sent' })
  })

  test('classifies a non-2xx answer with its decoded body', async () => {
    const classify = vi.fn((status: number) => ({ reason: `status:${status}` }))

    stubFetch(jsonResponse(409, { error: { code: 'Conflict' } }))

    const result = await Effect.runPromise(
      requestJson({
        path: '/thing',
        schema: Payload,
        classify,
        networkFailure,
        decodeFailure,
      }),
    )

    expect(result).toStrictEqual({ ok: false, error: { reason: 'status:409' } })
    expect(classify).toHaveBeenCalledWith(409, { error: { code: 'Conflict' } })
  })

  test('hands the classifier undefined when the body is not JSON', async () => {
    const classify = vi.fn((status: number) => ({ reason: `status:${status}` }))

    stubFetch(new Response('<html>nope</html>', { status: 502 }))

    const result = await Effect.runPromise(
      requestJson({
        path: '/thing',
        schema: Payload,
        classify,
        networkFailure,
        decodeFailure,
      }),
    )

    expect(result).toStrictEqual({ ok: false, error: { reason: 'status:502' } })
    expect(classify).toHaveBeenCalledWith(502, undefined)
  })

  test('reports a success body that does not decode as the decode failure', async () => {
    stubFetch(jsonResponse(200, { value: 42 }))

    const result = await Effect.runPromise(
      requestJson({
        path: '/thing',
        schema: Payload,
        classify: () => ({ reason: 'unexpected' }),
        networkFailure,
        decodeFailure,
      }),
    )

    expect(result).toStrictEqual({ ok: false, error: decodeFailure })
  })

  test('reports a transport rejection as the network failure', async () => {
    const fetchMock = stubFetch(new TypeError('offline'))

    const result = await Effect.runPromise(
      requestJson({
        path: '/thing',
        schema: Payload,
        classify: () => ({ reason: 'unexpected' }),
        networkFailure,
        decodeFailure,
      }),
    )

    expect(result).toStrictEqual({ ok: false, error: networkFailure })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('appends only the query values that are present and non-empty', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { value: 'hello' }))

    await Effect.runPromise(
      requestJson({
        path: '/month',
        schema: Payload,
        query: {
          anchor: Option.some('2026-10-20'),
          day: Option.none(),
          empty: Option.some(''),
        },
        classify: () => ({ reason: 'unexpected' }),
        networkFailure,
        decodeFailure,
      }),
    )

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${API_URL}/month?anchor=2026-10-20`,
    )
  })

  test('sends no query string when every value is absent', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { value: 'hello' }))

    await Effect.runPromise(
      requestJson({
        path: '/month',
        schema: Payload,
        query: { day: Option.none() },
        classify: () => ({ reason: 'unexpected' }),
        networkFailure,
        decodeFailure,
      }),
    )

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${API_URL}/month`)
  })
})

describe('requestCachedJson', () => {
  test('answers a 304 with the response ETag and no decode', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 304 }))

    const result = await Effect.runPromise(
      requestCachedJson({
        path: '/today',
        schema: Payload,
        maybeEtag: Option.some('W/"old"'),
        classify: () => ({ reason: 'unexpected' }),
        networkFailure,
        decodeFailure,
      }),
    )

    expect(result).toStrictEqual({
      ok: true,
      notModified: true,
      maybeEtag: Option.some('W/"old"'),
    })
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-cache',
      headers: { 'if-none-match': 'W/"old"' },
    })
  })

  test('prefers the ETag the response carries over the caller one', async () => {
    stubFetch(new Response(null, { status: 304, headers: { etag: 'W/"new"' } }))

    const result = await Effect.runPromise(
      requestCachedJson({
        path: '/week',
        schema: Payload,
        maybeEtag: Option.some('W/"old"'),
        classify: () => ({ reason: 'unexpected' }),
        networkFailure,
        decodeFailure,
      }),
    )

    expect(result).toStrictEqual({
      ok: true,
      notModified: true,
      maybeEtag: Option.some('W/"new"'),
    })
  })

  test('decodes a changed representation and keeps its ETag', async () => {
    stubFetch(jsonResponse(200, { value: 'fresh' }, 'W/"fresh"'))

    const result = await Effect.runPromise(
      requestCachedJson({
        path: '/week',
        schema: Payload,
        maybeEtag: Option.none(),
        classify: () => ({ reason: 'unexpected' }),
        networkFailure,
        decodeFailure,
      }),
    )

    expect(result).toStrictEqual({
      ok: true,
      notModified: false,
      model: { value: 'fresh' },
      maybeEtag: Option.some('W/"fresh"'),
    })
  })

  test('keeps the failure branches the plain client reports', async () => {
    stubFetch(new TypeError('offline'))

    const result = await Effect.runPromise(
      requestCachedJson({
        path: '/today',
        schema: Payload,
        maybeEtag: Option.none(),
        classify: () => ({ reason: 'unexpected' }),
        networkFailure,
        decodeFailure,
      }),
    )

    expect(result).toStrictEqual({ ok: false, error: networkFailure })
  })
})
