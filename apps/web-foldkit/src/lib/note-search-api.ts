import { Effect, Option, Schema } from 'effect'

import { AuthFailure, classifyApiFailure } from './auth-api'
import { API_URL } from './config'

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

const REQUEST_TIMEOUT_MS = 15_000

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

export type NoteSearchResult =
  | { readonly ok: true; readonly hits: ReadonlyArray<NoteSearchServerHit> }
  | { readonly ok: false; readonly error: AuthFailure }

const networkFailure = AuthFailure.make({ code: 'Network', retryable: true })

export const searchNotes = (query: string): Effect.Effect<NoteSearchResult> =>
  Effect.gen(function* () {
    const maybeResponse = yield* Effect.option(
      Effect.tryPromise({
        try: () =>
          fetch(`${API_URL}/search/notes?q=${encodeURIComponent(query)}`, {
            method: 'GET',
            credentials: 'include',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }),
        catch: () => networkFailure,
      }),
    )

    if (Option.isNone(maybeResponse)) {
      return { ok: false as const, error: networkFailure }
    }

    const response = maybeResponse.value

    const maybeJson = yield* Effect.option(
      Effect.tryPromise({
        try: () => response.json(),
        catch: () => undefined,
      }),
    )

    const json = Option.getOrUndefined(
      Option.flatMap(maybeJson, value =>
        Schema.decodeUnknownOption(Schema.Json)(value),
      ),
    )

    if (!response.ok) {
      return {
        ok: false as const,
        error: classifyApiFailure(response.status, json),
      }
    }

    const decoded = Schema.decodeUnknownOption(NoteSearchResponse)(json)

    return Option.match(decoded, {
      onNone: () => ({
        ok: false as const,
        error: AuthFailure.make({ code: 'InternalError', retryable: true }),
      }),
      onSome: value => ({ ok: true as const, hits: value.hits }),
    })
  })
