import { Effect, Schema } from 'effect'

import { type ApiResult, AuthFailure, classifyApiFailure } from '../auth-api'
import { requestJson } from '../http'
import { PushSubscriptionInput } from './subscription'

/**
 * `POST /push/register` (ticket #20), ported from
 * `apps/web/src/lib/push/push-api.ts`.
 *
 * Returns failures as values rather than throwing: the permission panel shows
 * a calm message and the subscription stays usable locally (a later boot
 * retries the registration), exactly like the auth client.
 *
 * A success answers `{ ok: true }`, so the response now decodes through the
 * shared JSON client and its error envelope reaches the classifier when the
 * worker rejects the registration. The status alone classified before.
 */

const RegisterResponse = Schema.Struct({ ok: Schema.Boolean })

export const registerPushSubscription = (
  subscription: PushSubscriptionInput,
): Effect.Effect<ApiResult<{ ok: boolean }>> =>
  requestJson({
    method: 'POST',
    path: '/push/register',
    schema: RegisterResponse,
    body: subscription,
    classify: classifyApiFailure,
    networkFailure: AuthFailure.make({ code: 'Network', retryable: true }),
    decodeFailure: AuthFailure.make({
      code: 'InternalError',
      retryable: false,
    }),
  })
