import type { SyncEntityType, SyncOp, SyncPushEntry } from "@tali/domain"

/**
 * The local-first client store types.
 *
 * The mirror is the row the UI renders from; the outbox is the queue of
 * mutations still to be pushed. `clientMutationId` is the idempotency key, so
 * the queue can survive a lost push response. See `docs/sync-protocol-draft.md`
 * §4 and §7 for the wire shapes and the hydration order.
 */

/**
 * A push the server refused as written. The mirror keeps the user's local row
 * (their intent is still what they see), but records why it never reached the
 * server so the UI can stop claiming "saved" and offer a retry.
 */
export interface SyncFailure {
  readonly code: string
  readonly message: string
  readonly at: string
  readonly clientMutationId: string
}

/** One entity row as this client currently knows it. */
export interface MirrorRecord {
  readonly entityType: SyncEntityType
  readonly entityId: string
  /** Last **server** version this client saw; `0` until the first ack. */
  readonly version: number
  /** Last local or server mutation time (ISO-8601 UTC). */
  readonly updatedAt: string
  /** Soft-delete tombstone; `null` for a live row. */
  readonly deletedAt: string | null
  /** The entity's own fields — no sync metadata duplicated in here. */
  readonly data: Readonly<Record<string, unknown>>
  /**
   * The last rejected push for this row, absent once it lands or is retried.
   *
   * IndexedDB stores each record as a plain value, so rows written before this
   * field existed simply read as `undefined`. No DB version bump is needed;
   * the field is added and removed per record.
   */
  readonly syncError?: SyncFailure
}

/** An entity addressed without its payload, for clearing a stale marker. */
export interface EntityRef {
  readonly entityType: SyncEntityType
  readonly entityId: string
}

/** A queued mutation plus the local FIFO key. */
export interface OutboxRecord extends SyncPushEntry {
  readonly seq: number
  /**
   * True once a push carrying this entry has started.
   *
   * It is the coalescing safety flag: an entry that may already have reached
   * the server is never merged into, because `applied_mutations` dedupe would
   * swallow a merged patch resent under the same `clientMutationId` after a
   * lost response. Rows written before this flag existed read as `undefined`
   * and are treated as unsent.
   */
  readonly sent: boolean
}

/** What a local mutation supplies; the store fills in ids/timestamps. */
export interface LocalWrite {
  readonly entityType: SyncEntityType
  readonly entityId: string
  readonly op: SyncOp
  /** Only the fields that changed (field-level LWW input). */
  readonly patch: Readonly<Record<string, unknown>>
  /**
   * Override the mirror's tombstone state. A `delete` sets `deletedAt` to the
   * write time; an `upsert` otherwise preserves the existing tombstone. The
   * notes trash view uses `null` for an optimistic local restore.
   */
  readonly deletedAt?: string | null
  /** Override for tests / replays; normally minted by the store. */
  readonly clientMutationId?: string
  /** Override for tests; defaults to the current time. */
  readonly now?: string
}

/** An authoritative row arriving from the server. */
export interface ServerRow {
  readonly entityType: SyncEntityType
  readonly entityId: string
  readonly version: number
  readonly updatedAt: string
  readonly deletedAt: string | null
  readonly data: Readonly<Record<string, unknown>>
}

export interface DraftRecord {
  readonly key: string
  readonly value: string
  readonly updatedAt: string
}

export type LocalStoreListener = () => void

/**
 * The store handle. Every method resolves only once IndexedDB has committed —
 * a resolved `writeLocal` means the write is durable, not merely enqueued in
 * memory.
 */
export interface LocalStore {
  readonly userId: string
  readonly closed: boolean

  /** Live rows for an entity type, newest `updatedAt` last. */
  list: (entityType: SyncEntityType) => Promise<ReadonlyArray<MirrorRecord>>
  /**
   * Rows whose last push was rejected, in no particular order. Failures are
   * rare, so a mirror scan is cheaper than a schema/index bump — but it is a
   * scan, so the provider does it only on open and after a sync pass, never on
   * every local write.
   */
  listFailed: () => Promise<ReadonlyArray<MirrorRecord>>
  failedCount: () => Promise<number>
  /**
   * Soft-deleted rows for the trash view. Trash is a tombstone in the mirror,
   * not a separate store: the same row can be restored in place.
   */
  listTrashed: (entityType: SyncEntityType) => Promise<ReadonlyArray<MirrorRecord>>
  get: (entityType: SyncEntityType, entityId: string) => Promise<MirrorRecord | undefined>

