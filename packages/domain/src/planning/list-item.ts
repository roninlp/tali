import { Schema } from "effect"
import { Model } from "effect/schema"
import { Visibility } from "../common.js"
import {
  commonItemFields,
  ListId,
  ListItemId,
  TagIds,
  TimestampUtc
} from "./common.js"

/**
 * `ListItem` aggregate (FR-LIST-01/02, docs/domain-model-draft.md §3.8).
 *
 * Items use `name` rather than `title` and a `done` flag rather than a
 * lifecycle enum; `order` is the manual ordering integer (the list's version
 * bumps when it changes). `checkedAt` is the completion audit the feature map
 * asks for, and `done` is the field the sync resolver protects with the
 * "ticked wins" rule.
 *
 * NOTE: the legacy scaffold exports a different top-level `ListItem` stub for
 * the pre-Slice-2 `list_items` table, and #34 keeps that scaffold wire shape
 * for sync so the web mirror needs no change. This real aggregate is re-exported
 * from `@tali/domain` as `PlanningListItem` (and under the `Planning`
 * namespace); sync dual-writes both column sets. Ticket #39's list UI speaks
 * this aggregate through the registry's `name`/`done`/`ordering` aliases; the
 * stub remains only for the scaffold repo and the `/today` quick list.
 */
export class ListItem extends Model.Class<ListItem>("ListItem")({
  ...commonItemFields("listItem", ListItemId),
  listId: ListId,
  name: Schema.String.check(Schema.isMinLength(1)),
  done: Schema.Boolean,
  /** Manual ordering integer; reorder bumps the owning list's version. */
  order: Schema.Int,
  /** Completion audit; `null` while unchecked. */
  checkedAt: Schema.NullOr(TimestampUtc),
  /** Denormalized tag ids; `item_tags` remains the source of truth. */
  tagIds: TagIds
}) {}

export const ListItemCreate = Schema.Struct({
  listId: ListId,
  name: Schema.String.check(Schema.isMinLength(1)),
  order: Schema.optional(Schema.Int),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  tagIds: Schema.optional(TagIds),
  visibility: Schema.optional(Visibility)
})
export type ListItemCreate = Schema.Schema.Type<typeof ListItemCreate>
