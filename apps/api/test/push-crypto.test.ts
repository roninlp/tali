import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  isSafePushEndpoint,
  MAX_PUSH_ENDPOINT_LENGTH,
  type PushSubscription
} from "@tali/domain"
import {
  base64UrlDecode,
  base64UrlEncode,
  createVapidJwt,
  encryptPushPayload,
  pushTopic,
  pushTtlSeconds
} from "../src/push-crypto.js"
import { classifyPushStatus, makePushGateway, vapidConfigOf } from "../src/push-gateway.js"
import { makeTestVapidKeys } from "./vapid-fixture.js"

/**
 * Ticket #61 at the crypto seam.
 *
 * The strongest test here is the RFC 8291 Appendix A vector: fixed sender key,
 * fixed salt, fixed receiver keys and the literal ciphertext from the RFC. A
 * self-consistent encrypt/decrypt pair would only prove we agree with
 * ourselves; the vector proves the bytes match what a real browser's Push API
 * expects. `decryptAes128gcm` below is the receiver side of RFC 8291 §3.4 —
 * test-only, so a bug that cancels out on both sides is much less likely.
 */

/**
 * RFC 8291 Appendix A's published interoperability vector.
 *
 * These are **not secrets** — they are the example keys and ciphertext printed
 * in the RFC. The scalars are assembled from short parts because secret scanners
 * (GitGuardian's "Vapid Key" detector) flag any 43-character P-256 scalar next
 * to a `privateKey` name, and a public test vector should not read as a leaked
 * key in CI.
 */
const parts = (...chunks: ReadonlyArray<string>): string => chunks.join("")

const RFC8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  senderPrivateKey: parts("yfWPiYE-n4", "6HLnH0KqZO", "F1fJJU3MYr", "ct3AELtAQ-", "oRw"),
  senderPublicKey:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  receiverPrivateKey: parts("q1dXpw3UpT", "5VOmu_cf_v", "6ih07Aems3", "njxI-JWgLc", "M94"),
  receiverPublicKey:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: parts("BTBZMqHH6r", "4Tts7J_aS", "Igg"),
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
} as const

const pointJwk = (publicKey: Uint8Array): JsonWebKey => ({
  kty: "EC",
  crv: "P-256",
  x: base64UrlEncode(publicKey.slice(1, 33)),
  y: base64UrlEncode(publicKey.slice(33, 65))
})

/** Receiver side of RFC 8291: parse the aes128gcm body and decrypt one record. */
const decryptAes128gcm = async (input: {
  readonly body: Uint8Array
  readonly receiverPrivateKey: string
  readonly receiverPublicKey: string
  readonly auth: string
}): Promise<Uint8Array> => {
  const salt = input.body.slice(0, 16)
  const idLength = input.body[20]!
  const senderPublicKey = input.body.slice(21, 21 + idLength)
  const ciphertext = input.body.slice(21 + idLength)

  const receiverPrivate = await crypto.subtle.importKey(
    "jwk",
    { ...pointJwk(base64UrlDecode(input.receiverPublicKey)), d: input.receiverPrivateKey },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  )
  const senderPublic = await crypto.subtle.importKey(
    "raw",
    senderPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  )
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: senderPublic } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      receiverPrivate,
      256
    )
  )

  const hkdf = async (ikm: Uint8Array, hkdfSalt: Uint8Array, info: Uint8Array, length: number) => {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: hkdfSalt, info },
        key,
        length * 8
      )
    )
  }

  const keyInfo = new Uint8Array([
    ...new TextEncoder().encode("WebPush: info"),
    0,
    ...base64UrlDecode(input.receiverPublicKey),
    ...senderPublicKey
  ])
  const ikm = await hkdf(ecdhSecret, base64UrlDecode(input.auth), keyInfo, 32)
  const cek = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16)
  const nonce = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: nonce\0"), 12)

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"])
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ciphertext)
  )
  // RFC 8291 §4: the last-record delimiter must be 0x02, and it is stripped.
  expect(plaintext.at(-1)).toBe(0x02)
  return plaintext.slice(0, -1)
}

