import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import {
  localDateStartInstant,
  MonthReadModel,
  Unauthorized,
  WeekReadModel,
  type LocalDate
} from "@tali/domain"
import { AuthService } from "./auth-service.js"
import { SESSION_COOKIE } from "./auth-routes.js"
import { CalendarService, type CalendarViewer } from "./calendar-service.js"
import { PreferencesService } from "./preferences-service.js"
import {
  cacheHeaders,
  etagOf,
  fail,
  matchesIfNoneMatch,
  requestUrl
} from "./read-model-http.js"

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
const dateParam = (url: URL, name: string): LocalDate | undefined | "invalid" => {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === "") return undefined
  try {
    localDateStartInstant(raw, "UTC")
    return raw as LocalDate
  } catch {
    return "invalid"
  }
}

export const CalendarRoutes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    const auth = yield* AuthService
    const preferences = yield* PreferencesService
    const calendar = yield* CalendarService

    /** Resolve the cookie principal into a viewer + the saved week start. */
    const principal = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function*() {
        const token = request.cookies[SESSION_COOKIE]
        if (token === undefined) {
          return yield* Effect.fail(new Unauthorized())
        }
        const context = yield* auth.me(token)
        const prefs = yield* preferences.get(context.user.id, {
          timeZone: context.user.timeZone,
          weekStart: context.user.weekStart,
          digits: context.user.digits
        })
        return {
          candidate: {
            userId: context.user.id,
            householdId: context.householdId,
            timeZone: prefs.timeZone,
            weekStart: prefs.weekStart
          }
        }
      })

    yield* router.add(
      "GET",
      "/week",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const { candidate } = yield* principal(request)
        if (candidate.householdId === null) {
          return yield* fail(403, "Forbidden", "Join a household to see the week")
        }
        const anchor = dateParam(requestUrl(request), "anchor")
        if (anchor === "invalid") {
          return yield* fail(400, "BadRequest", "anchor must be a real calendar date")
        }
        const viewer: CalendarViewer = {
          userId: candidate.userId,
          householdId: candidate.householdId,
          timeZone: candidate.timeZone,
          weekStart: candidate.weekStart
        }

        const model = yield* calendar.week(viewer, anchor)
        const body = yield* Schema.encodeEffect(WeekReadModel)(model)
        const etag = yield* etagOf(body)
        const ifNoneMatch = request.headers["if-none-match"]

        if (ifNoneMatch !== undefined && matchesIfNoneMatch(ifNoneMatch, etag)) {
          return HttpServerResponse.empty({
            status: 304,
            headers: cacheHeaders(etag)
          })
        }

        return yield* HttpServerResponse.json(body, {
          status: 200,
          headers: cacheHeaders(etag)
        })
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, "Unauthorized", "No active session")
          },
          () => fail(500, "InternalError", "Unexpected server error", true)
        )
      )
    )

    yield* router.add(
      "GET",
      "/month",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const { candidate } = yield* principal(request)
        if (candidate.householdId === null) {
          return yield* fail(403, "Forbidden", "Join a household to see the month")
        }
        const url = requestUrl(request)
        const anchor = dateParam(url, "anchor")
        const day = dateParam(url, "day")
        if (anchor === "invalid" || day === "invalid") {
          return yield* fail(
            400,
            "BadRequest",
            "anchor and day must be real calendar dates"
          )
        }
        const viewer: CalendarViewer = {
          userId: candidate.userId,
          householdId: candidate.householdId,
          timeZone: candidate.timeZone,
          weekStart: candidate.weekStart
        }

        const model = yield* calendar.month(viewer, {
          anchor,
          day: day ?? null
        })
        const body = yield* Schema.encodeEffect(MonthReadModel)(model)
        const etag = yield* etagOf(body)
        const ifNoneMatch = request.headers["if-none-match"]

        if (ifNoneMatch !== undefined && matchesIfNoneMatch(ifNoneMatch, etag)) {
          return HttpServerResponse.empty({
            status: 304,
            headers: cacheHeaders(etag)
          })
        }

        return yield* HttpServerResponse.json(body, {
          status: 200,
          headers: cacheHeaders(etag)
        })
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, "Unauthorized", "No active session")
          },
          () => fail(500, "InternalError", "Unexpected server error", true)
        )
      )
    )
  })
)
