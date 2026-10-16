import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { ListItem, ListItemId } from "@tali/domain"

/**
 * D1-backed repository for `ListItem`.
 *
 * Uses `@effect/sql-d1`'s `SqlClient` (provided by `D1Client.layer({ db })`).
 * D1 has no interactive transactions, so multi-row atomicity would use
 * `D1Client.batch()`; for the scaffold, each operation is a single statement.
 */

const columns =
  `id, title, checked, sort_order AS sortOrder, version, ` +
  `created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt`

export class ListItemRepo extends Context.Service<ListItemRepo>()("ListItemRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const findById = SqlSchema.findOneOption({
      Request: ListItemId,
      Result: ListItem,
      execute: (id) => sql`SELECT ${columns} FROM list_items WHERE id = ${id}`
    })

    const findAll = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ListItem,
      execute: () => sql`SELECT ${columns} FROM list_items WHERE deleted_at IS NULL ORDER BY sort_order ASC`
    })

    const findAllForSync = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ListItem,
      execute: () => sql`SELECT ${columns} FROM list_items ORDER BY updated_at ASC`
    })

    const insert = SqlSchema.findOne({
      Request: ListItem,
      Result: ListItem,
      execute: (item) => sql`
        INSERT INTO list_items (id, title, checked, sort_order, version, created_at, updated_at, deleted_at)
        VALUES (${item.id}, ${item.title}, ${item.checked ? 1 : 0}, ${item.sortOrder}, ${item.version},
                ${item.createdAt}, ${item.updatedAt}, NULL)
        RETURNING ${columns}
      `
    })

    const setChecked = SqlSchema.findOne({
      Request: Schema.Struct({
        id: ListItemId,
        checked: Schema.Boolean,
        version: Schema.Number,
        updatedAt: Schema.String
      }),
      Result: ListItem,
      execute: (p) => sql`
        UPDATE list_items
        SET checked = ${p.checked ? 1 : 0}, version = ${p.version}, updated_at = ${p.updatedAt}
        WHERE id = ${p.id}
        RETURNING ${columns}
      `
    })

    return { findById, findAll, findAllForSync, insert, setChecked } as const
  })
}) {}

/** The layer providing `ListItemRepo`, given a `SqlClient` (D1). */
export const ListItemRepoLive = Layer.effect(ListItemRepo, ListItemRepo.make)
