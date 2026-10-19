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
  SyncRepo,
  SyncRepoLive,
  type AppliedMutation,
  type FeedRow,
  type SyncEntityState
} from "@tali/sql"

/**
 * The server-side sync engine (ticket #18, `docs/sync-protocol-draft.md`).
 *
 * Pull reads the household-scoped `change_feed` and hydrates the latest row
 * state; push dedupes, resolves conflicts field-by-field (tombstone →
 * delete-wins → done-wins → LWW), and commits every write in one D1 batch.
 * The server is the single resolver: clients adopt the returned row.
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

const asEpoch = (value: DecodedPushEntry["clientUpdatedAt"] | string): number =>
  typeof value === "string" ? Date.parse(value) : DateTime.toDateUtc(value).getTime()

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

const asVisibility = (value: string): Visibility =>
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
): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

/** Only the dummy aggregate's writable fields cross the wire in Slice 1. */
const sanitizePatch = (
  patch: Record<string, unknown>
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  if (typeof patch.title === "string") out.title = patch.title
  if (typeof patch.checked === "boolean") out.checked = patch.checked
  if (typeof patch.sortOrder === "number" && Number.isFinite(patch.sortOrder)) {
    out.sortOrder = patch.sortOrder
  }
  if (patch.visibility === "private" || patch.visibility === "shared") {
    out.visibility = patch.visibility
  }
  return out
}

const insertData = (
  entityId: string,
  patch: Record<string, unknown>,
  ownerId: string,
  fallbackCreatedAt: string
): Record<string, unknown> => ({
  id: entityId,
  type: "listItem",
  title: typeof patch.title === "string" ? patch.title : "",
  checked: patch.checked === true,
  sortOrder: typeof patch.sortOrder === "number" ? patch.sortOrder : 0,
  ownerId,
  visibility: patch.visibility === "private" ? "private" : "shared",
  createdAt: typeof patch.createdAt === "string" ? patch.createdAt : fallbackCreatedAt
})

export class SyncService extends Context.Service<SyncService>()("SyncService", {
  make: Effect.gen(function*() {
    const repo = yield* SyncRepo

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

        const states = yield* repo.findEntities(page.map((row) => row.entityId)).pipe(Effect.orDie)
        const entries: Array<ChangeFeedEntry> = []
        const items: Array<SyncEntityRow> = []
        const removed: Array<{ entityType: SyncEntityType; entityId: string }> = []
        const removedKeys = new Set<string>()

        for (const row of page) {
          const state = states.get(row.entityId)
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
          const key = `${row.entityType}\u0000${row.entityId}`
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
        const rows = yield* repo.bootstrapPage({
          householdId: input.householdId,
          userId: input.userId,
          offset,
          limit
        }).pipe(Effect.orDie)
        const hasMore = rows.length > limit
        const items = hasMore ? rows.slice(0, limit) : rows
        return { items, nextOffset: offset + items.length, hasMore, cursor }
      })

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
          if (entry.entityType !== "listItem") {
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
          .findEntities(input.entries.map((entry) => entry.entityId))
          .pipe(Effect.orDie)
        const planned = new Map(states)
        const plans: Array<Plan> = []
        const statements: Array<ReturnType<typeof repo.writeEntity>> = []
        const now = new Date().toISOString()

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
          planned.set(state.entityId, state)
          plans.push({ kind: "write", entry, tag, state })
        }

        for (const entry of input.entries) {
          const mutation = deduped.get(entry.clientMutationId)
          if (mutation !== undefined) {
            plans.push({ kind: "dedupe", entry, mutation })
            continue
          }

          const current = planned.get(entry.entityId)
          // Households are hard boundaries: a row in another household (or an
          // unclaimed pre-sync row with no household at all) is not writable.
          if (current !== undefined && current.householdId !== input.householdId) {
            return yield* Effect.fail(new SyncEntityForbidden({ entityId: entry.entityId }))
          }
          if (
            current !== undefined && current.ownerId !== "" &&
            current.ownerId !== input.userId && current.visibility === "private"
          ) {
            return yield* Effect.fail(new SyncEntityForbidden({ entityId: entry.entityId }))
          }

          const patch = sanitizePatch(entry.patch)
          const rawPatch = entry.patch

          if (entry.op === "delete") {
            if (current === undefined) {
              const state: SyncEntityState = {
                entityType: "listItem",
                entityId: entry.entityId,
                householdId: input.householdId,
                ownerId: input.userId,
                visibility: "shared",
                version: 1,
                updatedAt: now,
                deletedAt: now,
                data: insertData(entry.entityId, rawPatch, input.userId, asIso(entry.clientUpdatedAt))
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
            const state: SyncEntityState = {
              entityType: "listItem",
              entityId: entry.entityId,
              householdId: input.householdId,
              ownerId: input.userId,
              visibility: patch.visibility === "private" ? "private" : "shared",
              version: 1,
              updatedAt: now,
              deletedAt: null,
              data: insertData(entry.entityId, rawPatch, input.userId, asIso(entry.clientUpdatedAt))
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
            const state: SyncEntityState = {
              ...current,
              householdId: input.householdId,
              visibility: patch.visibility === "private" ? "private" : current.visibility,
              data: { ...current.data, ...patch },
              version: current.version + 1,
              updatedAt: now
            }
            write(entry, state, current.version, "upsert", "applied")
            continue
          }

          // 3. Conflict: field-level LWW on the fields in the patch, with
          // checklist done-wins as the settled exception (§6.3/§6.5).
          const incomingNewer = Date.parse(asIso(entry.clientUpdatedAt)) > Date.parse(current.updatedAt)
          const data: Record<string, unknown> = { ...current.data }
          if (incomingNewer) Object.assign(data, patch)
          if (current.data.checked === true || patch.checked === true) data.checked = true
          const visibility = incomingNewer && patch.visibility !== undefined
            ? asVisibility(String(patch.visibility))
            : current.visibility

          if (sameData(data, current.data) && visibility === current.visibility) {
            plans.push({ kind: "nowrite", entry, tag: "conflict", state: current })
            continue
          }
          const state: SyncEntityState = {
            ...current,
            householdId: input.householdId,
            visibility,
            data,
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
          .findEntities(input.entries.map((entry) => entry.entityId))
          .pipe(Effect.orDie)

        const results: Array<SyncPushResult> = plans.map((plan) => {
          const state = authoritative.get(plan.entry.entityId) ?? (plan.kind === "dedupe" ? undefined : plan.state)
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
          if (plan.kind === "nowrite") {
            return {
              _tag: plan.tag,
              clientMutationId: plan.entry.clientMutationId,
              entityType: plan.entry.entityType,
              entityId: plan.entry.entityId,
              version: state?.version ?? plan.state.version,
              seq: mutation?.seq ?? 0,
              ...item
            }
          }
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

    return { pull, bootstrap, push } as const
  })
}) {}

export const SyncServiceLive = Layer.effect(SyncService, SyncService.make).pipe(
  Layer.provide(SyncRepoLive)
)
