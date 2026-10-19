import { Schema } from "effect"
import {
  SyncBootstrapResponse,
  SyncPullResponse,
  SyncPushResponse,
  type SyncEntityRow,
  type SyncPushEntry
} from "@tali/domain"
import { API_URL } from "./config"
import type { LocalStore } from "./local-store/types"

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
    const code = Schema.decodeUnknownOption(
      Schema.Struct({
        error: Schema.Struct({ code: Schema.String })
      })
    )(body)
    throw new Error(code._tag === "Some" ? code.value.error.code : "sync-failed")
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
    })
})

const asServerRows = (result: { readonly item?: SyncEntityRow }): ReadonlyArray<SyncEntityRow> =>
  result.item === undefined ? [] : [result.item]

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
   * One entry per entity, up to `limit`. Sending the second edit of a row in
   * the same request would need a server-assigned version the client does not
   * have yet; one round trip per chain keeps the CAS anchor honest (§4.3).
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
      const entries = batch.map((entry) => {
        const key = `${entry.entityType}\u0000${entry.entityId}`
        const chained = versionByEntity.get(key)
        return chained === undefined ? entry : { ...entry, baseVersion: chained }
      })
      const response = await transport.push(entries)
      for (const result of response.results) {
        versionByEntity.set(
          `${result.entityType}\u0000${result.entityId}`,
          result.version
        )
      }
      const rows = response.results.flatMap(asServerRows)
      await store.ack(
        response.results.map((result) => result.clientMutationId),
        rows,
        response.cursor
      )
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
