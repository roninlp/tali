import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  PushSubscriptionRepoLive,
  ReminderDispatchRepoLive,
  SyncRepoLive
} from "@tali/sql"
import { type VapidConfig, PushConfig, PushGatewayLive, vapidConfigOf } from "./push-gateway.js"
import { OccasionServiceLive } from "./occasion-service.js"
import { ReminderServiceLive } from "./reminder-service.js"
import { ReminderSweep, ReminderSweepLive } from "./reminder-sweep.js"
import { FEED_RETENTION_MS } from "./sync-service.js"

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
 * A second, independent chance to enforce the feed window. The purge cron at
 * 03:17 owns retention, but it opts out of retries and only logs a failure; if
 * it misses, `change_feed` must not grow without bound. The per-minute reminder
 * sweep already builds `SyncRepo`, so one matching minute an hour later is
 * effectively free. The prune is idempotent, so a healthy night pays two
 * statements for a no-op.
 */
const FEED_PRUNE_FALLBACK_UTC_HOUR = 4
const FEED_PRUNE_FALLBACK_UTC_MINUTE = 17

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
        const result = yield* sweep.sweep(now)
        const at = new Date(now)
        if (
          at.getUTCHours() === FEED_PRUNE_FALLBACK_UTC_HOUR &&
          at.getUTCMinutes() === FEED_PRUNE_FALLBACK_UTC_MINUTE
        ) {
          const cutoff = new Date(at.getTime() - FEED_RETENTION_MS).toISOString()
          yield* sweep.pruneFeed(cutoff).pipe(
            Effect.catch((error) =>
              // A failed fallback must not fail the reminder tick.
              Effect.sync(() => {
                console.error(
                  JSON.stringify({
                    event: "feed.prune.failed",
                    at: now,
                    message: String(error)
                  })
                )
              })
            )
          )
        }
        return result
      }),
      sweepLayer(env.DB, vapidConfigOf(env))
    )
  )
