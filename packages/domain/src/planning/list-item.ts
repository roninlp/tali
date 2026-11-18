import { Schema } from 'effect'
import { Model } from 'effect/schema'
import { Visibility } from '../common.js'
import {
  commonItemFields,
  ListId,
  ListItemId,
  NonEmptyString,
  TagIds,
  TimestampUtc,
} from './common.js'

/**
 * `ListItem` aggregate (FR-LIST-01/02, docs/domain-model-draft.md §3.8).
 *
 * Items use `name` rather than `title` and a `done` flag rather than a
 * lifecycle enum; `order` is the manual ordering integer (the list's version
 * bumps when it changes). `checkedAt` is the completion audit the feature map
 * asks for, and `done` is the field the sync resolver protects with the
 * "ticked wins" rule.
 *
 * This is the only `ListItem` the package exports (#119 retired the
 * pre-Slice-2 scaffold stub): the sync registry's `listItem` entity and the
 * web mirror both speak this aggregate's field names (`name`/`done`/`order`),
 * and the physical `list_items` scaffold columns are gone (migration 0015).
 */
export class ListItem extends Model.Class<ListItem>('ListItem')({
  ...commonItemFields('listItem', ListItemId),
  /** Inherited from the parent list, at most narrower (ADR-0011). */
  visibility: Visibility,
  listId: ListId,
  name: NonEmptyString,
  done: Schema.Boolean,
  /** Manual ordering integer; reorder bumps the owning list's version. */
  order: Schema.Int,
  /** Completion audit; `null` while unchecked. */
  checkedAt: Schema.NullOr(TimestampUtc),
  /** Denormalized tag ids; `item_tags` remains the source of truth. */
  tagIds: TagIds,
}) {}

export const ListItemCreate = Schema.Struct({
  listId: ListId,
  name: NonEmptyString,
  order: Schema.optional(Schema.Int),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  tagIds: Schema.optional(TagIds),
})
export type ListItemCreate = Schema.Schema.Type<typeof ListItemCreate>
