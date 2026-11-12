import { Effect, Option } from 'effect'
import { SqlError } from 'effect/sql'
import type { Statement } from 'effect/sql'
import type { SyncEntityType, Visibility } from '@tali/domain'
import type {
  AppliedMutation,
  AppliedWrite,
  EntityWrite,
  FeedWrite,
  SyncEntityDefinition,
  SyncEntityState,
} from '@tali/sql'

/**
 * The sync write kit — one mutation, one `D1Client.batch()`.
 *
 * Seven services (event, reminder, occasion, habit, list, note, task) each
 * carried a private copy of the same five steps:
 *
 * 1. validate a service-built aggregate through the registry's `validate`
 *    boundary, so a row written here can never be a shape a `/sync/pull` would
 *    reject (`stateOf`);
 * 2. read the replay ledger for the mutation id(s) (`appliedMutation`);
 * 3. refuse a mutation id already spent on a *different* row or aggregate
 *    before writing anything (`reusedMutationId`);
 * 4. build `writeEntity + appendFeed + recordApplied + index + extra`
 *    statements (`entryStatements`);
 * 5. commit, then re-read the ledger to learn which ids actually landed
 *    (`commitEntries`).
 *
 * Step 4 is where the copies had drifted: only `note` and `reminder` appended
 * the registry's `indexStatements`, so any hook on another aggregate (or a new
 * one) would have been silently skipped by the service path. The kit always
 * asks the registry.
 *
 * The gating rules it preserves are the ones the primitives document: the feed
 * row is appended only when the entity write changed a row (`changes() = 1`),
 * the ledger row is gated on the feed append (its `seq` is the feed row just
 * written), and an `insert` override exists for a row whose gate is another row
 * in the same batch (a split's new tail, a recurrence successor).
 */

/** The service-shaped subset of `SyncRepo` this kit needs. */
export interface SyncWriteRepo {
  readonly definition: (
    entityType: SyncEntityType,
  ) => SyncEntityDefinition | undefined
  readonly findApplied: (input: {
    readonly householdId: string
    readonly clientMutationIds: ReadonlyArray<string>
  }) => Effect.Effect<ReadonlyMap<string, AppliedMutation>, SqlError.SqlError>
  readonly writeEntity: (input: EntityWrite) => Statement.Statement<unknown>
  readonly indexStatements: (
    state: SyncEntityState,
  ) => ReadonlyArray<Statement.Statement<unknown>>
  readonly appendFeed: (entry: FeedWrite) => Statement.Statement<unknown>
  readonly recordApplied: (entry: AppliedWrite) => Statement.Statement<unknown>
  readonly commit: (
    statements: ReadonlyArray<Statement.Statement<unknown>>,
  ) => Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>
}

export interface SyncKitConfig<E> {
  readonly sync: SyncWriteRepo
  /** The service's own validation failure, for the shared reuse refusal. */
  readonly invalid: (field: string, message: string) => Effect.Effect<never, E>
}

/** The fields every aggregate row shares with `SyncEntityState`. */
export interface SyncAggregateRow {
  readonly id: string
  readonly householdId: string | null
  readonly ownerId: string
  readonly visibility: Visibility
  readonly version: number
  readonly updatedAt: string
  readonly deletedAt: string | null
}

/** How a service row becomes the registry's payload. */
export interface StateShape<A> {
  /**
   * The wire payload handed to `validate`, when the row is not already it (the
   * `listItem` legacy vocabulary carries `title`/`checked`/`sortOrder` too).
   */
  readonly encode?: (row: A) => Record<string, unknown>
  /**
   * Trusted data the service owns beyond the aggregate, added **after**
   * validation (the list's server-stamped `lastWriterId`).
   */
  readonly decorate?: (data: Record<string, unknown>) => Record<string, unknown>
}

/**
 * The ledger role of one written row.
 *
 * - `client` (default) — the row is the mutation: a prior ledger row for the id
 *   that names another row is a reuse conflict.
 * - `derived` — the ledger key is server-minted (a recurrence successor's
 *   `recurrence:<parentId>`). A prior row is not a conflict: the successor
 *   insert is already exactly-once through its unique parent index.
 * - `none` — the row is written by the mutation but is not its replay key (the
 *   occasion a "prepare gift" task is linked from).
 */
export type LedgerMode = 'client' | 'derived' | 'none'

