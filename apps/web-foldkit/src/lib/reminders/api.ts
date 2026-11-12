import { Effect, Option, Schema } from 'effect'

import { type HttpResult, type JsonRequest, requestJson } from '../http'

/**
 * The reminder ledger client, ported from `apps/web/src/lib/reminders/api.ts`.
 *
 * Aggregate CRUD rides RPC, but the inbox and the Done/Snooze/Dismiss answer
 * ride **plain HTTP** because they are not aggregate mutations: the dispatch
 * ledger is server-written, and the same two routes are what the service
 * worker's action queue and the in-app inbox both call. Failures are values: a
 * stable code the UI localizes, plus a transport-only `Network` case.
 *
 * The response schemas are local and plain (no branded domain ids), matching
 * `auth-api.ts` and `today-api.ts`: dev Vite serves `effect/schema` as a second
 * module graph, so decoding through `@tali/domain`'s wire schemas would produce
 * values from the other Schema runtime.
 */

export const DispatchResponse = Schema.Literals(['done', 'snooze', 'dismiss'])

export type DispatchResponse = typeof DispatchResponse.Type

export const ReminderKind = Schema.Literals([
  'medication',
  'exercise',
  'chore',
  'general',
])

export type ReminderKind = typeof ReminderKind.Type

export const ReminderTier = Schema.Literals(['normal', 'critical'])

export type ReminderTier = typeof ReminderTier.Type

export const ReminderDispatch = Schema.Struct({
  id: Schema.String,
  reminderId: Schema.String,
  userId: Schema.String,
  scheduledFor: Schema.String,
  deliverAt: Schema.String,
  rootScheduledFor: Schema.String,
  origin: Schema.String,
  pushOutcome: Schema.String,
  attempts: Schema.Int,
  lastAttemptAt: Schema.NullOr(Schema.String),
  parentDispatchId: Schema.NullOr(Schema.String),
  response: Schema.NullOr(DispatchResponse),
  respondedAt: Schema.NullOr(Schema.String),
  snoozedUntil: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
})

export type ReminderDispatch = typeof ReminderDispatch.Type

export const ReminderInboxItem = Schema.Struct({
  dispatch: ReminderDispatch,
  reminderId: Schema.String,
  title: Schema.String,
  note: Schema.NullOr(Schema.String),
  kind: ReminderKind,
  tier: ReminderTier,
  /** The response target; the inbox never renders it, so it stays opaque. */
  link: Schema.optional(Schema.Unknown),
  visibility: Schema.Literals(['private', 'shared']),
  state: Schema.Literals(['inbox', 'history']),
})

export type ReminderInboxItem = typeof ReminderInboxItem.Type

const ReminderInboxResponse = Schema.Struct({
  items: Schema.Array(ReminderInboxItem),
})

const ReminderResponseResult = Schema.Struct({
  dispatch: ReminderDispatch,
  child: Schema.NullOr(ReminderDispatch),
  onTime: Schema.Boolean,
})

export type ReminderResponseResult = typeof ReminderResponseResult.Type

export const ReminderFailureCode = Schema.Literals([
  'Unauthorized',
  'Forbidden',
  'BadRequest',
  'NotFound',
  'Conflict',
  'Network',
  'InternalError',
])

export type ReminderFailureCode = typeof ReminderFailureCode.Type

export const ReminderFailure = Schema.Struct({
  code: ReminderFailureCode,
  retryable: Schema.Boolean,
})

export type ReminderFailure = typeof ReminderFailure.Type

export type ReminderApiResult<A> = HttpResult<A, ReminderFailure>

/** Map a non-2xx status onto the legacy failure codes. */
export const classifyReminderStatus = (status: number): ReminderFailure => {
  if (status === 401) {
    return ReminderFailure.make({ code: 'Unauthorized', retryable: false })
  }

  if (status === 403) {
    return ReminderFailure.make({ code: 'Forbidden', retryable: false })
  }

  if (status === 404) {
    return ReminderFailure.make({ code: 'NotFound', retryable: false })
  }

  if (status === 409) {
    return ReminderFailure.make({ code: 'Conflict', retryable: true })
  }

  if (status === 400 || status === 422) {
    return ReminderFailure.make({ code: 'BadRequest', retryable: false })
  }

  return ReminderFailure.make({ code: 'InternalError', retryable: true })
}

type ReminderJsonRequest<A> = Omit<
  JsonRequest<A, ReminderFailure>,
  'classify' | 'networkFailure' | 'decodeFailure'
>

const send = <A>(
  request: ReminderJsonRequest<A>,
): Effect.Effect<ReminderApiResult<A>> =>
  requestJson({
    ...request,
    classify: classifyReminderStatus,
    networkFailure: ReminderFailure.make({ code: 'Network', retryable: true }),
    decodeFailure: ReminderFailure.make({
      code: 'InternalError',
      retryable: false,
    }),
  })

export type ReminderInboxOptions = Readonly<{
  history?: boolean
  limit?: number
}>

const unwrapInboxItems = (
  result: ReminderApiResult<{
    readonly items: ReadonlyArray<ReminderInboxItem>
  }>,
): ReminderApiResult<ReadonlyArray<ReminderInboxItem>> =>
  result.ok ? { ok: true, value: result.value.items } : result

/** `GET /reminders/inbox` — the missed-reminder view (or its history page). */
export const fetchReminderInbox = (
  options: ReminderInboxOptions = {},
): Effect.Effect<ReminderApiResult<ReadonlyArray<ReminderInboxItem>>> =>
  send({
    path: '/reminders/inbox',
    schema: ReminderInboxResponse,
    query: {
      history: options.history === true ? Option.some('1') : Option.none(),
      limit:
        options.limit === undefined
          ? Option.none()
          : Option.some(String(options.limit)),
    },
  }).pipe(Effect.map(unwrapInboxItems))

export type RespondToReminderInput = Readonly<{
  dispatchId: string
  response: DispatchResponse
  snoozeMinutes?: number
}>

/**
 * `POST /reminders/dispatches/:id/respond` — the same call the service worker
 * action eventually makes. A double tap returns the stored answer (200), so
 * callers can treat a repeated tap as success.
 */
export const respondToReminder = (
  input: RespondToReminderInput,
): Effect.Effect<ReminderApiResult<ReminderResponseResult>> =>
  send({
    method: 'POST',
    path: `/reminders/dispatches/${encodeURIComponent(input.dispatchId)}/respond`,
    schema: ReminderResponseResult,
    body:
      input.snoozeMinutes === undefined
        ? { response: input.response }
        : { response: input.response, snoozeMinutes: input.snoozeMinutes },
  })
