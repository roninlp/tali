import { Effect, Option } from 'effect'
import type { HouseholdId, Tag, TagId, UserId } from '@tali/domain'
import { readScoped, type ScopeViolation } from './row-scope.js'

/**
 * Tag assignment guard shared by the note and task services (#36/#40).
 *
 * Both aggregates accept a denormalized `tagIds` array, and both enforce the
 * same rules: the tag exists, is live, belongs to the viewer's household and
 * is not another member's private tag. Those are the standard ADR-0011 read
 * rules, so the guard delegates them to the shared scope predicate and keeps
 * only its error mapping — the issue message each caller folds into its own
 * typed validation error.
 *
 * The caller passes the already-yielded `TagRepo` instance, so this helper has
 * no service requirement of its own.
 */

export interface TagScope {
  readonly userId: UserId
  readonly householdId: HouseholdId
}

export interface TagIssue {
  readonly field: 'tagIds'
  readonly message: string
}

/** The subset of `TagRepo` this guard needs. */
export interface TagLookup<E> {
  readonly findById: (id: TagId) => Effect.Effect<Option.Option<Tag>, E>
}

/** Which read rule the tag failed, as the guard's field-level issue. */
const tagIssue = (tagId: TagId, violation: ScopeViolation): TagIssue => ({
  field: 'tagIds',
  message:
    violation === 'household'
      ? `tag is not in this household: ${tagId}`
      : violation === 'private'
        ? `tag is private: ${tagId}`
        : `tag does not exist: ${tagId}`,
})

export const loadAssignableTags = <E>(
  tags: TagLookup<E>,
  scope: TagScope,
  tagIds: ReadonlyArray<TagId>,
): Effect.Effect<ReadonlyArray<Tag>, TagIssue> =>
  Effect.gen(function* () {
    const result: Array<Tag> = []
    for (const tagId of tagIds) {
      const tag = yield* readScoped({
        viewer: scope,
        id: tagId,
        find: tags.findById,
        // A trashed tag reads as missing before the household/owner checks,
        // like the hand-written guard this replaces.
        trash: 'first',
        onViolation: violation => tagIssue(tagId, violation),
      })
      result.push(tag)
    }
    return result
  })
