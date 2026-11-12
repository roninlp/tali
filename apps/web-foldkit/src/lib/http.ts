import { Effect, Option, Schema } from 'effect'

import { API_URL } from './config'

/**
 * The one plain-HTTP JSON client behind the app's hand-rolled read models.
 *
 * Several routes ride plain `fetch` rather than Effect RPC: auth, because the
 * session cookie is set and cleared by the raw response; the dashboard, week,
 * and month read models, because they need real HTTP caching (`If-None-Match`
 * answered by a 304); preferences, note search, reminders, and push
 * registration, because they are not aggregate mutations. They all shared the
 * same skeleton — timeout, cookie, JSON decode, status classification, schema
 * decode — so it lives here once.
 *
 * Failures are values, never exceptions. A transport failure or the abort
 * timeout is the caller's `networkFailure`; an unreadable or non-JSON body
 * reaches `classify` as `undefined`; a body that does not match the caller's
 * schema is `decodeFailure`. Callers map those onto their own failure type, so
 * this module never imports a feature module.
 */

/** No request may hang the boot splash or disable a form forever. */
export const REQUEST_TIMEOUT_MS = 15_000

export type HttpResult<A, F> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: F }

/**
 * A conditional GET's answer: the caller keeps painting its mirror on a 304,
 * and decodes a fresh payload only when the representation changed.
 */
export type CachedHttpResult<A, F> =
  | {
      readonly ok: true
      readonly notModified: true
      readonly maybeEtag: Option.Option<string>
    }
  | {
      readonly ok: true
      readonly notModified: false
      readonly model: A
      readonly maybeEtag: Option.Option<string>
    }
  | { readonly ok: false; readonly error: F }

/**
 * A value `JSON.stringify` turns into the request body. Looser than
 * `Schema.Json` only where a patch struct's optional properties are
 * `undefined`: `JSON.stringify` drops those keys.
 */
export type JsonBody =
  | Schema.Json
  | { readonly [key: string]: JsonBody | undefined }
  | ReadonlyArray<JsonBody>

export interface JsonRequest<A, F> {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  readonly path: string
  readonly schema: Schema.ConstraintDecoder<A>
  readonly body?: JsonBody | undefined
  readonly query?: Readonly<Record<string, Option.Option<string>>>
  readonly headers?: Readonly<Record<string, string>>
  readonly cache?: RequestCache
  readonly classify: (status: number, body: Schema.Json | undefined) => F
  readonly networkFailure: F
  readonly decodeFailure: F
}

export interface CachedJsonRequest<A, F> extends Omit<
  JsonRequest<A, F>,
  'body' | 'method'
> {
  readonly maybeEtag: Option.Option<string>
}

const queryString = (
  query: Readonly<Record<string, Option.Option<string>>> | undefined,
): string => {
  if (query === undefined) {
    return ''
  }

  const params = new URLSearchParams()

  Object.entries(query).forEach(([key, maybeValue]) => {
    if (Option.isSome(maybeValue) && maybeValue.value !== '') {
      params.set(key, maybeValue.value)
    }
  })

  const encoded = params.toString()

  return encoded === '' ? '' : `?${encoded}`
}

const urlFor = (
  path: string,
  query: Readonly<Record<string, Option.Option<string>>> | undefined,
): string => `${API_URL}${path}${queryString(query)}`

const initFor = <A, F>(
  request: JsonRequest<A, F>,
  fallbackCache: RequestCache | undefined,
  maybeEtag: Option.Option<string>,
): RequestInit => {
  const headerEntries = Object.entries(request.headers ?? {})

  if (request.body !== undefined) {
    headerEntries.push(['content-type', 'application/json'])
  }

  if (Option.isSome(maybeEtag)) {
    headerEntries.push(['if-none-match', maybeEtag.value])
  }

  const cache = request.cache ?? fallbackCache

  const init: RequestInit = {
    method: request.method ?? 'GET',
    credentials: 'include',
    headers: Object.fromEntries(headerEntries),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }

  if (cache !== undefined) {
    init.cache = cache
  }

  if (request.body !== undefined) {
    init.body = JSON.stringify(request.body)
  }

  return init
}

const send = <A, F>(
  request: JsonRequest<A, F>,
  fallbackCache: RequestCache | undefined,
  maybeEtag: Option.Option<string>,
): Effect.Effect<Option.Option<Response>> =>
  Effect.option(
    Effect.tryPromise({
      try: () =>
        fetch(
          urlFor(request.path, request.query),
          initFor(request, fallbackCache, maybeEtag),
        ),
      catch: () => request.networkFailure,
    }),
  )

const readJson = (
  response: Response,
): Effect.Effect<Option.Option<Schema.Json>> =>
  Effect.gen(function* () {
    const maybeBody = yield* Effect.option(
      Effect.tryPromise({
        try: () => response.json(),
        catch: () => undefined,
      }),
    )

    return Option.flatMap(maybeBody, value =>
      Schema.decodeUnknownOption(Schema.Json)(value),
    )
  })

const settle = <A, F>(
  request: JsonRequest<A, F>,
  response: Response,
): Effect.Effect<HttpResult<A, F>> =>
  Effect.gen(function* () {
    const maybeJson = yield* readJson(response)

    if (!response.ok) {
      return {
        ok: false,
        error: request.classify(
          response.status,
          Option.getOrUndefined(maybeJson),
        ),
      }
    }

    const decoded = Option.flatMap(maybeJson, json =>
      Schema.decodeOption(request.schema)(json),
    )

    return Option.isSome(decoded)
      ? { ok: true, value: decoded.value }
      : { ok: false, error: request.decodeFailure }
  })

/** One request/response exchange whose success body decodes to `A`. */
export const requestJson = <A, F>(
  request: JsonRequest<A, F>,
): Effect.Effect<HttpResult<A, F>> =>
  Effect.gen(function* () {
    const maybeResponse = yield* send(request, undefined, Option.none())

    if (Option.isNone(maybeResponse)) {
      return { ok: false, error: request.networkFailure }
    }

    return yield* settle(request, maybeResponse.value)
  })

/**
 * A conditional GET: the caller's ETag rides `If-None-Match`, and a 304 is
 * answered before any decode. `cache: 'no-cache'` is the default so the browser
 * revalidates instead of serving a stale copy; callers may override it.
 */
export const requestCachedJson = <A, F>(
  request: CachedJsonRequest<A, F>,
): Effect.Effect<CachedHttpResult<A, F>> =>
  Effect.gen(function* () {
    const maybeResponse = yield* send(request, 'no-cache', request.maybeEtag)

    if (Option.isNone(maybeResponse)) {
      return { ok: false, error: request.networkFailure }
    }

    const response = maybeResponse.value
    const maybeResponseEtag = Option.fromNullishOr(response.headers.get('etag'))

    const maybeEtag = Option.isSome(maybeResponseEtag)
      ? maybeResponseEtag
      : request.maybeEtag

    if (response.status === 304) {
      return { ok: true, notModified: true, maybeEtag }
    }

    const result = yield* settle(request, response)

    return result.ok
      ? { ok: true, notModified: false, model: result.value, maybeEtag }
      : result
  })
