import { Schema } from "effect"
import { Model } from "effect/schema"
import { Visibility } from "../common.js"
import {
  commonItemFields,
  ListCheckedPlacement,
  ListId,
  ListItemSort
} from "./common.js"

/**
 * `List` aggregate (FR-LIST-01/02, docs/domain-model-draft.md §3.8).
 *
 * A list owns its items and stores the two per-list display preferences the
 * feature map asks for: the default sort and where checked items appear.
 */
export class List extends Model.Class<List>("List")({
  ...commonItemFields("list", ListId),
  title: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(Schema.String),
  sort: ListItemSort,
  checkedPlacement: ListCheckedPlacement
}) {}

export const ListCreate = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  icon: Schema.optional(Schema.NullOr(Schema.String)),
  sort: Schema.optional(ListItemSort),
  checkedPlacement: Schema.optional(ListCheckedPlacement),
  visibility: Schema.optional(Visibility)
})
export type ListCreate = Schema.Schema.Type<typeof ListCreate>
