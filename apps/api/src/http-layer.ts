import { Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { RpcServer, RpcSerialization } from "effect/rpc"
import { ApiRpcs } from "@tali/rpc"
import {
  ListItemRepoLive,
  NoteRepoLive,
  ProjectRepoLive,
  PushSubscriptionRepoLive,
  TagRepoLive,
  TaskRepoLive
} from "@tali/sql"
import { AuthServiceLive } from "./auth-service.js"
import { AuthRoutes } from "./auth-routes.js"
import { ListServiceLive } from "./list-service.js"
import { ListItemServiceLive } from "./list-item-service.js"
import { NoteServiceLive } from "./note-service.js"
import { PreferencesRoutes } from "./preferences-routes.js"
import { PreferencesServiceLive } from "./preferences-service.js"
import { PushRoutes } from "./push-routes.js"
import { RpcHandlers } from "./rpc-handlers.js"
import { SyncRoutes } from "./sync.js"
import { SyncServiceLive } from "./sync-service.js"
import { TaskServiceLive } from "./task-service.js"
import { TodayRoutes } from "./today-routes.js"
import { TodayServiceLive } from "./today-service.js"

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
  PreferencesRoutes,
  TodayRoutes,
  PushRoutes,
  RpcLayer
).pipe(
  Layer.provide(AuthServiceLive),
  Layer.provide(PreferencesServiceLive),
  Layer.provide(SyncServiceLive),
  Layer.provide(ListServiceLive),
  Layer.provide(ListItemServiceLive),
  Layer.provide(TaskServiceLive),
  Layer.provide(NoteServiceLive),
  Layer.provide(TodayServiceLive),
  Layer.provide(ListItemRepoLive),
  Layer.provide(NoteRepoLive),
  Layer.provide(ProjectRepoLive),
  Layer.provide(TagRepoLive),
  Layer.provide(TaskRepoLive),
  Layer.provide(PushSubscriptionRepoLive)
)
