import { Effect } from 'effect'
import { HttpRouter, HttpServerRequest } from 'effect/http'
import { SyncPushRequest } from '@tali/domain'
import { AuthService } from './auth-service.js'
import { fail, json, requestUrl, unexpectedFailure } from './http-envelope.js'
import { sessionResolver } from './principal.js'
import {
  SyncContended,
  SyncEntityForbidden,
  SyncInvalidPatch,
  SyncPayloadTooLarge,
  SyncService,
  UnsupportedSyncEntity,
} from './sync-service.js'

/**
 * Plain-HTTP sync endpoints (CC-02, ticket #18). Deliberately NOT RPC: sync is
 * a bulk cursor delta, and the envelopes live in `packages/domain` so the web
 * client and the Worker share one codec (`docs/sync-protocol-draft.md`).
 *
 * Errors use the same `ErrorEnvelope` shape as auth (`docs/error-model-draft.md`
 * §5.1). A cursor that predates the retained window is *not* an HTTP error —
 * `/sync/pull` answers `resetRequired: true`, and the client re-bootstraps.
 */

/** Cursor/limit are query params; the wire schema validates the body, not the URL. */
const queryInt = (
  url: URL,
  name: string,
  fallback: number,
  min: number,
): number | undefined => {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= min ? value : undefined
}

export const SyncRoutes = HttpRouter.use(router =>
  Effect.gen(function* () {
    const auth = yield* AuthService
    const sync = yield* SyncService
    const session = sessionResolver(auth)

    yield* router.add(
      'GET',
      '/sync/pull',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const context = yield* session(request)
        if (context.householdId === null) {
          return yield* fail(
            409,
            'NoHousehold',
            'Join or create a household first',
          )
        }
        const url = requestUrl(request)
        const cursor = queryInt(url, 'cursor', 0, 0)
        const limit = queryInt(url, 'limit', 500, 1)
        if (cursor === undefined || limit === undefined) {
          return yield* fail(
            400,
            'BadRequest',
            'cursor and limit must be non-negative integers',
          )
        }
        const page = yield* sync.pull({
          userId: context.user.id,
          householdId: context.householdId,
          cursor,
          limit,
        })
        return yield* json(200, page)
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, 'Unauthorized', 'No active session'),
          },
          unexpectedFailure(),
        ),
      ),
    )

    yield* router.add(
      'GET',
      '/sync/bootstrap',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const context = yield* session(request)
        if (context.householdId === null) {
          return yield* fail(
            409,
            'NoHousehold',
            'Join or create a household first',
          )
        }
        const url = requestUrl(request)
        const offset = queryInt(url, 'offset', 0, 0)
        const limit = queryInt(url, 'limit', 500, 1)
        if (offset === undefined || limit === undefined) {
          return yield* fail(
            400,
            'BadRequest',
            'offset and limit must be non-negative integers',
          )
        }
        const page = yield* sync.bootstrap({
          userId: context.user.id,
          householdId: context.householdId,
          offset,
          limit,
        })
        return yield* json(200, page)
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, 'Unauthorized', 'No active session'),
          },
          unexpectedFailure(),
        ),
      ),
    )

    yield* router.add(
      'POST',
      '/sync/push',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const context = yield* session(request)
        if (context.householdId === null) {
          return yield* fail(
            409,
            'NoHousehold',
            'Join or create a household first',
          )
        }
        const body = yield* HttpServerRequest.schemaBodyJson(SyncPushRequest)
        const response = yield* sync.push({
          userId: context.user.id,
          householdId: context.householdId,
          entries: body.entries,
        })
        return yield* json(200, response)
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, 'Unauthorized', 'No active session'),
            UnsupportedSyncEntity: (error: UnsupportedSyncEntity) =>
              fail(
                422,
                'UnsupportedEntity',
                'Entity type is not syncable yet',
                false,
                {
                  entityType: error.entityType,
                },
              ),
            SyncPayloadTooLarge: (error: SyncPayloadTooLarge) =>
              fail(422, 'BadRequest', 'Too many entries in one push', false, {
                count: error.count,
              }),
            SyncInvalidPatch: (error: SyncInvalidPatch) =>
              fail(
                400,
                'BadRequest',
                'The patch does not match this entity',
                false,
                {
                  entityType: error.entityType,
                  entityId: error.entityId,
                },
              ),
            SyncEntityForbidden: (error: SyncEntityForbidden) =>
              fail(
                403,
                'Forbidden',
                'Entity is not writable by this client',
                false,
                {
                  entityId: error.entityId,
                },
              ),
            SyncContended: (error: SyncContended) =>
              fail(
                409,
                'Conflict',
                'A concurrent write won; retry the push',
                true,
                {
                  count: error.count,
                },
              ),
          },
          unexpectedFailure(),
        ),
      ),
    )
  }),
)
