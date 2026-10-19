/**
 * Client-mintable ids.
 *
 * IDs are **UUID v7** (RFC 9562): the leading 48 bits are a Unix-ms timestamp,
 * so ids sort by creation time, and the client can mint one offline without a
 * server round-trip. That is what makes offline-first inserts possible.
 */

const HEX: ReadonlyArray<string> = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0")
)

/**
 * Mint a UUID v7.
 *
 * `now` is injectable for deterministic tests; production callers omit it.
 * The global `crypto` exists in browsers, Workers and Node >= 19.
 */
export const uuidV7 = (now: number = Date.now()): string => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  // 48-bit big-endian millisecond timestamp (bytes 0..5).
  const ts = BigInt(Math.max(0, Math.trunc(now)))
  bytes[0] = Number((ts >> 40n) & 0xffn)
  bytes[1] = Number((ts >> 32n) & 0xffn)
  bytes[2] = Number((ts >> 24n) & 0xffn)
  bytes[3] = Number((ts >> 16n) & 0xffn)
  bytes[4] = Number((ts >> 8n) & 0xffn)
  bytes[5] = Number(ts & 0xffn)

  // Version 7 in the high nibble of byte 6, RFC 4122 variant in byte 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex = HEX
  return (
    hex[bytes[0]!]! + hex[bytes[1]!]! + hex[bytes[2]!]! + hex[bytes[3]!]! + "-" +
    hex[bytes[4]!]! + hex[bytes[5]!]! + "-" +
    hex[bytes[6]!]! + hex[bytes[7]!]! + "-" +
    hex[bytes[8]!]! + hex[bytes[9]!]! + "-" +
    hex[bytes[10]!]! + hex[bytes[11]!]! + hex[bytes[12]!]! + hex[bytes[13]!]! +
    hex[bytes[14]!]! + hex[bytes[15]!]!
  )
}
