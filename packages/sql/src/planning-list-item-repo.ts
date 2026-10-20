import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import {
  type ListId,
  PlanningListItem as ListItem,
  type PlanningListItemId as ListItemId,
  type TagId,
  type UserId
} from "@tali/domain"

/**
 * D1-backed repository for the real `ListItem` aggregate (ticket #33;
 * FR-LIST-01/02).
 *
 * Migration 0005 extends the Slice 1 `list_items` table in place instead of
 * forking it. The real columns are `name` / `done` / `ordering` / `checked_at`;
 * the scaffold columns (`title` / `checked` / `sort_order`) are written too, as
 * the sync registry (#34) keeps the legacy wire shape and dual-writes both sets
 * so the web mirror needs no change. The legacy reader lives in
 * `list-item-repo.ts` and only sees scaffold rows.
 */

const LIST_ITEM_COLUMNS =
  `id, type, list_id AS listId, name, done, ordering AS "order", ` +
  `checked_at AS checkedAt, owner_id AS ownerId, household_id AS householdId, ` +
  `visibility, color, tag_ids AS tagIds, created_at AS createdAt, ` +
  `updated_at AS updatedAt, version, deleted_at AS deletedAt`

interface ListItemRow extends Omit<ListItem, "done" | "tagIds"> {
  readonly done: number | boolean
  readonly tagIds: string
}

const toListItem = (row: ListItemRow): ListItem =>
  new ListItem({
    ...row,
    done: row.done === true || row.done === 1,
    tagIds: JSON.parse(row.tagIds) as ReadonlyArray<TagId>
  })

const encodeTagIds = (ids: ReadonlyArray<TagId>): string => JSON.stringify(ids)
const bit = (value: boolean): number => (value ? 1 : 0)

export class PlanningListItemRepo extends Context.Service<PlanningListItemRepo>()(
  "PlanningListItemRepo",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const findById = (id: ListItemId) =>
        Effect.map(
          sql<ListItemRow>`
            SELECT ${sql.literal(LIST_ITEM_COLUMNS)} FROM list_items
            WHERE id = ${id} AND list_id IS NOT NULL
          `,
          (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toListItem)
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
            SELECT ${sql.literal(LIST_ITEM_COLUMNS)} FROM list_items
            WHERE list_id = ${input.listId}
              AND household_id = ${input.householdId}
              AND deleted_at IS NULL
              AND (owner_id = ${input.userId} OR visibility = 'shared')
            ORDER BY ordering ASC, id ASC
          `,
          (rows) => rows.map(toListItem)
        )

      const insert = (item: ListItem) =>
        Effect.map(
          sql<ListItemRow>`
            INSERT INTO list_items
              (id, title, checked, sort_order, version, created_at, updated_at, deleted_at,
               owner_id, visibility, household_id,
               list_id, name, done, ordering, checked_at, color, tag_ids, type)
            VALUES
              (${item.id}, ${item.name}, ${bit(item.done)}, ${item.order},
               ${item.version}, ${item.createdAt}, ${item.updatedAt}, ${item.deletedAt},
               ${item.ownerId}, ${item.visibility}, ${item.householdId},
               ${item.listId}, ${item.name}, ${bit(item.done)}, ${item.order},
               ${item.checkedAt}, ${item.color}, ${encodeTagIds(item.tagIds)}, ${item.type})
            RETURNING ${sql.literal(LIST_ITEM_COLUMNS)}
          `,
          (rows) => toListItem(rows[0]!)
        )

      const update = (item: ListItem) =>
        Effect.map(
          sql<ListItemRow>`
            UPDATE list_items SET
              title = ${item.name},
              checked = ${bit(item.done)},
              sort_order = ${item.order},
              name = ${item.name},
              done = ${bit(item.done)},
              ordering = ${item.order},
              checked_at = ${item.checkedAt},
              visibility = ${item.visibility},
              color = ${item.color},
              tag_ids = ${encodeTagIds(item.tagIds)},
              updated_at = ${item.updatedAt},
              version = ${item.version},
              deleted_at = ${item.deletedAt}
            WHERE id = ${item.id}
            RETURNING ${sql.literal(LIST_ITEM_COLUMNS)}
          `,
          (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toListItem)
        )

      return { findById, listByList, insert, update } as const
    })
  }
) {}

export const PlanningListItemRepoLive = Layer.effect(
  PlanningListItemRepo,
  PlanningListItemRepo.make
)
