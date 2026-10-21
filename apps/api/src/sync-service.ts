import { Context, Data, DateTime, Effect, Layer, Option, Schema } from "effect"
import type { Statement } from "effect/sql"
import {
  type ChangeFeedEntry,
  type SyncBootstrapResponse,
  type SyncEntityRow,
  type SyncEntityType,
  type SyncPullResponse,
  SyncPushEntry,
  type SyncPushResponse,
  type SyncPushResult,
  type Visibility
} from "@tali/domain"
import {
  entityKey,
  SyncRepo,
  SyncRepoLive,
  type AppliedMutation,
  type FeedRow,
  type SyncEntityDefinition,
  type SyncEntityMeta,
  type SyncEntityState
} from "@tali/sql"

/**
 * The server-side sync engine (tickets #18, #34, `docs/sync-protocol-draft.md`).
 *
 * Pull reads the household-scoped `change_feed` and hydrates the latest row
 * state; push dedupes, resolves conflicts field-by-field (tombstone →
 * delete-wins → done-wins → LWW), and commits every write in one D1 batch.
 * A constraint failure is attributed to entry groups by bounded recursive
 * bisection (`MAX_ISOLATION_BATCHES`), never a linear per-entry sweep.
 * The server is the single resolver: clients adopt the returned row.
 *
 * Which aggregates sync, their tables, writable-field allowlists and hydration
 * schemas live in the registry (`packages/sql/src/sync-registry.ts`). This
 * service only drives the protocol and stays aggregate-agnostic.
 */

const FEED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const DEFAULT_PULL_LIMIT = 500
const MAX_PULL_LIMIT = 1000
const MAX_PUSH_ENTRIES = 200

/**
 * Hard ceiling on the D1 batches one push may issue, including its first
 * (happy-path) attempt, while attributing a constraint failure to entry
 * groups. Recursive bisection needs ~18 batches to find one bad entry among
 * `MAX_PUSH_ENTRIES` and ~31 for two; a linear per-entry sweep would need up
 * to 201 and turn into a retryable 500 under Workers/D1 limits. At the cap the
 * unattempted groups are returned as `rejected` with `AttributionLimit` so the
 * client acks them instead of resending the chunk forever.
 */
export const MAX_ISOLATION_BATCHES = 32

export class UnsupportedSyncEntity extends Data.TaggedError("UnsupportedSyncEntity")<{
  readonly entityType: string
}> {}

export class SyncPayloadTooLarge extends Data.TaggedError("SyncPayloadTooLarge")<{
  readonly count: number
}> {}

export class SyncEntityForbidden extends Data.TaggedError("SyncEntityForbidden")<{
  readonly entityId: string
}> {}

/** A patch that the aggregate's schema rejects (wrong type/shape for its fields). */
export class SyncInvalidPatch extends Data.TaggedError("SyncInvalidPatch")<{
  readonly entityType: string
  readonly entityId: string
}> {}

/**
 * Another writer won the version race between our pre-read and our batch. The
 * gated CAS wrote nothing for the losing entries, so the client can retry the
 * push; every entry that did land is deduped by `clientMutationId`.
 */
export class SyncContended extends Data.TaggedError("SyncContended")<{
  readonly count: number
}> {}

export type SyncServiceError =
  | UnsupportedSyncEntity
  | SyncPayloadTooLarge
  | SyncEntityForbidden
  | SyncInvalidPatch
  | SyncContended

type DecodedPushEntry = Schema.Schema.Type<typeof SyncPushEntry>

/**
 * The service accepts both the decoded wire value (an Effect `DateTime`) and
 * the encoded ISO string the test harness/replay path uses.
 */
type PushEntry = Omit<DecodedPushEntry, "clientUpdatedAt"> & {
  readonly clientUpdatedAt: DecodedPushEntry["clientUpdatedAt"] | string
}

const asIso = (value: DecodedPushEntry["clientUpdatedAt"] | string): string =>
  typeof value === "string" ? value : DateTime.formatIso(value)