export interface CommitEntry {
  readonly state: SyncEntityState
  /** `null` inserts; otherwise the version this write is conditioned on. */
  readonly expectedVersion: number | null
  readonly clientMutationId: string
  readonly op?: 'upsert' | 'delete'
  /**
   * A gated insert for a row that must not land unless another row in the same
   * batch did. Defaults to the registry's plain insert/update.
   */
  readonly insert?: (state: SyncEntityState) => Statement.Statement<unknown>
  /** Statements that ride the same batch after the index statements. */
  readonly extra?: (
    state: SyncEntityState,
  ) => ReadonlyArray<Statement.Statement<unknown>>
  readonly ledger?: LedgerMode
}

export interface CommitInput {
  readonly householdId: string
  readonly entries: ReadonlyArray<CommitEntry>
  readonly now: string
  /**
   * Skip the entries the ledger already has, instead of re-issuing their
   * (CAS-gated, therefore no-op) statements. The applied set still reports
   * them, so a replay reads exactly like the original call.
   */
  readonly skipApplied?: boolean
}

export interface CommitOneInput {
  readonly householdId: string
  readonly state: SyncEntityState
  readonly expectedVersion: number | null
  readonly clientMutationId: string
  readonly now: string
  readonly op?: 'upsert' | 'delete'
  readonly extra?: (
    state: SyncEntityState,
  ) => ReadonlyArray<Statement.Statement<unknown>>
}

