import { Effect, Option, Schema } from "effect"
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import {
  SyncPushRequest,
  Unauthorized,
  type SessionContext,
  type SyncErrorCode
} from "@tali/domain"
import { AuthService } from "./auth-service.js"
import {
  SyncContended,
  SyncEntityForbidden,
  SyncPayloadTooLarge,
  SyncService,
  UnsupportedSyncEntity
} from "./sync-service.js"

/**
 * Plain-HTTP sync endpoints (CC-02, ticket #18). Deliberately NOT RPC: sync is
 * a bulk cursor delta, and the envelopes live in `packages/domain` so the web
 * client and the Worker share one codec (`docs/sync-protocol-draft.md`).
 *
 * Errors use the same `ErrorEnvelope` shape as auth (`docs/error-model-draft.md`
 * §5.1). A cursor that predates the retained window is *not* an HTTP error —
 * `/sync/pull` answers `resetRequired: true`, and the client re-bootstraps.
 */

const SESSION_COOKIE = "tali_session"

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
  code: SyncErrorCode,
  message: string,
  retryable = false,
  details: Record<string, unknown> = {}
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  json(status, { error: { code, message, retryable, details } })

const unexpectedFailure = (error: unknown): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Schema.isSchemaError(error) || HttpServerError.isHttpServerError(error)
    ? fail(400, "BadRequest", "Malformed request")
    : fail(500, "InternalError", "Unexpected server error", true)

/**
 * Effect v4 keeps `HttpServerRequest.url` path-only (`/sync/pull?cursor=0`);
 * the absolute URL is derived from the `host`/`x-forwarded-proto` headers.
 * `new URL(request.url)` therefore throws on every sync request — ask the
 * request for its absolute URL instead.
 */
const requestUrl = (request: HttpServerRequest.HttpServerRequest): URL =>
  Option.getOrElse(
    HttpServerRequest.toURL(request),
    () => new URL(request.url, "http://localhost")
  )

/** Cursor/limit are query params; the wire schema validates the body, not the URL. */
const queryInt = (
  url: URL,
  name: string,
  fallback: number,
  min: number
): number | undefined => {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === "") return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= min ? value : undefined
}

export const SyncRoutes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    const auth = yield* AuthService
    const sync = yield* SyncService

    /** Resolve the session cookie and the household the feed is scoped to. */
    const principal = (
      request: HttpServerRequest.HttpServerRequest
    ): Effect.Effect<SessionContext, Unauthorized> =>
      Effect.gen(function*() {
        const token = request.cookies[SESSION_COOKIE]
        if (token === undefined) {
          return yield* Effect.fail(new Unauthorized())
        }
        return yield* auth.me(token)
      })

    yield* router.add(
      "GET",
      "/sync/pull",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const context = yield* principal(request)
        if (context.householdId === null) {
          return yield* fail(409, "NoHousehold", "Join or create a household first")
        }
        const url = requestUrl(request)
        const cursor = queryInt(url, "cursor", 0, 0)
        const limit = queryInt(url, "limit", 500, 1)
        if (cursor === undefined || limit === undefined) {
          return yield* fail(400, "BadRequest", "cursor and limit must be non-negative integers")
        }
        const page = yield* sync.pull({
          userId: context.user.id,
          householdId: context.householdId,
          cursor,
          limit
        })
        return yield* json(200, page)
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
      "GET",
      "/sync/bootstrap",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const context = yield* principal(request)
        if (context.householdId === null) {
          return yield* fail(409, "NoHousehold", "Join or create a household first")
        }
        const url = requestUrl(request)
        const offset = queryInt(url, "offset", 0, 0)
        const limit = queryInt(url, "limit", 500, 1)
        if (offset === undefined || limit === undefined) {
          return yield* fail(400, "BadRequest", "offset and limit must be non-negative integers")
        }
        const page = yield* sync.bootstrap({
          userId: context.user.id,
          householdId: context.householdId,
          offset,
          limit
        })
        return yield* json(200, page)
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
      "/sync/push",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const context = yield* principal(request)
        if (context.householdId === null) {
          return yield* fail(409, "NoHousehold", "Join or create a household first")
        }
        const body = yield* HttpServerRequest.schemaBodyJson(SyncPushRequest)
        const response = yield* sync.push({
          userId: context.user.id,
          householdId: context.householdId,
          entries: body.entries
        })
        return yield* json(200, response)
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, "Unauthorized", "No active session"),
            UnsupportedSyncEntity: (error: UnsupportedSyncEntity) =>
              fail(422, "UnsupportedEntity", "Entity type is not syncable yet", false, {
                entityType: error.entityType
              }),
            SyncPayloadTooLarge: (error: SyncPayloadTooLarge) =>
              fail(422, "BadRequest", "Too many entries in one push", false, {
                count: error.count
              }),
            SyncEntityForbidden: (error: SyncEntityForbidden) =>
              fail(403, "Forbidden", "Entity is not writable by this client", false, {
                entityId: error.entityId
              }),
            SyncContended: (error: SyncContended) =>
              fail(409, "Conflict", "A concurrent write won; retry the push", true, {
                count: error.count
              })
          },
          unexpectedFailure
        )
      )
    )
  })
)
