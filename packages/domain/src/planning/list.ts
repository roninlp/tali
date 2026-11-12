import { Schema } from 'effect'
import { Model } from 'effect/schema'
import { Visibility } from '../common.js'
import {
  commonItemFields,
  ListCheckedPlacement,
  ListId,
  ListItemSort,
  NonEmptyString,
} from './common.js'

/**
 * `List` aggregate (FR-LIST-01/02, docs/domain-model-draft.md §3.8).
 *
 * A list owns its items and stores the two per-list display preferences the
 * feature map asks for: the default sort and where checked items appear.
 */
export class List extends Model.Class<List>('List')({
  ...commonItemFields('list', ListId),
  /** Resolved from the list's `shareable` policy (ADR-0011). */
  visibility: Visibility,
  title: NonEmptyString,
  description: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(Schema.String),
  sort: ListItemSort,
  checkedPlacement: ListCheckedPlacement,
}) {}
