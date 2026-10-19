/**
 * Web Push client configuration.
 *
 * The VAPID **public** key is public by design (RFC 8292 §3.2): it is the
 * `applicationServerKey` a browser passes to `pushManager.subscribe()`, which
 * restricts the subscription to messages signed by our private key. The
 * private key never reaches the web app (`apps/api/.dev.vars` locally, a
 * Worker secret in production).
 *
 * When the key is missing the shell stays usable and the permission panel says
 * so instead of failing to boot.
 */
export const VAPID_PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY ?? "").trim()

export const VAPID_CONFIGURED = VAPID_PUBLIC_KEY.length > 0

/** Decode a base64url VAPID key into the BufferSource `subscribe()` expects. */
export const urlBase64ToUint8Array = (base64: string): Uint8Array<ArrayBuffer> => {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/")
  const decoded = atob(normalized)
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length))
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return bytes
}
