import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import { PushSubscription, PushSubscriptionInput, Unauthorized } from "@tali/domain"
import { PushSubscriptionRepo } from "@tali/sql"
import { AuthService } from "./auth-service.js"
import { SESSION_COOKIE } from "./auth-routes.js"

/**
 * Web Push registration (Slice 1 / ticket #20).
 *
 * The shell registers the browser's `PushSubscription` so a later dispatch
 * slice has somewhere to send. This route deliberately does **not** send push:
 * there is no scheduler, dispatch ledger, or payload encryption here yet.
 *
 * It rides plain HTTP (like auth/sync) because the browser sends the session
 * cookie; the response body is the shared `ErrorEnvelope` on failure.
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

/** Maps malformed bodies to 400 and anything else to a retryable 500. */
const unexpectedFailure = (error: unknown): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Schema.isSchemaError(error) || HttpServerError.isHttpServerError(error)
    ? fail(400, "BadRequest", "Malformed push subscription")
    : fail(500, "InternalError", "Unexpected server error", true)

const optionalIso = (epochMs: number | null): string | null =>
  epochMs === null ? null : new Date(epochMs).toISOString()

export const PushRoutes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    const auth = yield* AuthService
    const subscriptions = yield* PushSubscriptionRepo

    yield* router.add(
      "POST",
      "/push/register",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = request.cookies[SESSION_COOKIE]
        if (token === undefined) {
          return yield* Effect.fail(new Unauthorized())
        }
        const context = yield* auth.me(token)
        const input = yield* HttpServerRequest.schemaBodyJson(PushSubscriptionInput)
        const now = new Date().toISOString()

        yield* subscriptions
          .upsert(
            PushSubscription.insert.make({
              userId: context.user.id,
              endpoint: input.endpoint,
              p256dh: input.keys.p256dh,
              auth: input.keys.auth,
              expirationTime: optionalIso(input.expirationTime),
              userAgent: request.headers["user-agent"] ?? null,
              createdAt: now,
              updatedAt: now
            })
          )
          .pipe(Effect.orDie)

        return yield* json(201, { ok: true })
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
