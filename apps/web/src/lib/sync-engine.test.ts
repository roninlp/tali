import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import { uuidV7, type SyncBootstrapResponse, type SyncPullResponse, type SyncPushEntry, type SyncPushResponse } from "@tali/domain"
import { openLocalStore } from "./local-store/store"
import type { LocalStore } from "./local-store/types"
import { createSyncEngine, type SyncTransport } from "./sync-engine"

/**
 * The client half of #18: the handler behind `registerSync` pulls deltas into
 * the mirror, pushes the outbox with the right CAS anchors, and adopts the
 * server's authoritative rows. The server-side convergence proof lives in
 * `apps/api/test/sync.test.ts`; this covers the transport wiring.
 */

const freshUser = (): string => `user-${uuidV7()}`

const open = (): Promise<LocalStore> => openLocalStore(freshUser())

const emptyPull = (cursor = 0): SyncPullResponse => ({
  entries: [],
  items: [],
  removed: [],
  nextCursor: cursor,
  hasMore: false,
  resetRequired: false
})

const page = <A>(pages: ReadonlyArray<A>): (() => A) => {
  let index = 0
  return () => {
    const value = pages[Math.min(index, pages.length - 1)]!
    index += 1
    return value
  }
}

const transport = (parts: {
  readonly pull?: (cursor: number, limit: number) => Promise<SyncPullResponse>
  readonly bootstrap?: (offset: number, limit: number) => Promise<SyncBootstrapResponse>
  readonly push?: (entries: ReadonlyArray<SyncPushEntry>) => Promise<SyncPushResponse>
}): SyncTransport => ({
  pull: parts.pull ?? (async (cursor) => emptyPull(cursor)),
  bootstrap: parts.bootstrap ?? (async () => ({ items: [], nextOffset: 0, hasMore: false, cursor: 0 })),
  push: parts.push ?? (async () => ({ results: [], cursor: 0 }))
})

