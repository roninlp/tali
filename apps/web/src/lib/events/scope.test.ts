import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it } from "vitest"
import {
  Event,
  uuidV7,
  type EventId,
  type EventOccurrenceChange,
  type EventOccurrenceDeleteInput,
  type EventOccurrenceEditInput,
  type HouseholdId,
  type RecurrenceRule,
  type UserId
} from "@tali/domain"
import { openLocalStore } from "../local-store/store"
import type { LocalStore } from "../local-store/types"
import {
  SPLIT_REQUIRES_SERVER,
  applyEventScopeInMirror,
  commitEventScope,
  deleteEventWithinScope,
  editEventWithinScope,
  newScopedIds,
  type EventScopeIds,
  type EventScopeServer
} from "./scope"

/**
 * Ticket #62 at the edit-scope seam: the calendar must offer the real #58
 * choice without weakening its invariants.
 *
 * - "this occurrence" is one exception on the series row (a single-row LWW
 *   write, safe in the outbox).
 * - "this and following" is a two-row split. Online it goes through the
 *   service RPC (CAS gate, gated tail, replay keys); offline the single-row
 *   scopes still work and a split edit is refused rather than queued as two
 *   independent LWW rows.
 */

const NOW = "2026-03-25T10:00:00.000Z"
const TZ = "Asia/Tehran"
const USER = uuidV7() as UserId
const HOUSEHOLD = uuidV7() as HouseholdId

const weekly: RecurrenceRule = {
  frequency: "weekly",
  interval: 1,
  byDay: [3],
  end: { _tag: "never" }
}

const event = (input: {
  readonly recurrence?: RecurrenceRule | null
  readonly timing?: Event["timing"]
  readonly exceptions?: Event["exceptions"]
} = {}): Event =>
  new Event({
    id: uuidV7() as EventId,
    type: "event",
    title: "جلسهٔ هفتگی",
    description: null,
    location: null,
    category: null,
    people: [],
    timing: input.timing ?? { _tag: "allDay", date: "2026-03-18" },
    timeZone: TZ,
    recurrence: input.recurrence === undefined ? weekly : input.recurrence,
    exceptions: input.exceptions ?? [],
    occasionId: null,
    ownerId: USER,
    householdId: HOUSEHOLD,
    visibility: "shared",
    color: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 3,
    deletedAt: null
  })

const withScope = (overrides = {}) => ({ ...newScopedIds(), now: NOW, ...overrides })

const freshStore = (): Promise<LocalStore> => openLocalStore(uuidV7())

interface FakeServer {
  readonly server: EventScopeServer
  readonly editCalls: Array<EventOccurrenceEditInput>
  readonly deleteCalls: Array<EventOccurrenceDeleteInput>
}

/**
 * A stand-in for the service: same pure builders, using the ids the caller
 * minted (which is what the real RPC does).
 */
const fakeServer = (series: Event, now = NOW): FakeServer => {
  const editCalls: Array<EventOccurrenceEditInput> = []
  const deleteCalls: Array<EventOccurrenceDeleteInput> = []
  return {
    editCalls,
    deleteCalls,
    server: {
      editOccurrence: async (input) => {
        editCalls.push(input)
        const change = editEventWithinScope({
          event: series,
          instanceId: input.instanceId,
          overrides: input.overrides,
          scope: input.scope,
          exceptionId: input.exceptionId ?? uuidV7(),
          followingId: input.followingId ?? uuidV7(),
          now
        })
        return { series: change.series, following: change.following }
      },
      deleteOccurrence: async (input) => {
        deleteCalls.push(input)
        const change = deleteEventWithinScope({
          event: series,
          instanceId: input.instanceId,
          scope: input.scope,
          exceptionId: input.exceptionId ?? uuidV7(),
          followingId: uuidV7(),
          now
        })
        return { series: change.series, following: null }
      }
    }
  }
}

