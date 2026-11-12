import { Effect, Option, Schema } from 'effect'

import { AuthFailure, classifyApiFailure } from './auth-api'
import { CalendarMonthPayload, CalendarWeekPayload } from './calendar-data'
import { type CachedHttpResult, requestCachedJson } from './http'

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

export type CalendarFetchResult<A> = CachedHttpResult<A, AuthFailure>

const read = <A>(
  schema: Schema.ConstraintDecoder<A>,
  path: string,
  query: Readonly<Record<string, Option.Option<string>>>,
  maybeEtag: Option.Option<string>,
): Effect.Effect<CalendarFetchResult<A>> =>
  requestCachedJson({
    path,
    schema,
    query,
    maybeEtag,
    classify: classifyApiFailure,
    networkFailure: AuthFailure.make({ code: 'Network', retryable: true }),
    decodeFailure: AuthFailure.make({ code: 'InternalError', retryable: true }),
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
