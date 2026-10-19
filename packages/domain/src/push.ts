import { Schema } from "effect"
import { Model } from "effect/schema"
import { PushSubscriptionId, UserId } from "./common.js"

/**
 * Web Push shell shapes (ticket #20).
 *
 * Source of truth: `docs/research/web-push-workers.md` §4. A subscription is
 * the browser's capability URL plus its two encryption keys; the server never
 * exposes it back to other clients.
 *
 * The notification payload stays a **pointer** (id/title/tier), not the full
 * reminder body — the missed-reminder inbox is the recovery path, so the push
 * only needs enough to render an actionable notification.
 */

/** `PushSubscription.toJSON()` — exactly what the browser hands us. */
export const PushSubscriptionInput = Schema.Struct({
  endpoint: Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/)),
  /** Milliseconds since epoch, or `null` when the browser did not set one. */
  expirationTime: Schema.NullOr(Schema.Number),
  keys: Schema.Struct({
    p256dh: Schema.String.check(Schema.isMinLength(1)),
    auth: Schema.String.check(Schema.isMinLength(1))
  })
})
export type PushSubscriptionInput = Schema.Schema.Type<typeof PushSubscriptionInput>

/**
 * The persisted per-device subscription (`push_subscriptions`).
 *
 * `endpoint` is unique: a browser rotates its subscription by creating a new
 * endpoint, and re-registering the same endpoint refreshes the keys in place.
 */
export class PushSubscription extends Model.Class<PushSubscription>("PushSubscription")({
  id: Model.UuidV7Insert(PushSubscriptionId),
  userId: UserId,
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
  /** ISO-8601, normalized from the browser's epoch milliseconds. */
  expirationTime: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String
}) {}

/**
 * What a push message carries. The service worker (`apps/web/public/sw.js`)
 * reads these fields directly; keep the two in sync when the dispatch slice
 * starts sending real reminders.
 */
export const ReminderNotification = Schema.Struct({
  type: Schema.Literal("reminder"),
  id: Schema.String,
  title: Schema.String,
  body: Schema.optional(Schema.String),
  /** Medication = `critical`; everything else is `normal`. */
  tier: Schema.optional(Schema.Literals(["normal", "critical"])),
  /** Where a body tap should land. Defaults to `/reminders`. */
  url: Schema.optional(Schema.String)
})
export type ReminderNotification = Schema.Schema.Type<typeof ReminderNotification>

/** The two action buttons the shell wires in the notification. */
export const ReminderNotificationAction = Schema.Literals(["done", "snooze"])
export type ReminderNotificationAction = Schema.Schema.Type<typeof ReminderNotificationAction>
