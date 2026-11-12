import { describe, expect, it } from 'vitest'
import { Effect, Schema } from 'effect'
import {
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/http'
import {
  cacheHeaders,
  conditionalJson,
  etagOf,
  fail,
  json,
  malformed,
  matchesIfNoneMatch,
  requestUrl,
  SESSION_COOKIE,
  unexpectedFailure,
} from '../src/http-envelope.js'

/**
 * The one plain-HTTP envelope every non-RPC route shares. These pin the parts
 * the routes depend on: an uncacheable body, the `ErrorEnvelope` shape (with
 * `details`), the 400-vs-retryable-500 mapping, the `If-None-Match` comparison
 * and the 200↔304 exchange, and the absolute URL derivation that keeps
 * `new URL(request.url)` from throwing on a query string.
 */

/** Run an effect to its web `Response`, the seam a route's output comes out of. */
const web = (
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse>,
): Promise<Response> =>
  Effect.runPromise(Effect.map(effect, HttpServerResponse.toWeb))

const requestWith = (
  path: string,
  headers: Record<string, string> = {},
): HttpServerRequest.HttpServerRequest =>
  HttpServerRequest.fromWeb(new Request(`http://localhost${path}`, { headers }))

/** A real `SchemaError`, as `schemaBodyJson` would raise for a bad body. */
const schemaError = (): unknown =>
  Effect.runSync(Effect.flip(Schema.decodeUnknownEffect(Schema.String)(1)))

describe('json', () => {
  it('serializes the body at the given status and forbids caching', async () => {
    const response = await web(json(201, { ok: true }))

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true })
  })
})

describe('fail', () => {
  it('writes the shared error envelope with empty details by default', async () => {
    const response = await web(fail(401, 'Unauthorized', 'No active session'))

    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      error: {
        code: 'Unauthorized',
        message: 'No active session',
        retryable: false,
        details: {},
      },
    })
  })

  it('carries retryable and machine-readable details', async () => {
    const response = await web(
      fail(429, 'RateLimited', 'Too many attempts', true, {
        retryAfterSeconds: 30,
      }),
    )

    expect(await response.json()).toEqual({
      error: {
        code: 'RateLimited',
        message: 'Too many attempts',
        retryable: true,
        details: { retryAfterSeconds: 30 },
      },
    })
  })
})

describe('malformed', () => {
  it('answers 400 with the given message, whatever the error was', async () => {
    const response = await web(
      malformed('Malformed request body')(new Error('boom')),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: 'BadRequest',
        message: 'Malformed request body',
        retryable: false,
        details: {},
      },
    })
  })
})

describe('unexpectedFailure', () => {
  it('maps a schema error to a 400 carrying the route message', async () => {
    const response = await web(
      unexpectedFailure('Malformed preferences')(schemaError()),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: 'BadRequest',
        message: 'Malformed preferences',
        retryable: false,
        details: {},
      },
    })
  })

  it('defaults the 400 message to "Malformed request"', async () => {
    const response = await web(unexpectedFailure()(schemaError()))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: 'BadRequest',
        message: 'Malformed request',
        retryable: false,
        details: {},
      },
    })
  })

  it('maps anything else to a retryable 500', async () => {
    const response = await web(unexpectedFailure()(new Error('boom')))

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: {
        code: 'InternalError',
        message: 'Unexpected server error',
        retryable: true,
        details: {},
      },
    })
  })

  it('maps a request-parse error to a 400 carrying the route message', async () => {
    const response = await web(
      unexpectedFailure('Malformed preferences')(
        new HttpServerError.HttpServerError({
          reason: new HttpServerError.RequestParseError({
            request: requestWith('/preferences'),
          }),
        }),
      ),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: 'BadRequest',
        message: 'Malformed preferences',
        retryable: false,
        details: {},
      },
    })
  })

  it('maps a missing route to a 404', async () => {
    const response = await web(
      unexpectedFailure()(
        new HttpServerError.HttpServerError({
          reason: new HttpServerError.RouteNotFound({
            request: requestWith('/nowhere'),
          }),
        }),
      ),
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: {
        code: 'NotFound',
        message: 'No such route',
        retryable: false,
        details: {},
      },
    })
  })

  it('maps an InternalError to a retryable 500, not a 400', async () => {
    const response = await web(
      unexpectedFailure()(
        new HttpServerError.HttpServerError({
          reason: new HttpServerError.InternalError({
            request: requestWith('/today'),
          }),
        }),
      ),
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: {
        code: 'InternalError',
        message: 'Unexpected server error',
        retryable: true,
        details: {},
      },
    })
  })

  it('maps a ResponseError to a retryable 500, not a 400', async () => {
    const response = await web(
      unexpectedFailure()(
        new HttpServerError.HttpServerError({
          reason: new HttpServerError.ResponseError({
            request: requestWith('/today'),
            response: HttpServerResponse.empty(),
          }),
        }),
      ),
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: {
        code: 'InternalError',
        message: 'Unexpected server error',
        retryable: true,
        details: {},
      },
    })
  })
})

