import { Effect, Option } from "effect"
import type { HouseholdId, Tag, TagId, UserId } from "@tali/domain"

/**
 * Tag assignment guard shared by the note and task services (#36/#40).
 *
 * Both aggregates accept a denormalized `tagIds` array, and both must enforce
 * the same rules: the tag exists, is live, belongs to the viewer's household
 * and is not another member's private tag. Keeping the lookup here means the
 * note service reuses the tag primitives instead of growing a second copy of
 * the rules; each caller maps the issue into its own typed validation error.
 *
 * The caller passes the already-yielded `TagRepo` instance, so this helper has
 * no service requirement of its own.
 */

export interface TagScope {
  readonly userId: UserId
  readonly householdId: HouseholdId
}

export interface TagIssue {
  readonly field: "tagIds"
  readonly message: string
}

/** The subset of `TagRepo` this guard needs. */
export interface TagLookup<E> {
  readonly findById: (id: TagId) => Effect.Effect<Option.Option<Tag>, E>
}

export const loadAssignableTags = <E>(
  tags: TagLookup<E>,
  scope: TagScope,
  tagIds: ReadonlyArray<TagId>
): Effect.Effect<ReadonlyArray<Tag>, TagIssue> =>
  Effect.gen(function*() {
    const result: Array<Tag> = []
    for (const tagId of tagIds) {
      const found = yield* tags.findById(tagId).pipe(Effect.orDie)
      if (Option.isNone(found) || found.value.deletedAt !== null) {
        return yield* Effect.fail<TagIssue>({
          field: "tagIds",
          message: `tag does not exist: ${tagId}`
        })
      }
      const tag = found.value
      if (tag.householdId !== scope.householdId) {
        return yield* Effect.fail<TagIssue>({
          field: "tagIds",
          message: `tag is not in this household: ${tagId}`
        })
      }
      if (tag.visibility === "private" && tag.ownerId !== scope.userId) {
        return yield* Effect.fail<TagIssue>({
          field: "tagIds",
          message: `tag is private: ${tagId}`
        })
      }
      result.push(tag)
    }
    return result
  })
