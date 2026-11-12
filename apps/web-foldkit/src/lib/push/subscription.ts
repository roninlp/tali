import { Schema } from 'effect'

/**
 * The browser subscription as the Model and the `/push/register` body hold it.
 *
 * `PushSubscription` is a DOM object that cannot live in a Schema Model, so
 * the app stores `toJSON()`'s plain shape. Keep this in step with
 * `packages/domain/src/push.ts` and this app's `public/sw.js`.
 */

export const PushSubscriptionJson = Schema.Struct({
  endpoint: Schema.String,
  expirationTime: Schema.NullOr(Schema.Finite),
  keys: Schema.Struct({
    p256dh: Schema.String,
    auth: Schema.String,
  }),
})

export type PushSubscriptionJson = typeof PushSubscriptionJson.Type

export const PushSubscriptionInput = Schema.Struct({
  endpoint: Schema.String,
  expirationTime: Schema.NullOr(Schema.Finite),
  keys: Schema.Struct({
    p256dh: Schema.String,
    auth: Schema.String,
  }),
})

export type PushSubscriptionInput = typeof PushSubscriptionInput.Type

/** Normalize the browser's `toJSON()` output into the strict wire shape. */
export const toRegistrationInput = (
  json: PushSubscriptionJson,
): PushSubscriptionInput =>
  PushSubscriptionInput.make({
    endpoint: json.endpoint,
    expirationTime: json.expirationTime,
    keys: {
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    },
  })
