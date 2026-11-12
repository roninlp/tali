import { Effect, Schema } from 'effect'

import { Preferences, type PreferencesPatch } from '../preferences-model'
import { type ApiResult, AuthFailure, classifyApiFailure } from './auth-api'
import { requestJson } from './http'

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

const PreferencesResponse = Schema.Struct({ preferences: Preferences })

type PreferencesResponse = typeof PreferencesResponse.Type

const unwrapPreferences = (
  result: ApiResult<PreferencesResponse>,
): ApiResult<Preferences> =>
  result.ok ? { ok: true, value: result.value.preferences } : result

const send = (
  method: 'GET' | 'PATCH',
  body?: PreferencesPatch,
): Effect.Effect<ApiResult<Preferences>> =>
  requestJson({
    method,
    path: '/preferences',
    schema: PreferencesResponse,
    body,
    classify: classifyApiFailure,
    networkFailure: AuthFailure.make({ code: 'Network', retryable: true }),
    decodeFailure: AuthFailure.make({
      code: 'InternalError',
      retryable: false,
    }),
  }).pipe(Effect.map(unwrapPreferences))

export const preferencesApi = {
  get: (): Effect.Effect<ApiResult<Preferences>> => send('GET'),

  patch: (patch: PreferencesPatch): Effect.Effect<ApiResult<Preferences>> =>
    send('PATCH', patch),
}
