import { Effect, Option, Schema } from "effect"
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import {
  ChangePasswordInput,
  CreateHouseholdInput,
  JoinHouseholdInput,
  LoginInput,
  RateLimited,
  RegisterInput,
  toUserProfile,
  Unauthorized,
  type AuthErrorCode
} from "@tali/domain"
import { AuthService } from "./auth-service.js"

/**
 * Auth & household endpoints (Slice 1 / ticket #15, shell in #16).
 *
 * These ride the **plain HTTP** app rather than Effect RPC: minting and clearing
 * an HTTP-only session cookie needs the raw `HttpServerResponse`, which the RPC
 * layer does not expose to handlers. Aggregate CRUD/mutations keep using RPC;
 * sync (`/sync/*`) is plain HTTP for the same reason.
 *
 * Every non-2xx body is the shared `ErrorEnvelope` from `@tali/domain`
 * (`docs/error-model-draft.md` §5.1): a stable `code`, a non-localized
 * `message`, a `retryable` flag, and machine-readable `details`.
 */

const SESSION_COOKIE = "tali_session"
const SESSION_MAX_AGE = "30 days"

/** The session cookie name, shared with route modules that authenticate too. */
export { SESSION_COOKIE }

/** Serialize a body and mark it uncacheable (auth responses are per-session). */
const json = (
  status: number,
  body: unknown
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.json(body, { status }).pipe(
    Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
    Effect.orDie
  )

/** The one plain-HTTP error shape (see the file header). */
const fail = (
  status: number,
  code: AuthErrorCode,
  message: string,
  retryable = false,
  details: Record<string, unknown> = {}
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  json(status, { error: { code, message, retryable, details } })

/** Maps non-domain failures: a bad body is a 400, anything else a 500. */
const unexpectedFailure = (error: unknown): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Schema.isSchemaError(error) || HttpServerError.isHttpServerError(error)
    ? fail(400, "BadRequest", "Malformed request body")
    : fail(500, "InternalError", "Unexpected server error", true)

/**
 * Rate-limit bucket IP. Cloudflare sets `CF-Connecting-IP`; Effect's adapter
 * also exposes a remote address. Local `wrangler dev` has neither, so all local
 * attempts share one bucket.
 */
const clientIp = (request: HttpServerRequest.HttpServerRequest): string =>
  request.headers["cf-connecting-ip"] ??
  Option.getOrElse(request.remoteAddress, () => "unknown")

export const AuthRoutes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    const auth = yield* AuthService

    const setSession = (
      response: HttpServerResponse.HttpServerResponse,
      token: string,
      request: HttpServerRequest.HttpServerRequest
    ): HttpServerResponse.HttpServerResponse =>
      HttpServerResponse.setCookieUnsafe(response, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_MAX_AGE,
        secure: request.url.startsWith("https://")
      })

    /** Resolve the cookie's token and principal, failing `Unauthorized` without one. */
    const authenticate = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function*() {
        const token = request.cookies[SESSION_COOKIE]
        if (token === undefined) {
          return yield* Effect.fail(new Unauthorized())
        }
        const context = yield* auth.me(token)
        return { token, context }
      })

    /**
     * Like `authenticate`, but also slides the session when it is close to
     * expiry. The mutation routes re-stamp the cookie; taking the renewal flag
     * from the service is what keeps the cookie and the row expiring together.
     */
    const authenticateWithRenewal = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function*() {
        const token = request.cookies[SESSION_COOKIE]
        if (token === undefined) {
          return yield* Effect.fail(new Unauthorized())
        }
        const { context, renewed } = yield* auth.meWithRenewal(token)
        return { token, context, renewed }
      })

    yield* router.add(
      "POST",
      "/auth/register",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const input = yield* HttpServerRequest.schemaBodyJson(RegisterInput)
        const { user, token } = yield* auth.register(input)
        // A fresh account cannot belong to a household yet.
        const response = yield* json(201, { user: toUserProfile(user), householdId: null })
        return setSession(response, token, request)
      }).pipe(
        Effect.catchTags(
          {
            EmailAlreadyRegistered: () =>
              fail(409, "EmailAlreadyRegistered", "Email already registered")
          },
          unexpectedFailure
        )
      )
    )

    yield* router.add(
      "POST",
      "/auth/login",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const input = yield* HttpServerRequest.schemaBodyJson(LoginInput)
        const { user, token, householdId } = yield* auth.login(input, clientIp(request))
        // The full session context: the client needs no follow-up `/auth/me`.
        const response = yield* json(200, { user: toUserProfile(user), householdId })
        return setSession(response, token, request)
      }).pipe(
        Effect.catchTags(
          {
            InvalidCredentials: () =>
              fail(401, "InvalidCredentials", "Email or login key is incorrect"),
            RateLimited: (error: RateLimited) =>
              fail(429, "RateLimited", "Too many login attempts", true, {
                retryAfterSeconds: error.retryAfterSeconds
              }).pipe(
                Effect.map((response) =>
                  HttpServerResponse.setHeader(response, "retry-after", `${error.retryAfterSeconds}`)
                )
              )
          },
          unexpectedFailure
        )
      )
    )

    yield* router.add(
      "POST",
      "/auth/change-password",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const { token, context, renewed } = yield* authenticateWithRenewal(request)
        const input = yield* HttpServerRequest.schemaBodyJson(ChangePasswordInput)
        yield* auth.changePassword(context.user.id, input, clientIp(request))
        const response = yield* json(200, { ok: true })
        return renewed ? setSession(response, token, request) : response
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, "Unauthorized", "No active session"),
            InvalidCredentials: () =>
              fail(401, "InvalidCredentials", "Current login key is incorrect"),
            RateLimited: (error: RateLimited) =>
              fail(429, "RateLimited", "Too many attempts", true, {
                retryAfterSeconds: error.retryAfterSeconds
              }).pipe(
                Effect.map((response) =>
                  HttpServerResponse.setHeader(response, "retry-after", `${error.retryAfterSeconds}`)
                )
              )
          },
          unexpectedFailure
        )
      )
    )

    yield* router.add(
      "POST",
      "/auth/logout",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = request.cookies[SESSION_COOKIE]
        if (token !== undefined) {
          yield* auth.logout(token)
        }
        const response = yield* json(200, { ok: true })
        return HttpServerResponse.expireCookieUnsafe(response, SESSION_COOKIE, { path: "/" })
      }).pipe(Effect.catchTags({}, unexpectedFailure))
    )

    yield* router.add(
      "GET",
      "/auth/me",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = request.cookies[SESSION_COOKIE]
        if (token === undefined) {
          return yield* Effect.fail(new Unauthorized())
        }
        const { context, renewed } = yield* auth.meWithRenewal(token)
        const response = yield* json(200, context)
        // Sliding: re-stamp the cookie only when the row also moved, so the
        // browser and `expires_at` stay in step. A plain read touches neither.
        return renewed ? setSession(response, token, request) : response
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
      "POST",
      "/household",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const { token, context, renewed } = yield* authenticateWithRenewal(request)
        const input = yield* HttpServerRequest.schemaBodyJson(CreateHouseholdInput)
        const household = yield* auth.createHousehold(context.user.id, input)
        const response = yield* json(201, { household })
        return renewed ? setSession(response, token, request) : response
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, "Unauthorized", "No active session"),
            AlreadyInHousehold: () =>
              fail(409, "AlreadyInHousehold", "Already a member of a household")
          },
          unexpectedFailure
        )
      )
    )

    yield* router.add(
      "POST",
      "/household/join",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const { token, context, renewed } = yield* authenticateWithRenewal(request)
        const input = yield* HttpServerRequest.schemaBodyJson(JoinHouseholdInput)
        const household = yield* auth.joinHousehold(context.user.id, input)
        const response = yield* json(200, { household })
        return renewed ? setSession(response, token, request) : response
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, "Unauthorized", "No active session"),
            AlreadyInHousehold: () =>
              fail(409, "AlreadyInHousehold", "Already a member of a household"),
            HouseholdFull: () => fail(409, "HouseholdFull", "Household is full"),
            InviteInvalid: () => fail(404, "InviteInvalid", "Invite code is invalid")
          },
          unexpectedFailure
        )
      )
    )
  })
)
