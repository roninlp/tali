import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { RpcServer, RpcSerialization } from "effect/rpc"
import { ApiRpcs } from "@tali/rpc"
import { ListItemRepoLive } from "@tali/sql"
import { ListItemService, ListItemServiceLive } from "./list-item-service.js"
import { AuthServiceLive } from "./auth-service.js"
import { AuthRoutes } from "./auth-routes.js"
import { SyncRoutes } from "./sync.js"
import { SyncServiceLive } from "./sync-service.js"

/** Implement the RPC contract. Each handler yields the service, then delegates. */
const RpcHandlers = ApiRpcs.toLayer({
  CreateListItem: (input) =>
    ListItemService.pipe(Effect.flatMap((svc) => svc.create(input))),
  ListListItems: () =>
    ListItemService.pipe(Effect.flatMap((svc) => svc.list())),
  ToggleListItem: ({ id, checked }) =>
    ListItemService.pipe(Effect.flatMap((svc) => svc.setChecked(id, checked)))
})

/** Mount `POST /rpc` over plain HTTP (ndjson). */
const RpcLayer = RpcServer.layerHttp({
  group: ApiRpcs,
  path: "/rpc",
  protocol: "http"
}).pipe(
  Layer.provide(RpcHandlers),
  Layer.provide(RpcSerialization.layerNdjson)
)

/**
 * The full HTTP application layer: RPC + plain-HTTP sync + health.
 *
 * Requires `HttpRouter` (provided by `HttpRouter.toWebHandler`/`serve`) and
 * `SqlClient` (provided by `D1Client.layer({ db })`).
 */
export const AppLayer = Layer.mergeAll(
  HttpRouter.add("GET", "/health", HttpServerResponse.json({ ok: true })),
  SyncRoutes,
  AuthRoutes,
  RpcLayer
).pipe(
  Layer.provide(AuthServiceLive),
  Layer.provide(SyncServiceLive),
  Layer.provide(ListItemServiceLive),
  Layer.provide(ListItemRepoLive)
)
