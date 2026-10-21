import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { uuidV7 } from "../ids.js"
import type { HouseholdId, UserId } from "../common.js"
import type { EventExceptionId, EventId, OccasionId } from "./common.js"
import {
  Event,
  EventCreateInput,
  EventPatch,
  EventTiming,
  ReminderLink
} from "./index.js"

/**
 * Ticket #57 exit criterion, at the model seam: the event shape round-trips
 * through its Schema model, the timing union keeps its two shapes apart, and
 * the malformed payloads a client could send are rejected at the edge.
 */

const NOW = "2026-10-20T09:30:00.000Z"
const USER = "user-1" as UserId
const HOUSEHOLD = "household-1" as HouseholdId

const base = {
  type: "event" as const,
  ownerId: USER,
  householdId: HOUSEHOLD,
  visibility: "shared" as const,
  color: null,
  createdAt: NOW,
  updatedAt: NOW,
  version: 1,
  deletedAt: null
}

const timedEvent = {
  ...base,
  id: uuidV7(1_700_000_000_020) as EventId,
  title: "جلسهٔ هم‌اندیشی",
  description: "برنامه‌ریزی هفته",
  location: "خانه",
  category: "work",
  people: ["سارا"],
  timing: { _tag: "timed" as const, start: NOW, end: NOW },
  timeZone: "Asia/Tehran",
  recurrence: null,
  exceptions: [],
  occasionId: null
}

const allDayEvent = {
  ...base,
  id: uuidV7(1_700_000_000_021) as EventId,
  title: "تعطیلی",
  description: null,
  location: null,
  category: null,
  people: [],
  timing: { _tag: "allDay" as const, date: "2026-10-21" },
  timeZone: "Asia/Tehran",
  recurrence: null,
  exceptions: [],
  occasionId: null
}

describe("Event model", () => {
  it("round-trips a timed event", () => {
    const decoded = Schema.decodeUnknownSync(Event)(timedEvent)
    expect(decoded.timing).toEqual(timedEvent.timing)
    expect(decoded.people).toEqual(["سارا"])
    expect(decoded.title).toBe("جلسهٔ هم‌اندیشی")
  })

  it("round-trips an all-day event", () => {
    const decoded = Schema.decodeUnknownSync(Event)(allDayEvent)
    expect(decoded.timing).toEqual({ _tag: "allDay", date: "2026-10-21" })
  })

  it("keeps the two timing shapes apart", () => {
    expect(() => Schema.decodeUnknownSync(EventTiming)({ _tag: "timed", start: NOW })).toThrow()
    expect(() => Schema.decodeUnknownSync(EventTiming)({ _tag: "allDay", date: "1403/07/28" }))
      .toThrow()
    expect(() => Schema.decodeUnknownSync(EventTiming)({ _tag: "allDay", date: "2026-10-21" }))
      .not.toThrow()
  })

  it("rejects a malformed event", () => {
    expect(() => Schema.decodeUnknownSync(Event)({ ...timedEvent, type: "task" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Event)({ ...timedEvent, id: "not-a-uuid" })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Event)({ ...timedEvent, timeZone: "Mars/Olympus" })
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(Event)({ ...timedEvent, people: [""] })).toThrow()
  })

  it("carries the structured recurrence rule and the exception list", () => {
    const recurrence = {
      frequency: "weekly" as const,
      interval: 2,
      byDay: [6],
      end: { _tag: "until" as const, date: "2026-12-31" }
    }
    const exceptions = [
      {
        id: uuidV7(1_700_000_000_022) as EventExceptionId,
        instanceId: "2026-10-28",
        action: "override" as const,
        overrides: { title: "جلسهٔ کوتاه" },
        createdAt: NOW
      }
    ]
    const decoded = Schema.decodeUnknownSync(Event)({
      ...timedEvent,
      recurrence,
      exceptions
    })
    expect(decoded.recurrence).toEqual(recurrence)
    expect(decoded.exceptions).toEqual(exceptions)
  })

  it("keeps the reserved relations", () => {    const occasionId = uuidV7(1_700_000_000_023) as OccasionId
    const decoded = Schema.decodeUnknownSync(Event)({ ...timedEvent, occasionId })
    expect(decoded.occasionId).toBe(occasionId)

    const link = Schema.decodeUnknownSync(ReminderLink)({
      _tag: "event",
      eventId: timedEvent.id
    })
    expect(link).toEqual({ _tag: "event", eventId: timedEvent.id })
    expect(() =>
      Schema.decodeUnknownSync(ReminderLink)({ _tag: "event", eventId: "not-a-uuid" })
    ).toThrow()
  })

  it("decodes a minimal create input and a one-field patch", () => {
    const created = Schema.decodeUnknownSync(EventCreateInput)({
      clientMutationId: "m-1",
      title: "قرار",
      timing: { _tag: "allDay", date: "2026-10-21" }
    })
    expect(created).toEqual({
      clientMutationId: "m-1",
      title: "قرار",
      timing: { _tag: "allDay", date: "2026-10-21" }
    })

    const patched = Schema.decodeUnknownSync(EventPatch)({ title: "قرار تازه" })
    expect(patched).toEqual({ title: "قرار تازه" })

    // A create without a time is not an event.
    expect(() =>
      Schema.decodeUnknownSync(EventCreateInput)({ clientMutationId: "m-2", title: "قرار" })
    ).toThrow()
  })
})