describe("client sync engine", () => {
  it("pulls server rows, pushes the outbox, and adopts the authoritative row", async () => {
    const store = await open()
    const id = uuidV7()
    await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      patch: { title: "محلی" },
      now: "2026-10-19T08:00:00.000Z"
    })

    const pushed: Array<ReadonlyArray<SyncPushEntry>> = []
    const engine = createSyncEngine(
      transport({
        push: async (entries) => {
          pushed.push(entries)
          return {
            results: entries.map((entry) => ({
              _tag: "applied" as const,
              clientMutationId: entry.clientMutationId,
              entityType: entry.entityType,
              entityId: entry.entityId,
              version: 1,
              seq: 9,
              item: {
                entityType: entry.entityType,
                entityId: entry.entityId,
                version: 1,
                updatedAt: "2026-10-19T08:00:01.000Z",
                deletedAt: null,
                data: { id, type: "listItem", title: "سرور", checked: false, sortOrder: 0 }
              }
            })),
            cursor: 9
          }
        }
      })
    )

    await engine.sync(store)

    expect(pushed).toHaveLength(1)
    expect(pushed[0]![0]!.baseVersion).toBe(0)
    expect(await store.pending()).toHaveLength(0)
    expect(await store.get("listItem", id)).toMatchObject({
      version: 1,
      data: { title: "سرور" }
    })
    expect(await store.cursor()).toBe(9)
    store.close()
  })

  it("chains a row's queued edits through the version returned by the previous push", async () => {
    const store = await open()
    const id = uuidV7()
    await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      patch: { title: "اول" }
    })
    await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      patch: { checked: true }
    })

    const anchors: Array<number> = []
    const engine = createSyncEngine(
      transport({
        push: async (entries) => {
          anchors.push(entries[0]!.baseVersion)
          const entry = entries[0]!
          return {
            results: [
              {
                _tag: "applied" as const,
                clientMutationId: entry.clientMutationId,
                entityType: entry.entityType,
                entityId: entry.entityId,
                version: anchors.length,
                seq: anchors.length,
                item: {
                  entityType: entry.entityType,
                  entityId: entry.entityId,
                  version: anchors.length,
                  updatedAt: new Date().toISOString(),
                  deletedAt: null,
                  data: { id, type: "listItem", title: "اول", checked: true, sortOrder: 0 }
                }
              }
            ],
            cursor: anchors.length
          }
        }
      })
    )

    await engine.sync(store)

    // One entry per entity per request: 0, then the version the server gave us.
    expect(anchors).toEqual([0, 1])
    expect(await store.pending()).toHaveLength(0)
    store.close()
  })

  it("removes rows the server says are no longer visible", async () => {
    const store = await open()
    const visible = uuidV7()
    const hidden = uuidV7()
    await store.mergeServer([
      {
        entityType: "listItem",
        entityId: visible,
        version: 1,
        updatedAt: "2026-10-19T08:00:00.000Z",
        deletedAt: null,
        data: { title: "دیدنی" }
      },
      {
        entityType: "listItem",
        entityId: hidden,
        version: 1,
        updatedAt: "2026-10-19T08:00:00.000Z",
        deletedAt: null,
        data: { title: "خصوصی" }
      }
    ])

    const engine = createSyncEngine(
      transport({
        pull: async () => ({
          ...emptyPull(1),
          entries: [
            {
              seq: 1,
              entityType: "listItem",
              entityId: visible,
              op: "upsert",
              version: 1,
              updatedAt: "2026-10-19T08:00:00.000Z",
              ownerId: "owner",
              visibility: "shared"
            }
          ],
          items: [
            {
              entityType: "listItem",
              entityId: visible,
              version: 1,
              updatedAt: "2026-10-19T08:00:00.000Z",
              deletedAt: null,
              data: { title: "دیدنی" }
            }
          ],
          removed: [{ entityType: "listItem", entityId: hidden }],
          nextCursor: 1
        })
      })
    )

    await engine.sync(store)

    expect(await store.get("listItem", visible)).toBeDefined()
    expect(await store.get("listItem", hidden)).toBeUndefined()
    expect(await store.cursor()).toBe(1)
    store.close()
  })

  it("re-bootstraps and replaces the mirror when the cursor is stale", async () => {
    const store = await open()
    const stale = uuidV7()
    const fresh = uuidV7()
    await store.mergeServer([
      {
        entityType: "listItem",
        entityId: stale,
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
        data: { title: "کهنه" }
      }
    ])
    await store.setCursor(3)

    const engine = createSyncEngine(
      transport({
        pull: async () => ({ ...emptyPull(3), resetRequired: true }),
        bootstrap: async () => ({
          items: [
            {
              entityType: "listItem",
              entityId: fresh,
              version: 2,
              updatedAt: "2026-10-19T08:00:00.000Z",
              deletedAt: null,
              data: { title: "تازه" }
            }
          ],
          nextOffset: 1,
          hasMore: false,
          cursor: 41
        })
      })
    )

    await engine.sync(store)

    expect(await store.get("listItem", stale)).toBeUndefined()
    expect(await store.get("listItem", fresh)).toBeDefined()
    expect(await store.cursor()).toBe(41)
    store.close()
  })

  it("pages a pull until hasMore is false", async () => {
    const store = await open()
    const first = uuidV7()
    const second = uuidV7()
    const nextPage = page([
      {
        ...emptyPull(4),
        entries: [
          {
            seq: 4,
            entityType: "listItem" as const,
            entityId: first,
            op: "upsert" as const,
            version: 1,
            updatedAt: "2026-10-19T08:00:00.000Z",
            ownerId: "owner",
            visibility: "shared" as const
          }
        ],
        items: [
          {
            entityType: "listItem" as const,
            entityId: first,
            version: 1,
            updatedAt: "2026-10-19T08:00:00.000Z",
            deletedAt: null,
            data: { title: "اول" }
          }
        ],
        nextCursor: 4,
        hasMore: true
      },
      {
        ...emptyPull(7),
        entries: [
          {
            seq: 7,
            entityType: "listItem" as const,
            entityId: second,
            op: "upsert" as const,
            version: 1,
            updatedAt: "2026-10-19T08:00:01.000Z",
            ownerId: "owner",
            visibility: "shared" as const
          }
        ],
        items: [
          {
            entityType: "listItem" as const,
            entityId: second,
            version: 1,
            updatedAt: "2026-10-19T08:00:01.000Z",
            deletedAt: null,
            data: { title: "دوم" }
          }
        ],
        nextCursor: 7,
        hasMore: false
      }
    ])

    const engine = createSyncEngine(transport({ pull: async () => nextPage() }))
    await engine.sync(store)

    expect(await store.cursor()).toBe(7)
    expect((await store.list("listItem")).map((row) => row.data.title).sort()).toEqual(
      ["اول", "دوم"].sort()
    )
    store.close()
  })
})
