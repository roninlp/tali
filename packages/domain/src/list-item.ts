import { Schema } from "effect"

/**
 * The scaffold `ListItem` shape the sync `listItem` entity speaks.
 *
 * NOTE: this is the scaffold wire shape the sync `listItem` entity still speaks
 * (ticket #34 keeps it compatible so the web mirror needs no change). The real
 * core-planning `ListItem` aggregate lives in `./planning/list-item.ts` and is
 * exported from this package as `PlanningListItem` (plus `Planning.ListItem`);
 * sync dual-writes both column sets. Retiring this stub is UI work (#39).
 *
 * Keep this package free of DB/runtime coupling — it is the only package both
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

// The sync wire shapes (change feed, pull/push envelopes, hydrated rows) live
// in `./sync.ts`: they are aggregate-agnostic, so they do not depend on this
// dummy aggregate.
