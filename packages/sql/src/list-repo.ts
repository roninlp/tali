import { Context, Effect, Layer, Option } from 'effect'
import { SqlClient } from 'effect/sql'
import { List, type ListId, type UserId } from '@tali/domain'
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
 * D1-backed repository for `List` (ticket #33; FR-LIST-01/02).
 *
 * The list row owns the display preferences (`sort`, `checked_placement`);
 * items live in `list_items` with a manual `ordering` integer.
 */

/**
 * The one place `lists`' columns are declared (#115): the repo's SELECT,
 * INSERT and UPDATE lists below, and the sync registry's projection and
 * statements, are all generated from this descriptor.
 *
 * `last_writer_id` is sync-managed (#39's server attribution): the registry
 * writes and hydrates it, the repo neither reads nor writes it.
 */
export const LIST_TABLE = defineTable('lists', [
  column('id', { updatable: false }),
  column('type', { updatable: false }),
  column('title', { codec: columnCodecs.text }),
  column('description', { codec: columnCodecs.nullableText }),
  column('owner_id', 'ownerId', { updatable: false }),
  column('household_id', 'householdId', { updatable: false }),
  column('visibility'),
  column('color', { codec: columnCodecs.nullableText }),
  column('icon', { codec: columnCodecs.nullableText }),
  column('sort', { codec: columnCodecs.text }),
  column('checked_placement', 'checkedPlacement', {
    codec: columnCodecs.text,
  }),
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

const LIST_SELECT = selectList(LIST_TABLE)

/** The model's column values; the descriptor's codecs do the encoding. */
const listValues = (list: List): ColumnValues<typeof LIST_TABLE> => ({
  id: list.id,
  type: list.type,
  title: list.title,
  description: list.description,
  ownerId: list.ownerId,
  householdId: list.householdId,
  visibility: list.visibility,
  color: list.color,
  icon: list.icon,
  sort: list.sort,
  checkedPlacement: list.checkedPlacement,
  createdAt: list.createdAt,
  updatedAt: list.updatedAt,
  version: list.version,
  deletedAt: list.deletedAt,
})

export class ListRepo extends Context.Service<ListRepo>()('ListRepo', {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const findById = (id: ListId) =>
      Effect.map(
        sql<List>`SELECT ${sql.literal(LIST_SELECT)} FROM lists WHERE id = ${id}`,
        rows => Option.fromUndefinedOr(rows[0]),
      )

    const listVisible = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<List>`
          SELECT ${sql.literal(LIST_SELECT)} FROM lists
          WHERE ${visibleScopeSql(sql, input)}
          ORDER BY updated_at DESC, id ASC
        `,
        rows => rows,
      )

    const insert = (list: List) =>
      Effect.map(
        insertStatement<List>(sql, LIST_TABLE, {
          values: listValues(list),
          returning: LIST_SELECT,
        }),
        rows => rows[0]!,
      )

    const update = (list: List) =>
      Effect.map(
        updateStatement<List>(sql, LIST_TABLE, {
          id: list.id,
          values: listValues(list),
          returning: LIST_SELECT,
        }),
        rows => Option.fromUndefinedOr(rows[0]),
      )

    return { findById, listVisible, insert, update }
  }),
}) {}

export const ListRepoLive = Layer.effect(ListRepo, ListRepo.make)
