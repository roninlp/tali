import { Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { RpcServer, RpcSerialization } from "effect/rpc"
import { ApiRpcs } from "@tali/rpc"
import {
  EventRepoLive,
  HabitEntryRepoLive,
  HabitRepoLive,
  ListItemRepoLive,
  OccasionRepoLive,
  NoteRepoLive,
  NoteSearchRepoLive,
  ProjectRepoLive,
  PushSubscriptionRepoLive,
  ReminderDispatchRepoLive,
  ReminderRepoLive,
  SyncRepoLive,
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
import { OccasionServiceLive } from "./occasion-service.js"
import { PreferencesRoutes } from "./preferences-routes.js"
import { PreferencesServiceLive } from "./preferences-service.js"
import { DevReminderRoutes } from "./dev-reminder-routes.js"
import { PushConfig, PushGatewayLive, type VapidConfig } from "./push-gateway.js"
import { PushRoutes } from "./push-routes.js"
import { ReminderRoutes } from "./reminder-routes.js"
import { ReminderServiceLive } from "./reminder-service.js"
import { ReminderSweepLive } from "./reminder-sweep.js"
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
  ReminderServiceLive,
  OccasionServiceLive,
  PushGatewayLive
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
  OccasionRepoLive,
  ReminderRepoLive,
  ReminderDispatchRepoLive,
  PushSubscriptionRepoLive,
  // The sweep reads the ledger directly and commits its outcome batch through
  // the same sync primitives, so it needs the repo (not just the service).
  SyncRepoLive
)

export interface AppOptions {
  /** VAPID identity for dispatch and for `GET /push/vapid`; `null` disables push. */
  readonly vapid?: VapidConfig | null
  /**
   * Register the local-only sweep trigger (`POST /dev/reminders/sweep`).
   * `alchemy dev` sets this; a deploy never does (ADR-0005 §11).
   */
  readonly devRoutes?: boolean
}

/**
 * The full HTTP application layer: RPC + plain-HTTP sync + health.
 *
 * Requires `HttpRouter` (provided by `HttpRouter.toWebHandler`/`serve`) and
 * `SqlClient` (provided by `D1Client.layer({ db })`).
 *
 * Dev routes are *conditionally registered* rather than guarded at runtime, so
 * a deployed Worker has no `/dev/reminders/sweep` route at all.
 */
export const makeAppLayer = (options: AppOptions = {}) => {
  const app = Layer.mergeAll(
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
  )
  return (options.devRoutes === true ? Layer.merge(app, DevReminderRoutes) : app).pipe(
    // The sweep runs inside the app so the local-only dev trigger can drive a
    // tick without a second Worker or a second D1 layer.
    Layer.provide(ReminderSweepLive.pipe(Layer.provide(ServiceLayers))),
    Layer.provide(ServiceLayers),
    Layer.provide(RepoLayers),
    Layer.provide(Layer.succeed(PushConfig, options.vapid ?? null))
  )
}

/** The default app (tests and non-push environments). */
export const AppLayer = makeAppLayer()
