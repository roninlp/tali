import { Effect } from 'effect'
import type { HttpServerRequest } from 'effect/http'
import {
  type PreferenceDefaults,
  type SessionContext,
  Unauthorized,
  type UserPreferences,
} from '@tali/domain'
import { AuthService } from './auth-service.js'
import { SESSION_COOKIE } from './http-envelope.js'
import { PreferencesService } from './preferences-service.js'

/**
 * One session → one principal, for every authenticated edge.
 *
 * The plain-HTTP routes read the session cookie, the RPC edge reads the raw
 * `cookie` header, but both mean the same thing: a token that `AuthService`
 * resolves into a `SessionContext`, plus the user's stored preferences. Only
 * the token lookup differs (`sessionOf` vs `sessionFromToken`), so the cookie
 * parsing, the `Unauthorized` failure and the preferences fallback live here
 * instead of being re-implemented per route.
 *
 * Authorization stays with the caller: whether a missing household is a `403`,
 * a `401`, a `409` or a type-specific forbidden error is a property of the
 * aggregate's contract, not of principal resolution.
 */

/** A resolved session plus the preferences that shape its view of the data. */
export interface Principal {
  readonly context: SessionContext
  readonly preferences: UserPreferences
}

/** Raw cookie token → session context. */
export const sessionFromToken = (
  token: string,
): Effect.Effect<SessionContext, Unauthorized, AuthService> =>
  Effect.gen(function* () {
    const auth = yield* AuthService
    return yield* auth.me(token)
  })

/** Cookie value → session context; a missing cookie is an `Unauthorized`. */
export const sessionOf = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<SessionContext, Unauthorized, AuthService> =>
  Effect.gen(function* () {
    const token = request.cookies[SESSION_COOKIE]
    if (token === undefined) {
      return yield* new Unauthorized()
    }
    return yield* sessionFromToken(token)
  })

/** The profile values a user has never overridden in preferences. */
export const profileDefaults = (
  context: SessionContext,
): PreferenceDefaults => ({
  timeZone: context.user.timeZone,
  weekStart: context.user.weekStart,
  digits: context.user.digits,
})

/**
 * The stored preferences, or the Persian-first defaults seeded from the
 * profile when the user has never opened settings.
 */
export const preferencesOf = (
  context: SessionContext,
): Effect.Effect<UserPreferences, never, PreferencesService> =>
  Effect.gen(function* () {
    const preferences = yield* PreferencesService
    return yield* preferences.get(context.user.id, profileDefaults(context))
  })

/** Cookie value → principal. */
export const principalOf = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<Principal, Unauthorized, AuthService | PreferencesService> =>
  Effect.gen(function* () {
    const context = yield* sessionOf(request)
    const preferences = yield* preferencesOf(context)
    return { context, preferences }
  })

/** Raw token → principal (the RPC edge reads the `cookie` header itself). */
export const principalFromToken = (
  token: string,
): Effect.Effect<Principal, Unauthorized, AuthService | PreferencesService> =>
  Effect.gen(function* () {
    const context = yield* sessionFromToken(token)
    const preferences = yield* preferencesOf(context)
    return { context, preferences }
  })

/**
 * The implementations a plain-HTTP route captures at layer scope.
 *
 * `HttpRouter` route handlers cannot carry service requirements of their own:
 * the requirement escapes the router layer as a request-level one and
 * `toWebHandler` then demands it in a per-request `Context`. Routes therefore
 * resolve the services once, where they already did, and use the bound forms
 * below inside their handlers.
 */
type AuthServiceShape = Effect.Success<typeof AuthService>
type PreferencesServiceShape = Effect.Success<typeof PreferencesService>

/** `sessionOf`, bound to the route's captured `AuthService`. */
export const sessionResolver =
  (auth: AuthServiceShape) =>
  (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<SessionContext, Unauthorized> =>
    sessionOf(request).pipe(Effect.provideService(AuthService, auth))

/** `principalOf`, bound to the services the route captured at layer scope. */
export const principalResolver =
  (auth: AuthServiceShape, preferences: PreferencesServiceShape) =>
  (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<Principal, Unauthorized> =>
    principalOf(request).pipe(
      Effect.provideService(AuthService, auth),
      Effect.provideService(PreferencesService, preferences),
    )
