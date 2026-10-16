import { Schema } from "effect"

/**
 * The dummy aggregate carried end-to-end for the scaffold round-trip.
 *
 * NOTE: this is a minimal stub. The real domain model lands in ticket #7
 * (`docs/domain-model-draft.md`) and will replace these placeholders. Keep
 * this package free of DB/runtime coupling — it is the only package both
 * `apps/web` and `apps/api` are allowed to depend on.
 */

/** A `List` item id (FR-LIST-01). UUID string, validated at decode. */
export const ListItemId = Schema.String.check(Schema.isUUID())
export type ListItemId = Schema.Schema.Type<typeof ListItemId>

/** A `List` item (FR-LIST-01/02). Timestamps are ISO-8601 UTC strings. */
export class ListItem extends Schema.Class<ListItem>("ListItem")({
  id: ListItemId,
  title: Schema.String,
  checked: Schema.Boolean,
  sortOrder: Schema.Number,
  version: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  deletedAt: Schema.OptionFromNullOr(Schema.String)
}) {}

/** Input for creating a `ListItem` (title-only is enough). */
export const ListItemInsert = Schema.Struct({
  title: Schema.String,
  sortOrder: Schema.Number
})
export type ListItemInsert = Schema.Schema.Type<typeof ListItemInsert>

/** Typed error raised when an aggregate is missing. */
export class ListItemNotFound extends Schema.TaggedError<ListItemNotFound>()("ListItemNotFound", {
  id: ListItemId
}) {}

/**
 * A single entry in the sync change feed (CC-02). One `Change` per row
 * mutation; consumers reconcile by `version`/`updatedAt`.
 */
export class Change extends Schema.Class<Change>("Change")({
  entity: Schema.Literal("ListItem"),
  id: ListItemId,
  version: Schema.Number,
  updatedAt: Schema.String,
  deleted: Schema.Boolean
}) {}

/** Response of the plain-HTTP sync pull endpoint (`GET /sync/pull`). */
export class SyncPullResponse extends Schema.Class<SyncPullResponse>("SyncPullResponse")({
  cursor: Schema.Number,
  changes: Schema.Array(Change),
  hasMore: Schema.Boolean
}) {}
