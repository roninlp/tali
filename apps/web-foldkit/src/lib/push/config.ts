import { Effect, Option, Schema } from 'effect'

import { API_URL } from '../config'

/**
 * Web Push client configuration, ported from
 * `apps/web/src/lib/push/config.ts`.
 *
 * The VAPID **public** key is public by design (RFC 8292 §3.2): it is the
 * `applicationServerKey` a browser passes to `pushManager.subscribe()`, which
 * restricts the subscription to messages signed by our private key. The
 * private key never reaches the web app.
 *
 * The server is the **only** source of truth (`GET /push/vapid`). There is no
 * build-time override on purpose: a `VITE_VAPID_PUBLIC_KEY` baked into a stale
 * bundle would shadow the signer, and the browser's `subscribe()` would mint a
 * subscription the Worker cannot push to (every message rejected with `403`,
 * silently). Asking the API removes that failure mode.
 */

const REQUEST_TIMEOUT_MS = 5_000

const VapidResponse = Schema.Struct({
  publicKey: Schema.NullOr(Schema.String),
})

/** The server's VAPID public key (`""` while unknown / unconfigured). */
export const loadVapidPublicKey: Effect.Effect<string> = Effect.tryPromise({
  try: async () => {
    const response = await fetch(`${API_URL}/push/vapid`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      return ''
    }

    const body: unknown = await response.json()
    const decoded = Schema.decodeUnknownOption(VapidResponse)(body)

    return Option.match(decoded, {
      onNone: () => '',
      onSome: value => value.publicKey?.trim() ?? '',
    })
  },
  catch: () => '',
}).pipe(Effect.orElseSucceed(() => ''))

/** Decode a base64url VAPID key into the BufferSource `subscribe()` expects. */
export const urlBase64ToUint8Array = (
  base64: string,
): Uint8Array<ArrayBuffer> => {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const decoded = atob(normalized)
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length))

  bytes.set(Array.from(decoded, char => char.charCodeAt(0)))

  return bytes
}
