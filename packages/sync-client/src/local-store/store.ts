import { uuidV7 } from "@tali/domain"

import {
  coalesceOutboxEntry,
  newOutboxEntry,
  nextMirrorRecord,
  withoutSyncError
} from "./coalescing"
import { countFailedRows, failedRows, liveRows, trashedRows } from "./mirror"
import type {
  DraftRecord,
  LocalStore,
  LocalStoreListener,
  LocalWrite,
  MirrorRecord,
  OutboxRecord,
  ServerRow
} from "./types"

/**
 * The IndexedDB-backed local-first store.
 *
 * Two object stores matter: `mirror` (rows the UI renders) and `outbox`
 * (mutations waiting to be pushed). `writeLocal` touches both in **one**
 * transaction, so a mutation can never be visible without being queued, or
 * queued without being visible.
 *
 * One database per user (`tali.mirror.v1.<userId>`) keeps two household
 * accounts on a shared browser from ever reading each other's mirror, and
 * keeps a signed-out user's mirror intact for an offline reload.
 *
 * The pure write rules live in `coalescing.ts`; this module is only the
 * IndexedDB adapter, so a Foldkit Command can open it as a managed resource
 * without importing any framework code.
 */

const DB_VERSION = 1
const MIRROR = "mirror"
const OUTBOX = "outbox"
const META = "meta"
const DRAFTS = "drafts"

const CURSOR_KEY = "lastCursor"

const databaseName = (userId: string): string => `tali.mirror.v1.${userId}`

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"))
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"))
  })

const requestResult = <A>(request: IDBRequest<A>): Promise<A> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })

/** Write the cursor only when it moves forward; a stale pull must not rewind it. */
const advanceCursor = (meta: IDBObjectStore, seq: number): void => {
  const read = meta.get(CURSOR_KEY) as IDBRequest<{ key: string; value: unknown } | undefined>
  read.onsuccess = () => {
    const current = typeof read.result?.value === "number" ? read.result.value : 0
    if (seq > current) meta.put({ key: CURSOR_KEY, value: seq })
  }
}

export interface OpenLocalStoreOptions {
  /** Override the IndexedDB factory (tests). Defaults to the global. */
  readonly factory?: IDBFactory
}

