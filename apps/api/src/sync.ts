import { Effect, Option } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { Change } from "@tali/domain"
import { ListItemRepo } from "@tali/sql"

/**
 * Plain-HTTP sync pull endpoint (CC-02). Deliberately NOT RPC: sync is a bulk
 * cursor-based delta, so it travels as a plain JSON envelope whose shape lives
 * in `packages/domain` (`Change` / `SyncPullResponse`).
 *
 * The repository is captured at layer-build time (via `HttpRouter.use`), so it
 * is a plain layer requirement — provided by `ListItemRepoLive` + the D1 layer.
 *
 * TODO(full sync): filter by `?cursor=<version>` and paginate with `hasMore`.
 * For the scaffold this returns the full change feed and the latest cursor.
 */
export const SyncRoutes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    const repo = yield* ListItemRepo

    router.add(
      "GET",
      "/sync/pull",
      Effect.gen(function*() {
        const items = yield* repo.findAllForSync()
        const changes = items.map(
          (item) =>
            new Change({
              entity: "ListItem",
              id: item.id,
              version: item.version,
              updatedAt: item.updatedAt,
              deleted: Option.isSome(item.deletedAt)
            })
        )
        const cursor = changes.reduce((max, c) => Math.max(max, c.version), 0)
        return yield* HttpServerResponse.json({ cursor, changes, hasMore: false })
      })
    )
  })
)
