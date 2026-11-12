import { Effect, Schema } from 'effect'
import { HttpRouter, HttpServerRequest } from 'effect/http'
import {
  localDateStartInstant,
  MonthReadModel,
  WeekReadModel,
  type LocalDate,
} from '@tali/domain'
import { AuthService } from './auth-service.js'
import { CalendarService, type CalendarViewer } from './calendar-service.js'
import { conditionalJson, fail, requestUrl } from './http-envelope.js'
import { PreferencesService } from './preferences-service.js'
import { principalResolver } from './principal.js'

/**
 * `GET /week` and `GET /month` — the calendar read models (ticket #43;
 * FR-VIEW-02/03).
 *
 * Both are plain HTTP for the same reason as `/today`: the encoded body is
 * deterministic for a window + data set, so it becomes a strong `ETag` and an
 * `If-None-Match` revalidation is a real `304`. The cookie remains the session,
 * so responses are `private, no-cache` and `vary: cookie`.
 *
 * Query parameters:
 *
 * - `anchor=YYYY-MM-DD` — any day in the requested week/month (default: the
 *   viewer's today in the preferences zone).
 * - `day=YYYY-MM-DD` (month only) — optional day drill-down included in the
 *   same payload, so opening a day never needs a second round trip.
 *
 * The week start comes from the #35 preferences, never from a query parameter:
 * a client cannot ask for a different calendar shape than the user's saved
 * preference. Payloads are encoded through the shared domain schemas, so a
 * service regression fails the typed boundary instead of leaking a shape.
 */

/** A real calendar date (`YYYY-MM-DD`), or `undefined` when absent. */
const dateParam = (
  url: URL,
  name: string,
): LocalDate | undefined | 'invalid' => {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === '') return undefined
  try {
    localDateStartInstant(raw, 'UTC')
    return raw as LocalDate
  } catch {
    return 'invalid'
  }
}

export const CalendarRoutes = HttpRouter.use(router =>
  Effect.gen(function* () {
    const auth = yield* AuthService
    const preferences = yield* PreferencesService
    const calendar = yield* CalendarService
    const principal = principalResolver(auth, preferences)

    yield* router.add(
      'GET',
      '/week',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const resolved = yield* principal(request)
        if (resolved.context.householdId === null) {
          return yield* fail(
            403,
            'Forbidden',
            'Join a household to see the week',
          )
        }
        const anchor = dateParam(requestUrl(request), 'anchor')
        if (anchor === 'invalid') {
          return yield* fail(
            400,
            'BadRequest',
            'anchor must be a real calendar date',
          )
        }
        const viewer: CalendarViewer = {
          userId: resolved.context.user.id,
          householdId: resolved.context.householdId,
          timeZone: resolved.preferences.timeZone,
          weekStart: resolved.preferences.weekStart,
        }

        const model = yield* calendar.week(viewer, anchor)
        const body = yield* Schema.encodeEffect(WeekReadModel)(model)
        return yield* conditionalJson(request, body)
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, 'Unauthorized', 'No active session'),
          },
          () => fail(500, 'InternalError', 'Unexpected server error', true),
        ),
      ),
    )

    yield* router.add(
      'GET',
      '/month',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const resolved = yield* principal(request)
        if (resolved.context.householdId === null) {
          return yield* fail(
            403,
            'Forbidden',
            'Join a household to see the month',
          )
        }
        const url = requestUrl(request)
        const anchor = dateParam(url, 'anchor')
        const day = dateParam(url, 'day')
        if (anchor === 'invalid' || day === 'invalid') {
          return yield* fail(
            400,
            'BadRequest',
            'anchor and day must be real calendar dates',
          )
        }
        const viewer: CalendarViewer = {
          userId: resolved.context.user.id,
          householdId: resolved.context.householdId,
          timeZone: resolved.preferences.timeZone,
          weekStart: resolved.preferences.weekStart,
        }

        const model = yield* calendar.month(viewer, {
          anchor,
          day: day ?? null,
        })
        const body = yield* Schema.encodeEffect(MonthReadModel)(model)
        return yield* conditionalJson(request, body)
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, 'Unauthorized', 'No active session'),
          },
          () => fail(500, 'InternalError', 'Unexpected server error', true),
        ),
      ),
    )
  }),
)