export const makeSyncKit = <E>(config: SyncKitConfig<E>) => {
  const { sync, invalid } = config

  /** The prior ledger rows for these ids, one read per commit. */
  const priorOf = (householdId: string, ids: ReadonlyArray<string>) =>
    sync.findApplied({ householdId, clientMutationIds: ids }).pipe(Effect.orDie)

  /** The registry's definition, or a defect: an unregistered type is a bug. */
  const definition = (entityType: SyncEntityType): SyncEntityDefinition => {
    const def = sync.definition(entityType)
    if (def === undefined) {
      throw new Error(`sync entity type is not registered: ${entityType}`)
    }
    return def
  }

  /**
   * The registry's trusted write state for a validated aggregate. The
   * `validate` boundary is the one the sync push uses, so a service write can
   * never put a shape on the wire that a pull would reject.
   */
  const stateOf = <A extends SyncAggregateRow>(
    entityType: SyncEntityType,
    row: A,
    shape: StateShape<A> = {},
  ): SyncEntityState => {
    const def = definition(entityType)
    const validated = def.validate(
      shape.encode === undefined
        ? ({ ...row } as Record<string, unknown>)
        : shape.encode(row),
      {
        version: row.version,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
      },
    )
    return {
      entityType,
      entityId: row.id,
      householdId: row.householdId,
      ownerId: row.ownerId,
      visibility: row.visibility,
      version: row.version,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      data:
        shape.decorate === undefined ? validated : shape.decorate(validated),
    }
  }

  /** The ledger row for one mutation id, if this household already applied it. */
  const appliedMutation = (
    householdId: string,
    clientMutationId: string,
  ): Effect.Effect<Option.Option<AppliedMutation>> =>
    Effect.map(priorOf(householdId, [clientMutationId]), applied =>
      Option.fromUndefinedOr(applied.get(clientMutationId)),
    )

  /** A mutation id may not be reused for a different row or aggregate. */
  const reusedMutationId = (
    row: { readonly entityType: SyncEntityType; readonly entityId: string },
    expected: { readonly entityType: SyncEntityType; readonly id?: string },
  ): boolean =>
    row.entityType !== expected.entityType ||
    (expected.id !== undefined && row.entityId !== expected.id)

  const reusedMutationIdError = (_id: string) =>
    invalid(
      'clientMutationId',
      'this mutation id was already applied to a different change',
    )

  /**
   * The statements for a set of entries, in batch order.
   *
   * Exposed on its own for a caller that composes this mutation into a larger
   * hand-built batch (the reminder response writes the answer, the linked task
   * and a snooze child in one commit). Such a caller owns the ledger pre-check.
   */
  const entryStatements = (input: {
    readonly householdId: string
    readonly entries: ReadonlyArray<CommitEntry>
    readonly now: string
  }): ReadonlyArray<Statement.Statement<unknown>> =>
    input.entries.flatMap(entry => [
      entry.insert === undefined
        ? sync.writeEntity({
            state: entry.state,
            expectedVersion: entry.expectedVersion,
          })
        : entry.insert(entry.state),
      sync.appendFeed({
        householdId: input.householdId,
        entityType: entry.state.entityType,
        entityId: entry.state.entityId,
        op: entry.op ?? 'upsert',
        version: entry.state.version,
        updatedAt: entry.state.updatedAt,
        ownerId: entry.state.ownerId,
        visibility: entry.state.visibility,
      }),
      // The ledger row must directly follow its own feed append: its `seq` is
      // `last_insert_rowid()`, and its own write is gated on `changes() = 1`
      // (the feed statement) so a lost CAS records nothing at all.
      ...((entry.ledger ?? 'client') === 'none'
        ? []
        : [
            sync.recordApplied({
              clientMutationId: entry.clientMutationId,
              householdId: input.householdId,
              entityType: entry.state.entityType,
              entityId: entry.state.entityId,
              version: entry.state.version,
              createdAt: input.now,
            }),
          ]),
      ...sync.indexStatements(entry.state),
      ...(entry.extra?.(entry.state) ?? []),
    ])

  /**
   * Check the batch refusals and decide which entries still need statements.
   *
   * A mutation id is one mutation for its whole retention window. If the ledger
   * already maps it to a different row/aggregate, `recordApplied` would be an
   * `INSERT OR IGNORE` no-op: the write would land with no replay guard, so a
   * retry would apply it twice and `applied` would report success even when the
   * CAS lost. Refuse before writing.
   */
  const plan = (
    input: CommitInput,
  ): Effect.Effect<
    {
      readonly ids: ReadonlyArray<string>
      readonly entries: ReadonlyArray<CommitEntry>
    },
    E
  > =>
    Effect.gen(function* () {
      const ids = input.entries.map(entry => entry.clientMutationId)
      if (new Set(ids).size !== ids.length) {
        return yield* invalid(
          'clientMutationId',
          'a split needs two distinct mutation ids',
        )
      }
      const prior = yield* priorOf(input.householdId, ids)
      for (const entry of input.entries) {
        if ((entry.ledger ?? 'client') !== 'client') continue
        const row = Option.fromUndefinedOr(prior.get(entry.clientMutationId))
        if (
          Option.isSome(row) &&
          reusedMutationId(row.value, {
            entityType: entry.state.entityType,
            id: entry.state.entityId,
          })
        ) {
          return yield* reusedMutationIdError(entry.state.entityId)
        }
      }
      return {
        ids,
        entries:
          input.skipApplied === true
            ? input.entries.filter(entry => !prior.has(entry.clientMutationId))
            : input.entries,
      }
    })

  /** Which of this batch's mutation ids the ledger now records. */
  const appliedIds = (
    householdId: string,
    ids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlySet<string>> =>
    Effect.map(priorOf(householdId, ids), applied => new Set(applied.keys()))

  const statementsFor = (
    input: CommitInput,
    entries: ReadonlyArray<CommitEntry>,
  ) =>
    entryStatements({
      householdId: input.householdId,
      entries,
      now: input.now,
    })

  /**
   * The base commit: one mutation (or a split's pair of mutations), each CAS
   * entity write with its gated feed append, gated ledger row and registry
   * index statements, all in one D1 batch. Returns the mutation ids the ledger
   * now records, i.e. the writes that won their gate. The repository failure
   * stays typed.
   *
   * The task service maps a `SqlError` from the tag unique index onto a field
   * validation error; every other service treats a batch failure as a defect
   * (`commitEntries`).
   */
  const tryCommitEntries = (
    input: CommitInput,
  ): Effect.Effect<ReadonlySet<string>, E | SqlError.SqlError> =>
    Effect.gen(function* () {
      const planned = yield* plan(input)
      yield* sync.commit(statementsFor(input, planned.entries))
      return yield* appliedIds(input.householdId, planned.ids)
    })

  /**
   * `tryCommitEntries` with the repository failure made a defect: every service
   * but the task one treats a failed batch as unexpected, so only the service's
   * own typed failures propagate.
   */
  const commitEntries = (
    input: CommitInput,
  ): Effect.Effect<ReadonlySet<string>, E> =>
    tryCommitEntries(input).pipe(
      Effect.catchIf(SqlError.isSqlError, error => Effect.die(error)),
    )

  /** The single-row case of `commitEntries`. */
  const commitOne = (input: CommitOneInput): Effect.Effect<boolean, E> =>
    Effect.map(
      commitEntries({
        householdId: input.householdId,
        now: input.now,
        entries: [
          {
            state: input.state,
            expectedVersion: input.expectedVersion,
            clientMutationId: input.clientMutationId,
            op: input.op,
            extra: input.extra,
          },
        ],
      }),
      applied => applied.has(input.clientMutationId),
    )

  return {
    definition,
    stateOf,
    appliedMutation,
    reusedMutationId,
    reusedMutationIdError,
    entryStatements,
    commitEntries,
    tryCommitEntries,
    commitOne,
  } as const
}