  /**
   * Apply a local mutation: write the mirror row **and** append the outbox
   * entry in one IndexedDB transaction. Resolves after the transaction commits.
   */
  writeLocal: (write: LocalWrite) => Promise<MirrorRecord>

  /**
   * Queue contents in local FIFO order. A whole-outbox read: tests and the
   * rare caller that needs every entry. The drain uses `pendingBatch`.
   */
  pending: () => Promise<ReadonlyArray<OutboxRecord>>
  /**
   * The head of the queue: at most `limit` entries in `seq` order, one per
   * entity.
   *
   * The push engine only ever sends the first un-acked entry per entity, so a
   * drain that re-reads the whole outbox every round trip is O(n²) in record
   * reads for a long offline session. The cursor stops as soon as it has
   * `limit` distinct entities, leaving each entity's older chain links for the
   * next iteration.
   */
  pendingBatch: (limit: number) => Promise<ReadonlyArray<OutboxRecord>>
  pendingCount: () => Promise<number>
  hasPending: (entityType: SyncEntityType, entityId: string) => Promise<boolean>
  /**
   * Flag entries as possibly delivered, returning them as they stand now.
   * One transaction, called immediately before the push that carries them,
   * never after: a failed push leaves them `sent` on purpose, so the retry
   * resends them unchanged instead of folding a newer patch into an entry the
   * server may already have applied.
   *
   * The return value matters: a write can fold into an entry between the
   * engine's `pending` read and this mark. Sending the previously read copy
   * would drop that field when the ack removes the marked entry, so the engine
   * pushes what this returns. Readwrite transactions on the outbox serialize,
   * so a fold either lands before the mark (and travels here) or sees
   * `sent === true` and queues its own entry.
   */
  markSent: (clientMutationIds: ReadonlyArray<string>) => Promise<ReadonlyArray<OutboxRecord>>

  /**
   * Apply server-authoritative rows. Rows with a pending local mutation are
   * left alone, so a refresh never clobbers unsent local intent.
   */
  mergeServer: (rows: ReadonlyArray<ServerRow>) => Promise<number>

  /**
   * Drop acked outbox entries and adopt the server's rows. One transaction, so
   * the queue and the mirror cannot disagree afterwards.
   *
   * `failures` records the rejected results in that same transaction: the
   * entry leaves the outbox (a permanent refusal must not wedge it), while the
   * mirror row keeps a durable marker. `resolved` clears a marker when a later
   * result for the entity landed without carrying an authoritative row.
   *
   * It deliberately does **not** touch the pull cursor: a push's highest `seq`
   * is not contiguous with what this device has pulled, so moving the cursor to
   * it would skip a remote change committed between the pull and the push. The
   * cursor only advances from `/sync/pull` (and bootstrap).
   */
  ack: (
    clientMutationIds: ReadonlyArray<string>,
    rows?: ReadonlyArray<ServerRow>,
    failures?: ReadonlyArray<SyncFailure & EntityRef>,
    resolved?: ReadonlyArray<EntityRef>
  ) => Promise<void>

  /**
   * Retry a row whose last push was rejected. Clears the marker and queues the
   * mirror's current data as a **fresh** upsert: new `clientMutationId`,
   * `baseVersion` = the version the mirror currently holds, `clientUpdatedAt`
   * = now. It never folds into a queued entry — a retry is a new attempt, not
   * another keystroke. If the server refuses it again, `ack` re-marks the row.
   */
  retryFailed: (
    entityType: SyncEntityType,
    entityId: string
  ) => Promise<MirrorRecord | undefined>

  /**
   * Drop a mirrored row without queueing a mutation. The server uses this when
   * a row is no longer visible to this user (a visibility flip, or a hard
   * purge), which is "remove from mirror", not a soft delete
   * (`docs/sync-protocol-draft.md` §3.1/DP-9).
   */
  removeFromMirror: (entityType: SyncEntityType, entityId: string) => Promise<void>

  /**
   * Empty the mirror without touching the outbox, cursor or drafts. Used by
   * the sync engine when a stale cursor forces a re-bootstrap.
   */
  clearMirror: () => Promise<void>

  /** The last feed `seq` applied to the mirror (0 = nothing seen yet). */
  cursor: () => Promise<number>
  setCursor: (seq: number) => Promise<void>

  /** Draft text survives a reload without touching the sync path. */
  saveDraft: (key: string, value: string) => Promise<void>
  readDraft: (key: string) => Promise<string | undefined>
  clearDraft: (key: string) => Promise<void>

  /** Notified after every committed mutation (useful for re-rendering). */
  subscribe: (listener: LocalStoreListener) => () => void

  /** Wipe every store in this user's database. */
  clear: () => Promise<void>
  close: () => void
}