describe('matchesIfNoneMatch', () => {
  const etag = '"abc"'

  it('matches a strong tag', () => {
    expect(matchesIfNoneMatch('"abc"', etag)).toBe(true)
    expect(matchesIfNoneMatch('"def"', etag)).toBe(false)
  })

  it('matches a weak tag against a strong one', () => {
    expect(matchesIfNoneMatch('W/"abc"', etag)).toBe(true)
  })

  it('matches any member of a comma-separated list', () => {
    expect(matchesIfNoneMatch('"def", W/"abc"', etag)).toBe(true)
    expect(matchesIfNoneMatch('"def", "ghi"', etag)).toBe(false)
  })

  it('treats * as a match', () => {
    expect(matchesIfNoneMatch('*', etag)).toBe(true)
  })
})

describe('conditionalJson', () => {
  const body = { items: [1, 2, 3] }

  it('answers 200 with the ETag and per-session cache headers', async () => {
    const etag = await Effect.runPromise(etagOf(body))
    const response = await web(conditionalJson(requestWith('/today'), body))

    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe(etag)
    expect(response.headers.get('cache-control')).toBe('private, no-cache')
    expect(response.headers.get('vary')).toBe('cookie')
    expect(await response.json()).toEqual(body)
  })

  it('answers 304 with no body when If-None-Match matches', async () => {
    const etag = await Effect.runPromise(etagOf(body))
    const response = await web(
      conditionalJson(requestWith('/today', { 'if-none-match': etag }), body),
    )

    expect(response.status).toBe(304)
    expect(response.headers.get('etag')).toBe(etag)
    expect(response.headers.get('cache-control')).toBe('private, no-cache')
    expect(response.body).toBeNull()
  })

  it('answers 200 when the tag no longer matches', async () => {
    const response = await web(
      conditionalJson(
        requestWith('/today', { 'if-none-match': '"stale"' }),
        body,
      ),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(body)
  })
})

describe('etagOf / cacheHeaders', () => {
  it('hashes the encoded body into a strong tag', async () => {
    const etag = await Effect.runPromise(etagOf({ a: 1 }))

    expect(etag).toMatch(/^"[0-9a-f]{64}"$/)
    expect(await Effect.runPromise(etagOf({ a: 1 }))).toBe(etag)
    expect(await Effect.runPromise(etagOf({ a: 2 }))).not.toBe(etag)
    expect(cacheHeaders(etag)).toEqual({
      etag,
      'cache-control': 'private, no-cache',
      vary: 'cookie',
    })
  })
})

describe('requestUrl', () => {
  it('derives an absolute URL from the host header, preserving the query', () => {
    const url = requestUrl(
      requestWith('/week?anchor=2024-01-01&day=2024-01-05', {
        host: 'tali.example',
      }),
    )

    expect(url.origin).toBe('http://tali.example')
    expect(url.pathname).toBe('/week')
    expect(url.searchParams.get('anchor')).toBe('2024-01-01')
    expect(url.searchParams.get('day')).toBe('2024-01-05')
  })

  it('falls back to localhost when no host header is present', () => {
    const url = requestUrl(requestWith('/reminders/inbox?limit=50'))

    expect(url.origin).toBe('http://localhost')
    expect(url.pathname).toBe('/reminders/inbox')
    expect(url.searchParams.get('limit')).toBe('50')
  })
})

describe('SESSION_COOKIE', () => {
  it('is the one cookie name every plain-HTTP route reads', () => {
    expect(SESSION_COOKIE).toBe('tali_session')
  })
})
