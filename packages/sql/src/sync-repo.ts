import { Context, Effect, Layer, Option } from "effect"
import { D1Client } from "@effect/sql-d1"
import { SqlClient, Statement } from "effect/sql"
import {
  type SyncEntityRow,
  type SyncEntityType,
  type SyncOp,
  type Visibility
} from "@tali/domain"

/**
 * D1-backed persistence for the sync engine (ticket #18).
 *
 * The pull list is `change_feed` (global `seq`); the conflict field is the
 * entity row's per-row `version` (session draft §2). Every push write is built
 * as a statement sequence the service applies in **one** `D1Client.batch()`,
 * because D1 has no interactive transactions.
 *
 * Only the dummy `listItem` aggregate is syncable in Slice 1. The branch is
 * deliberately explicit: adding an aggregate means adding its row adapter here,
 * not guessing at columns.
 */

const LIST_ITEM_COLUMNS =
  `id, title, checked, sort_order AS sortOrder, version, ` +
  `created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt, ` +
  `owner_id AS ownerId, visibility, household_id AS householdId`

interface ListItemRow {
  readonly id: string
  readonly title: string
  readonly checked: number | boolean
  readonly sortOrder: number
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly deletedAt: string | null
  readonly ownerId: string
  readonly visibility: string
  readonly householdId: string | null
}

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

export interface SyncEntityState {
  readonly entityType: SyncEntityType
  readonly entityId: string
  readonly householdId: string | null
  readonly ownerId: string
  readonly visibility: Visibility
  readonly version: number
  readonly updatedAt: string
  readonly deletedAt: string | null
  readonly data: Record<string, unknown>
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

const asVisibility = (value: string): Visibility =>
  value === "private" ? "private" : "shared"

const asBoolean = (value: number | boolean): boolean => value === true || value === 1

const toState = (row: ListItemRow): SyncEntityState => ({
  entityType: "listItem",
  entityId: row.id,
  householdId: row.householdId,
  ownerId: row.ownerId,
  visibility: asVisibility(row.visibility),
  version: row.version,
  updatedAt: row.updatedAt,
  deletedAt: row.deletedAt,
  data: {
    id: row.id,
    type: "listItem",
    title: row.title,
    checked: asBoolean(row.checked),
    sortOrder: row.sortOrder,
    ownerId: row.ownerId,
    visibility: asVisibility(row.visibility),
    createdAt: row.createdAt
  }
})

const toEntityRow = (row: ListItemRow): SyncEntityRow => {
  const state = toState(row)
  return {
    entityType: "listItem",
    entityId: row.id,
    version: row.version,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    data: state.data
  }
}

export class SyncRepo extends Context.Service<SyncRepo>()("SyncRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const d1 = yield* D1Client.D1Client

    /** Batch-hydrate the entity rows behind a set of feed entries. */
    const findEntities = (ids: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        const unique = [...new Set(ids)]
        if (unique.length === 0) return new Map<string, SyncEntityState>()
        const rows = yield* sql<ListItemRow>`
          SELECT ${sql.literal(LIST_ITEM_COLUMNS)} FROM list_items
          WHERE ${sql.in("id", unique)}
        `
        return new Map(rows.map((row) => [row.id, toState(row)]))
      })

    /** Dedupe pre-read: which of these mutation ids has the server already applied? */
    const findApplied = (clientMutationIds: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        const unique = [...new Set(clientMutationIds)]
        if (unique.length === 0) return new Map<string, AppliedMutation>()
        const rows = yield* sql<AppliedRow>`
          SELECT client_mutation_id AS clientMutationId, entity_type AS entityType,
                 entity_id AS entityId, server_version AS serverVersion, seq
          FROM applied_mutations
          WHERE ${sql.in("client_mutation_id", unique)}
        `
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

    /** All visible live rows for a fresh mirror / stale cursor (`/sync/bootstrap`). */
    const bootstrapPage = (input: {
      readonly householdId: string
      readonly userId: string
      readonly offset: number
      readonly limit: number
    }) =>
      Effect.gen(function*() {
        const rows = yield* sql<ListItemRow>`
          SELECT ${sql.literal(LIST_ITEM_COLUMNS)} FROM list_items
          WHERE household_id = ${input.householdId}
            AND deleted_at IS NULL
            AND (owner_id = ${input.userId} OR visibility = 'shared')
          ORDER BY updated_at ASC, id ASC
          LIMIT ${input.limit + 1} OFFSET ${input.offset}
        `
        return rows.map(toEntityRow)
      })

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
        yield* sql`DELETE FROM change_feed WHERE updated_at < ${cutoff}`
        yield* sql`DELETE FROM applied_mutations WHERE created_at < ${cutoff}`
      })

    /** The entity write: insert, or a compare-and-set update on the row version. */
    const writeEntity = ({ state, expectedVersion }: EntityWrite): Statement.Statement<unknown> => {
      if (expectedVersion === null) {
        return sql`
          INSERT INTO list_items
            (id, title, checked, sort_order, version, created_at, updated_at, deleted_at,
             owner_id, visibility, household_id)
          VALUES
            (${state.entityId}, ${String(state.data.title ?? "")},
             ${state.data.checked === true ? 1 : 0},
             ${typeof state.data.sortOrder === "number" ? state.data.sortOrder : 0},
             ${state.version}, ${String(state.data.createdAt ?? state.updatedAt)},
             ${state.updatedAt}, ${state.deletedAt}, ${state.ownerId},
             ${state.visibility}, ${state.householdId})
        `
      }
      return sql`
        UPDATE list_items SET
          title = ${String(state.data.title ?? "")},
          checked = ${state.data.checked === true ? 1 : 0},
          sort_order = ${typeof state.data.sortOrder === "number" ? state.data.sortOrder : 0},
          version = ${state.version},
          updated_at = ${state.updatedAt},
          deleted_at = ${state.deletedAt},
          visibility = ${state.visibility}
        WHERE id = ${state.entityId} AND version = ${expectedVersion}
      `
    }

    /** Append the feed row. Must run immediately before `recordApplied`. */
    const appendFeed = (entry: FeedWrite): Statement.Statement<unknown> =>
      sql`
        INSERT INTO change_feed
          (household_id, entity_type, entity_id, op, version, updated_at, owner_id, visibility)
        VALUES
          (${entry.householdId}, ${entry.entityType}, ${entry.entityId}, ${entry.op},
           ${entry.version}, ${entry.updatedAt}, ${entry.ownerId}, ${entry.visibility})
      `

    /** Dedupe row; `last_insert_rowid()` is the feed seq appended just above. */
    const recordApplied = (entry: AppliedWrite): Statement.Statement<unknown> =>
      sql`
        INSERT OR IGNORE INTO applied_mutations
          (client_mutation_id, household_id, entity_type, entity_id, server_version, seq, created_at)
        VALUES
          (${entry.clientMutationId}, ${entry.householdId}, ${entry.entityType},
           ${entry.entityId}, ${entry.version}, last_insert_rowid(), ${entry.createdAt})
      `

    const commit = (statements: ReadonlyArray<Statement.Statement<unknown>>) =>
      statements.length === 0 ? Effect.succeed([]) : d1.batch(statements)

    return {
      findEntities,
      findApplied,
      pullFeed,
      bootstrapPage,
      minSeq,
      maxSeq,
      prune,
      writeEntity,
      appendFeed,
      recordApplied,
      commit
    } as const
  })
}) {}

export const SyncRepoLive = Layer.effect(SyncRepo, SyncRepo.make)
