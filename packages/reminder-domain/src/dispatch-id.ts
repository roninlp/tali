import type { ReminderDispatchId } from '@tali/domain'

/**
 * A deterministic UUIDv7-shaped id for one ledger row, derived from the
 * claim mutex key — (reminder, fire instant, origin) — and the row's creation
 * instant.
 *
 * The old sweep minted a random `uuidV7()` in its claim batch; an aggregate's
 * `decide` runs once per command id, so any id would do, but a derived one
 * buys two things: the row's identity is predictable from the facts that
 * caused it (stories assert whole events without guessing), and a re-decide
 * under any future at-least-once seam converges on the same row instead of
 * forking the ledger.
 *
 * The layout is a real UUIDv7: the claim's instant in the 48-bit timestamp,
 * and the 74 random bits taken from FNV-1a over the seed.
 */

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK64 = (1n << 64n) - 1n

const fnv1a = (seed: string): bigint => {
  let hash = FNV_OFFSET
  for (const byte of new TextEncoder().encode(seed)) {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME) & MASK64
  }
  return hash
}

const hex = (value: bigint, width: number): string =>
  value.toString(16).padStart(width, '0').slice(-width)

/** The dispatch id for one (reminder, fire instant, origin) at `createdAt`. */
export const dispatchIdFor = (
  reminderId: string,
  scheduledFor: string,
  origin: string,
  createdAt: string,
): ReminderDispatchId => {
  const timestamp = hex(BigInt(Math.max(0, Date.parse(createdAt))), 12)
  const h1 = fnv1a(`${reminderId}\u0000${scheduledFor}\u0000${origin}`)
  const h2 = fnv1a(`${origin}\u0000${scheduledFor}\u0000${reminderId}`)
  const bits = `${hex(h1, 16)}${hex(h2, 16)}`
  // A UUIDv7's 48-bit timestamp spans the first two groups (8 + 4 hex);
  // version 7 opens the third, variant 10xx the fourth.
  const timeLow = timestamp.slice(0, 8)
  const timeMid = timestamp.slice(8, 12)
  const randA = `7${bits.slice(0, 3)}`
  const randB = `${(8 + (Number.parseInt(bits[3]!, 16) % 4)).toString(16)}${bits.slice(4, 7)}`
  return `${timeLow}-${timeMid}-${randA}-${randB}-${bits.slice(7, 19)}` as ReminderDispatchId
}
