import { Effect, Option } from 'effect'

import { type ApiResult, AuthFailure, classifyApiFailure } from '../auth-api'
import { API_URL } from '../config'
import { PushSubscriptionInput } from './subscription'

/**
 * `POST /push/register` (ticket #20), ported from
 * `apps/web/src/lib/push/push-api.ts`.
 *
 * Returns failures as values rather than throwing: the permission panel shows
 * a calm message and the subscription stays usable locally (a later boot
 * retries the registration), exactly like the auth client.
 */

const REQUEST_TIMEOUT_MS = 15_000

export const registerPushSubscription = (
  subscription: PushSubscriptionInput,
): Effect.Effect<ApiResult<{ ok: boolean }>> =>
  Effect.gen(function* () {
    const maybeResponse = yield* Effect.option(
      Effect.tryPromise({
        try: () =>
          fetch(`${API_URL}/push/register`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(subscription),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }),
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

    if (response.ok) {
      return { ok: true, value: { ok: true } }
    }

    return {
      ok: false,
      error: classifyApiFailure(response.status, undefined),
    }
  })
