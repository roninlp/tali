import { Schema } from "effect"
import { Visibility } from "./common.js"

/**
 * Sync wire shapes shared by the client store and the sync endpoints.
 *
 * Source of truth: `docs/sync-protocol-draft.md` §3–§4. Transport is plain
 * HTTP JSON, so these are the codecs the API validates with and the web client
 * parses with. The outbox entry itself is queued by the local store (#17); the
 * pull/push envelopes and the change feed land with the sync engine (#18).
 */

/**
 * Discriminator for a syncable entity. Mirrors `ItemType` from
 * `docs/domain-model-draft.md` §2.4; the mirror is schema-agnostic, so every
 * synced aggregate is addressable even before its aggregate model lands.
 */
export const SyncEntityType = Schema.Literals([
  "habit",
  "habitEntry",
  "event",
  "occasion",
  "task",
  "reminder",
  "note",
  "tag",
  "list",
  "listItem",
  "project"
])
export type SyncEntityType = Schema.Schema.Type<typeof SyncEntityType>

/** `delete` is a soft-delete tombstone, not a physical row removal. */
export const SyncOp = Schema.Literals(["upsert", "delete"])
export type SyncOp = Schema.Schema.Type<typeof SyncOp>

/**
 * One queued local mutation (the outbox entry).
 *
 * - `clientMutationId` is the idempotency key the server dedupes on.
 * - `baseVersion` is the row version the client last saw (`0` = insert); it is
 *   the optimistic-concurrency anchor, not a version the client assigns. When
 *   an entity already has an un-acked entry, a second edit stores the same
 *   anchor (the client still has not seen a newer server version). The push
 *   engine sends each entity's entries in FIFO order and **replaces** the
 *   anchor of every entry after the first with the `version` returned for the
 *   preceding entry — the server-side chain described in
 *   `docs/sync-protocol-draft.md` §4.3.
 * - `patch` carries **only** the fields the user changed, which is what makes
 *   field-level LWW possible. Server-assigned fields (`version`, `updatedAt`)
 *   never appear here; the client's edit time travels in `clientUpdatedAt`.
 * - `clientUpdatedAt` is the LWW input, validated as an ISO-8601 UTC string.
 */
export const SyncPushEntry = Schema.Struct({
  clientMutationId: Schema.String,
  entityType: SyncEntityType,
  entityId: Schema.String,
  baseVersion: Schema.Int,
  op: SyncOp,
  patch: Schema.Record(Schema.String, Schema.Unknown),
  clientUpdatedAt: Schema.DateTimeUtcFromString
})
/**
 * The *encoded* (wire/storage) shape: `clientUpdatedAt` stays a UTC string.
 * The outbox persists this form and `POST /sync/push` accepts it.
 */
export type SyncPushEntry = Schema.Codec.Encoded<typeof SyncPushEntry>

// ── Pull ──────────────────────────────────────────────────────────────────

/**
 * One committed mutation in the household feed. `seq` is the global pull
 * cursor; `version` is the row's new per-row conflict counter. `ownerId` and
 * `visibility` are denormalized so pull can filter without a join.
 */
export const ChangeFeedEntry = Schema.Struct({
  seq: Schema.Int,
  entityType: SyncEntityType,
  entityId: Schema.String,
  op: SyncOp,
  version: Schema.Int,
  updatedAt: Schema.String,
  ownerId: Schema.String,
  visibility: Visibility
})
export type ChangeFeedEntry = Schema.Schema.Type<typeof ChangeFeedEntry>

/**
 * One syncable row in its latest state. `data` holds the entity's own fields;
 * sync metadata stays in the envelope so the mirror can compare versions
 * without knowing each aggregate's schema.
 */
export const SyncEntityRow = Schema.Struct({
  entityType: SyncEntityType,
  entityId: Schema.String,
  version: Schema.Int,
  updatedAt: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
  data: Schema.Record(Schema.String, Schema.Unknown)
})
export type SyncEntityRow = Schema.Schema.Type<typeof SyncEntityRow>

