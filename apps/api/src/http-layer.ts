import { Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { RpcServer, RpcSerialization } from "effect/rpc"
import { ApiRpcs } from "@tali/rpc"
import {
  EventRepoLive,
  HabitEntryRepoLive,
  HabitRepoLive,
  ListItemRepoLive,
  NoteRepoLive,
  NoteSearchRepoLive,
  ProjectRepoLive,
  PushSubscriptionRepoLive,
  ReminderDispatchRepoLive,
  ReminderRepoLive,
  TagRepoLive,
  TaskRepoLive
} from "@tali/sql"
import { AuthServiceLive } from "./auth-service.js"
import { AuthRoutes } from "./auth-routes.js"
import { CalendarRoutes } from "./calendar-routes.js"
import { CalendarServiceLive } from "./calendar-service.js"
import { EventServiceLive } from "./event-service.js"
import { HabitServiceLive } from "./habit-service.js"
import { ListServiceLive } from "./list-service.js"
import { ListItemServiceLive } from "./list-item-service.js"
import { NoteSearchRoutes } from "./note-search-routes.js"
import { NoteSearchServiceLive } from "./note-search-service.js"
import { NoteServiceLive } from "./note-service.js"
import { PreferencesRoutes } from "./preferences-routes.js"
import { PreferencesServiceLive } from "./preferences-service.js"
import { PushRoutes } from "./push-routes.js"
import { ReminderRoutes } from "./reminder-routes.js"
import { ReminderServiceLive } from "./reminder-service.js"
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
 * The service layers, grouped because `Layer.provide` merges at most 20
 * layers: the app now provides more services and repositories than that.
 */
const ServiceLayers = Layer.mergeAll(
  AuthServiceLive,
  PreferencesServiceLive,
  SyncServiceLive,
  ListServiceLive,
  ListItemServiceLive,
  TaskServiceLive,
  NoteServiceLive,
  NoteSearchServiceLive,
  TodayServiceLive,
  CalendarServiceLive,
  EventServiceLive,
  HabitServiceLive,
  ReminderServiceLive
)

/** The aggregate repositories (each service also provides the ones it owns). */
const RepoLayers = Layer.mergeAll(
  ListItemRepoLive,
  NoteRepoLive,
  NoteSearchRepoLive,
  ProjectRepoLive,
  TagRepoLive,
  TaskRepoLive,
  EventRepoLive,
  HabitRepoLive,
  HabitEntryRepoLive,
  ReminderRepoLive,
  ReminderDispatchRepoLive,
  PushSubscriptionRepoLive
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
  CalendarRoutes,
  NoteSearchRoutes,
  PushRoutes,
  ReminderRoutes,
  RpcLayer
).pipe(
  Layer.provide(ServiceLayers),
  Layer.provide(RepoLayers)
)
