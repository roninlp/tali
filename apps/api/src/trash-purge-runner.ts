import { Effect, Layer } from "effect"
import { D1Client } from "@effect/sql-d1"
import { TrashPurgeRepo, TrashPurgeRepoLive } from "@tali/sql"

/**
 * The trash-purge entry point for the nightly cron (ticket #85).
 *
 * A cron tick has no HTTP app and no session, so this builds the smallest layer
 * that can read the registered aggregates and batch their hard deletes around
 * the same D1 binding the fetch handler uses.
 */

export interface PurgeEnv {
  readonly DB: D1Database
}

export const purgeLayer = (db: D1Database) =>
  TrashPurgeRepoLive.pipe(Layer.provide(D1Client.layer({ db })))

/** One nightly sweep at the cron tick's nominal instant. */
export const runTrashPurge = (env: PurgeEnv, now: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function*() {
        const purge = yield* TrashPurgeRepo
        return yield* purge.purge(now)
      }),
      purgeLayer(env.DB)
    )
  )
