import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import {
  type DashboardSectionOrder,
  normalizeDashboardSectionOrder,
  TodayReadModel,
  Unauthorized
} from "@tali/domain"
import { AuthService } from "./auth-service.js"
import { SESSION_COOKIE } from "./auth-routes.js"
import { sha256Hex } from "./bytes.js"
import { PreferencesService } from "./preferences-service.js"
import { TodayService, type TodayViewer } from "./today-service.js"

/**
 * `GET /today` — the aggregated dashboard read model (ticket #42; FR-VIEW-01).
 *
 * Plain HTTP rather than RPC because the read needs HTTP caching semantics:
 * the body is deterministic for a day + data set, so it is hashed into a strong
 * `ETag` and a matching `If-None-Match` answers `304` with no body. The session
 * is still the cookie, so the response is `private, no-cache` (a shared cache
 * must never reuse one household's dashboard for another).
 *
 * Authorization is not re-implemented here: authenticated requests become a
 * viewer, and `TodayService` delegates to the #36/#40 services, which already
 * scope by household and hide another member's private rows.
 *
 * GET has no request body or query parameters to validate; the payload itself
 * is encoded through `TodayReadModel` below, so a service regression fails the
 * typed boundary instead of leaking a malformed shape.
 */

const CACHE_CONTROL = "private, no-cache"

const json = (
  status: number,
  body: unknown
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.json(body, { status }).pipe(
    Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
    Effect.orDie
  )

const fail = (
  status: number,
  code: "Unauthorized" | "Forbidden" | "BadRequest" | "InternalError",
  message: string,
  retryable = false
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  json(status, { error: { code, message, retryable, details: {} } })

/** A strong hash of the encoded payload; the body alone determines the tag. */
const etagOf = (body: unknown): Effect.Effect<string> =>
  sha256Hex(JSON.stringify(body)).pipe(Effect.map((hex) => `"${hex}"`))

/**
 * `If-None-Match` uses the weak comparison function even for strong tags, so
 * `W/"x"` matches `"x"`. A comma-separated list and `*` are both legal.
 */
const matchesIfNoneMatch = (header: string, etag: string): boolean => {
  const opaque = (value: string): string => value.trim().replace(/^W\//, "")
  return header
    .split(",")
    .some((candidate) => candidate.trim() === "*" || opaque(candidate) === opaque(etag))
}

const cacheHeaders = (etag: string): Record<string, string> => ({
  etag,
  "cache-control": CACHE_CONTROL,
  // The body is per-session; make that explicit for any intermediary.
  vary: "cookie"
})

export const TodayRoutes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    const auth = yield* AuthService
    const preferences = yield* PreferencesService
    const today = yield* TodayService

    /** Resolve the cookie principal into a viewer + its saved display order. */
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
          viewer: {
            userId: context.user.id,
            householdId: context.householdId,
            timeZone: prefs.timeZone
          },
          sectionOrder: normalizeDashboardSectionOrder(
            prefs.dashboardSectionOrder
          ) as DashboardSectionOrder
        }
      })

    yield* router.add(
      "GET",
      "/today",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const { viewer: candidate, sectionOrder } = yield* principal(request)
        if (candidate.householdId === null) {
          return yield* fail(403, "Forbidden", "Join a household to see Today")
        }
        const viewer: TodayViewer = {
          userId: candidate.userId,
          householdId: candidate.householdId,
          timeZone: candidate.timeZone
        }

        const model = yield* today.get(viewer, sectionOrder)
        // Encode through the shared schema: the wire shape is the contract,
        // not whatever object the composition happened to build.
        const body = yield* Schema.encodeEffect(TodayReadModel)(model)
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
          // Encoding a bad payload is a server bug, not client input: 500.
          () => fail(500, "InternalError", "Unexpected server error", true)
        )
      )
    )
  })
)
