import { Effect, Option, Schema } from 'effect'

import { AuthFailure, classifyApiFailure } from './auth-api'
import { CalendarMonthPayload, CalendarWeekPayload } from './calendar-data'
import { API_URL } from './config'

/**
 * The plain-HTTP week and month clients.
 *
 * Both reads carry the session cookie and the last ETag, so returning to a
 * window that has not changed is a real 304. Failures are values: the screen
 * keeps painting the mirror when the API is unreachable, exactly like
 * `/today`. `Network` means "could not reach the API", never "signed out".
 *
 * The response schemas are local and plain (no branded domain ids), matching
 * `today-api.ts`. Only the source rows are decoded; the day grids are rebuilt
 * locally through the domain builders.
 */

const REQUEST_TIMEOUT_MS = 15_000

export type CalendarFetchResult<A> =
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
  | { readonly ok: false; readonly error: AuthFailure }

const networkFailure = AuthFailure.make({ code: 'Network', retryable: true })

const read = <A>(
  schema: Schema.ConstraintDecoder<A>,
  path: string,
  query: Readonly<Record<string, Option.Option<string>>>,
  maybeEtag: Option.Option<string>,
): Effect.Effect<CalendarFetchResult<A>> =>
  Effect.gen(function* () {
    const url = new URL(`${API_URL}${path}`)

    for (const [key, maybeValue] of Object.entries(query)) {
      if (Option.isSome(maybeValue) && maybeValue.value !== '') {
        url.searchParams.set(key, maybeValue.value)
      }
    }

    const headers: Record<string, string> = {}

    if (Option.isSome(maybeEtag)) {
      headers['if-none-match'] = maybeEtag.value
    }

    const maybeResponse = yield* Effect.option(
      Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-cache',
            headers,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }),
        catch: () => networkFailure,
      }),
    )

    if (Option.isNone(maybeResponse)) {
      return { ok: false as const, error: networkFailure }
    }

    const response = maybeResponse.value
    const responseEtag = Option.fromNullishOr(response.headers.get('etag'))
    const etag = Option.isSome(responseEtag) ? responseEtag : maybeEtag

    if (response.status === 304) {
      return { ok: true as const, notModified: true as const, maybeEtag: etag }
    }

    const maybeJson = yield* Effect.option(
      Effect.tryPromise({
        try: () => response.json(),
        catch: () => undefined,
      }),
    )

    const json: unknown = Option.getOrUndefined(maybeJson)

    if (!response.ok) {
      return {
        ok: false as const,
        error: classifyApiFailure(response.status, json),
      }
    }

    const decoded = Schema.decodeUnknownOption(schema)(json)

    if (Option.isNone(decoded)) {
      return {
        ok: false as const,
        error: AuthFailure.make({ code: 'InternalError', retryable: true }),
      }
    }

    return {
      ok: true as const,
      notModified: false as const,
      model: decoded.value,
      maybeEtag: etag,
    }
  })

export const fetchCalendarWeek = (
  anchor: string,
  maybeEtag: Option.Option<string>,
): Effect.Effect<CalendarFetchResult<CalendarWeekPayload>> =>
  read(CalendarWeekPayload, '/week', { anchor: Option.some(anchor) }, maybeEtag)

export const fetchCalendarMonth = (
  anchor: string,
  maybeDay: Option.Option<string>,
  maybeEtag: Option.Option<string>,
): Effect.Effect<CalendarFetchResult<CalendarMonthPayload>> =>
  read(
    CalendarMonthPayload,
    '/month',
    { anchor: Option.some(anchor), day: maybeDay },
    maybeEtag,
  )
