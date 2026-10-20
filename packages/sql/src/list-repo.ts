import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { List, type ListId, type UserId } from "@tali/domain"

/**
 * D1-backed repository for `List` (ticket #33; FR-LIST-01/02).
 *
 * The list row owns the display preferences (`sort`, `checked_placement`);
 * items live in `list_items` with a manual `ordering` integer.
 */

const LIST_COLUMNS =
  `id, type, title, description, owner_id AS ownerId, household_id AS householdId, ` +
  `visibility, color, icon, sort, checked_placement AS checkedPlacement, ` +
  `created_at AS createdAt, updated_at AS updatedAt, version, deleted_at AS deletedAt`

export class ListRepo extends Context.Service<ListRepo>()("ListRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const findById = (id: ListId) =>
      Effect.map(
        sql<List>`SELECT ${sql.literal(LIST_COLUMNS)} FROM lists WHERE id = ${id}`,
        (rows) => Option.fromUndefinedOr(rows[0])
      )

    const listVisible = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<List>`
          SELECT ${sql.literal(LIST_COLUMNS)} FROM lists
          WHERE household_id = ${input.householdId}
            AND deleted_at IS NULL
            AND (owner_id = ${input.userId} OR visibility = 'shared')
          ORDER BY updated_at DESC, id ASC
        `,
        (rows) => rows
      )

    const insert = (list: List) =>
      Effect.map(
        sql<List>`
          INSERT INTO lists
            (id, type, title, description, owner_id, household_id, visibility,
             color, icon, sort, checked_placement, created_at, updated_at, version, deleted_at)
          VALUES
            (${list.id}, ${list.type}, ${list.title}, ${list.description},
             ${list.ownerId}, ${list.householdId}, ${list.visibility}, ${list.color},
             ${list.icon}, ${list.sort}, ${list.checkedPlacement}, ${list.createdAt},
             ${list.updatedAt}, ${list.version}, ${list.deletedAt})
          RETURNING ${sql.literal(LIST_COLUMNS)}
        `,
        (rows) => rows[0]!
      )

    const update = (list: List) =>
      Effect.map(
        sql<List>`
          UPDATE lists SET
            title = ${list.title},
            description = ${list.description},
            visibility = ${list.visibility},
            color = ${list.color},
            icon = ${list.icon},
            sort = ${list.sort},
            checked_placement = ${list.checkedPlacement},
            updated_at = ${list.updatedAt},
            version = ${list.version},
            deleted_at = ${list.deletedAt}
          WHERE id = ${list.id}
          RETURNING ${sql.literal(LIST_COLUMNS)}
        `,
        (rows) => Option.fromUndefinedOr(rows[0])
      )

    return { findById, listVisible, insert, update } as const
  })
}) {}

export const ListRepoLive = Layer.effect(ListRepo, ListRepo.make)
