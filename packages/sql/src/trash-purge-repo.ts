import { Context, Effect, Layer } from "effect"
import { D1Client } from "@effect/sql-d1"
import { SqlClient, SqlError, Statement } from "effect/sql"
import { TRASH_RETENTION_MS, type SyncEntityType } from "@tali/domain"
import { makeSyncRegistry, type SyncEntityDefinition } from "./sync-registry.js"

/**
 * The trash purge (ticket #85; the 30-day hard delete settled in #7/#8).
 *
 * A soft delete keeps the row restorable for 30 days. After that the nightly
 * sweep removes it from three places **in one D1 batch**, so a crash can never
 * leave a note's search text, or a row's feed history, pointing at data that no
 * longer exists:
 *
 * 1. the aggregate's own table;
 * 2. every `change_feed` entry for that row (a feed entry for a purged row is a
 *    dangling reference, and a pull would only skip it);
 * 3. derived state — the `notes_fts` row, and `item_tags` joins.
 *
 * The purge is **idempotent** and **bounded**. Each tick takes at most
 * {@link PURGE_MAX_ROWS_PER_AGGREGATE} rows per aggregate and stops before D1's
 * per-invocation query ceiling ({@link PURGE_MAX_STATEMENTS_PER_TICK}); a large
 * backlog drains over successive nights. Chunk size is 40 ids so the widest
 * statement (row delete, feed delete, FTS delete, join delete) stays far below
 * D1's 100-bound-parameter limit.
 *
 * Two details make a concurrent restore safe:
 *
 * - every row delete repeats the `deleted_at < cutoff` predicate, so a row the
 *   user restored between the selection read and the batch survives;
 * - every feed/index cleanup is gated on the row *not* being live, so the same
 *   race cannot strip a restored row's history or search text.
 */

/** At most this many rows per aggregate per nightly tick. */
export const PURGE_MAX_ROWS_PER_AGGREGATE = 40
/** Statements (reads + writes) a tick may use; D1 Free allows 50 per invocation. */
export const PURGE_MAX_STATEMENTS_PER_TICK = 45
/** Bound parameters per cleanup statement (D1 rejects > 100). */
export const PURGE_CHUNK_SIZE = 40

/**
 * Child aggregates first: a habit entry before its habit, a list item before
 * its list. Nothing here relies on SQLite's cascade ordering, so the sweep is
 * deterministic on D1 and in the test harness.
 */
const PURGE_ORDER: ReadonlyArray<SyncEntityType> = [
  "habitEntry",
  "listItem",
  "task",
  "note",
  "reminder",
  "event",
  "occasion",
  "habit",
  "list",
  "project",
  "tag"
]

/** Aggregates whose rows can appear in `item_tags` as the item side. */
const ITEM_TAG_AGGREGATES: ReadonlySet<SyncEntityType> = new Set([
  "task",
  "note",
  "listItem"
])

export interface PurgeEntityResult {
  readonly entityType: SyncEntityType
  readonly selected: number
  readonly purged: number
}

export interface TrashPurgeResult {
  /** The sweep's nominal clock (`controller.scheduledTime`). */
  readonly at: string
  /** Deleted rows strictly older than this instant are purged. */
  readonly cutoff: string
  readonly purged: number
  readonly entities: ReadonlyArray<PurgeEntityResult>
  /** Statements used by this tick, including the selection reads. */
  readonly statements: number
  /** True when a backlog remains (a row or statement cap stopped the sweep). */
  readonly capped: boolean
}

