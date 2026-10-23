import { Context, Effect, Layer } from "effect"
import { D1Client } from "@effect/sql-d1"
import { SqlClient, SqlError, Statement } from "effect/sql"
import { TRASH_RETENTION_MS, type SyncEntityType } from "@tali/domain"
import {
  makeSyncRegistry,
  type SyncEntityDefinition,
  type SyncRegistry
} from "./sync-registry.js"

/**
 * The trash purge (ticket #85; the 30-day hard delete settled in #7/#8).
 *
 * A soft delete keeps the row restorable for 30 days. After that the nightly
 * sweep removes it from three places **in one D1 batch**, so a crash can never
 * leave a note's search text, or a row's feed history, pointing at data that no
 * longer exists:
 *
 * 1. child rows (and their feed entries) that a foreign key would cascade;
 * 2. the aggregate's own row, plus the `purge` hook's derived state and
 *    reference repairs;
 * 3. every `change_feed` entry for the row.
 *
 * The purge is **idempotent** and **bounded**. Each tick takes at most
 * {@link PURGE_MAX_ROWS_PER_AGGREGATE} rows per aggregate and stops before D1's
 * per-invocation query ceiling ({@link PURGE_MAX_STATEMENTS_PER_TICK}); a large
 * backlog drains over successive nights. Chunks are 40 ids so the widest
 * statement stays far below D1's 100-bound-parameter limit.
 *
 * Two details make a concurrent restore safe:
 *
 * - every row delete repeats `deleted_at < cutoff`, so a row the user restored
 *   between the selection read and the batch survives;
 * - every feed/index cleanup is gated on the row *not* being live (or keeps the
 *   newest feed row), so the same race cannot strip a restored row's history or
 *   search text.
 *
 * Aggregate-specific work lives in the registry's `purge` hook, next to the
 * aggregate it belongs to (`sync-registry.ts`). This module only owns ordering,
 * parent/child cleanup, budgeting and the feed guard.
 */

/** At most this many rows per aggregate per nightly tick. */
export const PURGE_MAX_ROWS_PER_AGGREGATE = 40
/** Statements (reads + writes) a tick may use. D1 Free allows 50 per invocation. */
export const PURGE_MAX_STATEMENTS_PER_TICK = 48
/** Bound parameters per cleanup statement (D1 rejects > 100). */
export const PURGE_CHUNK_SIZE = 40

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

/** Child aggregates first, derived from the registry's `parent` metadata. */
const parentDepth = (registry: SyncRegistry, definition: SyncEntityDefinition): number => {
  const seen = new Set<SyncEntityType>()
  let depth = 0
  let current: SyncEntityDefinition | undefined = definition
  while (current?.parent !== undefined && !seen.has(current.entityType)) {
    seen.add(current.entityType)
    const parent = registry.get(current.parent.entityType)
    if (parent === undefined) break
    depth += 1
    current = parent
  }
  return depth
}

const ordered = (registry: SyncRegistry): ReadonlyArray<SyncEntityDefinition> =>
  [...registry.all()].sort((a, b) => {
    const depth = parentDepth(registry, b) - parentDepth(registry, a)
    return depth !== 0 ? depth : a.entityType.localeCompare(b.entityType)
  })

const childrenOf = (
  definitions: ReadonlyArray<SyncEntityDefinition>,
  parent: SyncEntityDefinition
): ReadonlyArray<SyncEntityDefinition> =>
  definitions.filter((definition) => definition.parent?.entityType === parent.entityType)