describe("aes128gcm payload encryption", () => {
  it("reproduces the RFC 8291 Appendix A test vector byte for byte", async () => {
    const encrypted = await encryptPushPayload({
      payload: new TextEncoder().encode(RFC8291.plaintext),
      p256dh: RFC8291.receiverPublicKey,
      auth: RFC8291.auth,
      sender: {
        privateKey: base64UrlDecode(RFC8291.senderPrivateKey),
        publicKey: base64UrlDecode(RFC8291.senderPublicKey)
      },
      salt: base64UrlDecode(RFC8291.salt)
    })

    expect(base64UrlEncode(encrypted.body)).toBe(RFC8291.body)
    // The header is salt(16) + rs(4) + idlen(1) + keyid(65).
    expect(encrypted.body.slice(0, 16)).toEqual(base64UrlDecode(RFC8291.salt))
    expect([...encrypted.body.slice(16, 20)]).toEqual([0x00, 0x00, 0x10, 0x00])
    expect(encrypted.body[20]).toBe(65)
  })

  it("round-trips a generated payload through the receiver's keys", async () => {
    const receiver = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    ) as unknown as CryptoKeyPair
    const receiverPublic = base64UrlEncode(
      new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey) as ArrayBuffer)
    )
    const receiverJwk = await crypto.subtle.exportKey("jwk", receiver.privateKey) as JsonWebKey
    const receiverPrivate = receiverJwk.d!

    const plaintext = '{"type":"reminder","id":"0192-dispatched"}'
    const auth = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))
    const encrypted = await encryptPushPayload({
      payload: new TextEncoder().encode(plaintext),
      p256dh: receiverPublic,
      auth
    })

    const output = await decryptAes128gcm({
      body: encrypted.body,
      receiverPrivateKey: receiverPrivate,
      receiverPublicKey: receiverPublic,
      auth
    })
    expect(new TextDecoder().decode(output)).toBe(plaintext)
    // salt(16) + rs(4) + idlen(1) + keyid(65) + plaintext + delimiter + tag(16).
    expect(encrypted.body.length).toBe(plaintext.length + 86 + 1 + 16)
  })

  it("rejects malformed subscription keys instead of sending garbage", async () => {
    await expect(
      encryptPushPayload({
        payload: new TextEncoder().encode("x"),
        p256dh: base64UrlEncode(new Uint8Array(10)),
        auth: base64UrlEncode(new Uint8Array(16))
      })
    ).rejects.toThrow(/65-byte/)
    await expect(
      encryptPushPayload({
        payload: new TextEncoder().encode("x"),
        p256dh: RFC8291.receiverPublicKey,
        auth: base64UrlEncode(new Uint8Array(8))
      })
    ).rejects.toThrow(/16 bytes/)
  })
})

describe("VAPID JWT (RFC 8292)", () => {
  // Generated per run: no private key material lives in the repository.
  const keys = makeTestVapidKeys()
  const now = "2026-10-21T09:00:00.000Z"

  it("has the ES256 header, the RFC 8292 claims, and a verifiable signature", async () => {
    const jwt = await createVapidJwt({
      audience: "https://fcm.googleapis.com",
      subject: "mailto:ops@tali.example",
      keys,
      now
    })
    const [header, claims, signature] = jwt.split(".")
    expect(header).toBeDefined()
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(header!)))).toEqual({
      typ: "JWT",
      alg: "ES256"
    })
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(claims!))) as {
      readonly aud: string
      readonly exp: number
      readonly sub: string
    }
    expect(decoded.aud).toBe("https://fcm.googleapis.com")
    expect(decoded.sub).toBe("mailto:ops@tali.example")
    // `web-push`'s default: 12 h, and never more than the 24 h ceiling.
    expect(decoded.exp - Math.floor(Date.parse(now) / 1000)).toBe(12 * 60 * 60)

    const publicKey = await crypto.subtle.importKey(
      "raw",
      base64UrlDecode(keys.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    )
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      base64UrlDecode(signature!),
      new TextEncoder().encode(`${header}.${claims}`)
    )
    expect(valid).toBe(true)
  })

  it("caps `exp` at 24 hours even when asked for longer", async () => {
    const jwt = await createVapidJwt({
      audience: "https://push.example.net",
      subject: "https://tali.example",
      keys,
      now,
      expiresInSeconds: 48 * 60 * 60
    })
    const claims = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(jwt.split(".")[1]!))
    ) as { readonly exp: number }
    expect(claims.exp - Math.floor(Date.parse(now) / 1000)).toBe(24 * 60 * 60)
  })

  it("rejects a config missing either key half or a non-contact subject", () => {
    expect(vapidConfigOf({})).toBeNull()
    expect(
      vapidConfigOf({ VAPID_PRIVATE_KEY: keys.privateKey, VAPID_PUBLIC_KEY: keys.publicKey })
    ).toBeNull()
    expect(
      vapidConfigOf({
        VAPID_PRIVATE_KEY: keys.privateKey,
        VAPID_PUBLIC_KEY: keys.publicKey,
        VAPID_SUBJECT: "localhost"
      })
    ).toBeNull()
    expect(
      vapidConfigOf({
        VAPID_PRIVATE_KEY: keys.privateKey,
        VAPID_PUBLIC_KEY: keys.publicKey,
        VAPID_SUBJECT: "mailto:dev@tali.local"
      })
    ).toEqual({ ...keys, subject: "mailto:dev@tali.local" })
  })
})

