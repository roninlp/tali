/**
 * The token alphabet a `fast-check` program draws from, decoded in one place.
 *
 * The write alphabet deliberately covers **every** operation the simulator
 * promises: six slots, each written four times per device as
 * create/patch (`kind` 0/1), delete (`kind` 2) and revive (`kind` 3). Keeping
 * the decode here (rather than as arithmetic inside the test) is what
 * `harness.test.ts` pins: an alphabet that silently stops generating deletes
 * or revives fails a unit test instead of quietly weakening the property run.
 */

export const SLOT_COUNT = 6
export const WRITE_KINDS = [0, 1, 2, 3] as const
export type WriteKind = (typeof WRITE_KINDS)[number]

/** Four writes per slot — one of each kind. */
export const WRITES_PER_DEVICE = SLOT_COUNT * WRITE_KINDS.length
export const WRITE_TOKEN_COUNT = WRITES_PER_DEVICE * 2

export interface WriteToken {
  readonly device: 0 | 1
  readonly slot: number
  readonly kind: WriteKind
}

/** Decode one write token. Throws for a token outside the write alphabet. */
export const decodeWriteToken = (token: number): WriteToken => {
  if (!Number.isInteger(token) || token < 0 || token >= WRITE_TOKEN_COUNT) {
    throw new Error(`not a write token: ${token}`)
  }
  const device = token < WRITES_PER_DEVICE ? 0 : 1
  const local = token % WRITES_PER_DEVICE
  return {
    device,
    slot: local % SLOT_COUNT,
    kind: Math.floor(local / SLOT_COUNT) as WriteKind
  }
}

/** The non-write tokens: syncs, duplicate pushes and the two probes. */
export const TOKEN = {
  syncA: WRITE_TOKEN_COUNT,
  syncB: WRITE_TOKEN_COUNT + 1,
  concurrentSync: WRITE_TOKEN_COUNT + 2,
  duplicatePushA: WRITE_TOKEN_COUNT + 3,
  duplicatePushB: WRITE_TOKEN_COUNT + 4,
  disjointProbe: WRITE_TOKEN_COUNT + 5,
  lwwProbe: WRITE_TOKEN_COUNT + 6
} as const

export const TOKEN_COUNT = WRITE_TOKEN_COUNT + 7
