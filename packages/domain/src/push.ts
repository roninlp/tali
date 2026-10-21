import { Schema } from "effect"
import { Model } from "effect/schema"
import { PushSubscriptionId, UserId } from "./common.js"

/**
 * Web Push shapes (tickets #20, #61).
 *
 * Source of truth: `docs/research/web-push-workers.md` §4. A subscription is
 * the browser's capability URL plus its two encryption keys; the server never
 * exposes it back to other clients.
 *
 * The notification payload stays a **pointer**, not the full reminder body:
 * `id` is the **dispatch id**, which is what the service worker answers
 * (`POST /reminders/dispatches/:id/respond`) and what its `tag`/the push
 * `Topic` coalesce on. The missed-reminder inbox is the recovery path, so the
 * push only needs enough to render an actionable notification.
 */

/**
 * Endpoint trust (ticket #61).
 *
 * The endpoint is a **client-supplied URL that the Worker POSTs to**, so it is
 * the one place a malicious (or compromised) browser could aim a server-side
 * request. Push services are always public HTTPS origins, so the checks are
 * deliberately narrow:
 *
 * - `https:` only (no plaintext, no `data:`/`file:`/`javascript:`);
 * - no `user:password@` credentials (they would be sent to the origin);
 * - the default port, or explicitly 443;
 * - no IP literal (v4/v6) and no `.local`/`.internal`/`.localhost` name, so a
 *   row cannot point at loopback, link-local, RFC 1918, or a LAN host;
 * - a length cap (the longest real endpoints are ~300 characters).
 *
 * Residual risk: a public hostname that resolves to a private address (DNS
 * rebinding). Cloudflare's `fetch` refuses private/reserved IP ranges at the
 * edge, and the send sets `redirect: "manual"`, so a redirect cannot bounce the
 * request to a different origin. An allowlist (FCM/Mozilla/Apple/WNS) would
 * close the rest but would make every new push service a deploy; ADR-0005 does
 * not ask for one.
 */
export const MAX_PUSH_ENDPOINT_LENGTH = 2048

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u
const RESERVED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"] as const

export const isSafePushEndpoint = (value: string): boolean => {
  if (value.length === 0 || value.length > MAX_PUSH_ENDPOINT_LENGTH) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  if (url.username !== "" || url.password !== "") return false
  if (url.port !== "" && url.port !== "443") return false
  const host = url.hostname.toLowerCase()
  if (host === "" || host === "localhost") return false
  // URL normalizes decimal/hex IPv4 forms to dotted-quad, so this also catches
  // `https://2130706433/` and `https://0x7f.0.0.1/`.
  if (IPV4.test(host)) return false
  // IPv6 hostnames keep their brackets (`[::1]`).
  if (host.startsWith("[")) return false
  if (RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false
  return true
}

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

/** The two action buttons the shell wires in the notification. */
export const ReminderNotificationAction = Schema.Literals(["done", "snooze"])
export type ReminderNotificationAction = Schema.Schema.Type<typeof ReminderNotificationAction>

/** What the notification's "Snooze" button means without a picker (minutes). */
export const DEFAULT_NOTIFICATION_SNOOZE_MINUTES = 10

/** One rendered notification button (W3C `Notification.actions`). */
export const ReminderPushAction = Schema.Struct({
  action: ReminderNotificationAction,
  /** Localized label ("انجام شد" / "بعداً"). */
  title: Schema.String,
  /** Only for `snooze`: the preset re-fire offset, in minutes (#13 §2.3). */
  minutes: Schema.optional(Schema.Int)
})
export type ReminderPushAction = Schema.Schema.Type<typeof ReminderPushAction>

/**
 * What a push message carries (ADR-0005 §Consequences: "a pointer").
 *
 * `id` is the dispatch id, not the reminder id — one fire is one ledger row and
 * one answer, and the service worker cannot answer a reminder without knowing
 * which occurrence it was showing.
 */
export const ReminderPushPayload = Schema.Struct({
  type: Schema.Literal("reminder"),
  /** The `reminder_dispatches.id` this notification answers. */
  id: Schema.String,
  reminderId: Schema.String,
  title: Schema.String,
  body: Schema.optional(Schema.String),
  /** Medication = `critical`; everything else is `normal`. */
  tier: Schema.optional(Schema.Literals(["normal", "critical"])),
  /** Where a body tap should land. Defaults to `/reminders`. */
  url: Schema.optional(Schema.String),
  actions: Schema.optional(Schema.Array(ReminderPushAction))
})
export type ReminderPushPayload = Schema.Schema.Type<typeof ReminderPushPayload>
