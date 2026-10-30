import { Effect, Option, Schema } from 'effect'

import {
  AUTH_ERROR_CODES,
  type ChangePasswordInput,
  type CreateHouseholdInput,
  type JoinHouseholdInput,
  type LoginInput,
  type RegisterInput,
} from '@tali/domain'

import { HouseholdSummary } from '../household-summary'
import { Session } from '../session'
import { API_URL } from './config'

/**
 * The plain-HTTP auth client, ported from `apps/web/src/lib/auth-api.ts`.
 *
 * Auth rides plain HTTP rather than Effect RPC because the session cookie is
 * set and cleared by the raw response. Every call sends `credentials: include`
 * so the `tali_session` cookie travels across the dev origin boundary.
 *
 * Failures are values, not exceptions: the API answers non-2xx with the shared
 * error envelope, which is decoded to an `AuthFailure` the UI maps to Persian
 * copy. A transport failure or timeout is `Network`.
 *
 * The response schemas are local and plain on purpose. `@tali/domain` builds
 * its wire schemas with `effect/schema`, which Vite serves as a second module
 * graph in dev; decoding through it produces values from the other Schema
 * runtime. Plain strings keep the decoded session and household in the app's
 * own Model types.
 */

/** No request may hang the boot splash or disable a form forever. */
const REQUEST_TIMEOUT_MS = 15_000

export const AuthErrorCode = Schema.Literals(AUTH_ERROR_CODES)
export type AuthErrorCode = typeof AuthErrorCode.Type

export const AuthFailureCode = Schema.Literals([...AUTH_ERROR_CODES, 'Network'])
export type AuthFailureCode = typeof AuthFailureCode.Type

export const AuthFailure = Schema.Struct({
  code: AuthFailureCode,
  retryable: Schema.Boolean,
})
export type AuthFailure = typeof AuthFailure.Type

const ErrorEnvelope = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
    details: Schema.Record(Schema.String, Schema.Unknown),
  }),
})

const OkResponse = Schema.Struct({ ok: Schema.Boolean })

const HouseholdResponse = Schema.Struct({ household: HouseholdSummary })

export type ApiResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: AuthFailure }

const networkFailure = AuthFailure.make({ code: 'Network', retryable: true })

const decodeErrorCode = Schema.decodeUnknownOption(AuthErrorCode)

/** Decode the shared envelope. Anything malformed falls back to the status. */
export const classifyApiFailure = (
  status: number,
  body: unknown,
): AuthFailure => {
  const envelope = Schema.decodeUnknownOption(ErrorEnvelope)(body)

  if (Option.isSome(envelope)) {
    const { code, retryable } = envelope.value.error
    const maybeCode = decodeErrorCode(code)

    if (Option.isSome(maybeCode)) {
      return AuthFailure.make({ code: maybeCode.value, retryable })
    }
  }

  if (status === 401) {
    return AuthFailure.make({ code: 'Unauthorized', retryable: false })
  }

  if (status === 400 || status === 422) {
    return AuthFailure.make({ code: 'BadRequest', retryable: false })
  }

  return AuthFailure.make({ code: 'InternalError', retryable: true })
}

const send = <A>(
  method: 'GET' | 'POST',
  path: string,
  schema: Schema.ConstraintDecoder<A>,
  body?: unknown,
): Effect.Effect<ApiResult<A>> =>
  Effect.gen(function* () {
    const init: RequestInit = {
      method,
      credentials: 'include',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }

    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }

    const maybeResponse = yield* Effect.option(
      Effect.tryPromise({
        try: () => fetch(`${API_URL}${path}`, init),
        catch: () => networkFailure,
      }),
    )

    if (Option.isNone(maybeResponse)) {
      return { ok: false, error: networkFailure }
    }

    const response = maybeResponse.value
    const maybeJson = yield* Effect.option(
      Effect.tryPromise({
        try: () => response.json(),
        catch: () => undefined,
      }),
    )
    const json: unknown = Option.getOrUndefined(maybeJson)

    if (!response.ok) {
      return { ok: false, error: classifyApiFailure(response.status, json) }
    }

    const decoded = Schema.decodeUnknownOption(schema)(json)

    return Option.isSome(decoded)
      ? { ok: true, value: decoded.value }
      : {
          ok: false,
          error: AuthFailure.make({
            code: 'InternalError',
            retryable: false,
          }),
        }
  })

export const authApi = {
  me: (): Effect.Effect<ApiResult<Session>> => send('GET', '/auth/me', Session),

  register: (input: RegisterInput): Effect.Effect<ApiResult<Session>> =>
    send('POST', '/auth/register', Session, input),

  login: (input: LoginInput): Effect.Effect<ApiResult<Session>> =>
    send('POST', '/auth/login', Session, input),

  changePassword: (
    input: ChangePasswordInput,
  ): Effect.Effect<ApiResult<{ ok: boolean }>> =>
    send('POST', '/auth/change-password', OkResponse, input),

  logout: (): Effect.Effect<ApiResult<{ ok: boolean }>> =>
    send('POST', '/auth/logout', OkResponse),

  createHousehold: (
    input: CreateHouseholdInput,
  ): Effect.Effect<ApiResult<{ household: HouseholdSummary }>> =>
    send('POST', '/household', HouseholdResponse, input),

  joinHousehold: (
    input: JoinHouseholdInput,
  ): Effect.Effect<ApiResult<{ household: HouseholdSummary }>> =>
    send('POST', '/household/join', HouseholdResponse, input),
}
