import { Schema } from "effect"
import {
  type Habit,
  type HabitEntry,
  type HabitEntryLogInput,
  type HabitEntryStatus,
  type HabitMutationInput,
  SyncBootstrapResponse,
  SyncPullResponse,
  SyncPushResponse,
  type SyncEntityRow,
  type SyncPushEntry,
  type SyncPushResult
} from "@tali/domain"
import { API_URL } from "./config"
import type { EntityRef, LocalStore, SyncFailure } from "./local-store/types"
import { api } from "./rpc"

/**
 * The client half of the sync engine (ticket #18) — the implementation behind
 * the `registerSync` seam opened in #17.
 *
 * Hydration order follows `docs/sync-protocol-draft.md` §7: pull first (adopt
 * committed server state without clobbering unsent local rows), then push the
 * outbox, adopt the authoritative results, and advance the cursor past our own
 * writes. The mirror stays the render source; the server stays the truth.
 */

const PULL_LIMIT = 500
const PUSH_CHUNK = 200
const REQUEST_TIMEOUT_MS = 15_000

export interface SyncTransport {
  readonly pull: (cursor: number, limit: number) => Promise<SyncPullResponse>
  readonly bootstrap: (offset: number, limit: number) => Promise<SyncBootstrapResponse>
  readonly push: (entries: ReadonlyArray<SyncPushEntry>) => Promise<SyncPushResponse>
  /**
   * The explicit service path that revives a habit day (#64).
   *
   * The generic push resolver keeps tombstone-wins, so a queued tap for a day
   * the server has tombstoned comes back as `tombstone` (or as a
   * `UniqueViolation` rejection when this device minted a different id for the
   * day). Rather than resurrecting the row inside the generic resolver, the
   * engine calls the habit logging mutation, which resolves the day and CASes
   * the revive in one batch. Optional so a test transport can omit it (the
   * entry is then acked like any other non-applied result).
   */
  readonly logHabitEntry?: (input: HabitEntryLogInput) => Promise<HabitEntry>
  /**
   * The explicit service path that undoes a habit soft delete (#63/#66).
   *
   * `/sync/push` deliberately keeps tombstone-wins, so the local-first undo
   * (a queued `upsert` with an empty patch) comes back as `tombstone`. The
   * engine calls `RestoreHabit`, which is idempotent on a live row, and adopts
   * the returned row. Optional for the same reason as `logHabitEntry`.
   */
  readonly restoreHabit?: (input: HabitMutationInput) => Promise<Habit>
}

/** The server row shape for a habit entry the revive path returned. */
const habitEntryRow = (entry: HabitEntry): SyncEntityRow => ({
  entityType: "habitEntry",
  entityId: entry.id,
  version: entry.version,
  updatedAt: entry.updatedAt,
  deletedAt: entry.deletedAt,
  data: { ...entry }
})

/** The server row shape for a habit the restore path returned (#63/#66). */
const habitRow = (habit: Habit): SyncEntityRow => ({
  entityType: "habit",
  entityId: habit.id,
  version: habit.version,
  updatedAt: habit.updatedAt,
  deletedAt: habit.deletedAt,
  data: { ...habit }
})

const isHabitEntryStatus = (value: unknown): value is HabitEntryStatus =>
  value === "done" || value === "partial" || value === "missed"

/**
 * Typed refusals from the logging mutation that retrying cannot change: the
 * habit went away/changed scope, or the tap's day is outside the window.
 * Anything else (a network/RPC failure) is retried by leaving the outbox alone.
 */
const PERMANENT_REVIVE_ERRORS: ReadonlySet<string> = new Set([
  "HabitEntryOutOfWindow",
  "HabitEntryNotFound",
  "HabitNotFound",
  "HabitForbidden",
  "HabitValidationError",
  "Unauthorized"
])

/**
 * A push outcome the habit tap can still rescue: the row is tombstoned, or the
 * unique `(habit, day)` key belongs to a row this device does not know.
 */
const repairableHabitEntry = (result: SyncPushResult): boolean =>
  result.entityType === "habitEntry" &&
  (result._tag === "tombstone" ||
    (result._tag === "rejected" && result.code === "UniqueViolation"))

/**
 * A queued habit restore: an `upsert` with no fields. The screen's delete is a
 * queued `delete`; its undo is a queued empty upsert that re-points the mirror
 * at the live row. The generic resolver answers `tombstone`, which the engine
 * repairs through `RestoreHabit`.
 */
