import { Schema } from "effect"

/**
 * Sync wire shapes shared by the client store and the eventual push endpoint.
 *
 * Source of truth: `docs/sync-protocol-draft.md` §4.1. Only the pieces the
 * client needs to *queue* a mutation live here today; the full pull/push
 * envelopes land with the sync engine (#18) so the wire contract is defined
 * once, in `packages/domain`, as the draft requires.
 */

/** Discriminator for a syncable entity. Grows as aggregates land. */
export const SyncEntityType = Schema.Literals(["listItem"])
export type SyncEntityType = Schema.Schema.Type<typeof SyncEntityType>

/** `delete` is a soft-delete tombstone, not a physical row removal. */
export const SyncOp = Schema.Literals(["upsert", "delete"])
export type SyncOp = Schema.Schema.Type<typeof SyncOp>

/**
 * One queued local mutation (the outbox entry).
 *
 * - `clientMutationId` is the idempotency key the server dedupes on.
 * - `baseVersion` is the row version the client last saw (`0` = insert); it is
 *   the optimistic-concurrency anchor, not a version the client assigns.
 * - `patch` carries **only** the fields the user changed, which is what makes
 *   field-level LWW possible.
 */
export const SyncPushEntry = Schema.Struct({
  clientMutationId: Schema.String,
  entityType: SyncEntityType,
  entityId: Schema.String,
  baseVersion: Schema.Int,
  op: SyncOp,
  patch: Schema.Record(Schema.String, Schema.Unknown),
  clientUpdatedAt: Schema.String
})
export type SyncPushEntry = Schema.Schema.Type<typeof SyncPushEntry>