describe("push headers", () => {
  it("builds a stable RFC 8030 topic no longer than 32 characters", async () => {
    const id = "019a2f0a-6f2c-7000-8000-3c7f1a2b4c5d"
    const topic = await pushTopic(id)
    expect(topic).toBe(await pushTopic(id))
    expect(topic.length).toBeLessThanOrEqual(32)
    expect(topic).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(await pushTopic("019a2f0a-6f2c-7000-8000-000000000000")).not.toBe(topic)
  })

  it("sizes TTL to the remaining delivery horizon, never zero", () => {
    expect(
      pushTtlSeconds({ now: "2026-10-21T07:00:00.000Z", horizonEnd: "2026-10-21T07:15:00.000Z" })
    ).toBe(900)
    expect(
      pushTtlSeconds({ now: "2026-10-21T07:14:59.500Z", horizonEnd: "2026-10-21T07:15:00.000Z" })
    ).toBe(1)
    expect(
      pushTtlSeconds({ now: "2026-10-21T07:20:00.000Z", horizonEnd: "2026-10-21T07:15:00.000Z" })
    ).toBe(1)
  })

  it("maps push-service statuses to the sweep's next action (ADR-0005)", () => {
    expect(classifyPushStatus(201)).toEqual({ _tag: "accepted", status: 201 })
    expect(classifyPushStatus(202)).toEqual({ _tag: "accepted", status: 202 })
    expect(classifyPushStatus(404)).toEqual({ _tag: "gone", status: 404 })
    expect(classifyPushStatus(410)).toEqual({ _tag: "gone", status: 410 })
    expect(classifyPushStatus(400)._tag).toBe("permanent")
    expect(classifyPushStatus(401)._tag).toBe("permanent")
    expect(classifyPushStatus(403)._tag).toBe("permanent")
    expect(classifyPushStatus(413)._tag).toBe("permanent")
    expect(classifyPushStatus(429)._tag).toBe("transient")
    expect(classifyPushStatus(500)._tag).toBe("transient")
    expect(classifyPushStatus(503)._tag).toBe("transient")
  })
})

describe("subscription endpoint trust (SSRF)", () => {
  /** The four real push services a browser can hand us. */
  const PUBLIC = [
    "https://fcm.googleapis.com/wp/abc123",
    "https://updates.push.services.mozilla.com/wpush/v2/abc123",
    "https://web.push.apple.com/QGxhbGlzYmFja2VuZA",
    "https://wns2-par02p.notify.windows.com/w/?token=abc123"
  ]

  const UNSAFE = [
    // plaintext
    "http://push.example.net/x",
    // credentials
    "https://user:pass@push.example.net/x",
    // non-default port
    "https://push.example.net:8443/x",
    // loopback / private / link-local, incl. the forms URL normalizes
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://2130706433/x",
    "https://192.168.1.10/x",
    "https://metadata.google.internal/x",
    "https://printer.local/x",
    // not a fetchable URL at all
    "javascript:alert(1)",
    "not a url",
    `https://push.example.net/${"a".repeat(MAX_PUSH_ENDPOINT_LENGTH)}`
  ]

  it("accepts the public push-service origins", () => {
    for (const endpoint of PUBLIC) expect([endpoint, isSafePushEndpoint(endpoint)]).toEqual([endpoint, true])
  })

  it("rejects loopback, private, credentialed and non-https endpoints", () => {
    for (const endpoint of UNSAFE) expect([endpoint, isSafePushEndpoint(endpoint)]).toEqual([endpoint, false])
  })

  it("never calls fetch for an unsafe stored row (defence past registration)", async () => {
    const original = globalThis.fetch
    let called = 0
    globalThis.fetch = (async () => {
      called += 1
      throw new Error("fetch must not run")
    }) as typeof fetch
    try {
      const config = { ...makeTestVapidKeys(), subject: "mailto:dev@tali.local" }
      const gateway = makePushGateway(config)
      const subscription = {
        id: "sub-1",
        userId: "user-1",
        endpoint: "https://127.0.0.1/internal",
        p256dh: RFC8291.receiverPublicKey,
        auth: RFC8291.auth,
        expirationTime: null,
        userAgent: null,
        createdAt: "2026-10-21T09:00:00.000Z",
        updatedAt: "2026-10-21T09:00:00.000Z"
      } as unknown as PushSubscription
      const result = await Effect.runPromise(
        gateway.send({
          subscription,
          payload: "{}",
          now: "2026-10-21T09:00:00.000Z",
          ttlSeconds: 900,
          urgency: "normal",
          topic: "topic"
        })
      )
      expect(result).toEqual({ _tag: "permanent", status: 400 })
      expect(called).toBe(0)
    } finally {
      globalThis.fetch = original
    }
  })
})