const isHabitRestore = (entry: SyncPushEntry): boolean =>
  entry.entityType === "habit" &&
  entry.op === "upsert" &&
  Object.keys(entry.patch).length === 0

/** A non-2xx sync response; the stable code and details travel to the engine. */
export class SyncRejected extends Error {
  constructor(
    readonly code: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(code)
  }
}

/**
 * The prefix of the error the engine raises when `RestoreHabit` permanently
 * refuses a queued habit undo (the row was purged, or is no longer visible).
 *
 * The undo is acked first — keeping it would retry forever — so the engine
 * reports the refusal after the batch so `syncNow` can surface it rather than
 * leaving the user with a habit that silently disappears again.
 */
export const HABIT_RESTORE_REFUSED = "habit-restore-refused"

export class HabitRestoreRefused extends Error {
  override readonly name = "HabitRestoreRefused"

  constructor(
    readonly habitId: string,
    readonly reason: string
  ) {
    super(`${HABIT_RESTORE_REFUSED}:${reason}`)
  }
}

const request = async <A>(
  path: string,
  schema: Schema.ConstraintDecoder<A>,
  init: RequestInit = {}
): Promise<A> => {
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, {
      credentials: "include",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...init
    })
  } catch {
    throw new Error("network")
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const envelope = Schema.decodeUnknownOption(
      Schema.Struct({
        error: Schema.Struct({
          code: Schema.String,
          details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
        })
      })
    )(body)
    throw envelope._tag === "Some"
      ? new SyncRejected(envelope.value.error.code, envelope.value.error.details ?? {})
      : new SyncRejected("sync-failed")
  }
  return Schema.decodeUnknownSync(schema)(body)
}

/** The plain-HTTP transport. Tests inject a fake with the same interface. */
export const httpSyncTransport = (): SyncTransport => ({
  pull: (cursor, limit) =>
    request(`/sync/pull?cursor=${cursor}&limit=${limit}`, SyncPullResponse),
  bootstrap: (offset, limit) =>
    request(`/sync/bootstrap?offset=${offset}&limit=${limit}`, SyncBootstrapResponse),
  push: (entries) =>
    request("/sync/push", SyncPushResponse, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries })
    }),
  logHabitEntry: (input) => api.logHabitEntry(input),
  restoreHabit: (input) => api.restoreHabit(input)
})

const asServerRows = (result: SyncPushResult): ReadonlyArray<SyncEntityRow> =>
  result._tag === "rejected" || result.item === undefined ? [] : [result.item]

export interface SyncEngine {
  /** One reconcile pass: pull deltas, then drain as much of the outbox as possible. */
  readonly sync: (store: LocalStore) => Promise<void>
}

