import { Effect, Option, Schema } from 'effect'

import { AuthFailure, classifyApiFailure } from './auth-api'
import { type HttpResult, requestJson } from './http'

/**
 * The note-search client, ported from `apps/web/src/lib/notes/search-api.ts`.
 *
 * The search is a **read**: it rides plain HTTP with the session cookie, so
 * the query is the only input and the answer is a plain list of hits the
 * browser can render as they arrive. Failures are values; a transport failure
 * is `Network`, and the screen falls back to the local mirror.
 *
 * The response schema is local and plain (no branded domain ids), matching
 * `today-api.ts`: dev Vite serves `effect/schema` as a second module graph.
 */

const NoteSearchSegment = Schema.Struct({
  text: Schema.String,
  match: Schema.Boolean,
})

export const NoteSearchServerHit = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  segments: Schema.Array(NoteSearchSegment),
  updatedAt: Schema.String,
})

export type NoteSearchServerHit = typeof NoteSearchServerHit.Type

const NoteSearchResponse = Schema.Struct({
  query: Schema.String,
  hits: Schema.Array(NoteSearchServerHit),
})

type NoteSearchResponse = typeof NoteSearchResponse.Type

export type NoteSearchResult =
  | { readonly ok: true; readonly hits: ReadonlyArray<NoteSearchServerHit> }
  | { readonly ok: false; readonly error: AuthFailure }

const toSearchResult = (
  result: HttpResult<NoteSearchResponse, AuthFailure>,
): NoteSearchResult =>
  result.ok ? { ok: true, hits: result.value.hits } : result

export const searchNotes = (query: string): Effect.Effect<NoteSearchResult> =>
  requestJson({
    path: '/search/notes',
    schema: NoteSearchResponse,
    query: { q: Option.some(query) },
    classify: classifyApiFailure,
    networkFailure: AuthFailure.make({ code: 'Network', retryable: true }),
    decodeFailure: AuthFailure.make({ code: 'InternalError', retryable: true }),
  }).pipe(Effect.map(toSearchResult))
