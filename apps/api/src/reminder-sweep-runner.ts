import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import { PushSubscriptionRepoLive, ReminderDispatchRepoLive, SyncRepoLive } from "@tali/sql"
import { type VapidConfig, PushConfig, PushGatewayLive, vapidConfigOf } from "./push-gateway.js"
import { OccasionServiceLive } from "./occasion-service.js"
import { ReminderServiceLive } from "./reminder-service.js"
import { ReminderSweep, ReminderSweepLive } from "./reminder-sweep.js"

/**
 * The `scheduled()` entry point's layer (ticket #61; ADR-0005 §11).
 *
 * A cron tick is not an HTTP request: it has no `AppLayer`, no router and no
 * session. This builds the smallest layer that can claim and push — the sweep,
 * the reminder service's claim seam, the three repositories it reads and the
 * push gateway — around the same D1 binding the fetch handler uses.
 *
 * `env.DB` is the only infrastructure dependency, so a tick costs the same
 * three indexed reads and two batches whether it came from a cron, the dev
 * trigger or a test.
 */

export interface SweepEnv {
  readonly DB: D1Database
  readonly VAPID_PRIVATE_KEY?: string
  readonly VAPID_PUBLIC_KEY?: string
  readonly VAPID_SUBJECT?: string
}

export const sweepLayer = (db: D1Database, vapid: VapidConfig | null) => {
  // `OccasionServiceLive` is the sweep's materialisation seam (#61): it turns
  // due occasion advance reminders into reminder rows before the claim.
  const services = Layer.mergeAll(ReminderServiceLive, PushGatewayLive, OccasionServiceLive)
  return ReminderSweepLive.pipe(
    Layer.provide(services),
    Layer.provide(
      Layer.mergeAll(
        ReminderDispatchRepoLive,
        PushSubscriptionRepoLive,
        SyncRepoLive
      )
    ),
    Layer.provide(Layer.succeed(PushConfig, vapid)),
    Layer.provide(
      D1Client.layer({
        db,
        transformQueryNames: Str.camelToSnake,
        transformResultNames: Str.snakeToCamel
      })
    )
  )
}

/**
 * Run one tick. `now` is the nominal clock (`controller.scheduledTime`).
 *
 * Cloudflare retries a throwing `scheduled()` handler; the caller decides
 * whether to swallow (a cron tick is a catch-up query, so the next minute
 * repairs it) — this function just surfaces the result.
 */
export const runReminderSweep = (env: SweepEnv, now: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function*() {
        const sweep = yield* ReminderSweep
        return yield* sweep.sweep(now)
      }),
      sweepLayer(env.DB, vapidConfigOf(env))
    )
  )