type WriteTag = "applied" | "conflict"

type Plan =
  | {
    readonly kind: "dedupe"
    readonly entry: PushEntry
    readonly mutation: AppliedMutation
  }
  | {
    readonly kind: "nowrite"
    readonly entry: PushEntry
    readonly tag: "conflict" | "tombstone"
    readonly state: SyncEntityState
  }
  | {
    readonly kind: "write"
    readonly entry: PushEntry
    readonly tag: WriteTag
    readonly state: SyncEntityState
    /** Index into the planned write groups (statements are applied per group). */
    readonly group: number
  }
  | {
    readonly kind: "rejected"
    readonly entry: PushEntry
    readonly code: string
    readonly message: string
  }

/** A non-retryable per-entry failure surfaced as `_tag: "rejected"`. */
interface ConstraintFailure {
  readonly code: string
  readonly message: string
}

/**
 * The stable code for an entry the server can never apply as written. The raw
 * SQLite message is kept for diagnosis; the code is what clients branch on.
 */
const CONSTRAINT_CODES: ReadonlyArray<readonly [RegExp, string]> = [
  [/UNIQUE constraint failed/i, "UniqueViolation"],
  [/FOREIGN KEY constraint failed/i, "ForeignKeyViolation"],
  [/NOT NULL constraint failed/i, "NotNullViolation"],
  [/CHECK constraint failed/i, "CheckViolation"],
  [/constraint failed/i, "ConstraintViolation"]
]

/**
 * D1 and the driver wrap SQLite failures differently (`SqlError` → reason →
 * native cause), so collect messages/codes down the whole cause chain rather
 * than matching only the top-level error.
 */
const errorTexts = (error: unknown, seen = new Set<unknown>()): ReadonlyArray<string> => {
  if (error === null || error === undefined) return []
  if (typeof error === "string") return [error]
  if (typeof error !== "object" || seen.has(error)) return []
  seen.add(error)
  const record = error as Record<string, unknown>
  const texts: Array<string> = []
  for (const key of ["message", "code", "errstr"]) {
    const value = record[key]
    if (typeof value === "string") texts.push(value)
  }
  for (const key of ["cause", "reason", "error"]) {
    texts.push(...errorTexts(record[key], seen))
  }
  return texts
}

/** `undefined` means "not a constraint failure" — keep today's retryable path. */
const constraintFailureOf = (error: unknown): ConstraintFailure | undefined => {
  const texts = errorTexts(error)
  if (texts.length === 0) return undefined
  const joined = texts.join("\n")
  for (const [pattern, code] of CONSTRAINT_CODES) {
    if (!pattern.test(joined)) continue
    const detail = texts.find((text) => pattern.test(text)) ?? joined
    return { code, message: detail.slice(0, 500) }
  }
  return undefined
}

/**
 * Parents before children inside one batch, so the common offline "create a
 * project/tag/list and its dependent row together" push succeeds without a
 * retry. `Array.prototype.sort` is stable, so entries for the same entity keep
 * their FIFO order.
 */
const dependencyRank = (entityType: SyncEntityType): number => {
  switch (entityType) {
    case "project":
    case "tag":
    case "list":
      return 0
    case "task":
    case "note":
    case "listItem":
      return 1
    default:
      return 1
  }
}

const asVisibility = (value: unknown): Visibility =>
  value === "private" ? "private" : "shared"

const toRow = (state: SyncEntityState): SyncEntityRow => ({
  entityType: state.entityType,
  entityId: state.entityId,
  version: state.version,
  updatedAt: state.updatedAt,
  deletedAt: state.deletedAt,
  data: state.data
})

const sameData = (
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Allowlist the patch against the registry's writable fields, dropping unknown
 * keys and values that fail a field guard. Client field names are never
 * interpolated into SQL — the registry maps them to trusted columns.
 *
 * `createdAt` is insert-only: a client may preserve its original creation time
 * when replaying an offline insert, but it can never rewrite it later.
 */
const sanitizePatch = (
  definition: SyncEntityDefinition,
  patch: Record<string, unknown>,
  options: { readonly allowCreatedAt: boolean }
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [field, guard] of definition.writable) {
    const value = patch[field]
    if (value !== undefined && guard(value)) out[field] = value
  }
  if (options.allowCreatedAt && typeof patch.createdAt === "string") {
    out.createdAt = patch.createdAt
  }
  return out
}

