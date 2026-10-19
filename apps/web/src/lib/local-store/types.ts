import type { SyncEntityType, SyncOp, SyncPushEntry } from "@tali/domain"

/**
 * The local-first client store types.
 *
 * The mirror is the row the UI renders from; the outbox is the queue of
 * mutations still to be pushed. `clientMutationId` is the idempotency key, so
 * the queue can survive a lost push response. See `docs/sync-protocol-draft.md`
 * §4 and §7 for the wire shapes and the hydration order.
 */

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
}

/** A queued mutation plus the local FIFO key. */
export interface OutboxRecord extends SyncPushEntry {
  readonly seq: number
}

/** What a local mutation supplies; the store fills in ids/timestamps. */
export interface LocalWrite {
  readonly entityType: SyncEntityType
  readonly entityId: string
  readonly op: SyncOp
  /** Only the fields that changed (field-level LWW input). */
  readonly patch: Readonly<Record<string, unknown>>
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
  get: (entityType: SyncEntityType, entityId: string) => Promise<MirrorRecord | undefined>

  /**
   * Apply a local mutation: write the mirror row **and** append the outbox
   * entry in one IndexedDB transaction. Resolves after the transaction commits.
   */
  writeLocal: (write: LocalWrite) => Promise<MirrorRecord>

  /** Queue contents in local FIFO order. */
  pending: () => Promise<ReadonlyArray<OutboxRecord>>
  pendingCount: () => Promise<number>
  hasPending: (entityType: SyncEntityType, entityId: string) => Promise<boolean>

  /**
   * Apply server-authoritative rows. Rows with a pending local mutation are
   * left alone, so a refresh never clobbers unsent local intent.
   */
  mergeServer: (rows: ReadonlyArray<ServerRow>) => Promise<number>

  /**
   * Drop acked outbox entries, adopt the server's rows, and advance the pull
   * cursor. One transaction, so the queue, the mirror, and the cursor cannot
   * disagree afterwards. The cursor never moves backwards.
   *
   * The push response carries the authoritative `seq` for the client's own
   * writes; passing it here lets the cursor move past them without a second
   * pull round-trip (`docs/sync-protocol-draft.md` §4.3/§7.4).
   */
  ack: (
    clientMutationIds: ReadonlyArray<string>,
    rows?: ReadonlyArray<ServerRow>,
    cursor?: number
  ) => Promise<void>

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