describe("edit scope — this occurrence", () => {
  it("adds one override exception and leaves the rule alone", () => {
    const series = event()
    const change = editEventWithinScope({
      ...withScope(),
      event: series,
      instanceId: "2026-03-25",
      overrides: { title: "جلسهٔ ویژه" },
      scope: "thisOccurrence"
    })

    expect(change.following).toBeNull()
    expect(change.series.id).toBe(series.id)
    expect(change.series.recurrence).toEqual(weekly)
    expect(change.series.version).toBe(series.version + 1)
    expect(change.series.exceptions).toHaveLength(1)
    expect(change.series.exceptions[0]).toMatchObject({
      instanceId: "2026-03-25",
      action: "override",
      overrides: { title: "جلسهٔ ویژه" }
    })
  })

  it("moves only the chosen occurrence's timing", () => {
    const series = event()
    const change = editEventWithinScope({
      ...withScope(),
      event: series,
      instanceId: "2026-03-25",
      overrides: { timing: { _tag: "allDay", date: "2026-03-26" } },
      scope: "thisOccurrence"
    })

    expect(change.series.timing).toEqual({ _tag: "allDay", date: "2026-03-18" })
    expect(change.series.exceptions[0]!.overrides).toEqual({
      timing: { _tag: "allDay", date: "2026-03-26" }
    })
  })

  it("deletes one occurrence without touching the schedule", () => {
    const series = event()
    const change = deleteEventWithinScope({
      ...withScope(),
      event: series,
      instanceId: "2026-04-01",
      scope: "thisOccurrence"
    })

    expect(change.following).toBeNull()
    expect(change.series.deletedAt).toBeNull()
    expect(change.series.recurrence).toEqual(weekly)
    expect(change.series.exceptions[0]).toMatchObject({
      instanceId: "2026-04-01",
      action: "delete"
    })
  })
})

describe("edit scope — this and following", () => {
  it("splits the series and keeps the rule in phase", () => {
    const series = event()
    const ids = newScopedIds()
    const change = editEventWithinScope({
      ...withScope(),
      event: series,
      instanceId: "2026-04-01",
      overrides: { title: "جلسهٔ تازه" },
      scope: "thisAndFollowing",
      exceptionId: ids.exceptionId,
      followingId: ids.followingId
    })

    expect(change.following).not.toBeNull()
    expect(change.following!.id).toBe(ids.followingId)
    expect(change.following!.title).toBe("جلسهٔ تازه")
    expect(change.following!.recurrence).toEqual(weekly)
    // The head is truncated the day before the split.
    expect(change.series.recurrence).toEqual({
      ...weekly,
      end: { _tag: "until", date: "2026-03-31" }
    })
    // The tail is anchored on the split occurrence itself.
    expect(change.following!.timing).toEqual({ _tag: "allDay", date: "2026-04-01" })
    expect(change.series.version).toBe(series.version + 1)
    expect(change.following!.version).toBe(1)
  })

  it("partitions the exceptions around the split", () => {
    const series = event({
      exceptions: [
        {
          id: uuidV7() as Event["exceptions"][number]["id"],
          instanceId: "2026-03-25",
          action: "override",
          overrides: { title: "قبل" },
          createdAt: NOW
        },
        {
          id: uuidV7() as Event["exceptions"][number]["id"],
          instanceId: "2026-04-08",
          action: "override",
          overrides: { title: "بعد" },
          createdAt: NOW
        }
      ]
    })
    const ids = newScopedIds()
    const change = editEventWithinScope({
      ...withScope(),
      event: series,
      instanceId: "2026-04-01",
      overrides: { title: "تازه" },
      scope: "thisAndFollowing",
      exceptionId: ids.exceptionId,
      followingId: ids.followingId
    })

    expect(change.series.exceptions.map((entry) => entry.instanceId)).toEqual(["2026-03-25"])
    expect(change.following!.exceptions.map((entry) => entry.instanceId)).toEqual(["2026-04-08"])
  })

  it("degrades to a whole-series edit at the first occurrence", () => {
    const series = event()
    const ids = newScopedIds()
    const change = editEventWithinScope({
      ...withScope(),
      event: series,
      instanceId: "2026-03-18",
      overrides: { title: "از ابتدا" },
      scope: "thisAndFollowing",
      exceptionId: ids.exceptionId,
      followingId: ids.followingId
    })

    expect(change.following).toBeNull()
    expect(change.series.id).toBe(series.id)
    expect(change.series.title).toBe("از ابتدا")
    expect(change.series.recurrence).toEqual(weekly)
  })

  it("deletes this and following, tombstoning a series cut at its start", () => {
    const series = event()
    const atStart = deleteEventWithinScope({
      ...withScope(),
      event: series,
      instanceId: "2026-03-18",
      scope: "thisAndFollowing"
    })
    expect(atStart.series.deletedAt).not.toBeNull()

    const later = deleteEventWithinScope({
      ...withScope(),
      event: series,
      instanceId: "2026-04-01",
      scope: "thisAndFollowing"
    })
    expect(later.series.deletedAt).toBeNull()
    expect(later.series.recurrence!.end).toEqual({ _tag: "until", date: "2026-03-31" })
  })

  it("edits a one-off event as a plain series edit", () => {
    const oneOff = event({ recurrence: null })
    const change = editEventWithinScope({
      ...withScope(),
      event: oneOff,
      instanceId: "2026-03-18",
      overrides: { title: "تک‌باره" },
      scope: "thisAndFollowing"
    })

    expect(change.following).toBeNull()
    expect(change.series.title).toBe("تک‌باره")
    expect(change.series.recurrence).toBeNull()
  })

  it("refuses an instance that is not an occurrence of the series", () => {
    // 2026-03-19 is a Thursday; the weekly rule is Wednesdays.
    expect(() =>
      editEventWithinScope({
        ...withScope(),
        event: event(),
        instanceId: "2026-03-19",
        overrides: { title: "نامعتبر" },
        scope: "thisAndFollowing"
      })
    ).toThrow(/مجموعه نیست/)

    expect(() =>
      editEventWithinScope({
        ...withScope(),
        event: event(),
        instanceId: "2026-03-19",
        overrides: { title: "نامعتبر" },
        scope: "thisOccurrence"
      })
    ).toThrow(/مجموعه نیست/)

    // A one-off has exactly one occurrence: its own anchor.
    expect(() =>
      editEventWithinScope({
        ...withScope(),
        event: event({ recurrence: null }),
        instanceId: "2026-03-19",
        overrides: { title: "نامعتبر" },
        scope: "thisOccurrence"
      })
    ).toThrow(/مجموعه نیست/)
  })
})

