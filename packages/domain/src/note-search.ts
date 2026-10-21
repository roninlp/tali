import { Schema } from "effect"
import { NoteId } from "./planning/common.js"

/**
 * The note-search wire shape (ticket #41; FR-NOTE-04).
 *
 * A hit carries the note's id, the title the index matched, and the snippet
 * split into **plain and matched runs** instead of HTML. The client renders
 * the matched runs as `<mark>` elements, so a note's own text can never inject
 * markup into the result list (the server never sends a tag the client
 * interprets).
 */

/** One run of the snippet: `match` marks the runs that matched the query. */
export const NoteSearchSegment = Schema.Struct({
  text: Schema.String,
  match: Schema.Boolean
})
export type NoteSearchSegment = Schema.Schema.Type<typeof NoteSearchSegment>

/** One matching note. */
export const NoteSearchHit = Schema.Struct({
  id: NoteId,
  /** The title as the index holds it (normalized). The client prefers the raw
   * title from its local mirror and falls back to this one. */
  title: Schema.String,
  /** The snippet around the match, split into plain/matched runs. */
  segments: Schema.Array(NoteSearchSegment),
  updatedAt: Schema.String
})
export type NoteSearchHit = Schema.Schema.Type<typeof NoteSearchHit>

/** The response of `GET /search/notes`. */
export const NoteSearchResponse = Schema.Struct({
  /** The (normalized) query the hits answer. */
  query: Schema.String,
  hits: Schema.Array(NoteSearchHit)
})
export type NoteSearchResponse = Schema.Schema.Type<typeof NoteSearchResponse>
