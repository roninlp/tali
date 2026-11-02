import type { LocalWrite, MirrorRecord, OutboxRecord } from "./types"

/**
 * The pure half of the local store: everything that decides what a write
 * means, with no IndexedDB in sight.
 *
 * The store module owns transactions; these helpers own the values that go
 * into them. Keeping them separate makes the outbox rules (fold, chain, keep
 * tombstones) testable without a database.
 */

export const entityKey = (entityType: string, entityId: string): string =>
  `${entityType}\u0000${entityId}`

export const isEmptyPatch = (
  patch: Readonly<Record<string, unknown>>
): boolean => Object.keys(patch).length === 0

export const withoutSyncError = (record: MirrorRecord): MirrorRecord => {
  if (record.syncError === undefined) return record
  const { syncError: _cleared, ...rest } = record
  return rest
}

/** Compare edit instants, not the text: the strings may carry an offset. */
export const laterInstant = (a: string, b: string): string =>
  Date.parse(b) > Date.parse(a) ? b : a

/**
 * Whether an incoming write folds into the newest queued entry for the same
 * entity instead of queueing another link in the chain.
 *
 * Only upsert↔upsert folds. `delete` stays serial because it is a different
 * intent against the same row; the empty-patch upsert stays serial because it
 * is the habit-restore signal the engine recognises by its empty patch (§63),
 * and a patch folded into (or out of) it would erase that signal.
 *
 * `sent` is the idempotency guard: an entry that may already have reached the
 * server must be resent byte-for-byte, because `applied_mutations` would
 * dedupe a merged patch under the same `clientMutationId` and silently drop
 * the newer fields.
 */
export const coalescible = (
  queued: OutboxRecord | undefined,
  write: LocalWrite
): queued is OutboxRecord =>
  queued !== undefined &&
  queued.sent !== true &&
  queued.op === "upsert" &&
  write.op === "upsert" &&
  !isEmptyPatch(queued.patch) &&
  !isEmptyPatch(write.patch)

/**
 * The mirror row a local write leaves behind.
 *
 * The mirror keeps the last *server* version: the client never invents
 * versions, it only invents patches. A newer local edit is not proof that the
 * older rejected fields reached the server, so the sync marker stays until a
 * push result clears it.
 */
export const nextMirrorRecord = (
  current: MirrorRecord | undefined,
  write: LocalWrite,
  now: string
): MirrorRecord => ({
  entityType: write.entityType,
  entityId: write.entityId,
  version: current?.version ?? 0,
  updatedAt: now,
  deletedAt:
    write.deletedAt !== undefined
      ? write.deletedAt
      : write.op === "delete"
        ? now
        : (current?.deletedAt ?? null),
  data: { ...current?.data, ...write.patch },
  ...(current?.syncError === undefined ? {} : { syncError: current.syncError })
})

/** The outbox entry a fresh write would append when it cannot fold. */
export const newOutboxEntry = (
  current: MirrorRecord | undefined,
  write: LocalWrite,
  clientMutationId: string,
  now: string
): Omit<OutboxRecord, "seq"> =>
  ({
    clientMutationId,
    entityType: write.entityType,
    entityId: write.entityId,
    baseVersion: current?.version ?? 0,
    op: write.op,
    patch: write.patch,
    clientUpdatedAt: now,
    sent: false
  }) satisfies Omit<OutboxRecord, "seq">

/**
 * Fold an unsent upsert into the newest queued upsert for the row, in the
 * same transaction as the mirror write, so one editing session is one outbox
 * entry instead of one per keystroke. `byEntity` is non-unique, so `getAll`
 * returns the chain in ascending `seq` order.
 */
export const coalesceOutboxEntry = (
  latest: OutboxRecord | undefined,
  write: LocalWrite,
  now: string
): OutboxRecord | undefined =>
  coalescible(latest, write)
    ? {
        ...latest,
        // Same seq, identity and anchor: the server sees one mutation.
        patch: { ...latest.patch, ...write.patch },
        clientUpdatedAt: laterInstant(latest.clientUpdatedAt, now),
        sent: false
      }
    : undefined
