import * as Domain from '@alchemy.run/domain'
import { Schema } from 'effect'
import { Context, Effect } from 'effect'
import { UserId } from '@tali/domain'
import type { SubscriptionRow } from './Dispatch.js'

/**
 * The firing model's one **External System**: the Web Push transport
 * (ADR-0005's delivery half). The adapter — `@tali/push`'s typed gateway —
 * is unchanged: VAPID ES256, `aes128gcm`, `TTL` ≤ the horizon, `Topic`
 * coalescing. Only the call site moved from the sweep's loop into a policy.
 */

/** What the push service can answer (the gateway's `PushSendResult`). */
export const PushSendResult = Schema.Union([
  Schema.TaggedStruct('accepted', { status: Schema.Finite }),
  /** 404/410: the endpoint is dead; delete this subscription row. */
  Schema.TaggedStruct('gone', { status: Schema.Finite }),
  /** 400/401/403/413: retrying cannot help; the dispatch is inbox-only. */
  Schema.TaggedStruct('permanent', { status: Schema.Finite }),
  /** 429/5xx/network: retry within the attempt budget and the horizon. */
  Schema.TaggedStruct('transient', { status: Schema.NullOr(Schema.Finite) }),
  /** No VAPID keys in this environment (dev without secrets). */
  Schema.TaggedStruct('unconfigured', {}),
])
export type PushSendResult = Schema.Schema.Type<typeof PushSendResult>

/** The registration row the gateway encrypts against. */
export const PushEndpoint = Schema.Struct({
  id: Schema.String,
  userId: UserId,
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
})
export type PushEndpoint = Schema.Schema.Type<typeof PushEndpoint>

export class PushService extends Domain.ExternalSystem(
  'PushService',
  {
    send: {
      args: {
        subscription: PushEndpoint,
        /** The exact JSON bytes the notification shows. */
        payload: Schema.String,
        /** The tick's nominal clock (never `Date.now()`; ADR-0005 §1). */
        now: Schema.String,
        /** Seconds the push service may keep trying (≤ the 15-minute horizon). */
        ttlSeconds: Schema.Int,
        urgency: Schema.Literals(['high', 'normal']),
        /** RFC 8030 §5.4 topic: same claim → one visible notification. */
        topic: Schema.String,
      },
      success: PushSendResult,
    },
  },
  {
    description:
      'The Web Push transport. Accepted means the push service took it, not that a device saw it.',
  },
) {}

/**
 * The owner's push subscriptions, read from the same table the registration
 * route writes. A port, not a database: the worker's adapter resolves the D1
 * binding once at Layer construction (a policy handler may require nothing
 * per call), and a story implements it with memory.
 */
export interface PushSubscriptionStoreApi {
  readonly listByUser: (
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<SubscriptionRow>>
  /** Drop dead endpoints (404/410); idempotent. */
  readonly deleteMany: (ids: ReadonlyArray<string>) => Effect.Effect<void>
}

export class PushSubscriptionStore extends Context.Service<
  PushSubscriptionStore,
  PushSubscriptionStoreApi
>()('ReminderDomain/PushSubscriptionStore') {}
