import { Context, Effect, Layer, Option } from "effect"
import { D1Client } from "@effect/sql-d1"
import { SqlClient, Statement } from "effect/sql"
import { type SyncEntityRow, type SyncEntityType, type SyncOp, type Visibility } from "@tali/domain"
import {
  makeSyncRegistry,
  type SyncEntityDefinition,
  type SyncEntityState,
  type SyncRegistry
} from "./sync-registry.js"

/**
 * D1-backed persistence for the sync engine (tickets #18, #34).
 *
 * The pull list is `change_feed` (global `seq`); the conflict field is the
 * entity row's per-row `version` (session draft §2). Every push write is built
 * as a statement sequence the service applies in **one** `D1Client.batch()`,
 * because D1 has no interactive transactions.
 *
 * Which tables/columns/allowlists exist is the registry's job
 * (`sync-registry.ts`); this module owns the SQL shape and the CAS gate.
 */

export interface FeedRow {
  readonly seq: number
  readonly entityType: SyncEntityType
  readonly entityId: string
  readonly op: SyncOp
  readonly version: number
  readonly updatedAt: string
  readonly ownerId: string
  readonly visibility: string
}

interface AppliedRow {
  readonly clientMutationId: string
  readonly entityType: SyncEntityType
  readonly entityId: string
  readonly serverVersion: number
  readonly seq: number
}

export interface AppliedMutation {
  readonly clientMutationId: string
  readonly entityType: SyncEntityType
  readonly entityId: string
  readonly version: number
  readonly seq: number
}

export interface EntityWrite {
  readonly state: SyncEntityState
  /** `null` inserts; otherwise the version this write is conditioned on (CAS). */
  readonly expectedVersion: number | null
}

export interface FeedWrite {
  readonly householdId: string
  readonly entityType: SyncEntityType
  readonly entityId: string
  readonly op: SyncOp
  readonly version: number
  readonly updatedAt: string
  readonly ownerId: string
  readonly visibility: Visibility
}

export interface AppliedWrite {
  readonly clientMutationId: string
  readonly householdId: string
  readonly entityType: SyncEntityType
  readonly entityId: string
  readonly version: number
  readonly createdAt: string
}

/** `(entityType, entityId)` is the real identity of a row across tables. */
export interface EntityRef {
  readonly entityType: SyncEntityType
  readonly entityId: string
}

export const entityKey = (ref: EntityRef): string =>
  `${ref.entityType}\u0000${ref.entityId}`

/**
 * D1 refuses a statement that binds more than 100 parameters
 * (<https://developers.cloudflare.com/d1/platform/limits/>), and `sql.in(...)`
 * expands to one bound parameter per value. Pull/bootstrap pages default to
 * 500 refs and a push may carry 200 entries, so every `IN` list is split into
 * chunks that leave headroom for the statement's other bindings. Without this
 * the first page above ~100 refs of a single entity type throws `SqlError`.
 */
const MAX_IN_PARAMS = 90

