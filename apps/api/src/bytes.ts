import { Effect } from "effect"

/** Hex/random/digest helpers shared by session minting and password hashing. */

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

export const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** Length-independent, value-independent comparison (avoids early exit). */
export const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

const encoder = new TextEncoder()

/** Cryptographically-random lowercase hex string of `bytes` bytes. */
export const randomToken = (bytes: number): string =>
  toHex(crypto.getRandomValues(new Uint8Array(bytes)))

export const sha256Hex = (value: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value))
    return toHex(new Uint8Array(digest))
  })