export class TrashPurgeRepo extends Context.Service<TrashPurgeRepo>()("TrashPurgeRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const d1 = yield* D1Client.D1Client
    const registry = makeSyncRegistry(sql)
    const definitions = registry.all()

    /**
     * Plan one parent chunk. Child rows are removed explicitly (not left to a
     * FK cascade) so their feed entries can be deleted before the parent row
     * disappears; the registry's `parent` rule supplies the column, so a new
     * child aggregate cannot drift.
     */
    const planChunk = (
      definition: SyncEntityDefinition,
      ids: ReadonlyArray<string>,
      now: string,
      cutoff: string
    ): Effect.Effect<
      {
        readonly statements: ReadonlyArray<Statement.Statement<unknown>>
        readonly reads: number
        /** Index of the row-delete statement in `statements` (RETURNING id). */
        readonly deletedResult: number
      },
      SqlError.SqlError
    > =>
      Effect.gen(function*() {
        const statements: Array<Statement.Statement<unknown>> = []
        let reads = 0

        for (const child of childrenOf(definitions, definition)) {
          const parent = child.parent
          if (parent === undefined) continue

          // A child with its own derived state gets its purge hook first; the
          // ids are read from the child table because the parent rows still
          // exist at this point.
          if (child.purge !== undefined) {
            const childRows = yield* sql<{ readonly id: string }>`
              SELECT id FROM ${sql.literal(child.table)}
              WHERE ${sql.in(parent.column, ids)}
            `
            reads += 1
            for (const chunk of chunked(childRows.map((row) => row.id), PURGE_CHUNK_SIZE)) {
              statements.push(...child.purge({ ids: chunk, now, cutoff }))
            }
          }

          // A parent restored between the selection read and this batch must
          // keep its children: gate both statements on the parent still being
          // expired. Feed entries first, because after the child rows are gone
          // the subquery can no longer find them. The max-seq guard mirrors the
          // feed pruning rule, so purging can never leave `change_feed` empty.
          const parentNotLive = sql`NOT EXISTS (
            SELECT 1 FROM ${sql.literal(definition.table)} AS parent
            WHERE ${sql.in("id", ids)}
              AND parent.${sql.literal(definition.softDeleteColumn)} IS NULL
          )`
          statements.push(sql`
            DELETE FROM change_feed
            WHERE entity_type = ${child.entityType}
              AND seq < (SELECT MAX(seq) FROM change_feed)
              AND ${parentNotLive}
              AND entity_id IN (
                SELECT id FROM ${sql.literal(child.table)}
                WHERE ${sql.in(parent.column, ids)}
              )
          `)
          statements.push(sql`
            DELETE FROM ${sql.literal(child.table)}
            WHERE ${parentNotLive}
              AND ${sql.in(parent.column, ids)}
          `)
        }

        if (definition.purge !== undefined) {
          statements.push(...definition.purge({ ids, now, cutoff }))
        }

        const deletedResult = statements.length
        statements.push(sql`
          DELETE FROM ${sql.literal(definition.table)}
          WHERE ${sql.in("id", ids)}
            AND ${sql.literal(definition.softDeleteColumn)} < ${cutoff}
          RETURNING id
        `)
        statements.push(sql`
          DELETE FROM change_feed
          WHERE entity_type = ${definition.entityType}
            AND seq < (SELECT MAX(seq) FROM change_feed)
            AND ${sql.in("entity_id", ids)}
            AND NOT EXISTS (
              SELECT 1 FROM ${sql.literal(definition.table)} AS live
              WHERE live.id = change_feed.entity_id
                AND live.${sql.literal(definition.softDeleteColumn)} IS NULL
            )
        `)

        return { statements, reads, deletedResult }
      })

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

        sweep: for (const definition of ordered(registry)) {
          // One extra row tells us whether the aggregate has a backlog; an
          // exact 40 rows is therefore not reported as capped.
          const rows = yield* sql<{ readonly id: string }>`
            SELECT id FROM ${sql.literal(definition.table)}
            WHERE ${sql.literal(definition.softDeleteColumn)} < ${cutoff}
            ORDER BY ${sql.literal(definition.softDeleteColumn)} ASC, id ASC
            LIMIT ${PURGE_MAX_ROWS_PER_AGGREGATE + 1}
          `
          statements += 1
          if (rows.length === 0) continue
          if (rows.length > PURGE_MAX_ROWS_PER_AGGREGATE) capped = true

          const selected = rows.slice(0, PURGE_MAX_ROWS_PER_AGGREGATE)
          let entityPurged = 0
          for (const ids of chunked(selected.map((row) => row.id), PURGE_CHUNK_SIZE)) {
            const plan = yield* planChunk(definition, ids, now, cutoff)
            if (statements + plan.reads + plan.statements.length > PURGE_MAX_STATEMENTS_PER_TICK) {
              statements += plan.reads
              capped = true
              entities.push({
                entityType: definition.entityType,
                selected: selected.length,
                purged: entityPurged
              })
              break sweep
            }
            // One batch per chunk: atomic row/feed/index removal, and partial
            // progress is durable if a later chunk is cut off. `RETURNING id`
            // makes the logged count the rows that actually disappeared (a row
            // restored mid-flight is not one of them).
            const results = yield* d1.batch(plan.statements)
            const deleted = results[plan.deletedResult]
            const deletedIds = Array.isArray(deleted) ? deleted : ids
            statements += plan.reads + plan.statements.length
            entityPurged += deletedIds.length
            purged += deletedIds.length
          }

          entities.push({
            entityType: definition.entityType,
            selected: selected.length,
            purged: entityPurged
          })
        }

        return { at: now, cutoff, purged, entities, statements, capped }
      })

    return { purge } as const
  })
}) {}

export const TrashPurgeRepoLive = Layer.effect(TrashPurgeRepo, TrashPurgeRepo.make)
