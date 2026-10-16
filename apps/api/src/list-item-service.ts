import { Context, Effect, Layer, Option } from "effect"
import { ListItem, ListItemId, ListItemInsert, ListItemNotFound } from "@tali/domain"
import { ListItemRepo, ListItemRepoLive } from "@tali/sql"

/**
 * The `ListItem` aggregate service (FR-LIST-01/02) — the domain layer exposed
 * over RPC. It owns ids, timestamps and version bumps; the repository is pure
 * SQL.
 *
 * Repository `SqlError`/`SchemaError` failures are unexpected (they indicate a
 * broken DB/query), so they are surfaced as defects (`Effect.orDie`); only the
 * domain error `ListItemNotFound` stays in the error channel.
 */
export class ListItemService extends Context.Service<ListItemService>()("ListItemService", {
  make: Effect.gen(function*() {
    const repo = yield* ListItemRepo

    const create = (input: ListItemInsert) =>
      Effect.gen(function*() {
        const now = new Date().toISOString()
        const item = new ListItem({
          id: crypto.randomUUID(),
          title: input.title,
          checked: false,
          sortOrder: input.sortOrder,
          version: 1,
          createdAt: now,
          updatedAt: now,
          deletedAt: Option.none()
        })
        return yield* repo.insert(item).pipe(Effect.orDie)
      })

    const list = () => repo.findAll().pipe(Effect.orDie)

    const setChecked = (id: ListItemId, checked: boolean) =>
      Effect.gen(function*() {
        const currentOpt = yield* repo.findById(id).pipe(Effect.orDie)
        if (Option.isNone(currentOpt)) {
          return yield* Effect.fail(new ListItemNotFound({ id }))
        }
        const current = currentOpt.value
        return yield* repo
          .setChecked({
            id,
            checked,
            version: current.version + 1,
            updatedAt: new Date().toISOString()
          })
          .pipe(Effect.orDie)
      })

    return { create, list, setChecked } as const
  })
}) {}

/** Provides `ListItemService`, wiring `ListItemRepo` (which needs `SqlClient`). */
export const ListItemServiceLive = Layer.effect(ListItemService, ListItemService.make).pipe(
  Layer.provide(ListItemRepoLive)
)
