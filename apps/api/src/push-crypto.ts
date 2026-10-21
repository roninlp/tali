/**
 * Web Push cryptography for the api Worker (ticket #61; RFC 8292 + RFC 8291).
 *
 * Two unrelated key pairs, deliberately (RFC 8292 §3.2):
 *
 * - **VAPID** (`VAPID_PRIVATE_KEY`/`VAPID_PUBLIC_KEY`, P-256, static): signs a
 *   short-lived ES256 JWT that authorizes us to the push service.
 * - **Subscription keys** (`push_subscriptions.p256dh`/`auth`, per browser):
 *   encrypt one message end-to-end, so the push service relays bytes it cannot
 *   read.
 *
 * Only WebCrypto is used (`crypto.subtle`, `crypto.getRandomValues`), so this
 * runs unchanged in workerd, in Node 24 for tests, and in a browser. No
 * `node:crypto`, no `Buffer`, no base64 package.
 *
 * The payload format is `aes128gcm` (RFC 8188 with RFC 8291 key derivation);
 * the RFC 8291 Appendix A vector is pinned in `test/push-crypto.test.ts`.
 */

const P256 = { name: "ECDH", namedCurve: "P-256" } as const
const AES_GCM = { name: "AES-GCM", length: 128 } as const
const ECDH_BITS = 256
/** RFC 8291 §4: a single record, and the server picks a record size above it. */
const RECORD_SIZE = 4096
/** RFC 8188: the last (here: only) record's padding delimiter. */
const LAST_RECORD_DELIMITER = 0x02
const AUTH_SECRET_BYTES = 16
const SALT_BYTES = 16
/** RFC 8292 §2: `exp` MUST be no more than 24 h out; `web-push` uses 12 h. */
const VAPID_EXPIRY_SECONDS = 12 * 60 * 60

export const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")
}

export const base64UrlDecode = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)

/** The uncompressed X9.62 point (0x04 || X || Y) split into a JWK. */
const pointJwk = (publicKey: Uint8Array): JsonWebKey => {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("a P-256 public key must be a 65-byte uncompressed point")
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(publicKey.slice(1, 33)),
    y: base64UrlEncode(publicKey.slice(33, 65))
  }
}

const importPublicKey = (publicKey: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", publicKey, P256, false, [])

const privateJwk = (privateKey: Uint8Array, publicKey: Uint8Array): JsonWebKey => ({
  ...pointJwk(publicKey),
  d: base64UrlEncode(privateKey)
})

const importEcdhPrivateKey = (privateKey: Uint8Array, publicKey: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey("jwk", privateJwk(privateKey, publicKey), P256, false, ["deriveBits"])

const importSigningKey = (privateKey: Uint8Array, publicKey: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "jwk",
    privateJwk(privateKey, publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  )

/** HKDF-SHA-256 extract+expand via WebCrypto (RFC 5869). */
const hkdf = async (
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8
  )
  return new Uint8Array(bits)
}

const deriveEcdhSecret = async (
  own: P256KeyPair,
  peerPublicKey: Uint8Array
): Promise<Uint8Array> => {
  // WebCrypto can only import a private EC key as a JWK, which needs both
  // halves of the pair — hence the key pair, not just the scalar.
  const privateKey = await importEcdhPrivateKey(own.privateKey, own.publicKey)
  const peer = await importPublicKey(peerPublicKey)
  // `@cloudflare/workers-types` spells the peer point `$public`; the runtime
  // (and the DOM typing) spell it `public`. Cast, keeping the runtime shape.
  const algorithm = { name: "ECDH", public: peer } as unknown as SubtleCryptoDeriveKeyAlgorithm
  const bits = await crypto.subtle.deriveBits(algorithm, privateKey, ECDH_BITS)
  return new Uint8Array(bits)
}

export interface P256KeyPair {
  /** Raw 32-byte scalar, base64url-encoded in configuration. */
  readonly privateKey: Uint8Array
  /** Uncompressed 65-byte point. */
  readonly publicKey: Uint8Array
}

/** Generate a fresh sender key pair; the public half is the `keyid` header. */
export const generateP256KeyPair = async (): Promise<P256KeyPair> => {
  const pair = await crypto.subtle.generateKey(P256, true, [
    "deriveBits"
  ]) as unknown as CryptoKeyPair
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer
  )
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey
  if (jwk.d === undefined) throw new Error("the generated P-256 key has no private scalar")
  return { privateKey: base64UrlDecode(jwk.d), publicKey }
}

export interface VapidKeyPair {
  /** Base64url 32-byte P-256 scalar. */
  readonly privateKey: string
  /** Base64url 65-byte uncompressed point. */
  readonly publicKey: string
}

/**
 * Mint the `Authorization: vapid t=…, k=…` JWT (RFC 8292 §2–3).
 *
 * `aud` is the push resource's *origin*, `sub` a contact URI, `exp` is bounded
 * at 24 h. ES256 signs the base64url `header.payload` with P-256 + SHA-256;
 * WebCrypto emits the JWS `r || s` shape directly, and returns a 64-byte
 * signature (a shorter one is left-padded per RFC 7518 §3.4).
 */
export const createVapidJwt = async (input: {
  readonly audience: string
  readonly subject: string
  readonly keys: VapidKeyPair
  /** ISO-8601 instant the token is minted at (the tick's nominal clock). */
  readonly now: string
  readonly expiresInSeconds?: number
}): Promise<string> => {
  const issuedAt = Math.floor(Date.parse(input.now) / 1000)
  const expiresIn = Math.min(
    Math.max(1, input.expiresInSeconds ?? VAPID_EXPIRY_SECONDS),
    24 * 60 * 60
  )
  const header = base64UrlEncode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })))
  const claims = base64UrlEncode(
    utf8(
      JSON.stringify({
        aud: input.audience,
        exp: issuedAt + expiresIn,
        sub: input.subject
      })
    )
  )
  const signingInput = utf8(`${header}.${claims}`)
  const privateKey = base64UrlDecode(input.keys.privateKey)
  const publicKey = base64UrlDecode(input.keys.publicKey)
  const key = await importSigningKey(privateKey, publicKey)
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signingInput)
  )
  if (signature.length !== 64) {
    throw new Error(`unexpected ES256 signature length: ${signature.length}`)
  }
  return `${header}.${claims}.${base64UrlEncode(signature)}`
}

