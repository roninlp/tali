import { Context, Effect, Layer } from "effect"
import { isSafePushEndpoint, type PushSubscription } from "@tali/domain"
import {
  base64UrlDecode,
  createVapidJwt,
  encryptPushPayload,
  type VapidKeyPair
} from "./push-crypto.js"

/**
 * The Web Push transport (ticket #61; ADR-0005 §Consequences).
 *
 * One typed gateway behind an interface so the sweep is testable with a fake:
 * `(subscription, payload, timing) -> PushSendResult`. The real layer signs a
 * VAPID JWT, encrypts the payload with the subscription's keys, and POSTs to
 * the push service with `TTL`, `Urgency` and `Topic`.
 *
 * The result is deliberately about *what to do next*, not about HTTP: the
 * sweep maps `gone` to a subscription delete, `permanent` to an inbox-only
 * dispatch, and `transient` to a bounded retry (ADR-0005 §Consequences).
 */

export interface VapidConfig {
  /** Base64url 32-byte P-256 scalar — a Worker secret, never logged. */
  readonly privateKey: string
  /** Base64url 65-byte uncompressed point; also the JWT's `k` parameter. */
  readonly publicKey: string
  /** `mailto:` or `https:` contact URI (Apple rejects localhost subjects). */
  readonly subject: string
}

/** The VAPID configuration, or `null` when this environment has no keys. */
export class PushConfig extends Context.Service<PushConfig, VapidConfig | null>()("PushConfig") {}

const decode = (value: string): Uint8Array | null => {
  try {
    return base64UrlDecode(value)
  } catch {
    return null
  }
}

/**
 * Read VAPID configuration from the Worker environment.
 *
 * Both halves are required (WebCrypto cannot import a bare EC scalar), and a
 * malformed key disables dispatch rather than throwing on every tick: the
 * sweep still records the ledger row, so the reminder lands in the inbox.
 */
export const vapidConfigOf = (env: {
  readonly VAPID_PRIVATE_KEY?: string
  readonly VAPID_PUBLIC_KEY?: string
  readonly VAPID_SUBJECT?: string
}): VapidConfig | null => {
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? ""
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? ""
  const subject = env.VAPID_SUBJECT?.trim() ?? ""
  if (privateKey === "" || publicKey === "" || subject === "") return null
  if (!/^(mailto:|https:)/u.test(subject)) return null
  if (decode(privateKey)?.length !== 32) return null
  if (decode(publicKey)?.length !== 65) return null
  return { privateKey, publicKey, subject }
}

export type PushSendResult =
  /** The push service accepted it — not "the device saw it" (RFC 8030 §5). */
  | { readonly _tag: "accepted"; readonly status: number }
  /** 404/410: the endpoint is dead; delete this subscription row. */
  | { readonly _tag: "gone"; readonly status: number }
  /** 400/401/403/413: retrying cannot help; the dispatch is inbox-only. */
  | { readonly _tag: "permanent"; readonly status: number }
  /** 429/5xx/network: retry within the attempt budget and the horizon. */
  | { readonly _tag: "transient"; readonly status: number | null }
  /** No VAPID keys in this environment (dev without secrets). */
  | { readonly _tag: "unconfigured" }

export interface PushSendInput {
  readonly subscription: PushSubscription
  /** The exact JSON bytes the notification shows. */
  readonly payload: string
  /** The tick's nominal clock (never `Date.now()`; ADR-0005 §1). */
  readonly now: string
  /** Seconds the push service may keep trying (≤ the 15-minute horizon). */
  readonly ttlSeconds: number
  readonly urgency: "high" | "normal"
  /** RFC 8030 §5.4 topic: same claim → same topic → one visible notification. */
  readonly topic: string
}

export interface PushGatewayApi {
  readonly send: (input: PushSendInput) => Effect.Effect<PushSendResult>
}

export class PushGateway extends Context.Service<PushGateway, PushGatewayApi>()("PushGateway") {}

/** HTTP status → the sweep's next action (ADR-0005 §Consequences). */
export const classifyPushStatus = (status: number): PushSendResult => {
  if (status >= 200 && status < 300) return { _tag: "accepted", status }
  if (status === 404 || status === 410) return { _tag: "gone", status }
  if (status === 429) return { _tag: "transient", status }
  if (status >= 500) return { _tag: "transient", status }
  // 400/401/403/413 and any other 4xx: the same message will fail again.
  return { _tag: "permanent", status }
}

const originOf = (endpoint: string): string => new URL(endpoint).origin

export const makePushGateway = (config: VapidConfig | null): PushGatewayApi => ({
  send: (input) =>
    Effect.gen(function*() {
      if (config === null) return { _tag: "unconfigured" } as const

      // The endpoint is client-supplied and this is a server-side POST: an
      // unsafe one is permanent (a different message cannot fix it) and must
      // never reach `fetch`. Registration rejects these too; this is the
      // defence that also covers rows stored before the check existed.
      if (!isSafePushEndpoint(input.subscription.endpoint)) {
        return { _tag: "permanent", status: 400 } as const
      }

      const keys: VapidKeyPair = config
      const encrypted = yield* Effect.tryPromise({
        try: () =>
          encryptPushPayload({
            payload: new TextEncoder().encode(input.payload),
            p256dh: input.subscription.p256dh,
            auth: input.subscription.auth
          }),
        catch: (error) => error
      }).pipe(Effect.option)
      // Bad subscription keys are permanent: a different message cannot fix them.
      if (encrypted._tag === "None") return { _tag: "permanent", status: 400 } as const

      const jwt = yield* Effect.tryPromise({
        try: () =>
          createVapidJwt({
            audience: originOf(input.subscription.endpoint),
            subject: config.subject,
            keys,
            now: input.now
          }),
        catch: (error) => error
      }).pipe(Effect.option)
      if (jwt._tag === "None") return { _tag: "transient", status: null } as const

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(input.subscription.endpoint, {
            method: "POST",
            cache: "no-store",
            // Push services answer directly; a redirect would be an attempt to
            // bounce this server-side POST to another origin (see
            // `isSafePushEndpoint`). Any 3xx is mapped to `permanent` below.
            redirect: "manual",
            headers: {
              authorization: `vapid t=${jwt.value}, k=${config.publicKey}`,
              "content-encoding": "aes128gcm",
              "content-type": "application/octet-stream",
              ttl: String(input.ttlSeconds),
              urgency: input.urgency,
              topic: input.topic
            },
            body: encrypted.value.body
          }),
        catch: (error) => error
      }).pipe(Effect.option)

      return response._tag === "None"
        ? { _tag: "transient", status: null } as const
        : classifyPushStatus(response.value.status)
    })
})

export const PushGatewayLive = Layer.effect(
  PushGateway,
  Effect.map(PushConfig, (config) => makePushGateway(config))
)
