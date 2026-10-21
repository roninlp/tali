import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import { PreferencesPatch, Unauthorized, type PreferenceDefaults } from "@tali/domain"
import { AuthService } from "./auth-service.js"
import { SESSION_COOKIE } from "./auth-routes.js"
import { PreferencesService } from "./preferences-service.js"

/**
 * Per-user preferences over plain HTTP (ticket #35).
 *
 * Auth/sync/push ride plain HTTP because they need the raw request/response
 * (the HTTP-only session cookie); preferences authenticate the same way, so
 * they follow that pattern instead of adding an RPC surface. Every non-2xx
 * body is the shared `ErrorEnvelope`; success bodies are `{ preferences }`.
 *
 * A row is per-user only: the user id always comes from the session, never the
 * body or the query string, so one account cannot read or write another's.
 */

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
  code: "Unauthorized" | "BadRequest" | "InternalError",
  message: string,
  retryable = false
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  json(status, { error: { code, message, retryable, details: {} } })

/** Malformed preferences are the client's fault (400); anything else is a 500. */
const unexpectedFailure = (error: unknown): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Schema.isSchemaError(error) || HttpServerError.isHttpServerError(error)
    ? fail(400, "BadRequest", "Malformed preferences")
    : fail(500, "InternalError", "Unexpected server error", true)

/** The profile values a user has never overridden in preferences. */
const profileDefaults = (context: {
  readonly user: PreferenceDefaults
}): PreferenceDefaults => ({
  timeZone: context.user.timeZone,
  weekStart: context.user.weekStart,
  digits: context.user.digits
})

export const PreferencesRoutes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    const auth = yield* AuthService
    const preferences = yield* PreferencesService

    /** Resolve the cookie's principal; preferences never accept a user id. */
    const authenticate = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function*() {
        const token = request.cookies[SESSION_COOKIE]
        if (token === undefined) {
          return yield* Effect.fail(new Unauthorized())
        }
        return yield* auth.me(token)
      })

    yield* router.add(
      "GET",
      "/preferences",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const context = yield* authenticate(request)
        const current = yield* preferences.get(context.user.id, profileDefaults(context))
        return yield* json(200, { preferences: current })
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, "Unauthorized", "No active session")
          },
          unexpectedFailure
        )
      )
    )

    yield* router.add(
      "PATCH",
      "/preferences",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const context = yield* authenticate(request)
        const patch = yield* HttpServerRequest.schemaBodyJson(PreferencesPatch)
        const current = yield* preferences.update(
          context.user.id,
          patch,
          profileDefaults(context)
        )
        return yield* json(200, { preferences: current })
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, "Unauthorized", "No active session")
          },
          unexpectedFailure
        )
      )
    )
  })
)