/** A row that stopped being visible to this client (visibility flip / purge). */
export const SyncRemovedEntry = Schema.Struct({
  entityType: SyncEntityType,
  entityId: Schema.String
})
export type SyncRemovedEntry = Schema.Schema.Type<typeof SyncRemovedEntry>

export const SyncPullResponse = Schema.Struct({
  entries: Schema.Array(ChangeFeedEntry),
  items: Schema.Array(SyncEntityRow),
  /** Rows this client may no longer see; remove them from the mirror. */
  removed: Schema.Array(SyncRemovedEntry),
  /** Max `seq` actually returned (resumable), never below the request cursor. */
  nextCursor: Schema.Int,
  hasMore: Schema.Boolean,
  /** True when the cursor predates the retained feed window; re-bootstrap. */
  resetRequired: Schema.Boolean
})
export type SyncPullResponse = Schema.Schema.Type<typeof SyncPullResponse>

/**
 * Fresh install / cleared mirror / `resetRequired` (§3.3). Returns the visible
 * live rows, paged by `offset`, plus the feed cursor to continue incrementally.
 */
export const SyncBootstrapResponse = Schema.Struct({
  items: Schema.Array(SyncEntityRow),
  nextOffset: Schema.Int,
  hasMore: Schema.Boolean,
  /** Max feed `seq` at bootstrap; the client continues from here. */
  cursor: Schema.Int
})
export type SyncBootstrapResponse = Schema.Schema.Type<typeof SyncBootstrapResponse>

// ── Push ──────────────────────────────────────────────────────────────────

export const SyncPushRequest = Schema.Struct({
  /** Chunked by the client; the server caps a request at 200 entries. */
  entries: Schema.Array(SyncPushEntry)
})
export type SyncPushRequest = Schema.Schema.Type<typeof SyncPushRequest>

const AppliedResult = Schema.Struct({
  _tag: Schema.Literal("applied"),
  clientMutationId: Schema.String,
  entityType: SyncEntityType,
  entityId: Schema.String,
  version: Schema.Int,
  seq: Schema.Int,
  item: Schema.optional(SyncEntityRow)
})

const AlreadyAppliedResult = Schema.Struct({
  _tag: Schema.Literal("alreadyApplied"),
  clientMutationId: Schema.String,
  entityType: SyncEntityType,
  entityId: Schema.String,
  version: Schema.Int,
  seq: Schema.Int,
  item: Schema.optional(SyncEntityRow)
})

const ConflictResult = Schema.Struct({
  _tag: Schema.Literal("conflict"),
  clientMutationId: Schema.String,
  entityType: SyncEntityType,
  entityId: Schema.String,
  version: Schema.Int,
  seq: Schema.Int,
  item: Schema.optional(SyncEntityRow)
})

const TombstoneResult = Schema.Struct({
  _tag: Schema.Literal("tombstone"),
  clientMutationId: Schema.String,
  entityType: SyncEntityType,
  entityId: Schema.String,
  version: Schema.Int,
  seq: Schema.Int,
  item: Schema.optional(SyncEntityRow)
})

/** Per-entry outcome (`docs/sync-protocol-draft.md` §4.3). */
export const SyncPushResult = Schema.Union([
  AppliedResult,
  AlreadyAppliedResult,
  ConflictResult,
  TombstoneResult
])
export type SyncPushResult = Schema.Schema.Type<typeof SyncPushResult>

export const SyncPushResponse = Schema.Struct({
  results: Schema.Array(SyncPushResult),
  /** Highest `seq` written (or deduped) by this push; the client may advance. */
  cursor: Schema.Int
})
export type SyncPushResponse = Schema.Schema.Type<typeof SyncPushResponse>

/**
 * Stable client-facing codes for sync failures carried by the shared
 * plain-HTTP `ErrorEnvelope` (`docs/error-model-draft.md` §5).
 */
export const SYNC_ERROR_CODES = [
  "NoHousehold",
  "Unauthorized",
  "BadRequest",
  "Forbidden",
  "UnsupportedEntity",
  "StaleCursor",
  "Conflict",
  "InternalError"
] as const
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number]
