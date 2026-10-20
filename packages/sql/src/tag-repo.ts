import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { type ItemType, Tag, type TagId, type UserId } from "@tali/domain"

/**
 * D1-backed repository for `Tag` and the `item_tags` join (ticket #33;
 * FR-TASK-02 / FR-NOTE-03).
 *
 * Tags are household-scoped; the join is the source of truth for assignments.
 * Item rows also carry a denormalized `tag_ids` JSON array so sync/read models
 * avoid a join. Assignment is a plain statement so callers can compose it into
 * a D1 batch with the entity write + feed append.
 */

const TAG_COLUMNS =
  `id, type, name, owner_id AS ownerId, household_id AS householdId, visibility, ` +
  `color, created_at AS createdAt, updated_at AS updatedAt, version, deleted_at AS deletedAt`

const TAG_COLUMNS_QUALIFIED =
  `t.id, t.type, t.name, t.owner_id AS ownerId, t.household_id AS householdId, t.visibility, ` +
  `t.color, t.created_at AS createdAt, t.updated_at AS updatedAt, t.version, t.deleted_at AS deletedAt`

export class TagRepo extends Context.Service<TagRepo>()("TagRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const findById = (id: TagId) =>
      Effect.map(
        sql<Tag>`SELECT ${sql.literal(TAG_COLUMNS)} FROM tags WHERE id = ${id}`,
        (rows) => Option.fromUndefinedOr(rows[0])
      )

    const listVisible = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<Tag>`
          SELECT ${sql.literal(TAG_COLUMNS)} FROM tags
          WHERE household_id = ${input.householdId}
            AND deleted_at IS NULL
            AND (owner_id = ${input.userId} OR visibility = 'shared')
          ORDER BY name ASC, id ASC
        `,
        (rows) => rows
      )

    const insert = (tag: Tag) =>
      Effect.map(
        sql<Tag>`
          INSERT INTO tags
            (id, type, name, owner_id, household_id, visibility, color,
             created_at, updated_at, version, deleted_at)
          VALUES
            (${tag.id}, ${tag.type}, ${tag.name}, ${tag.ownerId}, ${tag.householdId},
             ${tag.visibility}, ${tag.color}, ${tag.createdAt}, ${tag.updatedAt},
             ${tag.version}, ${tag.deletedAt})
          RETURNING ${sql.literal(TAG_COLUMNS)}
        `,
        (rows) => rows[0]!
      )

    const update = (tag: Tag) =>
      Effect.map(
        sql<Tag>`
          UPDATE tags SET
            name = ${tag.name},
            visibility = ${tag.visibility},
            color = ${tag.color},
            updated_at = ${tag.updatedAt},
            version = ${tag.version},
            deleted_at = ${tag.deletedAt}
          WHERE id = ${tag.id}
          RETURNING ${sql.literal(TAG_COLUMNS)}
        `,
        (rows) => Option.fromUndefinedOr(rows[0])
      )

    /** Tag rows assigned to one item (join is canonical). */
    const listForItem = (input: {
      readonly itemType: ItemType
      readonly itemId: string
    }) =>
      Effect.map(
        sql<Tag>`
          SELECT ${sql.literal(TAG_COLUMNS_QUALIFIED)}
          FROM tags t
          INNER JOIN item_tags it ON it.tag_id = t.id
          WHERE it.item_type = ${input.itemType} AND it.item_id = ${input.itemId}
            AND t.deleted_at IS NULL
          ORDER BY t.name ASC, t.id ASC
        `,
        (rows) => rows
      )

    const attach = (input: {
      readonly itemType: ItemType
      readonly itemId: string
      readonly tagId: TagId
      readonly householdId: string
      readonly createdAt: string
    }) =>
      sql`
        INSERT INTO item_tags (item_id, item_type, tag_id, household_id, created_at)
        VALUES (${input.itemId}, ${input.itemType}, ${input.tagId}, ${input.householdId}, ${input.createdAt})
        ON CONFLICT DO NOTHING
      `

    const detach = (input: {
      readonly itemType: ItemType
      readonly itemId: string
      readonly tagId: TagId
    }) =>
      sql`
        DELETE FROM item_tags
        WHERE item_id = ${input.itemId} AND item_type = ${input.itemType} AND tag_id = ${input.tagId}
      `

    const detachAllForItem = (input: {
      readonly itemType: ItemType
      readonly itemId: string
    }) =>
      sql`
        DELETE FROM item_tags
        WHERE item_id = ${input.itemId} AND item_type = ${input.itemType}
      `

    return {
      findById,
      listVisible,
      insert,
      update,
      listForItem,
      attach,
      detach,
      detachAllForItem
    } as const
  })
}) {}

export const TagRepoLive = Layer.effect(TagRepo, TagRepo.make)
