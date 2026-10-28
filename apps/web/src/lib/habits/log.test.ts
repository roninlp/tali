import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import {
  HabitEntryOutOfWindow,
  type SyncPushEntry,
  type SyncPushResponse,
  uuidV7
} from "@tali/domain"
import { openLocalStore } from "../local-store/store"
import type { LocalStore } from "../local-store/types"
import { createSyncEngine, type SyncTransport } from "../sync-engine"
import { findHabitEntryRecord, habitEntryStatusOf, tapHabitEntry } from "./log"

/**
 * Ticket #64 at the client seam: a tap writes the mirror + outbox first, and a
 * second tap replaces the same day's row instead of minting a second one. The
 * ≤ 7-day window is refused before anything is written.
 */

const TZ = "Asia/Tehran"
/** 2026-10-20T09:30Z = 13:00 on 20 October in Tehran. */
const NOW = "2026-10-20T09:30:00.000Z"

const open = (): Promise<LocalStore> => openLocalStore(`habit-${uuidV7()}`)

const habitId = (): string => uuidV7()

describe("habit tap", () => {
  it("writes one mirror row and one outbox entry before any sync", async () => {
    const store = await open()
    const habit = habitId()

    const row = await tapHabitEntry(store, {
      habitId: habit,
      localDate: "2026-10-20",
      timeZone: TZ,
      now: NOW
    })

    expect(row).toMatchObject({
      entityType: "habitEntry",
      deletedAt: null,
      version: 0
    })
    expect(row.data).toMatchObject({
      habitId: habit,
      localDate: "2026-10-20",
      timeZone: TZ,
      status: "done"
    })

    const live = await store.list("habitEntry")
    expect(live).toHaveLength(1)
    expect(live[0]!.entityId).toBe(row.entityId)

    const pending = await store.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      entityType: "habitEntry",
      entityId: row.entityId,
      op: "upsert",
      baseVersion: 0,
      patch: {
        habitId: habit,
        localDate: "2026-10-20",
        status: "done"
      }
    })

    store.close()
  })

  it("cycles the status and replaces the same row on a second tap", async () => {
    const store = await open()
    const habit = habitId()

    const first = await tapHabitEntry(store, {
      habitId: habit,
      localDate: "2026-10-20",
      timeZone: TZ,
      now: NOW
    })
    const second = await tapHabitEntry(store, {
      habitId: habit,
      localDate: "2026-10-20",
      timeZone: TZ,
      now: NOW
    })
    const third = await tapHabitEntry(store, {
      habitId: habit,
      localDate: "2026-10-20",
      timeZone: TZ,
      now: NOW
    })

    expect(second.entityId).toBe(first.entityId)
    expect(third.entityId).toBe(first.entityId)
    expect(habitEntryStatusOf(second)).toBe("partial")
    expect(habitEntryStatusOf(third)).toBe("missed")

    const live = await store.list("habitEntry")
    expect(live).toHaveLength(1)
    // Nothing has been sent, so the day's taps are one mutation: the last
    // status wins and the queue holds one patch, not one per tap.
    const pending = await store.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      entityId: first.entityId,
      op: "upsert",
      patch: { habitId: habit, localDate: "2026-10-20", status: "missed" }
    })

    store.close()
  })

  it("refuses an eight-day-old tap before writing anything", async () => {
    const store = await open()

    const failure = await tapHabitEntry(store, {
      habitId: habitId(),
      localDate: "2026-10-12",
      timeZone: TZ,
      now: NOW
    }).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(HabitEntryOutOfWindow)
    expect(failure).toMatchObject({
      _tag: "HabitEntryOutOfWindow",
      localDate: "2026-10-12",
      earliest: "2026-10-13",
      latest: "2026-10-20"
    })
    expect(await store.list("habitEntry")).toEqual([])
    expect(await store.pending()).toEqual([])

    store.close()
  })

  it("drains a tapped day through the normal push afterwards", async () => {
    const store = await open()
    const habit = habitId()

    const row = await tapHabitEntry(store, {
      habitId: habit,
      localDate: "2026-10-20",
      timeZone: TZ,
      now: NOW
    })

    const pushed: Array<ReadonlyArray<SyncPushEntry>> = []
    const transport: SyncTransport = {
      pull: async (cursor) => ({
        entries: [],
        items: [],
        removed: [],
        nextCursor: cursor,
        hasMore: false,
        resetRequired: false
      }),
      bootstrap: async () => ({ items: [], nextOffset: 0, hasMore: false, cursor: 0 }),
      push: async (entries) => {
        pushed.push(entries)
        const response: SyncPushResponse = {
          results: entries.map((entry) => ({
            _tag: "applied" as const,
            clientMutationId: entry.clientMutationId,
            entityType: entry.entityType,
            entityId: entry.entityId,
            version: 1,
            seq: 3,
            item: {
              entityType: entry.entityType,
              entityId: entry.entityId,
              version: 1,
              updatedAt: NOW,
              deletedAt: null,
              data: { ...entry.patch }
            }
          })),
          cursor: 3
        }
        return response
      }
    }

    await createSyncEngine(transport).sync(store)

    expect(pushed).toHaveLength(1)
    expect(pushed[0]![0]).toMatchObject({
      entityType: "habitEntry",
      entityId: row.entityId,
      baseVersion: 0,
      op: "upsert",
      patch: {
        habitId: habit,
        localDate: "2026-10-20",
        timeZone: TZ,
        status: "done"
      }
    })
    expect(await store.pending()).toEqual([])
    expect(await store.get("habitEntry", row.entityId)).toMatchObject({
      version: 1,
      deletedAt: null,
      data: { status: "done" }
    })

    store.close()
  })

  it("accepts the seventh day back", async () => {
    const store = await open()
    const row = await tapHabitEntry(store, {
      habitId: habitId(),
      localDate: "2026-10-13",
      timeZone: TZ,
      now: NOW
    })
    expect(row.data.localDate).toBe("2026-10-13")
    store.close()
  })

  it("revives a tombstoned local day at the same id", async () => {
    const store = await open()
    const habit = habitId()
    const entityId = uuidV7()

    await store.mergeServer([
      {
        entityType: "habitEntry",
        entityId,
        version: 1,
        updatedAt: NOW,
        deletedAt: NOW,
        data: {
          habitId: habit,
          localDate: "2026-10-20",
          timeZone: TZ,
          status: "done"
        }
      }
    ])
    // The day exists only as a tombstone in the mirror.
    expect(await store.list("habitEntry")).toEqual([])
    const tombstone = await findHabitEntryRecord(store, habit, "2026-10-20")
    expect(tombstone?.entityId).toBe(entityId)

    const revived = await tapHabitEntry(store, {
      habitId: habit,
      localDate: "2026-10-20",
      timeZone: TZ,
      now: NOW
    })

    expect(revived.entityId).toBe(entityId)
    expect(revived.deletedAt).toBeNull()
    // The cycle continues from the tombstoned row's last answer, not from null.
    expect(revived.data.status).toBe("partial")
    expect((await store.list("habitEntry")).map((row) => row.entityId)).toEqual([entityId])
    expect((await store.pending())).toHaveLength(1)

    store.close()
  })
})
