import { generateKeyPairSync } from "node:crypto"

/**
 * A throwaway VAPID pair for tests.
 *
 * Deliberately generated per run instead of being a constant: **no private key
 * material is committed to this repository**, not even a "test" or "dev" pair.
 * A committed private scalar is a leaked key the moment it lands, and a pair
 * that looks like a fixture is the easiest one to promote by accident. Tests
 * only need *a* matching pair, so they mint one.
 *
 * `privateKey` is the base64url 32-byte P-256 scalar (`d`); `publicKey` is the
 * base64url 65-byte uncompressed point, which is what RFC 8292 puts in `k`.
 */
export interface TestVapidKeys {
  readonly privateKey: string
  readonly publicKey: string
}

export const makeTestVapidKeys = (): TestVapidKeys => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1"
  })
  const scalar = privateKey.export({ format: "jwk" }).d
  if (scalar === undefined) throw new Error("the generated P-256 key has no private scalar")
  // SPKI for P-256 is a fixed header followed by the 65-byte uncompressed point.
  const der = publicKey.export({ format: "der", type: "spki" })
  const point = der.subarray(der.length - 65)
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error("unexpected P-256 SPKI encoding")
  }
  return {
    privateKey: scalar,
    publicKey: point.toString("base64url")
  }
}
