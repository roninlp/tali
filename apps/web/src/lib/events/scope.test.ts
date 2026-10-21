import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it } from "vitest"
import {
  Event,
  uuidV7,
  type EventId,
  type HouseholdId,
  type RecurrenceRule,
  type UserId
} from "@tali/domain"
import { openLocalStore } from "../local-store/store"
import {
  applyEventScopeInMirror,
  deleteEventWithinScope,
  editEventWithinScope,
  newScopedIds
} from "./scope"

/**
 * Ticket #62 at the edit-scope seam: the calendar must offer the real #58
 * choice, so both paths are pinned here — "this occurrence" is one exception on
 * the series row, "this and following" is the split (truncated head + new
 * tail), and each writes the mirror + outbox so the choice works offline.
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
})

describe("mirror commit", () => {
  beforeEach(() => {
    // Each test gets a clean database (one per user id).
  })

  it("writes both halves of a split as local mutations", async () => {
    const store = await openLocalStore(USER)
    try {
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

      await applyEventScopeInMirror(store, change, NOW)

      const head = await store.get("event", series.id)
      expect(head?.data.recurrence).toMatchObject({ end: { _tag: "until", date: "2026-03-31" } })
      const tail = await store.get("event", ids.followingId)
      expect(tail?.data.title).toBe("نیمهٔ دوم")
      expect(tail?.data.recurrence).toEqual(weekly)
      const queued = await store.pending()
      expect(queued.map((entry) => entry.entityId).sort()).toEqual(
        [series.id, ids.followingId].sort()
      )
    } finally {
      store.close()
    }
  })
})
