import type { MirrorRecord } from "./types"

/**
 * Pure mirror projections.
 *
 * The store reads rows out of IndexedDB; these helpers decide which rows a
 * view sees. Keeping them free of IndexedDB lets the Foldkit Model hold plain
 * snapshots without re-implementing the tombstone and failure rules.
 */

export const liveRows = (
  rows: ReadonlyArray<MirrorRecord>
): ReadonlyArray<MirrorRecord> => rows.filter(row => row.deletedAt === null)

export const trashedRows = (
  rows: ReadonlyArray<MirrorRecord>
): ReadonlyArray<MirrorRecord> =>
  rows
    .filter(row => row.deletedAt !== null)
    .sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""))

export const failedRows = (
  rows: ReadonlyArray<MirrorRecord>
): ReadonlyArray<MirrorRecord> => rows.filter(row => row.syncError !== undefined)

export const countFailedRows = (rows: ReadonlyArray<MirrorRecord>): number =>
  rows.reduce((count, row) => (row.syncError === undefined ? count : count + 1), 0)
