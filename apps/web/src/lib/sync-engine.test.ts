import "fake-indexeddb/auto"
import { describe, expect, it, vi } from "vitest"
import {
  type Habit,
  type HabitEntry,
  type HabitEntryLogInput,
  type HabitMutationInput,
  type SyncBootstrapResponse,
  type SyncPullResponse,
  type SyncPushEntry,
  type SyncPushResponse,
  uuidV7
} from "@tali/domain"
import { openLocalStore } from "./local-store/store"
import type { LocalStore } from "./local-store/types"
import { createSyncEngine, SyncRejected, type SyncTransport } from "./sync-engine"

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
  readonly logHabitEntry?: (input: HabitEntryLogInput) => Promise<HabitEntry>
  readonly restoreHabit?: (input: HabitMutationInput) => Promise<Habit>
}): SyncTransport => ({
  pull: parts.pull ?? (async (cursor) => emptyPull(cursor)),
  bootstrap: parts.bootstrap ?? (async () => ({ items: [], nextOffset: 0, hasMore: false, cursor: 0 })),
  push: parts.push ?? (async () => ({ results: [], cursor: 0 })),
  ...(parts.logHabitEntry === undefined ? {} : { logHabitEntry: parts.logHabitEntry }),
  ...(parts.restoreHabit === undefined ? {} : { restoreHabit: parts.restoreHabit })
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
    // Only pulls advance the cursor; the push's seq (9) may not be contiguous
    // with what this device has pulled, so ack must not jump to it.
    expect(await store.cursor()).toBe(0)
    store.close()
  })

  it("collapses edits queued while nothing is in flight into one push request", async () => {
    const store = await open()
    const id = uuidV7()
    await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      patch: { title: "اول" },
      now: "2026-10-19T08:00:00.000Z"
    })
    await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      patch: { checked: true },
      now: "2026-10-19T08:00:01.000Z"
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
              seq: 9
            })),
            cursor: 9
          }
        }
      })
    )

    await engine.sync(store)

    // One edit session, one request: the two patches travel as one entry.
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toHaveLength(1)
    expect(pushed[0]![0]).toMatchObject({
      baseVersion: 0,
      patch: { title: "اول", checked: true }
    })
    expect(await store.pending()).toHaveLength(0)
    store.close()
  })

  it("chains a row's edit queued while a send is in flight through the returned version", async () => {
    const store = await open()
    const id = uuidV7()
    await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      patch: { title: "اول" },
      now: "2026-10-19T08:00:00.000Z"
    })

    const anchors: Array<number> = []
    const pushed: Array<ReadonlyArray<SyncPushEntry>> = []
    const inFlight: Array<ReadonlyArray<boolean>> = []
    const engine = createSyncEngine(
      transport({
        push: async (entries) => {
          anchors.push(entries[0]!.baseVersion)
          pushed.push(entries)
          if (anchors.length === 1) {
            // The entry is marked before the request leaves, so this edit
            // cannot fold into it: it becomes the next chain link.
            inFlight.push((await store.pending()).map((entry) => entry.sent))
            await store.writeLocal({
              entityType: "listItem",
              entityId: id,
              op: "upsert",
              patch: { checked: true },
              now: "2026-10-19T08:00:01.000Z"
            })
          }
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
                  updatedAt: "2026-10-19T08:00:01.000Z",
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
    expect(inFlight).toEqual([[true]])
    // The in-flight edit carries only its own patch, anchored to the reply.
    expect(pushed[1]![0]).toMatchObject({ baseVersion: 1, patch: { checked: true } })
    expect(await store.pending()).toHaveLength(0)
    store.close()
  })

  it("sends a write that folds in between the queue read and the send mark", async () => {
    const store = await open()
    const id = uuidV7()
    await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      patch: { title: "اول" },
      now: "2026-10-19T08:00:00.000Z"
    })

    // The engine reads the queue, then a keystroke folds into that entry
    // before the send mark. The marked entry is what the ack will remove, so
    // the request must carry the folded patch, not the stale copy.
    let raced = false
    const racing: LocalStore = {
      ...store,
      pending: async () => {
        const rows = await store.pending()
        if (!raced) {
          raced = true
          await store.writeLocal({
            entityType: "listItem",
            entityId: id,
            op: "upsert",
            patch: { checked: true },
            now: "2026-10-19T08:00:01.000Z"
          })
        }
        return rows
      }
    }

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
              seq: 9
            })),
            cursor: 9
          }
        }
      })
    )

    await engine.sync(racing)

    expect(pushed).toHaveLength(1)
    expect(pushed[0]![0]!.patch).toEqual({ title: "اول", checked: true })
    expect(await store.pendingCount()).toBe(0)
    store.close()
  })

  it("drains 30 title patches and 8 body saves for one note in one request", async () => {
    // The measured editing session from the sync-latency review: every
    // keystroke wrote the title and every 700 ms saved the body, which used to
    // queue 37 entries and take 37 sequential round trips.
    const store = await open()
    const id = uuidV7()
    const start = Date.parse("2026-10-19T08:00:00.000Z")
    for (let index = 0; index < 30; index += 1) {
      await store.writeLocal({
        entityType: "note",
        entityId: id,
        op: "upsert",
        patch: { title: `عنوان ${index}` },
        now: new Date(start + index).toISOString()
      })
    }
    for (let index = 0; index < 8; index += 1) {
      await store.writeLocal({
        entityType: "note",
        entityId: id,
        op: "upsert",
        patch: { plainText: `متن ${index}` },
        now: new Date(start + 100 + index * 700).toISOString()
      })
    }

    const requests: Array<ReadonlyArray<SyncPushEntry>> = []
    const engine = createSyncEngine(
      transport({
        push: async (entries) => {
          requests.push(entries)
          return {
            results: entries.map((entry) => ({
              _tag: "applied" as const,
              clientMutationId: entry.clientMutationId,
              entityType: entry.entityType,
              entityId: entry.entityId,
              version: 1,
              seq: 37
            })),
            cursor: 37
          }
        }
      })
    )

    await engine.sync(store)

    expect(requests).toHaveLength(1)
    expect(requests[0]).toHaveLength(1)
    // Later value wins per field, so the server gets the final text only.
    expect(requests[0]![0]!.patch).toEqual({ title: "عنوان 29", plainText: "متن 7" })
    expect(await store.pendingCount()).toBe(0)
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

  it("does not skip a remote change that lands between our pull and our push", async () => {
    const store = await open()
    const local = uuidV7()
    const remote = uuidV7()
    await store.setCursor(10)
    await store.writeLocal({
      entityType: "listItem",
      entityId: local,
      op: "upsert",
      patch: { title: "محلی" }
    })

    // The spouse's change is committed at seq 15 after our pull but before our
    // push (which takes seq 20). Advancing the cursor to 20 would skip seq 15.
    let remoteLanded = false
    const engine = createSyncEngine(
      transport({
        pull: async (cursor) => {
          if (!remoteLanded || cursor >= 15) return emptyPull(cursor)
          return {
            ...emptyPull(15),
            entries: [
              {
                seq: 15,
                entityType: "listItem",
                entityId: remote,
                op: "upsert",
                version: 1,
                updatedAt: "2026-10-19T08:00:00.000Z",
                ownerId: "spouse",
                visibility: "shared"
              }
            ],
            items: [
              {
                entityType: "listItem",
                entityId: remote,
                version: 1,
                updatedAt: "2026-10-19T08:00:00.000Z",
                deletedAt: null,
                data: { title: "از همسر" }
              }
            ],
            nextCursor: 15
          }
        },
        push: async (entries) => {
          remoteLanded = true
          return {
            results: entries.map((entry) => ({
              _tag: "applied" as const,
              clientMutationId: entry.clientMutationId,
              entityType: entry.entityType,
              entityId: entry.entityId,
              version: 1,
              seq: 20
            })),
            cursor: 20
          }
        }
      })
    )

    await engine.sync(store)
    await engine.sync(store)

    expect(await store.get("listItem", remote)).toMatchObject({ data: { title: "از همسر" } })
    store.close()
  })

  it("drops an outbox entry the server will never accept instead of poisoning the queue", async () => {
    const store = await open()
    const poisoned = uuidV7()
    const healthy = uuidV7()
    await store.writeLocal({
      entityType: "listItem",
      entityId: poisoned,
      op: "upsert",
      patch: { title: "خصوصی شد" }
    })
    await store.writeLocal({
      entityType: "listItem",
      entityId: healthy,
      op: "upsert",
      patch: { title: "سالم" }
    })

    let calls = 0
    const engine = createSyncEngine(
      transport({
        push: async (entries) => {
          calls += 1
          if (calls === 1) {
            throw new SyncRejected("Forbidden", { entityId: poisoned })
          }
          return {
            results: entries.map((entry) => ({
              _tag: "applied" as const,
              clientMutationId: entry.clientMutationId,
              entityType: entry.entityType,
              entityId: entry.entityId,
              version: 1,
              seq: 30
            })),
            cursor: 30
          }
        }
      })
    )

    await expect(engine.sync(store)).resolves.toBeUndefined()
    expect(await store.pending()).toHaveLength(0)
    expect(await store.get("listItem", poisoned)).toBeUndefined()
    expect(await store.get("listItem", healthy)).toBeDefined()
    store.close()
  })

  it("acks a rejected entry and keeps draining without removing its mirror row", async () => {
    const store = await open()
    const rejectedId = uuidV7()
    const healthyId = uuidV7()
    await store.writeLocal({
      entityType: "tag",
      entityId: rejectedId,
      op: "upsert",
      patch: { name: "تکراری" }
    })
    await store.writeLocal({
      entityType: "listItem",
      entityId: healthyId,
      op: "upsert",
      patch: { title: "سالم" }
    })

    let calls = 0
    const engine = createSyncEngine(
      transport({
        push: async (entries) => {
          calls += 1
          return {
            results: entries.map((entry) =>
              entry.entityId === rejectedId
                ? {
                  _tag: "rejected" as const,
                  clientMutationId: entry.clientMutationId,
                  entityType: entry.entityType,
                  entityId: entry.entityId,
                  code: "UniqueViolation",
                  message: "UNIQUE constraint failed: tags.household_id, tags.name"
                }
                : {
                  _tag: "applied" as const,
                  clientMutationId: entry.clientMutationId,
                  entityType: entry.entityType,
                  entityId: entry.entityId,
                  version: 1,
                  seq: 7,
                  item: {
                    entityType: entry.entityType,
                    entityId: entry.entityId,
                    version: 1,
                    updatedAt: "2026-10-19T08:00:01.000Z",
                    deletedAt: null,
                    data: { id: healthyId, type: "listItem", title: "سرور", checked: false, sortOrder: 0 }
                  }
                }
            ),
            cursor: 7
          }
        }
      })
    )

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(engine.sync(store)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("UniqueViolation"))
    warn.mockRestore()

    // The rejected entry is acked (dropped from the outbox)…
    expect(calls).toBe(1)
    expect(await store.pending()).toHaveLength(0)
    // …but its optimistic mirror row is not removed, and the healthy entry applied.
    expect(await store.get("tag", rejectedId)).toBeDefined()
    expect(await store.get("listItem", healthyId)).toMatchObject({ data: { title: "سرور" } })
    store.close()
  })

  it("keeps a rejected result as a durable marker and clears it when a later result applies", async () => {
    const store = await open()
    const id = uuidV7()
    await store.writeLocal({
      entityType: "note",
      entityId: id,
      op: "upsert",
      patch: { title: "محلی" },
      now: "2026-10-19T08:00:00.000Z"
    })

    let calls = 0
    const engine = createSyncEngine(
      transport({
        push: async (entries) => {
          calls += 1
          if (calls === 1) {
            return {
              results: entries.map((entry) => ({
                _tag: "rejected" as const,
                clientMutationId: entry.clientMutationId,
                entityType: entry.entityType,
                entityId: entry.entityId,
                code: "InvalidPatch",
                message: "The patch value for \"title\" is not valid"
              })),
              cursor: 0
            }
          }
          return {
            results: entries.map((entry) => ({
              _tag: "applied" as const,
              clientMutationId: entry.clientMutationId,
              entityType: entry.entityType,
              entityId: entry.entityId,
              version: 2,
              seq: 8,
              item: {
                entityType: entry.entityType,
                entityId: entry.entityId,
                version: 2,
                updatedAt: "2026-10-19T08:00:02.000Z",
                deletedAt: null,
                data: { title: "محلی", plainText: "تازه" }
              }
            })),
            cursor: 8
          }
        }
      })
    )

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await engine.sync(store)
    warn.mockRestore()

    // Acked, so the queue is empty and the badge cannot be stuck…
    expect(await store.pendingCount()).toBe(0)
    // …but the mirror row is still marked with the server's reason.
    expect((await store.get("note", id))!.syncError).toMatchObject({
      code: "InvalidPatch",
      message: "The patch value for \"title\" is not valid",
      clientMutationId: expect.any(String)
    })
    expect(await store.failedCount()).toBe(1)

    // A new local edit does not erase the unresolved failure…
    await store.writeLocal({
      entityType: "note",
      entityId: id,
      op: "upsert",
      patch: { plainText: "تازه" },
      now: "2026-10-19T08:00:01.000Z"
    })
    expect((await store.get("note", id))!.syncError).not.toBeUndefined()

    // …and a later applied result for the same entity clears it.
    await engine.sync(store)
    expect(await store.pendingCount()).toBe(0)
    expect((await store.get("note", id))!.syncError).toBeUndefined()
    expect(await store.failedCount()).toBe(0)
    store.close()
  })

  it("keeps a rejected marker across a store reopen", async () => {
    const userId = freshUser()
    const id = uuidV7()
    const first = await openLocalStore(userId)
    await first.writeLocal({
      entityType: "note",
      entityId: id,
      op: "upsert",
      patch: { title: "ماندگار" }
    })
    const engine = createSyncEngine(
      transport({
        push: async (entries) => ({
          results: entries.map((entry) => ({
            _tag: "rejected" as const,
            clientMutationId: entry.clientMutationId,
            entityType: entry.entityType,
            entityId: entry.entityId,
            code: "ValidationError",
            message: "invalid note"
          })),
          cursor: 0
        })
      })
    )

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await engine.sync(first)
    warn.mockRestore()
    first.close()

    const second = await openLocalStore(userId)
    expect((await second.get("note", id))!.syncError).toMatchObject({
      code: "ValidationError"
    })
    second.close()
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

  it("revives a queued habit tap through the logging mutation when the push meets a tombstone (#64)", async () => {
    const store = await open()
    const habitId = uuidV7()
    const entryId = uuidV7()
    const now = "2026-10-20T09:30:00.000Z"
    await store.writeLocal({
      entityType: "habitEntry",
      entityId: entryId,
      op: "upsert",
      patch: {
        habitId,
        localDate: "2026-10-20",
        timeZone: "Asia/Tehran",
        status: "done"
      },
      now
    })

    const revived: Array<HabitEntryLogInput> = []
    const engine = createSyncEngine(
      transport({
        push: async (entries) => ({
          // Tombstone-wins: the generic resolver refuses the offline tap.
          results: [
            {
              _tag: "tombstone" as const,
              clientMutationId: entries[0]!.clientMutationId,
              entityType: "habitEntry" as const,
              entityId: entryId,
              version: 2,
              seq: 5,
              item: {
                entityType: "habitEntry" as const,
                entityId: entryId,
                version: 2,
                updatedAt: now,
                deletedAt: now,
                data: { habitId, localDate: "2026-10-20", status: "done" }
              }
            }
          ],
          cursor: 5
        }),
        logHabitEntry: async (input) => {
          revived.push(input)
          return {
            id: entryId,
            habitId,
            ownerId: "user",
            householdId: "household",
            visibility: "shared",
            localDate: "2026-10-20",
            timeZone: "Asia/Tehran",
            status: "done",
            createdAt: now,
            updatedAt: "2026-10-20T09:30:01.000Z",
            version: 3,
            deletedAt: null
          } as HabitEntry
        }
      })
    )

    await engine.sync(store)

    expect(revived).toHaveLength(1)
    expect(revived[0]).toMatchObject({
      habitId,
      localDate: "2026-10-20",
      status: "done",
      clientMutationId: expect.any(String)
    })
    expect(await store.pending()).toHaveLength(0)
    expect(await store.get("habitEntry", entryId)).toMatchObject({
      version: 3,
      deletedAt: null,
      data: { status: "done" }
    })
    store.close()
  })

  it("restores a queued habit undo through RestoreHabit when the push meets a tombstone (#66)", async () => {
    const store = await open()
    const habitId = uuidV7()
    const now = "2026-10-21T09:30:00.000Z"
    // The screen's undo is a local-first empty-patch upsert; tombstone-wins
    // answers it with a tombstone, which the explicit service path repairs.
    await store.writeLocal({
      entityType: "habit",
      entityId: habitId,
      op: "upsert",
      patch: {},
      deletedAt: null,
      now
    })

    const restored: Array<HabitMutationInput> = []
    const engine = createSyncEngine(
      transport({
        push: async (entries) => ({
          results: [
            {
              _tag: "tombstone" as const,
              clientMutationId: entries[0]!.clientMutationId,
              entityType: "habit" as const,
              entityId: habitId,
              version: 2,
              seq: 9,
              item: {
                entityType: "habit" as const,
                entityId: habitId,
                version: 2,
                updatedAt: now,
                deletedAt: now,
                data: {}
              }
            }
          ],
          cursor: 9
        }),
        restoreHabit: async (input) => {
          restored.push(input)
          return {
            id: habitId,
            type: "habit",
            title: "کتاب",
            description: null,
            icon: "📚",
            ownerId: "user",
            householdId: "household",
            visibility: "shared",
            color: null,
            startedOn: "2026-10-01",
            frequency: { _tag: "daily" },
            frequencyHistory: [{ effectiveFrom: "2026-10-01", frequency: { _tag: "daily" } }],
            reminderTime: null,
            timeZone: "Asia/Tehran",
            createdAt: now,
            updatedAt: "2026-10-21T09:30:01.000Z",
            version: 3,
            deletedAt: null
          } as unknown as Habit
        }
      })
    )

    await engine.sync(store)

    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ id: habitId, clientMutationId: expect.any(String) })
    expect(await store.pending()).toHaveLength(0)
    expect(await store.get("habit", habitId)).toMatchObject({
      version: 3,
      deletedAt: null,
      data: { title: "کتاب" }
    })
    store.close()
  })

  it("surfaces a permanent restore refusal instead of swallowing the undo (#66)", async () => {
    const store = await open()
    const habitId = uuidV7()
    const now = "2026-10-21T09:30:00.000Z"
    await store.writeLocal({
      entityType: "habit",
      entityId: habitId,
      op: "upsert",
      patch: {},
      deletedAt: null,
      now
    })

    const engine = createSyncEngine(
      transport({
        push: async (entries) => ({
          results: [
            {
              _tag: "tombstone" as const,
              clientMutationId: entries[0]!.clientMutationId,
              entityType: "habit" as const,
              entityId: habitId,
              version: 2,
              seq: 9,
              item: {
                entityType: "habit" as const,
                entityId: habitId,
                version: 2,
                updatedAt: now,
                deletedAt: now,
                data: {}
              }
            }
          ],
          cursor: 9
        }),
        restoreHabit: async () => {
          throw Object.assign(new Error("the habit was purged"), { _tag: "HabitNotFound" })
        }
      })
    )

    await expect(engine.sync(store)).rejects.toMatchObject({
      name: "HabitRestoreRefused",
      habitId,
      reason: "HabitNotFound"
    })
    // The undo is acked (it can never succeed) and the tombstone is adopted...
    expect(await store.pending()).toHaveLength(0)
    expect((await store.get("habit", habitId))?.deletedAt).not.toBeNull()
    store.close()
  })

  it("leaves the queued habit undo in place when RestoreHabit fails transiently (#66)", async () => {
    const store = await open()
    const habitId = uuidV7()
    await store.writeLocal({
      entityType: "habit",
      entityId: habitId,
      op: "upsert",
      patch: {},
      deletedAt: null
    })

    const engine = createSyncEngine(
      transport({
        push: async (entries) => ({
          results: [
            {
              _tag: "tombstone" as const,
              clientMutationId: entries[0]!.clientMutationId,
              entityType: "habit" as const,
              entityId: habitId,
              version: 2,
              seq: 9
            }
          ],
          cursor: 9
        }),
        restoreHabit: async () => {
          throw new Error("network")
        }
      })
    )

    await expect(engine.sync(store)).rejects.toThrow("network")
    expect(await store.pending()).toHaveLength(1)
    store.close()
  })

  it("keeps a tap queued when the revive path fails transiently (#64)", async () => {
    const store = await open()
    const habitId = uuidV7()
    const entryId = uuidV7()
    await store.writeLocal({
      entityType: "habitEntry",
      entityId: entryId,
      op: "upsert",
      patch: {
        habitId,
        localDate: "2026-10-20",
        timeZone: "Asia/Tehran",
        status: "done"
      }
    })

    const engine = createSyncEngine(
      transport({
        push: async (entries) => ({
          results: [
            {
              _tag: "tombstone" as const,
              clientMutationId: entries[0]!.clientMutationId,
              entityType: "habitEntry" as const,
              entityId: entryId,
              version: 2,
              seq: 1
            }
          ],
          cursor: 1
        }),
        logHabitEntry: async () => {
          throw new Error("network")
        }
      })
    )

    await expect(engine.sync(store)).rejects.toThrow("network")
    // Not acked: the next reconcile retries the revive.
    expect(await store.pending()).toHaveLength(1)
    store.close()
  })

  it("repairs a habit tap rejected for a unique day by adopting the server row (#64)", async () => {
    const store = await open()
    const habitId = uuidV7()
    const localId = uuidV7()
    const serverId = uuidV7()
    const now = "2026-10-20T09:30:00.000Z"
    await store.writeLocal({
      entityType: "habitEntry",
      entityId: localId,
      op: "upsert",
      patch: {
        habitId,
        localDate: "2026-10-20",
        timeZone: "Asia/Tehran",
        status: "partial"
      },
      now
    })

    const engine = createSyncEngine(
      transport({
        push: async (entries) => ({
          results: [
            {
              _tag: "rejected" as const,
              clientMutationId: entries[0]!.clientMutationId,
              entityType: "habitEntry" as const,
              entityId: localId,
              code: "UniqueViolation",
              message: "Insert conflicted with a row that is already live"
            }
          ],
          cursor: 0
        }),
        logHabitEntry: async () =>
          ({
            id: serverId,
            habitId,
            ownerId: "user",
            householdId: "household",
            visibility: "shared",
            localDate: "2026-10-20",
            timeZone: "Asia/Tehran",
            status: "partial",
            createdAt: now,
            updatedAt: "2026-10-20T09:30:01.000Z",
            version: 2,
            deletedAt: null
          }) as HabitEntry
      })
    )

    await engine.sync(store)

    expect(await store.pending()).toHaveLength(0)
    // Exactly one mirror row for the day: the local placeholder is dropped and
    // the server's row is adopted.
    const live = await store.list("habitEntry")
    expect(live.map((row) => row.entityId)).toEqual([serverId])
    expect(live[0]).toMatchObject({
      version: 2,
      deletedAt: null,
      data: { status: "partial" }
    })
    store.close()
  })

  it("converges two queued taps when the repair adopts a different server id (#64)", async () => {
    const store = await open()
    const habitId = uuidV7()
    const localId = uuidV7()
    const serverId = uuidV7()
    const now = "2026-10-20T09:30:00.000Z"

    // Two taps on the same day: the mirror keeps one id, the outbox two
    // patches. The first tap was already handed to a send, so the second is
    // the next chain link rather than a fold into it.
    await store.writeLocal({
      entityType: "habitEntry",
      entityId: localId,
      op: "upsert",
      patch: { habitId, localDate: "2026-10-20", timeZone: "Asia/Tehran", status: "done" },
      now
    })
    await store.markSent((await store.pending()).map((entry) => entry.clientMutationId))
    await store.writeLocal({
      entityType: "habitEntry",
      entityId: localId,
      op: "upsert",
      patch: { habitId, localDate: "2026-10-20", timeZone: "Asia/Tehran", status: "partial" },
      now
    })

    const revived: Array<HabitEntryLogInput> = []
    let version = 2
    const engine = createSyncEngine(
      transport({
        // The day is owned by another device under `serverId`, so every push of
        // the local id is refused as a duplicate day.
        push: async (entries) => ({
          results: entries.map((entry) => ({
            _tag: "rejected" as const,
            clientMutationId: entry.clientMutationId,
            entityType: entry.entityType,
            entityId: entry.entityId,
            code: "UniqueViolation",
            message: "Insert conflicted with a row that is already live"
          })),
          cursor: 0
        }),
        logHabitEntry: async (input) => {
          revived.push(input)
          version += 1
          return {
            id: serverId,
            habitId,
            ownerId: "user",
            householdId: "household",
            visibility: "shared",
            localDate: "2026-10-20",
            timeZone: "Asia/Tehran",
            status: input.status,
            createdAt: now,
            updatedAt: now,
            version,
            deletedAt: null
          } as HabitEntry
        }
      })
    )

    await engine.sync(store)

    // The repair runs for each queued tap and never loops: both patches land on
    // the server's row, the outbox drains, and the mirror holds exactly one row.
    expect(revived.map((input) => input.status)).toEqual(["done", "partial"])
    expect(await store.pending()).toHaveLength(0)
    const live = await store.list("habitEntry")
    expect(live.map((row) => row.entityId)).toEqual([serverId])
    expect(live[0]).toMatchObject({ version: 4, deletedAt: null, data: { status: "partial" } })
    store.close()
  })
})