const chunked = <A>(values: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const chunks: Array<ReadonlyArray<A>> = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

const toEntityRow = (state: SyncEntityState): SyncEntityRow => ({
  entityType: state.entityType,
  entityId: state.entityId,
  version: state.version,
  updatedAt: state.updatedAt,
  deletedAt: state.deletedAt,
  data: state.data
})

export class SyncRepo extends Context.Service<SyncRepo>()("SyncRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const d1 = yield* D1Client.D1Client
    const registry: SyncRegistry = makeSyncRegistry(sql)

    const definition = (entityType: SyncEntityType): SyncEntityDefinition | undefined =>
      registry.get(entityType)

    /**
     * Batch-hydrate entity rows behind feed/push references. Rows live in
     * per-entity tables, so this is one `IN` query per distinct type present
     * in the page — never a query per row. Ids are chunked because a page can
     * hold far more refs than D1 allows bound parameters in one statement.
     */
    const findEntities = (refs: ReadonlyArray<EntityRef>) =>
      Effect.gen(function*() {
        const byType = new Map<SyncEntityType, Set<string>>()
        for (const ref of refs) {
          const ids = byType.get(ref.entityType) ?? new Set<string>()
          ids.add(ref.entityId)
          byType.set(ref.entityType, ids)
        }
        const states = new Map<string, SyncEntityState>()
        for (const [entityType, ids] of byType) {
          const def = registry.get(entityType)
          if (def === undefined) continue
          for (const chunk of chunked([...ids], MAX_IN_PARAMS)) {
            const rows = yield* sql<Record<string, unknown>>`
              SELECT ${sql.literal(def.select)} FROM ${sql.literal(def.table)}
              WHERE ${sql.in("id", chunk)}
            `
            for (const row of rows) {
              const id = String(row.id)
              states.set(entityKey({ entityType, entityId: id }), {
                entityType,
                entityId: id,
                householdId: typeof row.householdId === "string" ? row.householdId : null,
                ownerId: typeof row.ownerId === "string" ? row.ownerId : "",
                visibility: row.visibility === "private" ? "private" : "shared",
                version: typeof row.version === "number" ? row.version : Number(row.version ?? 0),
                updatedAt: String(row.updatedAt ?? ""),
                deletedAt: typeof row.deletedAt === "string" ? row.deletedAt : null,
                data: def.hydrate(row)
              })
            }
          }
        }
        return states
      })

    /**
     * Dedupe pre-read: which of these mutation ids has the server already
     * applied? Scoped to the household so a ledger row can never hand another
     * household's row back in a push result.
     */
    const findApplied = (input: {
      readonly householdId: string
      readonly clientMutationIds: ReadonlyArray<string>
    }) =>
      Effect.gen(function*() {
        const unique = [...new Set(input.clientMutationIds)]
        if (unique.length === 0) return new Map<string, AppliedMutation>()
        const rows: Array<AppliedRow> = []
        for (const chunk of chunked(unique, MAX_IN_PARAMS)) {
          rows.push(...(yield* sql<AppliedRow>`
            SELECT client_mutation_id AS clientMutationId, entity_type AS entityType,
                   entity_id AS entityId, server_version AS serverVersion, seq
            FROM applied_mutations
            WHERE household_id = ${input.householdId}
              AND ${sql.in("client_mutation_id", chunk)}
          `))
        }
        return new Map(
          rows.map((row) => [
            row.clientMutationId,
            {
              clientMutationId: row.clientMutationId,
              entityType: row.entityType,
              entityId: row.entityId,
              version: row.serverVersion,
              seq: row.seq
            }
          ])
        )
      })

    /** A page of the household feed, plus one extra row to detect `hasMore`. */
    const pullFeed = (input: {
      readonly householdId: string
      readonly cursor: number
      readonly limit: number
    }) =>
      sql<FeedRow>`
        SELECT seq, entity_type AS entityType, entity_id AS entityId, op, version,
               updated_at AS updatedAt, owner_id AS ownerId, visibility
        FROM change_feed
        WHERE household_id = ${input.householdId} AND seq > ${input.cursor}
        ORDER BY seq ASC
        LIMIT ${input.limit + 1}
      `

    /**
     * All visible live rows for a fresh mirror / stale cursor
     * (`/sync/bootstrap`), across every registered aggregate.
     *
     * The per-entity branches are `UNION ALL`ed with a literal entity type, so
     * paging/ordering is one global sequence: `updated_at`, then type/id as a
     * stable tiebreak. Hydration happens in `findEntities` on the page refs —
     * this query only decides *which* rows belong to the page.
     */
    const bootstrapPage = (input: {
      readonly householdId: string
      readonly userId: string
      readonly offset: number
      readonly limit: number
    }) =>
      Effect.gen(function*() {
        const branches = registry.all().map((def) =>
          sql`
            SELECT ${def.entityType} AS entityType, id, updated_at AS updatedAt
            FROM ${sql.literal(def.table)}
            WHERE ${sql.literal(def.scope.householdId)} = ${input.householdId}
              AND ${sql.literal(def.softDeleteColumn)} IS NULL
              AND (${sql.literal(def.scope.ownerId)} = ${input.userId}
                OR ${sql.literal(def.scope.visibility)} = 'shared')
          `
        )
        const rows = yield* sql<{ readonly entityType: SyncEntityType; readonly id: string }>`
          ${sql.join(" UNION ALL ", false)(branches)}
          ORDER BY updatedAt ASC, entityType ASC, id ASC
          LIMIT ${input.limit + 1} OFFSET ${input.offset}
        `
        return rows.map((row) => ({ entityType: row.entityType, entityId: row.id }))
      })

    /** Hydrate a page of bootstrap refs into wire rows. */
    const bootstrapEntities = (refs: ReadonlyArray<EntityRef>) =>
      Effect.map(findEntities(refs), (states) =>
        refs.flatMap((ref) => {
          const state = states.get(entityKey(ref))
          return state === undefined ? [] : [toEntityRow(state)]
        }))

    const minSeq = Effect.gen(function*() {
      const rows = yield* sql<{ minSeq: number | null }>`
        SELECT MIN(seq) AS minSeq FROM change_feed
      `
      const value = rows[0]?.minSeq
      return value === null || value === undefined ? Option.none<number>() : Option.some(value)
    })

    const maxSeq = Effect.gen(function*() {
      const rows = yield* sql<{ maxSeq: number | null }>`
        SELECT MAX(seq) AS maxSeq FROM change_feed
      `
      return rows[0]?.maxSeq ?? 0
    })

    /** Bound feed growth + replay memory to the 90-day window (§DP-8). */
    const prune = (cutoff: string) =>
      Effect.gen(function*() {
        // Keep the newest feed row even when it is older than the window: it is
        // the high-water marker that keeps `minSeq` non-empty, so a cursor that
        // predates the pruned window is still detected as stale.
        yield* sql`
          DELETE FROM change_feed
          WHERE updated_at < ${cutoff}
            AND seq < (SELECT MAX(seq) FROM change_feed)
        `
        yield* sql`DELETE FROM applied_mutations WHERE created_at < ${cutoff}`
      })

    /**
     * The entity write: insert, or a compare-and-set update on the row version.
     *
     * The `changes()` gate on the two statements that follow is what makes the
     * CAS real inside a D1 batch: SQLite's `changes()` is the row count of the
     * preceding statement, so when another writer wins between our pre-read and
     * this batch, nothing is appended to the feed and nothing is recorded in
     * `applied_mutations`. The service then treats the entry as contended and
     * asks the client to retry (the retry re-resolves against fresh state).
     */
    const writeEntity = ({ state, expectedVersion }: EntityWrite): Statement.Statement<unknown> => {
      const def = registry.get(state.entityType)
      if (def === undefined) {
        throw new Error(`sync entity type is not registered: ${state.entityType}`)
      }
      return expectedVersion === null ? def.insert(state) : def.update(state, expectedVersion)
    }

    /**
     * The statements that maintain a derived index next to the row (the note
     * search index, #41).
     *
     * They belong to the **same batch** as the entity write and run right
     * after it: every one of them is gated on the row reaching the version
     * this write stamped, so a lost compare-and-set leaves the index
     * describing the row that is actually stored.
     */
    const indexStatements = (
      state: SyncEntityState
    ): ReadonlyArray<Statement.Statement<unknown>> => {
      const def = registry.get(state.entityType)
      return def?.index?.(state) ?? []
    }

    /**
     * Append the feed row, but only if the entity write above changed a row.
     * Must run immediately before `recordApplied`.
     */
    const appendFeed = (entry: FeedWrite): Statement.Statement<unknown> =>
      sql`
        INSERT INTO change_feed
          (household_id, entity_type, entity_id, op, version, updated_at, owner_id, visibility)
        SELECT ${entry.householdId}, ${entry.entityType}, ${entry.entityId}, ${entry.op},
               ${entry.version}, ${entry.updatedAt}, ${entry.ownerId}, ${entry.visibility}
        WHERE changes() = 1
      `

    /**
     * Dedupe row; `last_insert_rowid()` is the feed seq appended just above.
     * Gated the same way, so a CAS miss records nothing at all.
     */
    const recordApplied = (entry: AppliedWrite): Statement.Statement<unknown> =>
      sql`
        INSERT OR IGNORE INTO applied_mutations
          (client_mutation_id, household_id, entity_type, entity_id, server_version, seq, created_at)
        SELECT ${entry.clientMutationId}, ${entry.householdId}, ${entry.entityType},
               ${entry.entityId}, ${entry.version}, last_insert_rowid(), ${entry.createdAt}
        WHERE changes() = 1
      `

    const commit = (statements: ReadonlyArray<Statement.Statement<unknown>>) =>
      statements.length === 0 ? Effect.succeed([]) : d1.batch(statements)

    return {
      definition,
      findEntities,
      findApplied,
      pullFeed,
      bootstrapPage,
      bootstrapEntities,
      minSeq,
      maxSeq,
      prune,
      writeEntity,
      indexStatements,
      appendFeed,
      recordApplied,
      commit
    } as const
  })
}) {}

export const SyncRepoLive = Layer.effect(SyncRepo, SyncRepo.make)