/** Open (or create) the mirror database for one user. */
export const openLocalStore = async (
  userId: string,
  options: OpenLocalStoreOptions = {}
): Promise<LocalStore> => {
  const factory = options.factory ?? globalThis.indexedDB
  if (factory === undefined) {
    throw new Error("IndexedDB is not available in this environment")
  }

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName(userId), DB_VERSION)
    request.onupgradeneeded = () => {
      const upgraded = request.result
      if (!upgraded.objectStoreNames.contains(MIRROR)) {
        const mirror = upgraded.createObjectStore(MIRROR, { keyPath: ["entityType", "entityId"] })
        mirror.createIndex("byEntityType", "entityType")
      }
      if (!upgraded.objectStoreNames.contains(OUTBOX)) {
        const outbox = upgraded.createObjectStore(OUTBOX, { keyPath: "seq", autoIncrement: true })
        outbox.createIndex("byClientMutationId", "clientMutationId", { unique: true })
        outbox.createIndex("byEntity", ["entityType", "entityId"])
      }
      if (!upgraded.objectStoreNames.contains(META)) {
        upgraded.createObjectStore(META, { keyPath: "key" })
      }
      if (!upgraded.objectStoreNames.contains(DRAFTS)) {
        upgraded.createObjectStore(DRAFTS, { keyPath: "key" })
      }
    }
    request.onsuccess = () => {
      const opened = request.result
      opened.onversionchange = () => opened.close()
      resolve(opened)
    }
    request.onerror = () => reject(request.error ?? new Error("Could not open the local mirror"))
  })

  const listeners = new Set<LocalStoreListener>()
  let closed = false

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const ensureOpen = () => {
    if (closed) throw new Error("The local store is closed")
  }

  const store: LocalStore = {
    userId,
    get closed() {
      return closed
    },

    async list(entityType) {
      ensureOpen()
      const tx = db.transaction(MIRROR, "readonly")
      const index = tx.objectStore(MIRROR).index("byEntityType")
      const rows = await requestResult(index.getAll(entityType)) as ReadonlyArray<MirrorRecord>
      return liveRows(rows)
    },

    async listFailed() {
      ensureOpen()
      const tx = db.transaction(MIRROR, "readonly")
      const rows = await requestResult(tx.objectStore(MIRROR).getAll()) as ReadonlyArray<MirrorRecord>
      return failedRows(rows)
    },

    async failedCount() {
      ensureOpen()
      const tx = db.transaction(MIRROR, "readonly")
      const rows = await requestResult(tx.objectStore(MIRROR).getAll()) as ReadonlyArray<MirrorRecord>
      return countFailedRows(rows)
    },

    async listTrashed(entityType) {
      ensureOpen()
      const tx = db.transaction(MIRROR, "readonly")
      const index = tx.objectStore(MIRROR).index("byEntityType")
      const rows = await requestResult(index.getAll(entityType)) as ReadonlyArray<MirrorRecord>
      return trashedRows(rows)
    },

    async get(entityType, entityId) {
      ensureOpen()
      const tx = db.transaction(MIRROR, "readonly")
      const row = await requestResult(tx.objectStore(MIRROR).get([entityType, entityId]))
      return row as MirrorRecord | undefined
    },

    async writeLocal(write: LocalWrite) {
      ensureOpen()
      const now = write.now ?? new Date().toISOString()
      const tx = db.transaction([MIRROR, OUTBOX], "readwrite")
      const mirror = tx.objectStore(MIRROR)
      const outbox = tx.objectStore(OUTBOX)

      let committed: MirrorRecord | undefined
      const existing = mirror.get([write.entityType, write.entityId]) as IDBRequest<
        MirrorRecord | undefined
      >
      existing.onsuccess = () => {
        const current = existing.result
        const record = nextMirrorRecord(current, write, now)
        mirror.put(record)
        committed = record

        const entry = newOutboxEntry(
          current,
          write,
          write.clientMutationId ?? uuidV7(),
          now
        )

        const queued = outbox
          .index("byEntity")
          .getAll([write.entityType, write.entityId]) as IDBRequest<Array<OutboxRecord>>
        queued.onsuccess = () => {
          const folded = coalesceOutboxEntry(queued.result[queued.result.length - 1], write, now)
          if (folded !== undefined) {
            outbox.put(folded)
            return
          }
          outbox.add(entry)
        }
      }

      await txDone(tx)
      notify()
      // The transaction completed, so every request in it succeeded.
      return committed!
    },

    async pending() {
      ensureOpen()
      const tx = db.transaction(OUTBOX, "readonly")
      return await requestResult(tx.objectStore(OUTBOX).getAll()) as ReadonlyArray<OutboxRecord>
    },

    async pendingBatch(limit) {
      ensureOpen()
      if (limit <= 0) return []
      const tx = db.transaction(OUTBOX, "readonly")
      const cursor = tx.objectStore(OUTBOX).openCursor()
      const batch: Array<OutboxRecord> = []
      const seen = new Set<string>()
      return await new Promise<ReadonlyArray<OutboxRecord>>((resolve, reject) => {
        cursor.onsuccess = () => {
          const position = cursor.result
          if (position === null) {
            resolve(batch)
            return
          }
          const entry = position.value as OutboxRecord
          const key = `${entry.entityType}\u0000${entry.entityId}`
          if (!seen.has(key)) {
            seen.add(key)
            batch.push(entry)
            // Enough distinct entities for one push: stop reading. This
            // entity's own chain (and the rest of the queue) waits its turn.
            if (batch.length === limit) {
              resolve(batch)
              return
            }
          }
          position.continue()
        }
        cursor.onerror = () => reject(cursor.error ?? new Error("IndexedDB request failed"))
      })
    },

    async pendingCount() {
      ensureOpen()
      const tx = db.transaction(OUTBOX, "readonly")
      return await requestResult(tx.objectStore(OUTBOX).count())
    },

    async hasPending(entityType, entityId) {
      ensureOpen()
      const tx = db.transaction(OUTBOX, "readonly")
      const index = tx.objectStore(OUTBOX).index("byEntity")
      const count = await requestResult(index.count([entityType, entityId]))
      return count > 0
    },

    async markSent(clientMutationIds) {
      ensureOpen()
      if (clientMutationIds.length === 0) return []
      const tx = db.transaction(OUTBOX, "readwrite")
      const outbox = tx.objectStore(OUTBOX)
      const byMutation = outbox.index("byClientMutationId")
      const marked: Array<OutboxRecord> = []
      // `byClientMutationId` is unique, so a batch is one indexed lookup per
      // id. The full cursor this replaces made marking a push chunk O(outbox).
      for (const id of new Set(clientMutationIds)) {
        const read = byMutation.get(id) as IDBRequest<OutboxRecord | undefined>
        read.onsuccess = () => {
          const entry = read.result
          if (entry === undefined) return
          if (entry.sent === true) {
            marked.push(entry)
            return
          }
          const next: OutboxRecord = { ...entry, sent: true }
          outbox.put(next)
          marked.push(next)
        }
      }

      await txDone(tx)
      // No notify: the pending badge counts entries, and marking does not
      // change the count (only `ack` removes them).
      return marked
    },

    async mergeServer(rows: ReadonlyArray<ServerRow>) {
      ensureOpen()
      const tx = db.transaction([MIRROR, OUTBOX], "readwrite")
      const mirror = tx.objectStore(MIRROR)
      const byEntity = tx.objectStore(OUTBOX).index("byEntity")

      let applied = 0
      // One indexed lookup per incoming row, not a full outbox scan per pull
      // page: the only question is whether *this* row has a pending mutation,
      // and the answer has to come from the same transaction as the put.
      for (const row of rows) {
        const queued = byEntity.getKey([row.entityType, row.entityId])
        queued.onsuccess = () => {
          if (queued.result !== undefined) return
          mirror.put(row)
          applied += 1
        }
      }

      await txDone(tx)
      if (applied > 0) notify()
      return applied
    },

    async ack(clientMutationIds, rows = [], failures = [], resolved = []) {
      ensureOpen()
      if (
        clientMutationIds.length === 0 &&
        rows.length === 0 &&
        failures.length === 0 &&
        resolved.length === 0
      ) return
      const tx = db.transaction([MIRROR, OUTBOX], "readwrite")
      const outbox = tx.objectStore(OUTBOX)
      const byMutation = outbox.index("byClientMutationId")

      for (const id of clientMutationIds) {
        const key = byMutation.getKey(id)
        key.onsuccess = () => {
          if (key.result !== undefined) outbox.delete(key.result)
        }
      }
      const mirror = tx.objectStore(MIRROR)
      // An authoritative row replaces the marker too: a later applied result
      // means the mirror is no longer diverging.
      for (const row of rows) mirror.put(row)
      for (const ref of resolved) {
        const read = mirror.get([ref.entityType, ref.entityId]) as IDBRequest<
          MirrorRecord | undefined
        >
        read.onsuccess = () => {
          const current = read.result
          if (current === undefined || current.syncError === undefined) return
          mirror.put(withoutSyncError(current))
        }
      }
      for (const failure of failures) {
        const { entityType, entityId, code, message, at, clientMutationId } = failure
        const read = mirror.get([entityType, entityId]) as IDBRequest<MirrorRecord | undefined>
        read.onsuccess = () => {
          const current = read.result
          // A rejected upsert always wrote its mirror row locally first; if the
          // row is gone (removed or purged), there is nothing left to mark.
          if (current === undefined) return
          mirror.put({
            ...current,
            syncError: { code, message, at, clientMutationId }
          })
        }
      }

      await txDone(tx)
      notify()
    },

    async retryFailed(entityType, entityId) {
      ensureOpen()
      const now = new Date().toISOString()
      const tx = db.transaction([MIRROR, OUTBOX], "readwrite")
      const mirror = tx.objectStore(MIRROR)
      const outbox = tx.objectStore(OUTBOX)

      let retried: MirrorRecord | undefined
      const existing = mirror.get([entityType, entityId]) as IDBRequest<
        MirrorRecord | undefined
      >
      existing.onsuccess = () => {
        const current = existing.result
        if (current === undefined) return
        retried = { ...withoutSyncError(current), updatedAt: now }
        mirror.put(retried)
        outbox.add({
          clientMutationId: uuidV7(),
          entityType,
          entityId,
          baseVersion: current.version,
          op: "upsert",
          patch: { ...current.data },
          clientUpdatedAt: now,
          sent: false
        } satisfies Omit<OutboxRecord, "seq">)
      }

      await txDone(tx)
      if (retried !== undefined) notify()
      return retried
    },

    async removeFromMirror(entityType, entityId) {
      ensureOpen()
      const tx = db.transaction(MIRROR, "readwrite")
      tx.objectStore(MIRROR).delete([entityType, entityId])
      await txDone(tx)
      notify()
    },

    async clearMirror() {
      ensureOpen()
      const tx = db.transaction(MIRROR, "readwrite")
      tx.objectStore(MIRROR).clear()
      await txDone(tx)
      notify()
    },

    async cursor() {
      ensureOpen()
      const tx = db.transaction(META, "readonly")
      const row = await requestResult(tx.objectStore(META).get(CURSOR_KEY)) as
        | { key: string; value: unknown }
        | undefined
      return typeof row?.value === "number" ? row.value : 0
    },

    async setCursor(seq) {
      ensureOpen()
      const tx = db.transaction(META, "readwrite")
      advanceCursor(tx.objectStore(META), seq)
      await txDone(tx)
    },

    async saveDraft(key, value) {
      ensureOpen()
      const tx = db.transaction(DRAFTS, "readwrite")
      tx.objectStore(DRAFTS).put({ key, value, updatedAt: new Date().toISOString() })
      await txDone(tx)
    },

    async readDraft(key) {
      ensureOpen()
      const tx = db.transaction(DRAFTS, "readonly")
      const row = await requestResult(tx.objectStore(DRAFTS).get(key)) as DraftRecord | undefined
      return row?.value
    },

    async clearDraft(key) {
      ensureOpen()
      const tx = db.transaction(DRAFTS, "readwrite")
      tx.objectStore(DRAFTS).delete(key)
      await txDone(tx)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async clear() {
      ensureOpen()
      const tx = db.transaction([MIRROR, OUTBOX, META, DRAFTS], "readwrite")
      for (const name of [MIRROR, OUTBOX, META, DRAFTS]) {
        tx.objectStore(name).clear()
      }
      await txDone(tx)
      notify()
    },

    close() {
      if (closed) return
      closed = true
      listeners.clear()
      db.close()
    }
  }

  return store
}
