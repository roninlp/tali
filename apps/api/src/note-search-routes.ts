import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { NoteSearchResponse, Unauthorized } from "@tali/domain"
import { AuthService } from "./auth-service.js"
import { SESSION_COOKIE } from "./auth-routes.js"
import { NoteSearchService, type NoteSearchViewer } from "./note-search-service.js"
import { fail, json, requestUrl } from "./read-model-http.js"

/**
 * `GET /search/notes?q=…` — Persian full-text note search (ticket #41;
 * FR-NOTE-04).
 *
 * Plain HTTP rather than RPC, because the search is a **read**: the session
 * cookie identifies the viewer, the query is the only input, and the response
 * is a plain list of hits the browser can render as they arrive. (The write
 * path — creating and editing notes — stays on the RPC/sync contract.)
 *
 * Query parameters:
 *
 * - `q` — the text to search for. It is normalized (folded) server-side
 *   before it reaches FTS5, so the Arabic and Farsi spellings of the same
 *   word find each other. An empty query returns no hits.
 * - `limit` — how many hits to return (1…100, default 50).
 *
 * Authorization is not re-implemented here: the repository scopes the query
 * to the viewer's household and to the notes they own or that are shared with
 * them, so another member's private note can never appear in the results.
 */

export const NoteSearchRoutes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    const auth = yield* AuthService
    const search = yield* NoteSearchService

    yield* router.add(
      "GET",
      "/search/notes",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = request.cookies[SESSION_COOKIE]
        if (token === undefined) {
          return yield* fail(401, "Unauthorized", "No active session")
        }
        const context = yield* auth.me(token)
        if (context.householdId === null) {
          return yield* fail(403, "Forbidden", "Join a household to search notes")
        }

        const url = requestUrl(request)
        const query = url.searchParams.get("q") ?? ""
        const rawLimit = url.searchParams.get("limit")
        const limit = rawLimit === null ? undefined : Number.parseInt(rawLimit, 10)

        const viewer: NoteSearchViewer = {
          userId: context.user.id,
          householdId: context.householdId
        }

        const model = yield* search.search(
          viewer,
          query,
          limit === undefined || Number.isNaN(limit) ? undefined : limit
        )
        // Encode through the shared schema: the wire shape is the contract,
        // not whatever object the composition happened to build.
        const body = yield* Schema.encodeEffect(NoteSearchResponse)(model)
        return yield* json(200, body)
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