export class SyncService extends Context.Service<SyncService>()("SyncService", {
  make: Effect.gen(function*() {
    const repo = yield* SyncRepo

    /**
     * One entry's write, always exactly three statements: entity write, gated
     * feed append, gated ledger row. Grouping them lets the failure path retry
     * one entry at a time without ever splitting the exactly-once triple.
     */
    type WriteStatement = ReturnType<typeof repo.writeEntity>
    interface WriteGroup {
      readonly index: number
      readonly entry: PushEntry
      readonly state: SyncEntityState
      readonly expectedVersion: number | null
      readonly statements: ReadonlyArray<WriteStatement>
    }

    const entityTypeOf = (entityType: SyncEntityType) => repo.definition(entityType)

    /**
     * Commit a statement sequence, distinguishing a SQLite constraint failure
     * (the caller isolates it per entry) from a transient/infra failure (which
     * stays retryable exactly as before).
     */
    const commitOrConstraint = (statements: ReadonlyArray<WriteStatement>) =>
      repo.commit(statements).pipe(
        Effect.map(() => undefined as ConstraintFailure | undefined),
        Effect.catchTag("SqlError", (error) => {
          const constraint = constraintFailureOf(error)
          return constraint === undefined ? Effect.die(error) : Effect.succeed(constraint)
        })
      )

    const push = (input: {
      readonly userId: string
      readonly householdId: string
      readonly entries: ReadonlyArray<PushEntry>
    }): Effect.Effect<SyncPushResponse, SyncServiceError> =>
      Effect.gen(function*() {
        if (input.entries.length > MAX_PUSH_ENTRIES) {
          return yield* Effect.fail(new SyncPayloadTooLarge({ count: input.entries.length }))
        }
        for (const entry of input.entries) {
          if (entityTypeOf(entry.entityType) === undefined) {
            return yield* Effect.fail(new UnsupportedSyncEntity({ entityType: entry.entityType }))
          }
        }

        const deduped = yield* repo
          .findApplied({
            householdId: input.householdId,
            clientMutationIds: input.entries.map((entry) => entry.clientMutationId)
          })
          .pipe(Effect.orDie)
        const states = yield* repo
          .findEntities(input.entries.map((entry) => ({
            entityType: entry.entityType,
            entityId: entry.entityId
          })))
          .pipe(Effect.orDie)
        const planned = new Map(states)
        const plans: Array<Plan> = []
        const groups: Array<WriteGroup> = []
        const now = new Date().toISOString()

        const reject = (entry: PushEntry, code: string, message: string) => {
          plans.push({ kind: "rejected", entry, code, message })
        }

        /** Strict decode boundary for client-authored data. */
        const validate = (
          definition: SyncEntityDefinition,
          data: Record<string, unknown>,
          meta: SyncEntityMeta,
          entry: PushEntry
        ): Effect.Effect<Record<string, unknown>, SyncInvalidPatch> =>
          Effect.flatMap(
            Effect.sync(() => {
              try {
                return { ok: true as const, data: definition.validate(data, meta) }
              } catch (error) {
                return { ok: false as const, error }
              }
            }),
            (result) =>
              result.ok
                ? Effect.succeed(result.data)
                : Schema.isSchemaError(result.error)
                ? Effect.fail(
                  new SyncInvalidPatch({
                    entityType: entry.entityType,
                    entityId: entry.entityId
                  })
                )
                : Effect.die(result.error)
          )

        /**
         * An invalid patch is this entry's problem, not the request's: the
         * other entries in the push still apply and this one is rejected.
         */
        const validateEntry = (
          definition: SyncEntityDefinition,
          data: Record<string, unknown>,
          meta: SyncEntityMeta,
          entry: PushEntry
        ) =>
          validate(definition, data, meta, entry).pipe(
            Effect.map(Option.some),
            Effect.catchTag("SyncInvalidPatch", () => Effect.succeed(Option.none()))
          )

        const write = (
          entry: PushEntry,
          inputState: SyncEntityState,
          expectedVersion: number | null,
          op: "upsert" | "delete",
          tag: WriteTag,
          previous?: SyncEntityState
        ) => {
          // Server-stamped attribution for the list "updated by" label (#39).
          // Only the list aggregates carry the column; other entities ignore
          // the extra data field.
          const state: SyncEntityState =
            inputState.entityType === "list" || inputState.entityType === "listItem"
              ? {
                ...inputState,
                data: { ...inputState.data, lastWriterId: input.userId }
              }
              : inputState
          const statements: Array<Statement.Statement<unknown>> = [
            repo.writeEntity({ state, expectedVersion }),
            repo.appendFeed({
              householdId: input.householdId,
              entityType: state.entityType,
              entityId: state.entityId,
              op,
              version: state.version,
              updatedAt: state.updatedAt,
              ownerId: state.ownerId,
              visibility: state.visibility
            }),
            repo.recordApplied({
              clientMutationId: entry.clientMutationId,
              householdId: input.householdId,
              entityType: state.entityType,
              entityId: state.entityId,
              version: state.version,
              createdAt: now
            })
          ]

          // A server-generated successor (task recurrence, #38) joins this
          // entry's batch. Its INSERT is gated on the parent write landing at
          // `state.version`; the child feed/ledger are gated on that INSERT
          // (`changes()`), so a lost CAS or an already-spawned series appends
          // nothing. The next `/sync/pull` delivers the child row normally.
          const definition = entityTypeOf(state.entityType)!
          const spawn = definition.spawn?.({ previous, next: state, now })
          if (spawn !== undefined) {
            statements.push(
              spawn.insert(spawn.state),
              repo.appendFeed({
                householdId: input.householdId,
                entityType: spawn.state.entityType,
                entityId: spawn.state.entityId,
                op: "upsert",
                version: spawn.state.version,
                updatedAt: spawn.state.updatedAt,
                ownerId: spawn.state.ownerId,
                visibility: spawn.state.visibility
              }),
              repo.recordApplied({
                clientMutationId: `recurrence:${spawn.parentId}`,
                householdId: input.householdId,
                entityType: spawn.state.entityType,
                entityId: spawn.state.entityId,
                version: spawn.state.version,
                createdAt: now
              }),
              ...(spawn.joins?.(spawn.state) ?? [])
            )
          }

          const group: WriteGroup = {
            index: groups.length,
            entry,
            state,
            expectedVersion,
            statements
          }
          groups.push(group)
          planned.set(entityKey(state), state)
          plans.push({ kind: "write", entry, tag, state, group: group.index })
        }

        /** Insert data for an offline create, validated against the aggregate. */
        const insertData = (
          definition: SyncEntityDefinition,
          entry: PushEntry,
          patch: Record<string, unknown>
        ): Effect.Effect<Record<string, unknown>, SyncInvalidPatch> =>
          Effect.gen(function*() {
            const raw = definition.defaults(patch, {
              entityId: entry.entityId,
              userId: input.userId,
              householdId: input.householdId,
              now,
              clientUpdatedAt: asIso(entry.clientUpdatedAt)
            })
            return yield* validate(
              definition,
              raw,
              { version: 1, updatedAt: now, deletedAt: null },
              entry
            )
          })

        for (const entry of input.entries) {
          const definition = entityTypeOf(entry.entityType)!
          const key = entityKey(entry)
          const mutation = deduped.get(entry.clientMutationId)
          if (mutation !== undefined) {
            plans.push({ kind: "dedupe", entry, mutation })
            continue
          }

          const current = planned.get(key)
          // Households are hard boundaries: a row in another household (or an
          // unclaimed pre-sync row with no household at all) is not writable.
          if (current !== undefined && current.householdId !== input.householdId) {
            return yield* Effect.fail(new SyncEntityForbidden({ entityId: entry.entityId }))
          }
          // Private rows are owner-only; shared rows are household-wide.
          if (
            current !== undefined && current.ownerId !== "" &&
            current.ownerId !== input.userId && current.visibility === "private"
          ) {
            return yield* Effect.fail(new SyncEntityForbidden({ entityId: entry.entityId }))
          }

          const patch = sanitizePatch(definition, entry.patch, { allowCreatedAt: true })
          const updatePatch = sanitizePatch(definition, entry.patch, { allowCreatedAt: false })

          if (entry.op === "delete") {
            if (current === undefined) {
              // A delete for a row the server never saw still needs a tombstone
              // so the other device learns the id is gone. It is not validated:
              // the delete-only patch may not satisfy the aggregate's schema.
              const raw = definition.defaults(patch, {
                entityId: entry.entityId,
                userId: input.userId,
                householdId: input.householdId,
                now,
                clientUpdatedAt: asIso(entry.clientUpdatedAt)
              })
              const visibility = asVisibility(raw.visibility)
              const state: SyncEntityState = {
                entityType: entry.entityType,
                entityId: entry.entityId,
                householdId: input.householdId,
                ownerId: input.userId,
                visibility,
                version: 1,
                updatedAt: now,
                deletedAt: now,
                data: { ...raw, ownerId: input.userId, visibility }
              }
              write(entry, state, null, "delete", "applied")
              continue
            }
            if (current.deletedAt !== null) {
              plans.push({ kind: "nowrite", entry, tag: "tombstone", state: current })
              continue
            }
            // Delete wins over a concurrent edit; the edit stays recoverable
            // from trash because this is a soft delete (§6.1/CC-03).
            const state: SyncEntityState = {
              ...current,
              householdId: input.householdId,
              version: current.version + 1,
              updatedAt: now,
              deletedAt: now
            }
            write(entry, state, current.version, "delete", "applied", current)
            continue
          }

          if (current === undefined) {
            const inserted = yield* Effect.option(insertData(definition, entry, patch))
            if (Option.isNone(inserted)) {
              reject(entry, "InvalidPatch", "The patch does not match this entity")
              continue
            }
            const data = inserted.value
            const visibility = asVisibility(data.visibility)
            const state: SyncEntityState = {
              entityType: entry.entityType,
              entityId: entry.entityId,
              householdId: input.householdId,
              ownerId: input.userId,
              visibility,
              version: 1,
              updatedAt: now,
              deletedAt: null,
              data: { ...data, ownerId: input.userId, visibility }
            }
            write(entry, state, null, "upsert", "applied")
            continue
          }

          // 1. Tombstone wins: an offline edit never resurrects a deleted row.
          if (current.deletedAt !== null) {
            plans.push({ kind: "nowrite", entry, tag: "tombstone", state: current })
            continue
          }

          // 2. Fast path: the client wrote against the version we hold.
          if (current.version === entry.baseVersion) {
            const merged = definition.merge({
              current: current.data,
              patch: updatePatch,
              incomingNewer: true,
              conflict: false,
              now
            })
            const validated = yield* validateEntry(
              definition,
              merged,
              { version: current.version + 1, updatedAt: now, deletedAt: null },
              entry
            )
            if (Option.isNone(validated)) {
              reject(entry, "InvalidPatch", "The patch does not match this entity")
              continue
            }
            const data = validated.value
            const visibility = asVisibility(data.visibility ?? current.visibility)
            const state: SyncEntityState = {
              ...current,
              householdId: input.householdId,
              visibility,
              data: { ...data, ownerId: current.ownerId, visibility },
              version: current.version + 1,
              updatedAt: now
            }
            write(entry, state, current.version, "upsert", "applied", current)
            continue
          }

          // 3. Conflict: field-level LWW on the fields in the patch, with
          // checklist done-wins / task completion as the settled exception
          // (§6.3/§6.5).
          const incomingNewer = Date.parse(asIso(entry.clientUpdatedAt)) > Date.parse(current.updatedAt)
          const merged = definition.merge({
            current: current.data,
            patch: updatePatch,
            incomingNewer,
            conflict: true,
            now
          })
          const validated = yield* validateEntry(
            definition,
            merged,
            { version: current.version + 1, updatedAt: now, deletedAt: null },
            entry
          )
          if (Option.isNone(validated)) {
            reject(entry, "InvalidPatch", "The patch does not match this entity")
            continue
          }
          const data = validated.value
          const visibility = asVisibility(data.visibility ?? current.visibility)

          if (sameData(data, current.data) && visibility === current.visibility) {
            plans.push({ kind: "nowrite", entry, tag: "conflict", state: current })
            continue
          }
          const state: SyncEntityState = {
            ...current,
            householdId: input.householdId,
            visibility,
            data: { ...data, ownerId: current.ownerId, visibility },
            version: current.version + 1,
            updatedAt: now
          }
          write(entry, state, current.version, "upsert", "conflict", current)
        }

        // Parents before children (stable within a type), so a project/tag/list
        // created in the same push exists before the task/note/listItem that
        // references it. The happy path is still exactly one D1 batch.
        const orderedGroups = [...groups].sort(
          (a, b) => dependencyRank(a.state.entityType) - dependencyRank(b.state.entityType)
        )
        const rejectedGroups = new Map<number, ConstraintFailure>()
        let batchesUsed = 0

        const commit = (subset: ReadonlyArray<WriteGroup>) =>
          Effect.suspend(() => {
            batchesUsed += 1
            return commitOrConstraint(subset.flatMap((group) => group.statements))
          })

        /**
         * Attribute a failed batch by recursive bisection instead of a linear
         * per-entry sweep. `subset` is a contiguous range already known to
         * have failed a constraint; halves are attempted in order so a parent
         * half is always committed before a child half. A half that succeeds
         * is applied exactly once (the parent rolled back atomically); a half
         * that fails is split again, and a single group is attempted once:
         * its own constraint failure rejects it, while a non-constraint error
         * propagates as the request's retryable failure.
         *
         * The budget is a hard cap, not a hint: once `MAX_ISOLATION_BATCHES`
         * batches have run, the unattempted remainder is marked rejected with
         * `AttributionLimit` so an unlucky chunk can never wedge the outbox.
         */
        const attribute = (subset: ReadonlyArray<WriteGroup>): Effect.Effect<void> =>
          Effect.suspend(() => {
            if (batchesUsed >= MAX_ISOLATION_BATCHES) {
              const limit: ConstraintFailure = {
                code: "AttributionLimit",
                message:
                  `Isolation stopped after ${MAX_ISOLATION_BATCHES} batches; this entry could not be attributed`
              }
              for (const group of subset) rejectedGroups.set(group.index, limit)
              return Effect.void
            }
            if (subset.length === 1) {
              const group = subset[0]!
              return commit(subset).pipe(
                Effect.map((failure) => {
                  if (failure !== undefined) rejectedGroups.set(group.index, failure)
                })
              )
            }
            const mid = Math.floor(subset.length / 2)
            const halves = [subset.slice(0, mid), subset.slice(mid)]
            return Effect.forEach(
              halves,
              (half) =>
                Effect.suspend(() => {
                  if (batchesUsed >= MAX_ISOLATION_BATCHES) return attribute(half)
                  return commit(half).pipe(
                    Effect.flatMap((failure) =>
                      failure === undefined ? Effect.void : attribute(half)
                    )
                  )
                }),
              { discard: true }
            )
          })

        if (orderedGroups.length > 0) {
          const failure = yield* commit(orderedGroups)
          if (failure !== undefined) {
            // The batch rolled back atomically, so no group was applied twice.
            yield* attribute(orderedGroups)
          }
        }

        const writes = plans.filter(
          (plan): plan is Extract<Plan, { readonly kind: "write" }> =>
            plan.kind === "write" && !rejectedGroups.has(plan.group)
        )
        const applied = yield* repo
          .findApplied({
            householdId: input.householdId,
            clientMutationIds: writes.map((plan) => plan.entry.clientMutationId)
          })
          .pipe(Effect.orDie)

        // Two distinct "the write changed nothing" outcomes:
        // - an UPDATE gate missed because another writer won the CAS → retryable;
        // - an upsert INSERT with ON CONFLICT DO NOTHING no-oped because a live
        //   row already holds the unique key (e.g. a household tag name) → this
        //   entry can never apply as written, so reject it instead of looping.
        //
        // A `delete` for a row the server never saw is also an insert
        // (`expectedVersion: null`), but its no-op means the row *did* appear
        // after our pre-read. That converges on retry (the retry sees the live
        // row and applies the delete through the CAS), so it stays retryable;
        // rejecting it would drop the delete and resurrect the row on the next
        // pull.
        const contended: Array<Extract<Plan, { readonly kind: "write" }>> = []
        for (const plan of writes) {
          if (applied.has(plan.entry.clientMutationId)) continue
          const group = groups[plan.group]!
          if (group.expectedVersion === null && group.entry.op === "upsert") {
            rejectedGroups.set(plan.group, {
              code: "UniqueViolation",
              message: "Insert conflicted with a row that is already live"
            })
          } else {
            contended.push(plan)
          }
        }
        if (contended.length > 0) {
          return yield* Effect.fail(new SyncContended({ count: contended.length }))
        }

        const authoritative = yield* repo
          .findEntities(input.entries.map((entry) => ({
            entityType: entry.entityType,
            entityId: entry.entityId
          })))
          .pipe(Effect.orDie)

        const results: Array<SyncPushResult> = plans.map((plan) => {
          if (plan.kind === "rejected") {
            return {
              _tag: "rejected" as const,
              clientMutationId: plan.entry.clientMutationId,
              entityType: plan.entry.entityType,
              entityId: plan.entry.entityId,
              code: plan.code,
              message: plan.message
            }
          }
          if (plan.kind === "write") {
            const rejection = rejectedGroups.get(plan.group)
            if (rejection !== undefined) {
              return {
                _tag: "rejected" as const,
                clientMutationId: plan.entry.clientMutationId,
                entityType: plan.entry.entityType,
                entityId: plan.entry.entityId,
                code: rejection.code,
                message: rejection.message
              }
            }
          }
          const state = authoritative.get(entityKey(plan.entry)) ??
            (plan.kind === "dedupe" ? undefined : plan.state)
          const item = state === undefined || state.householdId !== input.householdId
            ? {}
            : { item: toRow(state) }
          if (plan.kind === "dedupe") {
            return {
              _tag: "alreadyApplied" as const,
              clientMutationId: plan.entry.clientMutationId,
              entityType: plan.entry.entityType,
              entityId: plan.entry.entityId,
              version: plan.mutation.version,
              seq: plan.mutation.seq,
              ...item
            }
          }
          const mutation = applied.get(plan.entry.clientMutationId)
          return {
            _tag: plan.tag,
            clientMutationId: plan.entry.clientMutationId,
            entityType: plan.entry.entityType,
            entityId: plan.entry.entityId,
            version: state?.version ?? plan.state.version,
            seq: mutation?.seq ?? 0,
            ...item
          }
        })

        const cursor = results.reduce(
          (max, result) => result._tag === "rejected" ? max : Math.max(max, result.seq),
          0
        )
        return { results, cursor }
      })

    const pull = (input: {
      readonly userId: string
      readonly householdId: string
      readonly cursor: number
      readonly limit?: number
    }): Effect.Effect<SyncPullResponse> =>
      Effect.gen(function*() {
        const limit = Math.min(Math.max(input.limit ?? DEFAULT_PULL_LIMIT, 1), MAX_PULL_LIMIT)
        const cutoff = new Date(Date.now() - FEED_RETENTION_MS).toISOString()
        yield* repo.prune(cutoff).pipe(Effect.orDie)

        // The feed can't serve entries between the cursor and the oldest
        // retained seq. Cursor 0 on an aged feed is stale too: fresh mirrors
        // re-bootstrap rather than silently missing live rows (§3.2/DP-8).
        const min = yield* repo.minSeq.pipe(Effect.orDie)
        const resetRequired = Option.isSome(min) && input.cursor < min.value - 1
        if (resetRequired) {
          return {
            entries: [],
            items: [],
            removed: [],
            nextCursor: input.cursor,
            hasMore: false,
            resetRequired: true
          }
        }

        const rows = yield* repo.pullFeed({
          householdId: input.householdId,
          cursor: input.cursor,
          limit
        }).pipe(Effect.orDie)
        const hasMore = rows.length > limit
        const page: ReadonlyArray<FeedRow> = hasMore ? rows.slice(0, limit) : rows
        const nextCursor = page.length > 0 ? page[page.length - 1]!.seq : input.cursor

        const states = yield* repo.findEntities(page.map((row) => ({
          entityType: row.entityType,
          entityId: row.entityId
        }))).pipe(Effect.orDie)
        const entries: Array<ChangeFeedEntry> = []
        const items: Array<SyncEntityRow> = []
        const removed: Array<{ entityType: SyncEntityType; entityId: string }> = []
        const removedKeys = new Set<string>()

        for (const row of page) {
          const state = states.get(entityKey(row))
          const householdMatches = state === undefined || state.householdId === input.householdId
          const visible = householdMatches &&
            (state === undefined
              // Hard-purged row: the feed entry still advances the cursor.
              ? row.ownerId === input.userId || asVisibility(row.visibility) === "shared"
              : state.ownerId === input.userId || state.visibility === "shared")

          if (visible) {
            entries.push({
              seq: row.seq,
              entityType: row.entityType,
              entityId: row.entityId,
              op: row.op,
              version: state?.version ?? row.version,
              updatedAt: state?.updatedAt ?? row.updatedAt,
              ownerId: state?.ownerId ?? row.ownerId,
              visibility: state?.visibility ?? asVisibility(row.visibility)
            })
            if (state !== undefined) items.push(toRow(state))
            continue
          }

          // DP-9: a spouse's visibility flip must reach this mirror as a
          // removal. It is not a delete and queues no mutation.
          const key = entityKey(row)
          if (!removedKeys.has(key)) {
            removedKeys.add(key)
            removed.push({ entityType: row.entityType, entityId: row.entityId })
          }
        }

        return { entries, items, removed, nextCursor, hasMore, resetRequired: false }
      })

    const bootstrap = (input: {
      readonly userId: string
      readonly householdId: string
      readonly offset?: number
      readonly limit?: number
    }): Effect.Effect<SyncBootstrapResponse> =>
      Effect.gen(function*() {
        const limit = Math.min(Math.max(input.limit ?? DEFAULT_PULL_LIMIT, 1), MAX_PULL_LIMIT)
        const offset = Math.max(input.offset ?? 0, 0)
        // Read the high-water cursor *before* the visible rows. A write that
        // lands during paging then has a `seq` above the cursor and is delivered
        // by the next incremental pull; reading it afterwards could skip a row
        // that the page did not include.
        const cursor = yield* repo.maxSeq.pipe(Effect.orDie)
        const refs = yield* repo.bootstrapPage({
          householdId: input.householdId,
          userId: input.userId,
          offset,
          limit
        }).pipe(Effect.orDie)
        const hasMore = refs.length > limit
        const page = hasMore ? refs.slice(0, limit) : refs
        const items = yield* repo.bootstrapEntities(page).pipe(Effect.orDie)
        return { items, nextOffset: offset + items.length, hasMore, cursor }
      })

    return { pull, bootstrap, push } as const
  })
}) {}

export const SyncServiceLive = Layer.effect(SyncService, SyncService.make).pipe(
  Layer.provide(SyncRepoLive)
)
