import { uuidV7 } from "@tali/domain"
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
 * This module is deliberately framework-free: Solid wiring lives in
 * `context.tsx`, and the push/pull transport is not here (see #18).
 */

const DB_VERSION = 1
const MIRROR = "mirror"
const OUTBOX = "outbox"
const META = "meta"
const DRAFTS = "drafts"

const CURSOR_KEY = "lastCursor"

const databaseName = (userId: string): string => `tali.mirror.v1.${userId}`

const entityKey = (entityType: string, entityId: string): string => `${entityType}\u0000${entityId}`

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
      return rows.filter((row) => row.deletedAt === null)
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
        const record: MirrorRecord = {
          entityType: write.entityType,
          entityId: write.entityId,
          // The mirror keeps the last *server* version: the client never
          // invents versions, it only invents patches.
          version: current?.version ?? 0,
          updatedAt: now,
          deletedAt: write.op === "delete" ? now : (current?.deletedAt ?? null),
          data: { ...current?.data, ...write.patch }
        }
        mirror.put(record)

        const entry: Omit<OutboxRecord, "seq"> = {
          clientMutationId: write.clientMutationId ?? uuidV7(),
          entityType: write.entityType,
          entityId: write.entityId,
          baseVersion: current?.version ?? 0,
          op: write.op,
          patch: write.patch,
          clientUpdatedAt: now
        }
        outbox.add(entry)
        committed = record
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

    async mergeServer(rows: ReadonlyArray<ServerRow>) {
      ensureOpen()
      const tx = db.transaction([MIRROR, OUTBOX], "readwrite")
      const mirror = tx.objectStore(MIRROR)
      const outbox = tx.objectStore(OUTBOX)

      const queued = new Set<string>()
      let applied = 0
      const cursor = outbox.openCursor()
      cursor.onsuccess = () => {
        const position = cursor.result
        if (position !== null) {
          const entry = position.value as OutboxRecord
          queued.add(entityKey(entry.entityType, entry.entityId))
          position.continue()
          return
        }
        // No await between here and commit: every request stays in this tx.
        for (const row of rows) {
          if (queued.has(entityKey(row.entityType, row.entityId))) continue
          mirror.put(row)
          applied += 1
        }
      }

      await txDone(tx)
      if (applied > 0) notify()
      return applied
    },

    async ack(clientMutationIds, rows = []) {
      ensureOpen()
      if (clientMutationIds.length === 0 && rows.length === 0) return
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
      for (const row of rows) mirror.put(row)

      await txDone(tx)
      notify()
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
