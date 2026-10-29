import { Effect, Layer } from "effect"
import { D1Client } from "@effect/sql-d1"
import { SyncRepo, SyncRepoLive, TrashPurgeRepo, TrashPurgeRepoLive } from "@tali/sql"
import { FEED_RETENTION_MS } from "./sync-service.js"

/**
 * The trash-purge entry point for the nightly cron (ticket #85).
 *
 * A cron tick has no HTTP app and no session, so this builds the smallest layer
 * that can read the registered aggregates and batch their hard deletes around
 * the same D1 binding the fetch handler uses.
 *
 * The same tick now owns the `change_feed` retention window: it used to run on
 * every `GET /sync/pull` (two DELETEs on each poll), which made a read-only
 * poll write to D1. Pruning here keeps the 90-day window without touching it.
 */

export interface PurgeEnv {
  readonly DB: D1Database
}

export const purgeLayer = (db: D1Database) =>
  Layer.mergeAll(TrashPurgeRepoLive, SyncRepoLive).pipe(
    Layer.provide(D1Client.layer({ db }))
  )

/** One nightly sweep at the cron tick's nominal instant. */
export const runTrashPurge = (env: PurgeEnv, now: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function*() {
        const purge = yield* TrashPurgeRepo
        const result = yield* purge.purge(now)
        // Same cutoff the poll used to apply, now once a night. The repo keeps
        // the newest feed row as the high-water marker stale cursors need, so
        // `minSeq` detection is unchanged. These two statements are constant
        // and deliberately outside `PURGE_MAX_STATEMENTS_PER_TICK`, so they are
        // not counted in `result.statements`.
        const sync = yield* SyncRepo
        yield* sync.prune(
          new Date(Date.parse(now) - FEED_RETENTION_MS).toISOString()
        )
        return result
      }),
      purgeLayer(env.DB)
    )
  )
