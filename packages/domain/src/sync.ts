import { Schema } from "effect"

/**
 * Sync wire shapes shared by the client store and the eventual push endpoint.
 *
 * Source of truth: `docs/sync-protocol-draft.md` §4.1. Only the pieces the
 * client needs to *queue* a mutation live here today; the full pull/push
 * envelopes land with the sync engine (#18) so the wire contract is defined
 * once, in `packages/domain`, as the draft requires.
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