export const createSyncEngine = (
  transport: SyncTransport = httpSyncTransport()
): SyncEngine => {
  const pullAll = async (store: LocalStore): Promise<void> => {
    let cursor = await store.cursor()
    for (;;) {
      const page = await transport.pull(cursor, PULL_LIMIT)
      if (page.resetRequired) {
        await bootstrapAll(store)
        return
      }
      await store.mergeServer(page.items)
      for (const row of page.removed) {
        await store.removeFromMirror(row.entityType, row.entityId)
      }
      await store.setCursor(page.nextCursor)
      cursor = page.nextCursor
      if (!page.hasMore) return
    }
  }

  /**
   * A cursor older than the 90-day feed window cannot be served incrementally.
   * The mirror is replaced from the visible live set; pending outbox rows are
   * preserved (the server resolves their conflicts on push).
   */
  const bootstrapAll = async (store: LocalStore): Promise<void> => {
    let offset = 0
    let cursor = 0
    let first = true
    for (;;) {
      const page = await transport.bootstrap(offset, PULL_LIMIT)
      if (first) {
        await store.clearMirror()
        cursor = page.cursor
        first = false
      }
      await store.mergeServer(page.items)
      if (!page.hasMore) break
      if (page.nextOffset <= offset) break
      offset = page.nextOffset
    }
    await store.setCursor(cursor)
  }

  /**
   * One entry per entity, up to `limit`. Coalescing in `writeLocal` keeps an
   * idle session to one entry per row; this still matters for the entry that
   * was sent (marked `sent`) while a newer one queued behind it: sending both
   * in one request would need a server version the client does not have yet
   * (§4.3), so the newer link waits for the next round trip.
   */
  const takeFirstPerEntity = (
    entries: ReadonlyArray<SyncPushEntry & { readonly seq: number }>,
    limit: number
  ): ReadonlyArray<SyncPushEntry & { readonly seq: number }> => {
    const seen = new Set<string>()
    const batch: Array<SyncPushEntry & { readonly seq: number }> = []
    for (const entry of entries) {
      const key = `${entry.entityType}\u0000${entry.entityId}`
      if (seen.has(key)) continue
      seen.add(key)
      batch.push(entry)
      if (batch.length === limit) break
    }
    return batch
  }

  const pushAll = async (store: LocalStore): Promise<void> => {
    // The stored anchor is authoritative only for the first un-acked entry per
    // entity; later entries chain off the version returned by the previous
    // request (`docs/sync-protocol-draft.md` §4.1/§4.3).
    const versionByEntity = new Map<string, number>()

    for (;;) {
      const pending = await store.pending()
      if (pending.length === 0) return
      const batch = takeFirstPerEntity(pending, PUSH_CHUNK)
      if (batch.length === 0) return
      // A write can fold into one of these entries between the `pending` read
      // and the mark, so the push must carry what `markSent` returns rather
      // than the copy read above; otherwise acking the marked entry would drop
      // that field. Mark before sending, never after: if this request times
      // out the entries stay `sent` and are retried unchanged, so a merged
      // patch can never hide behind an `applied_mutations` dedupe hit.
      const marked = await store.markSent(batch.map((entry) => entry.clientMutationId))
      if (marked.length === 0) return
      const entries = marked.map((entry) => {
        const key = `${entry.entityType}\u0000${entry.entityId}`
        const chained = versionByEntity.get(key)
        return chained === undefined ? entry : { ...entry, baseVersion: chained }
      })
      let response: SyncPushResponse
      try {
        response = await transport.push(entries)
      } catch (cause) {
        // A 403 means this entry can never be applied (the row went private,
        // or belongs to another household). Retrying would fail forever and
        // block every later entry, so drop that entity's queue and mirror row.
        if (!(cause instanceof SyncRejected) || cause.code !== "Forbidden") throw cause
        const entityId = cause.details.entityId
        if (typeof entityId !== "string") throw cause
        const poisoned = pending.filter((entry) => entry.entityId === entityId)
        if (poisoned.length === 0) throw cause
        await store.ack(poisoned.map((entry) => entry.clientMutationId))
        for (const entityType of new Set(poisoned.map((entry) => entry.entityType))) {
          await store.removeFromMirror(entityType, entityId)
        }
        continue
      }
      const repairedRows: Array<SyncEntityRow> = []
      const repairedOriginalIds = new Set<string>()
      const failures: Array<SyncFailure & EntityRef> = []
      const resolved: Array<EntityRef> = []
      let restoreRefusal: HabitRestoreRefused | undefined

      for (const result of response.results) {
        /**
         * A queued undo for a habit the server tombstoned is a service
         * mutation, not a generic push: `RestoreHabit` clears the tombstone in
         * place (idempotent on a live row) and the engine adopts the returned
         * row. Like the habit-tap repair below, it runs before the entry is
         * acked so a transient failure leaves the undo queued.
         */
        if (
          result.entityType === "habit" &&
          result._tag === "tombstone" &&
          transport.restoreHabit !== undefined
        ) {
          const queued = batch.find(
            (entry) => entry.clientMutationId === result.clientMutationId
          )
          if (queued !== undefined && isHabitRestore(queued)) {
            try {
              const restored = await transport.restoreHabit({
                id: queued.entityId as Habit["id"],
                clientMutationId: queued.clientMutationId
              })
              repairedRows.push(habitRow(restored))
              versionByEntity.set(`habit\u0000${restored.id}`, restored.version)
            } catch (cause) {
              const tag = (cause as { readonly _tag?: unknown })._tag
              if (typeof tag !== "string" || !PERMANENT_REVIVE_ERRORS.has(tag)) {
                // Transient (offline, 5xx, timeout): keep the undo queued.
                throw cause
              }
              console.warn(
                `[sync] stopped restoring habit/${queued.entityId} (${tag}): ${
                  cause instanceof Error ? cause.message : String(cause)
                }`
              )
              // Acked below like any other resolved result, so the refusal is
              // reported after the batch instead of retrying forever.
              restoreRefusal ??= new HabitRestoreRefused(queued.entityId, tag)
            }
            continue
          }
        }
        /**
         * A queued tap for a day the server tombstoned (or for a day another
         * device already owns under a different id) is not lost: the generic
         * resolver refuses it by design, so the explicit logging mutation
         * resolves the day and revives/updates the existing row.
         */
        if (repairableHabitEntry(result) && transport.logHabitEntry !== undefined) {
          const queued = batch.find(
            (entry) => entry.clientMutationId === result.clientMutationId
          )
          const habitId = queued?.patch.habitId
          const localDate = queued?.patch.localDate
          const status = queued?.patch.status
          const timeZone = queued?.patch.timeZone
          if (
            queued !== undefined &&
            queued.op === "upsert" &&
            typeof habitId === "string" &&
            typeof localDate === "string" &&
            isHabitEntryStatus(status)
          ) {
            try {
              const revived = await transport.logHabitEntry({
                id: queued.entityId as HabitEntry["id"],
                clientMutationId: queued.clientMutationId,
                habitId: habitId as HabitEntry["habitId"],
                localDate: localDate as HabitEntry["localDate"],
                status,
                ...(typeof timeZone === "string" ? { timeZone } : {})
              })
              if (revived.id !== queued.entityId) {
                repairedOriginalIds.add(queued.entityId)
              }
              repairedRows.push(habitEntryRow(revived))
              versionByEntity.set(`habitEntry\u0000${revived.id}`, revived.version)
              if (revived.id !== queued.entityId) {
                versionByEntity.set(`habitEntry\u0000${queued.entityId}`, revived.version)
              }
            } catch (cause) {
              const tag = (cause as { readonly _tag?: unknown })._tag
              if (typeof tag !== "string" || !PERMANENT_REVIVE_ERRORS.has(tag)) {
                // Transient (offline, 5xx, timeout): keep the outbox entry and
                // try again on the next reconcile.
                throw cause
              }
              console.warn(
                `[sync] stopped reviving habitEntry/${queued.entityId} (${tag}): ${
                  cause instanceof Error ? cause.message : String(cause)
                }`
              )
            }
            continue
          }
        }
        // A rejected entry can never apply as written (invalid patch, duplicate
        // live tag name, missing FK parent, attribution budget). Acking it below
        // drops it from the outbox so it cannot wedge every later entry, but the
        // mirror keeps the local row **and** a durable marker: the server never
        // moved this row's feed seq, so no later pull will re-deliver it. The
        // marker is what stops the UI claiming "saved" and lets the user retry.
        if (result._tag === "rejected") {
          console.warn(
            `[sync] rejected ${result.entityType}/${result.entityId} (${result.code}): ${result.message}`
          )
          failures.push({
            entityType: result.entityType,
            entityId: result.entityId,
            code: result.code,
            message: result.message,
            at: new Date().toISOString(),
            clientMutationId: result.clientMutationId
          })
          continue
        }
        // Any non-rejected result resolved this entity on the server, even when
        // the response omits the authoritative row (tests, already-applied).
        resolved.push({ entityType: result.entityType, entityId: result.entityId })
        versionByEntity.set(
          `${result.entityType}\u0000${result.entityId}`,
          result.version
        )
      }
      const rows = [...response.results.flatMap(asServerRows), ...repairedRows]
      // Deliberately no cursor here: a push's highest `seq` is not contiguous
      // with what this device has pulled. A remote change committed between
      // our pull and our push would be skipped forever if we jumped to it.
      await store.ack(
        response.results.map((result) => result.clientMutationId),
        rows,
        failures,
        resolved
      )
      // The revive resolved the day to a different server row: drop the local
      // placeholder so the mirror holds exactly one row for the day.
      for (const entityId of repairedOriginalIds) {
        await store.removeFromMirror("habitEntry", entityId)
      }
      // The undo was acked (so it cannot loop), but the user asked to restore a
      // habit the server permanently refused: report it now that the mirror is
      // consistent. `syncNow` turns this into a visible error.
      if (restoreRefusal !== undefined) throw restoreRefusal
      // Defensive: a server result set with no ids would otherwise spin.
      if (response.results.length === 0) return
    }
  }

  return {
    sync: async (store) => {
      await pullAll(store)
      await pushAll(store)
    }
  }
}

/** The default handler registered into `LocalStoreProvider`. */
export const syncHandler = createSyncEngine().sync
