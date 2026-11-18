import { Context, Effect, Layer, Option } from 'effect'
import { SqlClient } from 'effect/sql'
import { type ItemType, Tag, type TagId, type UserId } from '@tali/domain'
import {
  type ColumnValues,
  column,
  columnCodecs,
  defineTable,
  insertStatement,
  selectList,
  updateStatement,
} from './columns'
import { visibleScopeSql } from './scope'

/**
 * D1-backed repository for `Tag` and the `item_tags` join (ticket #33;
 * FR-TASK-02 / FR-NOTE-03).
 *
 * Tags are household-scoped; the join is the source of truth for assignments.
 * Item rows also carry a denormalized `tag_ids` JSON array so sync/read models
 * avoid a join. Assignment is a plain statement so callers can compose it into
 * a D1 batch with the entity write + feed append.
 */

/**
 * The one place `tags`' columns are declared (#115): the repo's SELECT, INSERT
 * and UPDATE lists below, and the sync registry's projection and statements,
 * are all generated from this descriptor.
 */
export const TAG_TABLE = defineTable('tags', [
  column('id', { updatable: false }),
  column('type', { updatable: false }),
  column('name', { codec: columnCodecs.text }),
  column('owner_id', 'ownerId', { updatable: false }),
  column('household_id', 'householdId', { updatable: false }),
  column('visibility'),
  column('color', { codec: columnCodecs.nullableText }),
  column('created_at', 'createdAt', {
    updatable: false,
    codec: columnCodecs.text,
  }),
  column('updated_at', 'updatedAt', { codec: columnCodecs.text }),
  column('version', { codec: columnCodecs.int }),
  column('deleted_at', 'deletedAt', { codec: columnCodecs.nullableText }),
])

const TAG_SELECT = selectList(TAG_TABLE)
const TAG_SELECT_QUALIFIED = selectList(TAG_TABLE, { prefix: 't.' })

/** The model's column values; the descriptor's codecs do the encoding. */
const tagValues = (tag: Tag): ColumnValues<typeof TAG_TABLE> => ({
  id: tag.id,
  type: tag.type,
  name: tag.name,
  ownerId: tag.ownerId,
  householdId: tag.householdId,
  visibility: tag.visibility,
  color: tag.color,
  createdAt: tag.createdAt,
  updatedAt: tag.updatedAt,
  version: tag.version,
  deletedAt: tag.deletedAt,
})

export class TagRepo extends Context.Service<TagRepo>()('TagRepo', {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const findById = (id: TagId) =>
      Effect.map(
        sql<Tag>`SELECT ${sql.literal(TAG_SELECT)} FROM tags WHERE id = ${id}`,
        rows => Option.fromUndefinedOr(rows[0]),
      )

    const listVisible = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<Tag>`
          SELECT ${sql.literal(TAG_SELECT)} FROM tags
          WHERE ${visibleScopeSql(sql, input)}
          ORDER BY name ASC, id ASC
        `,
        rows => rows,
      )

    /**
     * A live tag by name in a household. The unique index spans both members'
     * tags (a private tag still occupies the vocabulary), so the duplicate
     * check must not be visibility-filtered.
     */
    const findLiveByName = (input: {
      readonly householdId: string
      readonly name: string
    }) =>
      Effect.map(
        sql<Tag>`
          SELECT ${sql.literal(TAG_SELECT)} FROM tags
          WHERE household_id = ${input.householdId}
            AND name = ${input.name}
            AND deleted_at IS NULL
          LIMIT 1
        `,
        rows => Option.fromUndefinedOr(rows[0]),
      )

    const insert = (tag: Tag) =>
      Effect.map(
        insertStatement<Tag>(sql, TAG_TABLE, {
          values: tagValues(tag),
          returning: TAG_SELECT,
        }),
        rows => rows[0]!,
      )

    const update = (tag: Tag) =>
      Effect.map(
        updateStatement<Tag>(sql, TAG_TABLE, {
          id: tag.id,
          values: tagValues(tag),
          returning: TAG_SELECT,
        }),
        rows => Option.fromUndefinedOr(rows[0]),
      )

    /** Tag rows assigned to one item (join is canonical). */
    const listForItem = (input: {
      readonly itemType: ItemType
      readonly itemId: string
    }) =>
      Effect.map(
        sql<Tag>`
          SELECT ${sql.literal(TAG_SELECT_QUALIFIED)}
          FROM tags t
          INNER JOIN item_tags it ON it.tag_id = t.id
          WHERE it.item_type = ${input.itemType} AND it.item_id = ${input.itemId}
            AND t.deleted_at IS NULL
          ORDER BY t.name ASC, t.id ASC
        `,
        rows => rows,
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
      findLiveByName,
      listVisible,
      insert,
      update,
      listForItem,
      attach,
      detach,
      detachAllForItem,
    }
  }),
}) {}

export const TagRepoLive = Layer.effect(TagRepo, TagRepo.make)
