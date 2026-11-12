import { Model } from 'effect/schema'
import { Visibility } from '../common.js'
import { commonItemFields, NonEmptyString, TagId } from './common.js'

/**
 * `Tag` aggregate (FR-TASK-02 / FR-NOTE-03, docs/domain-model-draft.md §3.7).
 *
 * Tags are household-scoped so both members share one tag vocabulary. The
 * `item_tags` join table is the source of truth for assignments; items also
 * carry a denormalized `tagIds` array so a sync payload needs no join.
 *
 * Tag carries the common-item sync contract (`version`/`deletedAt`) so a
 * rename or soft delete reaches the other device through the same feed as
 * every other aggregate. Visibility is `household` (ADR-0011): one shared tag
 * vocabulary, with no user-facing control.
 */
export class Tag extends Model.Class<Tag>('Tag')({
  ...commonItemFields('tag', TagId),
  visibility: Visibility,
  name: NonEmptyString,
}) {}