export interface EncryptedPushPayload {
  /** The full `aes128gcm` body: header + ciphertext. */
  readonly body: Uint8Array
  /** Exposed for tests and for logging the header size. */
  readonly salt: Uint8Array
  readonly senderPublicKey: Uint8Array
}

/**
 * Encrypt one payload for one subscription (RFC 8291 §3.4).
 *
 * The header is `salt(16) || rs(4, big-endian) || idlen(1) || keyid(65)`, and
 * the record is the plaintext plus the 0x02 last-record delimiter, so the body
 * length is `<payload> + 86 + 1 + 16`. The sender key pair is single-use and
 * never returned; the caller only needs the bytes.
 *
 * `sender`/`salt` exist for the RFC test vector. Production calls this with
 * neither and gets a fresh ephemeral pair and salt every time.
 */
export const encryptPushPayload = async (input: {
  readonly payload: Uint8Array
  /** The subscription's `p256dh` (base64url uncompressed point). */
  readonly p256dh: string
  /** The subscription's `auth` secret (base64url, 16 bytes). */
  readonly auth: string
  readonly sender?: P256KeyPair
  readonly salt?: Uint8Array
}): Promise<EncryptedPushPayload> => {
  const uaPublicKey = base64UrlDecode(input.p256dh)
  if (uaPublicKey.length !== 65) {
    throw new Error("p256dh must be a 65-byte uncompressed P-256 point")
  }
  const authSecret = base64UrlDecode(input.auth)
  if (authSecret.length !== AUTH_SECRET_BYTES) {
    throw new Error("auth must be 16 bytes")
  }

  const sender = input.sender ?? await generateP256KeyPair()
  const salt = input.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const ecdhSecret = await deriveEcdhSecret(sender, uaPublicKey)

  // RFC 8291 §3.3: mix the ECDH secret with the subscription's auth secret.
  const keyInfo = concat(utf8("WebPush: info"), Uint8Array.of(0), uaPublicKey, sender.publicKey)
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32)

  // RFC 8291 §3.4 → RFC 8188 §2.2: content-encoding key + nonce from the salt.
  const contentEncryptionKey = await hkdf(ikm, salt, utf8("Content-Encoding: aes128gcm\0"), 16)
  const nonce = await hkdf(ikm, salt, utf8("Content-Encoding: nonce\0"), 12)

  const aesKey = await crypto.subtle.importKey("raw", contentEncryptionKey, AES_GCM, false, [
    "encrypt"
  ])
  const record = concat(input.payload, Uint8Array.of(LAST_RECORD_DELIMITER))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record)
  )

  const header = concat(
    salt,
    // rs: always 4096 here — one record, far below the limit.
    Uint8Array.of(0x00, 0x00, 0x10, 0x00),
    Uint8Array.of(sender.publicKey.length),
    sender.publicKey
  )

  return {
    body: concat(header, ciphertext),
    salt,
    senderPublicKey: sender.publicKey
  }
}

/**
 * The push `Topic` (RFC 8030 §5.4): at most 32 base64url characters, so a
 * UUIDv7 dispatch id is hashed. Two sends of the same claim carry the same
 * topic, and the service worker's `tag` (`reminder:<dispatchId>`) coalesces
 * them into one visible notification.
 */
export const pushTopic = async (dispatchId: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", utf8(dispatchId))
  return base64UrlEncode(new Uint8Array(digest).slice(0, 16))
}

/** Remaining delivery window in whole seconds, floored at one (RFC 8030 §5.2). */
export const pushTtlSeconds = (input: {
  readonly now: string
  readonly horizonEnd: string
}): number => {
  const remaining = Date.parse(input.horizonEnd) - Date.parse(input.now)
  return Math.max(1, Math.floor(remaining / 1000))
}
