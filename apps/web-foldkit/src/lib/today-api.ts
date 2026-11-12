import { Effect, Option, Schema } from 'effect'

import { AuthFailure, classifyApiFailure } from './auth-api'
import { type CachedHttpResult, requestCachedJson } from './http'

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

export type TodayFetchResult = CachedHttpResult<TodayReadModel, AuthFailure>

export const fetchToday = (
  maybeEtag: Option.Option<string>,
): Effect.Effect<TodayFetchResult> =>
  requestCachedJson({
    path: '/today',
    schema: TodayReadModel,
    maybeEtag,
    classify: classifyApiFailure,
    networkFailure: AuthFailure.make({ code: 'Network', retryable: true }),
    decodeFailure: AuthFailure.make({ code: 'InternalError', retryable: true }),
  })
