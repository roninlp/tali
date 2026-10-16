import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import {
  CreateHouseholdInput,
  JoinHouseholdInput,
  LoginInput,
  RegisterInput,
  toUserProfile,
  Unauthorized
} from "@tali/domain"
import { AuthService } from "./auth-service.js"

/**
 * Auth & household endpoints (Slice 1 / ticket #15).
 *
 * These ride the **plain HTTP** app rather than Effect RPC: minting and clearing
 * an HTTP-only session cookie needs the raw `HttpServerResponse`, which the RPC
 * layer does not expose to handlers. Aggregate CRUD/mutations keep using RPC;
 * sync (`/sync/*`) is plain HTTP for the same reason.
 */

const SESSION_COOKIE = "tali_session"

const json = (status: number, body: unknown): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.json(body, { status }).pipe(Effect.orDie)

/** Maps the leftover (non-domain) failures: a bad body is a 400, anything else a 500. */
const orElse = (error: unknown): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  const tag = (error as { readonly _tag?: string })._tag
  return tag === "SchemaError"
    ? json(400, { code: "BadRequest" })
    : json(500, { code: "InternalError" })
}

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
        maxAge: "30 days",
        secure: request.url.startsWith("https://")
      })

    const tokenFrom = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<string, Unauthorized> => {
      const token = request.cookies[SESSION_COOKIE]
      return token === undefined ? Effect.fail(new Unauthorized()) : Effect.succeed(token)
    }

    yield* router.add(
      "POST",
      "/auth/register",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const input = yield* HttpServerRequest.schemaBodyJson(RegisterInput)
        const { user, token } = yield* auth.register(input)
        const response = yield* json(201, { user: toUserProfile(user) })
        return setSession(response, token, request)
      }).pipe(
        Effect.catchTags(
          {
            EmailAlreadyRegistered: () => json(409, { code: "EmailAlreadyRegistered" })
          },
          orElse
        )
      )
    )

    yield* router.add(
      "POST",
      "/auth/login",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const input = yield* HttpServerRequest.schemaBodyJson(LoginInput)
        const { user, token } = yield* auth.login(input)
        const response = yield* json(200, { user: toUserProfile(user) })
        return setSession(response, token, request)
      }).pipe(
        Effect.catchTags(
          {
            InvalidCredentials: () => json(401, { code: "InvalidCredentials" })
          },
          orElse
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
      }).pipe(Effect.catchTags({}, orElse))
    )

    yield* router.add(
      "GET",
      "/auth/me",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = yield* tokenFrom(request)
        const context = yield* auth.me(token)
        return yield* json(200, context)
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => json(401, { code: "Unauthorized" })
          },
          orElse
        )
      )
    )

    yield* router.add(
      "POST",
      "/household",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = yield* tokenFrom(request)
        const context = yield* auth.me(token)
        const input = yield* HttpServerRequest.schemaBodyJson(CreateHouseholdInput)
        const household = yield* auth.createHousehold(context.user.id, input)
        return yield* json(201, { household })
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => json(401, { code: "Unauthorized" }),
            AlreadyInHousehold: () => json(409, { code: "AlreadyInHousehold" })
          },
          orElse
        )
      )
    )

    yield* router.add(
      "POST",
      "/household/join",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = yield* tokenFrom(request)
        const context = yield* auth.me(token)
        const input = yield* HttpServerRequest.schemaBodyJson(JoinHouseholdInput)
        const household = yield* auth.joinHousehold(context.user.id, input)
        return yield* json(200, { household })
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => json(401, { code: "Unauthorized" }),
            AlreadyInHousehold: () => json(409, { code: "AlreadyInHousehold" }),
            InviteInvalid: () => json(404, { code: "InviteInvalid" })
          },
          orElse
        )
      )
    )
  })
)
