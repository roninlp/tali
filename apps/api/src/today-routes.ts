import { Effect, Schema } from 'effect'
import { HttpRouter, HttpServerRequest } from 'effect/http'
import {
  type DashboardSectionOrder,
  normalizeDashboardSectionOrder,
  TodayReadModel,
} from '@tali/domain'
import { AuthService } from './auth-service.js'
import { conditionalJson, fail } from './http-envelope.js'
import { PreferencesService } from './preferences-service.js'
import { principalResolver } from './principal.js'
import { TodayService, type TodayViewer } from './today-service.js'

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

export const TodayRoutes = HttpRouter.use(router =>
  Effect.gen(function* () {
    const auth = yield* AuthService
    const preferences = yield* PreferencesService
    const today = yield* TodayService
    const principal = principalResolver(auth, preferences)

    yield* router.add(
      'GET',
      '/today',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const resolved = yield* principal(request)
        if (resolved.context.householdId === null) {
          return yield* fail(403, 'Forbidden', 'Join a household to see Today')
        }
        const viewer: TodayViewer = {
          userId: resolved.context.user.id,
          householdId: resolved.context.householdId,
          timeZone: resolved.preferences.timeZone,
        }
        const sectionOrder = normalizeDashboardSectionOrder(
          resolved.preferences.dashboardSectionOrder,
        ) as DashboardSectionOrder

        const model = yield* today.get(viewer, sectionOrder)
        // Encode through the shared schema: the wire shape is the contract,
        // not whatever object the composition happened to build.
        const body = yield* Schema.encodeEffect(TodayReadModel)(model)
        return yield* conditionalJson(request, body)
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, 'Unauthorized', 'No active session'),
          },
          // Encoding a bad payload is a server bug, not client input: 500.
          () => fail(500, 'InternalError', 'Unexpected server error', true),
        ),
      ),
    )
  }),
)