describe("mirror commit — single-row scopes", () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await freshStore()
  })

  it("writes one local row and queues it", async () => {
    const series = event()
    const change = editEventWithinScope({
      ...withScope(),
      event: series,
      instanceId: "2026-03-25",
      overrides: { title: "محلی" },
      scope: "thisOccurrence"
    })

    await applyEventScopeInMirror(store, change, NOW)

    const row = await store.get("event", series.id)
    expect((row?.data.exceptions as ReadonlyArray<unknown>)).toHaveLength(1)
    const queued = await store.pending()
    expect(queued).toHaveLength(1)
    expect(queued[0]!.entityId).toBe(series.id)
    store.close()
  })

  it("refuses to queue a split, which needs the service's gated batch", async () => {
    const series = event()
    const ids = newScopedIds()
    const change = editEventWithinScope({
      ...withScope(),
      event: series,
      instanceId: "2026-04-01",
      overrides: { title: "نیمهٔ دوم" },
      scope: "thisAndFollowing",
      exceptionId: ids.exceptionId,
      followingId: ids.followingId
    })

    await expect(applyEventScopeInMirror(store, change, NOW)).rejects.toThrow(
      SPLIT_REQUIRES_SERVER
    )
    expect(await store.pending()).toHaveLength(0)
    expect(await store.get("event", series.id)).toBeUndefined()
    store.close()
  })
})

