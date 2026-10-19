import { Context, Effect, Layer } from "effect"
import { constantTimeEqual, fromHex, toHex } from "./bytes.js"

/**
 * Password hashing (ticket #15).
 *
 * The map settles on **argon2**, but Cloudflare Workers expose no argon2
 * primitive (WebCrypto offers PBKDF2 only, and argon2 would need a WASM/pure-JS
 * dependency). This is an interim, Workers-native **PBKDF2-SHA256** implementation
 * behind a stable interface; the algorithm choice is tracked as a follow-up
 * decision ticket (#21). Format: `pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>`.
 */
const SCHEME = "pbkdf2-sha256"
const ITERATIONS = 100_000
const KEY_BITS = 256
const SALT_BYTES = 16

const encoder = new TextEncoder()

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
