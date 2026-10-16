import { Context, Effect, Layer } from "effect"

/**
 * Password hashing (ticket #15).
 *
 * The map settles on **argon2**, but Cloudflare Workers expose no argon2
 * primitive (WebCrypto offers PBKDF2 only, and argon2 would need a WASM/pure-JS
 * dependency). This is an interim, Workers-native **PBKDF2-SHA256** implementation
 * behind a stable interface; the algorithm choice is tracked as a follow-up
 * decision ticket. Format: `pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>`.
 */
const SCHEME = "pbkdf2-sha256"
const ITERATIONS = 100_000
const KEY_BITS = 256
const SALT_BYTES = 16

const encoder = new TextEncoder()

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** Length-independent, value-independent comparison (avoids early exit). */
const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

const derive = (password: string, salt: Uint8Array, iterations: number): Effect.Effect<Uint8Array> =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
      "deriveBits"
    ])
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      key,
      KEY_BITS
    )
    return new Uint8Array(bits)
  })

export class PasswordHasher extends Context.Service<PasswordHasher>()("PasswordHasher", {
  make: Effect.sync(() => {
    const hash = (password: string): Effect.Effect<string> =>
      Effect.gen(function*() {
        const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
        const bits = yield* derive(password, salt, ITERATIONS)
        return `${SCHEME}$${ITERATIONS}$${toHex(salt)}$${toHex(bits)}`
      })

    const verify = (password: string, stored: string): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        const [scheme, iterations, saltHex, hashHex] = stored.split("$")
        if (
          scheme !== SCHEME ||
          iterations === undefined ||
          saltHex === undefined ||
          hashHex === undefined
        ) {
          return false
        }
        const bits = yield* derive(password, fromHex(saltHex), Number(iterations))
        return constantTimeEqual(toHex(bits), hashHex)
      })

    return { hash, verify } as const
  })
}) {}

export const PasswordHasherLive = Layer.effect(PasswordHasher, PasswordHasher.make)
