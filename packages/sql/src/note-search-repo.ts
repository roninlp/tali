import { Context, Effect, Layer } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import {
  buildSearchMatchQuery,
  SEARCH_MARK_CLOSE,
  SEARCH_MARK_OPEN,
  splitSearchSegments,
  type HouseholdId,
  type NoteId,
  type NoteSearchSegment,
  type UserId
} from "@tali/domain"

/**
 * The note search index (ticket #41; FR-NOTE-04).
 *
 * `notes_fts` is a standalone FTS5 table (see
 * `packages/sql/migrations/0009_note_search.sql`): it holds the **folded**
 * title and body, so the tokens it indexes are the canonical Persian ones and
 * a note written in one spelling is found by the other. The write path keeps
 * it in step with the `notes` row (see the registry's `index` hook), so the
 * index never lags behind a committed note.
 *
 * The query itself is scoped like every other read: the viewer's household,
 * and only the notes they own or the ones shared with them. Trashed notes
 * (tombstones) are never returned; archived notes are, because the search is
 * its own surface rather than a filter of the default list.
 *
 * Ranking is FTS5's own `bm25` (`ORDER BY rank` — lower is better), and the
 * snippet comes from `snippet()` with the match wrapped in control-character
 * markers, which the service splits into plain/matched runs. No markup ever
 * reaches the client.
 */

export interface NoteSearchRow {
  readonly id: string
  readonly title: string
  readonly updatedAt: string
  readonly snippet: string
}

export interface NoteSearchHit {
  readonly id: NoteId
  readonly title: string
  readonly segments: ReadonlyArray<NoteSearchSegment>
  readonly updatedAt: string
}

export interface NoteSearchInput {
  readonly householdId: HouseholdId
  readonly userId: UserId
  readonly query: string
  readonly limit: number
}

export class NoteSearchRepo extends Context.Service<NoteSearchRepo>()("NoteSearchRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    /**
     * Ranked hits for a query.
     *
     * The `MATCH` expression is built by the shared query builder, so a user
     * query can never be read as FTS5 syntax; a query with nothing searchable
     * in it returns no hits instead of an error.
     */
    const search = (
      input: NoteSearchInput
    ): Effect.Effect<ReadonlyArray<NoteSearchHit>, SqlError.SqlError> =>
      Effect.gen(function*() {
        const match = buildSearchMatchQuery(input.query)
        if (match === undefined) return []

        const rows = yield* sql<NoteSearchRow>`
          SELECT n.id AS id,
                 n.title AS title,
                 n.updated_at AS updatedAt,
                 snippet(notes_fts, 2, ${SEARCH_MARK_OPEN}, ${SEARCH_MARK_CLOSE}, '…', 24) AS snippet
          FROM notes_fts
          JOIN notes n ON n.id = notes_fts.note_id
          WHERE notes_fts MATCH ${match}
            AND n.household_id = ${input.householdId}
            AND n.deleted_at IS NULL
            AND (n.owner_id = ${input.userId} OR n.visibility = 'shared')
          ORDER BY notes_fts.rank
          LIMIT ${input.limit}
        `

        return rows.map((row) => ({
          id: row.id as NoteId,
          title: row.title,
          segments: splitSearchSegments(row.snippet),
          updatedAt: row.updatedAt
        }))
      })

    return { search } as const
  })
}) {}

export const NoteSearchRepoLive = Layer.effect(NoteSearchRepo, NoteSearchRepo.make)
