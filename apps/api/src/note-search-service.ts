import { Context, Effect, Layer } from "effect"
import {
  type HouseholdId,
  type NoteSearchHit,
  type UserId
} from "@tali/domain"
import { NoteSearchRepo, NoteSearchRepoLive } from "@tali/sql"

/**
 * `NoteSearchService` — Persian full-text note search (ticket #41;
 * FR-NOTE-04).
 *
 * The service is thin on purpose: the repository owns the FTS5 query, and the
 * service owns the two things a caller must not decide for itself:
 *
 * - **how long a query may be** (`MAX_QUERY_LENGTH`), so a pasted paragraph
 *   cannot turn into a pathological FTS5 expression;
 * - **how many hits come back** (`DEFAULT_LIMIT`), because the result list is
 *   a screen, not a dump.
 *
 * An empty (or punctuation-only) query is not an error: it returns no hits,
 * which is what the search box wants while the user is still typing.
 */

export const DEFAULT_SEARCH_LIMIT = 50
export const MAX_SEARCH_LIMIT = 100
export const MAX_QUERY_LENGTH = 200

export interface NoteSearchViewer {
  readonly userId: UserId
  readonly householdId: HouseholdId
}

export interface NoteSearchServiceApi {
  readonly search: (
    viewer: NoteSearchViewer,
    query: string,
    limit?: number
  ) => Effect.Effect<
    { readonly query: string; readonly hits: ReadonlyArray<NoteSearchHit> },
    never
  >
}

export class NoteSearchService extends Context.Service<NoteSearchService>()(
  "NoteSearchService",
  {
    make: Effect.gen(function*() {
      const repo = yield* NoteSearchRepo

      const search: NoteSearchServiceApi["search"] = (viewer, query, limit) =>
        Effect.gen(function*() {
          const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH)
          const capped = Math.min(
            Math.max(limit ?? DEFAULT_SEARCH_LIMIT, 1),
            MAX_SEARCH_LIMIT
          )
          const hits = yield* repo.search({
            householdId: viewer.householdId,
            userId: viewer.userId,
            query: trimmed,
            limit: capped
          }).pipe(Effect.orDie)
          return { query: trimmed, hits }
        })

      return { search } as const
    })
  }
) {}

export const NoteSearchServiceLive = Layer.effect(NoteSearchService, NoteSearchService.make).pipe(
  Layer.provide(NoteSearchRepoLive)
)
