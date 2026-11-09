import { Effect, Option, Schema } from 'effect'

import { AuthFailure, classifyApiFailure } from './auth-api'
import { API_URL } from './config'

/**
 * The plain-HTTP `GET /today` client.
 *
 * The read model is deliberately not RPC: it needs HTTP caching semantics, so
 * the request carries the session cookie and the last ETag, and a matching
 * `If-None-Match` answers a real 304 instead of a re-download. Failures are
 * values: the screen keeps rendering the mirror rather than blanking when the
 * API is unavailable. `Network` means "could not reach the API", not "the user
 * is signed out".
 *
 * The response schemas are local and plain (no branded domain ids), matching
 * `auth-api.ts`: dev Vite serves `effect/schema` as a second module graph, so
 * decoding through the domain's wire schemas would produce values from the
 * other Schema runtime.
 */

const REQUEST_TIMEOUT_MS = 15_000

export const ServerTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.String),
  dueDate: Schema.optional(Schema.NullOr(Schema.String)),
  dueAt: Schema.optional(Schema.NullOr(Schema.String)),
  timeZone: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.NullOr(Schema.String)),
  tagIds: Schema.optional(Schema.Array(Schema.String)),
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  version: Schema.optional(Schema.Int),
  ownerId: Schema.optional(Schema.String),
  visibility: Schema.optional(Schema.Literals(['private', 'shared'])),
})

export type ServerTask = typeof ServerTask.Type

export const ServerNote = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.Unknown),
  plainText: Schema.optional(Schema.String),
  isPinned: Schema.optional(Schema.Boolean),
  isArchived: Schema.optional(Schema.Boolean),
  tagIds: Schema.optional(Schema.Array(Schema.String)),
  updatedAt: Schema.optional(Schema.String),
  deletedAt: Schema.optional(Schema.NullOr(Schema.String)),
  version: Schema.optional(Schema.Int),
})

export type ServerNote = typeof ServerNote.Type

export const TodayCounts = Schema.Struct({
  tasks: Schema.Int,
  overdue: Schema.Int,
  events: Schema.Int,
  reminders: Schema.Int,
  habits: Schema.Int,
  notes: Schema.Int,
})

export type TodayCounts = typeof TodayCounts.Type

export const TodayEmpty = Schema.Struct({
  tasks: Schema.Boolean,
  events: Schema.Boolean,
  reminders: Schema.Boolean,
  habits: Schema.Boolean,
  notes: Schema.Boolean,
})

export type TodayEmpty = typeof TodayEmpty.Type

export const TodayReadModel = Schema.Struct({
  today: Schema.String,
  tomorrow: Schema.String,
  timeZone: Schema.String,
  sectionOrder: Schema.optional(Schema.Array(Schema.String)),
  tasks: Schema.Array(ServerTask),
  notes: Schema.Array(ServerNote),
  counts: TodayCounts,
  empty: TodayEmpty,
})

export type TodayReadModel = typeof TodayReadModel.Type

export type TodayFetchResult =
  | {
      readonly ok: true
      readonly notModified: true
      readonly maybeEtag: Option.Option<string>
    }
  | {
      readonly ok: true
      readonly notModified: false
      readonly model: TodayReadModel
      readonly maybeEtag: Option.Option<string>
    }
  | { readonly ok: false; readonly error: AuthFailure }

const networkFailure = AuthFailure.make({ code: 'Network', retryable: true })

export const fetchToday = (
  maybeEtag: Option.Option<string>,
): Effect.Effect<TodayFetchResult> =>
  Effect.gen(function* () {
    const headers: Record<string, string> = {}

    if (Option.isSome(maybeEtag)) {
      headers['if-none-match'] = maybeEtag.value
    }

    const maybeResponse = yield* Effect.option(
      Effect.tryPromise({
        try: () =>
          fetch(`${API_URL}/today`, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-cache',
            headers,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }),
        catch: () => networkFailure,
      }),
    )

    if (Option.isNone(maybeResponse)) {
      return { ok: false as const, error: networkFailure }
    }

    const response = maybeResponse.value
    const responseEtag = Option.fromNullishOr(response.headers.get('etag'))
    const etag = Option.isSome(responseEtag) ? responseEtag : maybeEtag

    if (response.status === 304) {
      return { ok: true as const, notModified: true as const, maybeEtag: etag }
    }

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

    const decoded = Schema.decodeUnknownOption(TodayReadModel)(json)

    if (Option.isNone(decoded)) {
      return {
        ok: false as const,
        error: AuthFailure.make({ code: 'InternalError', retryable: true }),
      }
    }

    return {
      ok: true as const,
      notModified: false as const,
      model: decoded.value,
      maybeEtag: etag,
    }
  })
