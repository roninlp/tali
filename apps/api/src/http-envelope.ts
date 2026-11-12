import { Effect, Option, Schema } from 'effect'
import {
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/http'
import type { AuthErrorCode, SyncErrorCode } from '@tali/domain'
import { sha256Hex } from './bytes.js'

/**
 * The one plain-HTTP envelope for every non-RPC route (auth, sync, preferences,
 * push, reminders, the read models).
 *
 * These routes bypass Effect RPC because they need the raw request/response —
 * the HTTP-only session cookie, the raw `ETag`/`304` exchange — so they also
 * share one way of writing a response: a JSON body that is never cached, or the
 * shared `ErrorEnvelope` from `@tali/domain` (`docs/error-model-draft.md` §5.1)
 * carrying a stable `code`, a non-localized `message`, a `retryable` flag and
 * machine-readable `details`.
 *
 * The session cookie lives here too: it is the one credential every plain-HTTP
 * route authenticates with, so its name is declared once.
 */

export const SESSION_COOKIE = 'tali_session'

/** The generic codes the read models can answer with (not domain-specific). */
export type ReadFailureCode =
  | 'Unauthorized'
  | 'Forbidden'
  | 'NotFound'
  | 'BadRequest'
  | 'InternalError'

/**
 * Every stable client-facing code the plain-HTTP errors use. Auth and sync own
 * their own vocabularies in `@tali/domain`; this is their union, so one `fail`
 * helper serves all of them.
 */
export type ErrorCode = AuthErrorCode | SyncErrorCode | ReadFailureCode

/** Serialize a body and mark it uncacheable (these responses are per-session). */
export const json = (
  status: number,
  body: unknown,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.json(body, { status }).pipe(
    Effect.map(HttpServerResponse.setHeader('cache-control', 'no-store')),
    Effect.orDie,
  )

/** An error envelope with `no-store`, so a failure is never cached. */
export const fail = (
  status: number,
  code: ErrorCode,
  message: string,
  retryable = false,
  details: Record<string, unknown> = {},
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  json(status, { error: { code, message, retryable, details } })

/** A request the client got wrong: 400 with the route's own message. */
export const malformed =
  (
    message: string,
  ): ((
    error: unknown,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>) =>
  () =>
    fail(400, 'BadRequest', message)

/**
 * Maps non-domain failures: a schema or request-body error is the client's
 * fault (400, carrying the given message), anything else is a retryable 500.
 */
export const unexpectedFailure =
  (
    message = 'Malformed request',
  ): ((
    error: unknown,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>) =>
  error =>
    Schema.isSchemaError(error) || HttpServerError.isHttpServerError(error)
      ? malformed(message)(error)
      : fail(500, 'InternalError', 'Unexpected server error', true)

/** A strong hash of the encoded payload; the body alone determines the tag. */
export const etagOf = (body: unknown): Effect.Effect<string> =>
  sha256Hex(JSON.stringify(body)).pipe(Effect.map(hex => `"${hex}"`))

/**
 * `If-None-Match` uses the weak comparison function even for strong tags, so
 * `W/"x"` matches `"x"`. A comma-separated list and `*` are both legal.
 */
export const matchesIfNoneMatch = (header: string, etag: string): boolean => {
  const opaque = (value: string): string => value.trim().replace(/^W\//, '')
  return header
    .split(',')
    .some(
      candidate =>
        candidate.trim() === '*' || opaque(candidate) === opaque(etag),
    )
}

export const cacheHeaders = (etag: string): Record<string, string> => ({
  etag,
  'cache-control': 'private, no-cache',
  // The body is per-session; make that explicit for any intermediary.
  vary: 'cookie',
})

/**
 * Effect v4 keeps `HttpServerRequest.url` path-only (`/week?anchor=…`); the
 * absolute URL is derived from the `host`/`x-forwarded-proto` headers.
 * `new URL(request.url)` therefore throws on every request with a query.
 */
export const requestUrl = (request: HttpServerRequest.HttpServerRequest): URL =>
  Option.getOrElse(
    HttpServerRequest.toURL(request),
    () => new URL(request.url, 'http://localhost'),
  )

/** Compute the ETag, honour `If-None-Match`, and return `304` or a 200 body. */
export const conditionalJson = (
  request: HttpServerRequest.HttpServerRequest,
  body: unknown,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.gen(function* () {
    const etag = yield* etagOf(body)
    const headers = cacheHeaders(etag)
    const ifNoneMatch = request.headers['if-none-match']

    if (ifNoneMatch !== undefined && matchesIfNoneMatch(ifNoneMatch, etag)) {
      return HttpServerResponse.empty({ status: 304, headers })
    }

    return yield* HttpServerResponse.json(body, {
      status: 200,
      headers,
    }).pipe(Effect.orDie)
  })
