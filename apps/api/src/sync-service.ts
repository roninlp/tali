import { Context, Data, DateTime, Effect, Layer, Option, Schema } from "effect"
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

    const entityTypeOf = (entityType: SyncEntityType) => repo.definition(entityType)

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
        const statements: Array<ReturnType<typeof repo.writeEntity>> = []
        const now = new Date().toISOString()

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

        const write = (
          entry: PushEntry,
          state: SyncEntityState,
          expectedVersion: number | null,
          op: "upsert" | "delete",
          tag: WriteTag
        ) => {
          statements.push(repo.writeEntity({ state, expectedVersion }))
          statements.push(repo.appendFeed({
            householdId: input.householdId,
            entityType: state.entityType,
            entityId: state.entityId,
            op,
            version: state.version,
            updatedAt: state.updatedAt,
            ownerId: state.ownerId,
            visibility: state.visibility
          }))
          statements.push(repo.recordApplied({
            clientMutationId: entry.clientMutationId,
            householdId: input.householdId,
            entityType: state.entityType,
            entityId: state.entityId,
            version: state.version,
            createdAt: now
          }))
          planned.set(entityKey(state), state)
          plans.push({ kind: "write", entry, tag, state })
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
            write(entry, state, current.version, "delete", "applied")
            continue
          }

          if (current === undefined) {
            const data = yield* insertData(definition, entry, patch)
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
            const data = yield* validate(
              definition,
              merged,
              { version: current.version + 1, updatedAt: now, deletedAt: null },
              entry
            )
            const visibility = asVisibility(data.visibility ?? current.visibility)
            const state: SyncEntityState = {
              ...current,
              householdId: input.householdId,
              visibility,
              data: { ...data, ownerId: current.ownerId, visibility },
              version: current.version + 1,
              updatedAt: now
            }
            write(entry, state, current.version, "upsert", "applied")
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
          const data = yield* validate(
            definition,
            merged,
            { version: current.version + 1, updatedAt: now, deletedAt: null },
            entry
          )
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
          write(entry, state, current.version, "upsert", "conflict")
        }

        yield* repo.commit(statements).pipe(Effect.orDie)

        const writes = plans.filter(
          (plan): plan is Extract<Plan, { readonly kind: "write" }> => plan.kind === "write"
        )
        const applied = yield* repo
          .findApplied({
            householdId: input.householdId,
            clientMutationIds: writes.map((plan) => plan.entry.clientMutationId)
          })
          .pipe(Effect.orDie)
        // The gated CAS writes nothing when a concurrent writer won, so a
        // missing ledger row means this entry did not apply. Failing the whole
        // request is safe and never silently drops the client's edit: the
        // client keeps its outbox and retries, and already-applied entries
        // dedupe. See `writeEntity`/`appendFeed` in `sync-repo.ts`.
        const contended = writes.filter(
          (plan) => !applied.has(plan.entry.clientMutationId)
        )
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

        const cursor = results.reduce((max, result) => Math.max(max, result.seq), 0)
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