const chunked = <A>(values: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const chunks: Array<ReadonlyArray<A>> = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

const ordered = (definitions: ReadonlyArray<SyncEntityDefinition>): ReadonlyArray<SyncEntityDefinition> => {
  const rank = new Map(PURGE_ORDER.map((entityType, index) => [entityType, index]))
  return [...definitions].sort((a, b) => {
    const left = rank.get(a.entityType) ?? PURGE_ORDER.length
    const right = rank.get(b.entityType) ?? PURGE_ORDER.length
    return left - right
  })
}

export class TrashPurgeRepo extends Context.Service<TrashPurgeRepo>()("TrashPurgeRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const d1 = yield* D1Client.D1Client
    const registry = makeSyncRegistry(sql)

    /**
     * Derived-state cleanup for a chunk. Every statement is gated on the row
     * not being live any more, so a restore that lands after the selection read
     * keeps its feed entry, search text and tag joins.
     */
    const derivedCleanup = (
      def: SyncEntityDefinition,
      ids: ReadonlyArray<string>
    ): ReadonlyArray<Statement.Statement<unknown>> => {
      const statements: Array<Statement.Statement<unknown>> = []

      if (def.entityType === "note") {
        statements.push(sql`
          DELETE FROM notes_fts
          WHERE ${sql.in("note_id", ids)}
            AND NOT EXISTS (
              SELECT 1 FROM notes AS live
              WHERE live.id = notes_fts.note_id AND live.deleted_at IS NULL
            )
        `)
      }

      if (def.entityType === "tag") {
        statements.push(sql`
          DELETE FROM item_tags
          WHERE ${sql.in("tag_id", ids)}
            AND NOT EXISTS (
              SELECT 1 FROM tags AS live
              WHERE live.id = item_tags.tag_id AND live.deleted_at IS NULL
            )
        `)
      }

      if (ITEM_TAG_AGGREGATES.has(def.entityType)) {
        statements.push(sql`
          DELETE FROM item_tags
          WHERE item_type = ${def.entityType}
            AND ${sql.in("item_id", ids)}
            AND NOT EXISTS (
              SELECT 1 FROM ${sql.literal(def.table)} AS live
              WHERE live.id = item_tags.item_id
            )
        `)
      }

      return statements
    }

    /** Remove the row + its feed entries + derived state for one id chunk. */
    const purgeChunk = (
      def: SyncEntityDefinition,
      ids: ReadonlyArray<string>,
      cutoff: string
    ): ReadonlyArray<Statement.Statement<unknown>> => [
      sql`
        DELETE FROM ${sql.literal(def.table)}
        WHERE ${sql.in("id", ids)}
          AND ${sql.literal(def.softDeleteColumn)} < ${cutoff}
        RETURNING id
      `,
      sql`
        DELETE FROM change_feed
        WHERE entity_type = ${def.entityType}
          AND ${sql.in("entity_id", ids)}
          AND NOT EXISTS (
            SELECT 1 FROM ${sql.literal(def.table)} AS live
            WHERE live.id = change_feed.entity_id
              AND live.${sql.literal(def.softDeleteColumn)} IS NULL
          )
      `,
      ...derivedCleanup(def, ids)
    ]

    /**
     * One bounded sweep at `now`. `now` is the cron tick's nominal instant, so
     * two invocations for the same night compute the same cutoff; the second
     * finds nothing to delete and is a no-op.
     */
    const purge = (now: string): Effect.Effect<TrashPurgeResult, SqlError.SqlError> =>
      Effect.gen(function*() {
        const cutoff = new Date(Date.parse(now) - TRASH_RETENTION_MS).toISOString()
        const entities: Array<PurgeEntityResult> = []
        let purged = 0
        let statements = 0
        let capped = false

        sweep: for (const def of ordered(registry.all())) {
          const rows = yield* sql<{ readonly id: string }>`
            SELECT id FROM ${sql.literal(def.table)}
            WHERE ${sql.literal(def.softDeleteColumn)} < ${cutoff}
            ORDER BY ${sql.literal(def.softDeleteColumn)} ASC, id ASC
            LIMIT ${PURGE_MAX_ROWS_PER_AGGREGATE}
          `
          statements += 1
          if (rows.length === 0) continue
          if (rows.length === PURGE_MAX_ROWS_PER_AGGREGATE) capped = true

          let entityPurged = 0
          for (const ids of chunked(rows.map((row) => row.id), PURGE_CHUNK_SIZE)) {
            const statementsForChunk = purgeChunk(def, ids, cutoff)
            if (statements + statementsForChunk.length > PURGE_MAX_STATEMENTS_PER_TICK) {
              capped = true
              break sweep
            }
            // One batch per chunk: atomic row/feed/index removal, and partial
            // progress is durable if a later chunk is cut off. `RETURNING id`
            // makes the logged count the rows that actually disappeared (a row
            // restored mid-flight is not one of them).
            const results = yield* d1.batch(statementsForChunk)
            const deletedIds = Array.isArray(results[0]) ? results[0] : ids
            statements += statementsForChunk.length
            entityPurged += deletedIds.length
            purged += deletedIds.length
          }

          entities.push({
            entityType: def.entityType,
            selected: rows.length,
            purged: entityPurged
          })
        }

        return { at: now, cutoff, purged, entities, statements, capped }
      })

    return { purge } as const
  })
}) {}

export const TrashPurgeRepoLive = Layer.effect(TrashPurgeRepo, TrashPurgeRepo.make)
