import { Context, Effect, Layer, Option, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import {
  type ListId,
  ListItem,
  type ListItemId,
  TagId,
  type UserId,
} from '@tali/domain'
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
 * D1-backed repository for the `ListItem` aggregate (ticket #33; FR-LIST-01/02).
 *
 * Migration 0005 extended the Slice 1 `list_items` table in place instead of
 * forking it, and the scaffold columns (`title` / `checked` / `sort_order`)
 * were dual-written while the sync registry still spoke the scaffold wire
 * shape (#34). Ticket #119 retired that shape: the registry, this repo and the
 * web mirror all speak the aggregate's own columns (`name` / `done` /
 * `ordering`), and migration 0015 dropped the scaffold columns.
 */

/**
 * The one place `list_items`' columns are declared (#115).
 *
 * `ordering`'s wire field is the aggregate's `order` — `order` is an SQL
 * keyword, hence the quoted SELECT alias.
 *
 * `last_writer_id` is sync-managed (#39's server attribution): the registry
 * writes and hydrates it; this repo neither reads nor writes it.
 */
export const LIST_ITEM_TABLE = defineTable('list_items', [
  column('id', { updatable: false }),
  column('type', { updatable: false }),
  column('name', { codec: columnCodecs.text }),
  column('done', { codec: columnCodecs.bit }),
  column('ordering', 'order', {
    as: '"order"',
    codec: columnCodecs.int,
  }),
  column('list_id', 'listId', { codec: columnCodecs.nullableText }),
  column('checked_at', 'checkedAt', { codec: columnCodecs.nullableText }),
  column('color', { codec: columnCodecs.nullableText }),
  column('tag_ids', 'tagIds', { codec: columnCodecs.json }),
  column('owner_id', 'ownerId', { updatable: false }),
  column('household_id', 'householdId', { updatable: false }),
  column('visibility'),
  column('last_writer_id', 'lastWriterId', {
    codec: columnCodecs.nullableText,
    syncManaged: true,
  }),
  column('created_at', 'createdAt', {
    updatable: false,
    codec: columnCodecs.text,
  }),
  column('updated_at', 'updatedAt', { codec: columnCodecs.text }),
  column('version', { codec: columnCodecs.int }),
  column('deleted_at', 'deletedAt', { codec: columnCodecs.nullableText }),
])

const LIST_ITEM_SELECT = selectList(LIST_ITEM_TABLE)

interface ListItemRow extends Omit<ListItem, 'done' | 'tagIds'> {
  readonly done: number | boolean
  readonly tagIds: string
}

const asTagIds = Schema.decodeOption(Schema.fromJsonString(Schema.Array(TagId)))

const toListItem = (row: ListItemRow): ListItem =>
  new ListItem({
    id: row.id,
    type: row.type,
    listId: row.listId,
    name: row.name,
    done: row.done === true || row.done === 1,
    order: row.order,
    checkedAt: row.checkedAt,
    ownerId: row.ownerId,
    householdId: row.householdId,
    visibility: row.visibility,
    color: row.color,
    tagIds: Option.getOrElse(asTagIds(row.tagIds), () => []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    deletedAt: row.deletedAt,
  })

/** The model's column values, one field per descriptor entry. */
const listItemValues = (
  item: ListItem,
): ColumnValues<typeof LIST_ITEM_TABLE> => ({
  id: item.id,
  type: item.type,
  name: item.name,
  done: item.done,
  order: item.order,
  listId: item.listId,
  checkedAt: item.checkedAt,
  color: item.color,
  tagIds: item.tagIds,
  ownerId: item.ownerId,
  householdId: item.householdId,
  visibility: item.visibility,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  version: item.version,
  deletedAt: item.deletedAt,
})

export class PlanningListItemRepo extends Context.Service<PlanningListItemRepo>()(
  'PlanningListItemRepo',
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const findById = (id: ListItemId) =>
        Effect.map(
          sql<ListItemRow>`
            SELECT ${sql.literal(LIST_ITEM_SELECT)} FROM list_items
            WHERE id = ${id} AND list_id IS NOT NULL
          `,
          rows => Option.map(Option.fromUndefinedOr(rows[0]), toListItem),
        )

      /**
       * Manual ordering within one visible list; `id` is the stable tiebreak.
       *
       * A shared list can still hold a member's `private` items, so the read is
       * scoped exactly like the sibling `listVisible` queries: this household,
       * live rows, shared or owned by the caller (`docs/sync-protocol-draft.md`
       * §1.4 — a spouse's private item never leaves the server).
       */
      const listByList = (input: {
        readonly listId: ListId
        readonly householdId: string
        readonly userId: UserId
      }) =>
        Effect.map(
          sql<ListItemRow>`
            SELECT ${sql.literal(LIST_ITEM_SELECT)} FROM list_items
            WHERE list_id = ${input.listId}
              AND ${visibleScopeSql(sql, input)}
            ORDER BY ordering ASC, id ASC
          `,
          rows => rows.map(toListItem),
        )

      /**
       * Every live item under a list, without the per-viewer visibility filter.
       * Used by `deleteList` to cascade a soft delete over the whole list, so a
       * spouse's private items cannot outlive it in their mirror. Deliberately
       * not `visibleScopeSql`: this is a system cascade, not a member's read.
       */
      const listAllForList = (input: {
        readonly listId: ListId
        readonly householdId: string
      }) =>
        Effect.map(
          sql<ListItemRow>`
            SELECT ${sql.literal(LIST_ITEM_SELECT)} FROM list_items
            WHERE list_id = ${input.listId}
              AND household_id = ${input.householdId}
              AND deleted_at IS NULL
            ORDER BY ordering ASC, id ASC
          `,
          rows => rows.map(toListItem),
        )

      const insert = (item: ListItem) =>
        Effect.map(
          insertStatement<ListItemRow>(sql, LIST_ITEM_TABLE, {
            values: listItemValues(item),
            returning: LIST_ITEM_SELECT,
          }),
          rows => toListItem(rows[0]!),
        )

      const update = (item: ListItem) =>
        Effect.map(
          updateStatement<ListItemRow>(sql, LIST_ITEM_TABLE, {
            id: item.id,
            values: listItemValues(item),
            returning: LIST_ITEM_SELECT,
          }),
          rows => Option.map(Option.fromUndefinedOr(rows[0]), toListItem),
        )

      /**
       * Item tag-join statements for a service mutation. Gated on the item's
       * new version + update timestamp, so a lost CAS cannot leave `item_tags`
       * ahead of the row. Mirrors TaskRepo's helpers.
       */
      const detachTagsIfVersion = (input: {
        readonly itemId: ListItemId
        readonly version: number
        readonly updatedAt: string
      }) =>
        sql`
          DELETE FROM item_tags
          WHERE item_id = ${input.itemId} AND item_type = 'listItem'
            AND EXISTS (
              SELECT 1 FROM list_items
              WHERE id = ${input.itemId}
                AND version = ${input.version}
                AND updated_at = ${input.updatedAt}
            )
        `

      const attachTagIfVersion = (input: {
        readonly itemId: ListItemId
        readonly tagId: TagId
        readonly householdId: string
        readonly createdAt: string
        readonly version: number
        readonly updatedAt: string
      }) =>
        sql`
          INSERT INTO item_tags (item_id, item_type, tag_id, household_id, created_at)
          SELECT ${input.itemId}, 'listItem', ${input.tagId}, ${input.householdId}, ${input.createdAt}
          WHERE EXISTS (
            SELECT 1 FROM list_items
            WHERE id = ${input.itemId}
              AND version = ${input.version}
              AND updated_at = ${input.updatedAt}
          )
          ON CONFLICT DO NOTHING
        `

      return {
        findById,
        listByList,
        listAllForList,
        insert,
        update,
        detachTagsIfVersion,
        attachTagIfVersion,
      }
    }),
  },
) {}

export const PlanningListItemRepoLive = Layer.effect(
  PlanningListItemRepo,
  PlanningListItemRepo.make,
)