describe("commitEventScope — transport choice", () => {
  let store: LocalStore
  let series: Event
  let ids: EventScopeIds

  beforeEach(async () => {
    store = await freshStore()
    series = event()
    ids = newScopedIds()
  })

  it("sends a connected series split through the RPC and adopts both rows", async () => {
    const { server, editCalls } = fakeServer(series)
    const result = await commitEventScope({
      store,
      online: true,
      server,
      event: series,
      instanceId: "2026-04-01",
      action: "edit",
      scope: "thisAndFollowing",
      overrides: { title: "نیمهٔ دوم" },
      ids,
      now: NOW
    })

    expect(result.source).toBe("server")
    expect(editCalls).toHaveLength(1)
    expect(editCalls[0]).toMatchObject({
      id: series.id,
      instanceId: "2026-04-01",
      clientMutationId: ids.clientMutationId,
      scope: "thisAndFollowing",
      exceptionId: ids.exceptionId,
      followingId: ids.followingId,
      followingMutationId: ids.followingMutationId
    })
    // The authoritative rows land in the mirror but are not queued again.
    expect(await store.pending()).toHaveLength(0)
    const head = await store.get("event", series.id)
    expect(head?.data.recurrence).toMatchObject({
      end: { _tag: "until", date: "2026-03-31" }
    })
    const tail = await store.get("event", ids.followingId)
    expect(tail?.data.title).toBe("نیمهٔ دوم")
    expect(tail?.data.timing).toEqual({ _tag: "allDay", date: "2026-04-01" })
    store.close()
  })

  it("sends a connected series 'this occurrence' edit through the RPC", async () => {
    const { server, editCalls } = fakeServer(series)
    const result = await commitEventScope({
      store,
      online: true,
      server,
      event: series,
      instanceId: "2026-03-25",
      action: "edit",
      scope: "thisOccurrence",
      overrides: { title: "یک روز" },
      ids,
      now: NOW
    })

    expect(result.source).toBe("server")
    expect(editCalls[0]).not.toHaveProperty("followingId")
    expect(await store.pending()).toHaveLength(0)
    const head = await store.get("event", series.id)
    expect(head?.data.exceptions).toHaveLength(1)
    store.close()
  })

  it("surfaces an RPC failure without replaying it locally", async () => {
    const server: EventScopeServer = {
      editOccurrence: async () => {
        throw new Error("network")
      },
      deleteOccurrence: async () => {
        throw new Error("network")
      }
    }
    await expect(
      commitEventScope({
        store,
        online: true,
        server,
        event: series,
        instanceId: "2026-04-01",
        action: "edit",
        scope: "thisAndFollowing",
        overrides: { title: "نیمهٔ دوم" },
        ids,
        now: NOW
      })
    ).rejects.toThrow("network")

    // A lost response may have committed; a second generic push could mint a
    // second tail. Nothing is queued or written locally.
    expect(await store.pending()).toHaveLength(0)
    expect(await store.get("event", series.id)).toBeUndefined()
    expect(await store.get("event", ids.followingId)).toBeUndefined()
    store.close()
  })

  it("keeps 'this occurrence' local-first while offline", async () => {
    const { server, editCalls } = fakeServer(series)
    const result = await commitEventScope({
      store,
      online: false,
      server,
      event: series,
      instanceId: "2026-03-25",
      action: "edit",
      scope: "thisOccurrence",
      overrides: { title: "آفلاین" },
      ids,
      now: NOW
    })

    expect(result.source).toBe("mirror")
    expect(editCalls).toHaveLength(0)
    expect(await store.pending()).toHaveLength(1)
    const head = await store.get("event", series.id)
    expect(head?.data.exceptions).toHaveLength(1)
    store.close()
  })

  it("keeps 'delete this and following' local while offline (one truncate row)", async () => {
    const { server, deleteCalls } = fakeServer(series)
    const result = await commitEventScope({
      store,
      online: false,
      server,
      event: series,
      instanceId: "2026-04-01",
      action: "delete",
      scope: "thisAndFollowing",
      overrides: {},
      ids,
      now: NOW
    })

    expect(result.source).toBe("mirror")
    expect(deleteCalls).toHaveLength(0)
    expect(await store.pending()).toHaveLength(1)
    expect(await store.get("event", ids.followingId)).toBeUndefined()
    const head = await store.get("event", series.id)
    expect(head?.deletedAt).toBeNull()
    expect(head?.data.recurrence).toMatchObject({
      end: { _tag: "until", date: "2026-03-31" }
    })
    store.close()
  })

  it("refuses a split edit offline instead of queueing two LWW rows", async () => {
    const { server, editCalls } = fakeServer(series)
    await expect(
      commitEventScope({
        store,
        online: false,
        server,
        event: series,
        instanceId: "2026-04-01",
        action: "edit",
        scope: "thisAndFollowing",
        overrides: { title: "نیمهٔ دوم" },
        ids,
        now: NOW
      })
    ).rejects.toThrow(SPLIT_REQUIRES_SERVER)

    expect(editCalls).toHaveLength(0)
    expect(await store.pending()).toHaveLength(0)
    store.close()
  })

  it("refuses a split edit while the head still has an unsent mutation", async () => {
    await store.writeLocal({
      entityType: "event",
      entityId: series.id,
      op: "upsert",
      patch: { title: "ویرایش قبلی" },
      now: NOW
    })
    const { server, editCalls } = fakeServer(series)

    await expect(
      commitEventScope({
        store,
        online: true,
        server,
        event: series,
        instanceId: "2026-04-01",
        action: "edit",
        scope: "thisAndFollowing",
        overrides: { title: "نیمهٔ دوم" },
        ids,
        now: NOW
      })
    ).rejects.toThrow(SPLIT_REQUIRES_SERVER)

    expect(editCalls).toHaveLength(0)
    // The existing mutation is untouched; no split rows were added.
    expect(await store.pending()).toHaveLength(1)
    expect(await store.get("event", ids.followingId)).toBeUndefined()
    store.close()
  })

  it("keeps a one-off edit local even while online (no series, no gate)", async () => {
    const oneOff = event({ recurrence: null })
    const { server, editCalls } = fakeServer(oneOff)
    const result = await commitEventScope({
      store,
      online: true,
      server,
      event: oneOff,
      instanceId: "2026-03-18",
      action: "edit",
      scope: "thisOccurrence",
      overrides: { title: "تک‌بارهٔ تازه" },
      ids,
      now: NOW
    })

    expect(result.source).toBe("mirror")
    expect(editCalls).toHaveLength(0)
    expect(await store.pending()).toHaveLength(1)
    store.close()
  })
})
