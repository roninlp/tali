import { Effect, Option, Schema } from 'effect'

import { Preferences, type PreferencesPatch } from '../preferences-model'
import { type ApiResult, AuthFailure, classifyApiFailure } from './auth-api'
import { API_URL } from './config'

/**
 * The plain-HTTP preferences client, ported from
 * `apps/web/src/lib/preferences-api.ts`.
 *
 * `/preferences` rides plain HTTP with the session cookie, like
 * auth/sync/push. Failures are values: the API's `ErrorEnvelope` is decoded to
 * a stable code the UI localizes, and a transport failure is `Network`.
 *
 * This is **not** an offline mutation stream: the server is the source of
 * truth for preferences and the browser only caches the last response
 * (`preferences-cache.ts`). A failed PATCH is surfaced, never queued
 * (ADR-0002) — a queued display preference would conflict with the server's
 * value on the next device for no benefit.
 */

const REQUEST_TIMEOUT_MS = 15_000

const PreferencesResponse = Schema.Struct({ preferences: Preferences })

const send = (
  method: 'GET' | 'PATCH',
  body?: PreferencesPatch,
): Effect.Effect<ApiResult<Preferences>> =>
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
        try: () => fetch(`${API_URL}/preferences`, init),
        catch: () => undefined,
      }),
    )

    if (Option.isNone(maybeResponse)) {
      return {
        ok: false,
        error: AuthFailure.make({ code: 'Network', retryable: true }),
      }
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

    const decoded = Schema.decodeUnknownOption(PreferencesResponse)(json)

    return Option.isSome(decoded)
      ? { ok: true, value: decoded.value.preferences }
      : {
          ok: false,
          error: { code: 'InternalError', retryable: false },
        }
  })

export const preferencesApi = {
  get: (): Effect.Effect<ApiResult<Preferences>> => send('GET'),

  patch: (patch: PreferencesPatch): Effect.Effect<ApiResult<Preferences>> =>
    send('PATCH', patch),
}
