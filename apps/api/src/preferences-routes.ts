import { Effect } from 'effect'
import { HttpRouter, HttpServerRequest } from 'effect/http'
import { PreferencesPatch } from '@tali/domain'
import { AuthService } from './auth-service.js'
import { fail, json, unexpectedFailure } from './http-envelope.js'
import {
  principalResolver,
  profileDefaults,
  sessionResolver,
} from './principal.js'
import { PreferencesService } from './preferences-service.js'

/**
 * Per-user preferences over plain HTTP (ticket #35).
 *
 * Auth/sync/push ride plain HTTP because they need the raw request/response
 * (the HTTP-only session cookie); preferences authenticate the same way, so
 * they follow that pattern instead of adding an RPC surface. Every non-2xx
 * body is the shared `ErrorEnvelope`; success bodies are `{ preferences }`.
 *
 * A row is per-user only: the user id comes from the session, never the body
 * or the query string, so one account cannot read or write another's.
 */

export const PreferencesRoutes = HttpRouter.use(router =>
  Effect.gen(function* () {
    const auth = yield* AuthService
    const preferences = yield* PreferencesService
    const principal = principalResolver(auth, preferences)
    const session = sessionResolver(auth)

    yield* router.add(
      'GET',
      '/preferences',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const resolved = yield* principal(request)
        return yield* json(200, { preferences: resolved.preferences })
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, 'Unauthorized', 'No active session'),
          },
          unexpectedFailure('Malformed preferences'),
        ),
      ),
    )

    yield* router.add(
      'PATCH',
      '/preferences',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // `update` reads the pre-update row itself to merge the patch, so
        // resolving the full principal here would only read it twice.
        const context = yield* session(request)
        const patch = yield* HttpServerRequest.schemaBodyJson(PreferencesPatch)
        const current = yield* preferences.update(
          context.user.id,
          patch,
          profileDefaults(context),
        )
        return yield* json(200, { preferences: current })
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, 'Unauthorized', 'No active session'),
          },
          unexpectedFailure('Malformed preferences'),
        ),
      ),
    )
  }),
)
