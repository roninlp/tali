import { describe, expect, it } from "vitest"
import { uuidV7 } from "../ids.js"
import type { HouseholdId, UserId } from "../common.js"
import type { RecurrenceRule } from "../recurrence.js"
import type { EventExceptionId, EventId, LocalDate } from "./common.js"
import { Event } from "./event.js"
import {
  deleteEventOccurrence,
  eventAnchorDate,
  eventOccurrences,
  eventTimingOn,
  isEventOccurrence,
  localDayBefore,
  overrideEventOccurrence,
  patchEventSeries,
  splitEventSeries,
  trashEvent,
  truncateEventSeries,
  type EventOccurrenceSource
} from "./event-recurrence.js"

/**
 * Ticket #58, at the pure seam: a series expands into its window through the
 * #38 engine (Jalali leap months and DST included), one occurrence can deviate
 * without changing the series, and "this and following" splits the series.
 */

const NOW = "2026-10-20T09:30:00.000Z"
const USER = "user-a" as UserId
const HOUSEHOLD = "household-a" as HouseholdId
const TEHRAN = "Asia/Tehran"

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

/** Two weeks of Wednesdays (2026-10-21 is a Wednesday), count-bounded. */
const weeklyTen: RecurrenceRule = {
  frequency: "weekly",
  interval: 1,
  byDay: [3],
  end: { _tag: "count", count: 10 }
}

/** 10:00–11:00 Tehran time on the anchor Wednesday. */
const series = (overrides: Partial<ConstructorParameters<typeof Event>[0]> = {}): Event =>
  new Event({
    ...base,
    id: uuidV7() as EventId,
    title: "جلسهٔ هفتگی",
    description: "برنامه‌ریزی",
    location: "خانه",
    category: "work",
    people: ["سارا"],
    timing: {
      _tag: "timed",
      start: "2026-10-21T06:30:00.000Z",
      end: "2026-10-21T07:30:00.000Z"
    },
    timeZone: TEHRAN,
    recurrence: weeklyTen,
    exceptions: [],
    occasionId: null,
    ...overrides
  } as never)

const source = (event: Event): EventOccurrenceSource => event

const dates = (occurrences: ReadonlyArray<{ readonly instanceId: string }>): ReadonlyArray<string> =>
  occurrences.map((occurrence) => occurrence.instanceId)

describe("eventOccurrences", () => {
  it("expands a weekly series over its window and marks generated occurrences read-only", () => {
    const event = series()
    const occurrences = eventOccurrences({
      events: [source(event)],
      from: "2026-10-18",
      to: "2026-10-31",
      timeZone: TEHRAN
    })

    expect(dates(occurrences)).toEqual([
      "2026-10-21",
      "2026-10-28"
    ])
    // The anchor is the real row; the later occurrence is generated.
    expect(occurrences[0]).toMatchObject({
      key: event.id,
      projected: false,
      recurring: true,
      overridden: false,
      title: "جلسهٔ هفتگی",
      date: "2026-10-21"
    })
    expect(occurrences[1]).toMatchObject({
      key: `${event.id}@2026-10-28`,
      projected: true,
      date: "2026-10-28"
    })
    // The projected occurrence keeps the series' wall-clock time.
    expect(occurrences[1]!.timing).toEqual({
      _tag: "timed",
      start: "2026-10-28T06:30:00.000Z",
      end: "2026-10-28T07:30:00.000Z"
    })
  })

  it("omits a deleted occurrence without shifting the schedule", () => {
    const event = series({
      exceptions: [
        {
          id: uuidV7() as EventExceptionId,
          instanceId: "2026-10-28",
          action: "delete",
          overrides: null,
          createdAt: NOW
        }
      ]
    })

    const occurrences = eventOccurrences({
      events: [source(event)],
      from: "2026-10-18",
      to: "2026-11-08",
      timeZone: TEHRAN
    })

    // The deleted week is absent; the following weeks keep their Wednesdays.
    expect(dates(occurrences)).toEqual([
      "2026-10-21",
      "2026-11-04"
    ])
  })

  it("places an overridden occurrence at its new time and title", () => {
    const event = series({
      exceptions: [
        {
          id: uuidV7() as EventExceptionId,
          instanceId: "2026-10-28",
          action: "override",
          overrides: {
            title: "جلسهٔ کوتاه",
            location: "کافه",
            timing: {
              _tag: "timed",
              start: "2026-10-28T14:00:00.000Z",
              end: "2026-10-28T14:30:00.000Z"
            }
          },
          createdAt: NOW
        }
      ]
    })

    const occurrences = eventOccurrences({
      events: [source(event)],
      from: "2026-10-25",
      to: "2026-10-31",
      timeZone: TEHRAN
    })

    expect(occurrences).toHaveLength(1)
    expect(occurrences[0]).toMatchObject({
      instanceId: "2026-10-28",
      title: "جلسهٔ کوتاه",
      location: "کافه",
      overridden: true,
      projected: true,
      timing: {
        _tag: "timed",
        start: "2026-10-28T14:00:00.000Z",
        end: "2026-10-28T14:30:00.000Z"
      }
    })
  })

  it("shows an occurrence moved into the window from a rule date outside it", () => {
    const event = series({
      exceptions: [
        {
          id: uuidV7() as EventExceptionId,
          instanceId: "2026-11-04",
          action: "override",
          overrides: { timing: { _tag: "allDay", date: "2026-10-29" } },
          createdAt: NOW
        }
      ]
    })

    const occurrences = eventOccurrences({
      events: [source(event)],
      from: "2026-10-25",
      to: "2026-10-31",
      timeZone: TEHRAN
    })

    expect(occurrences.map((occurrence) => [occurrence.instanceId, occurrence.date])).toEqual([
      ["2026-10-28", "2026-10-28"],
      ["2026-11-04", "2026-10-29"]
    ])
  })

  it("keeps Jalali leap months the engine's business", () => {
    // A yearly all-day event on Esfand 30 (1403-12-30 = 2025-03-20): the day
    // only exists in Jalali leap years (1403, 1408, 1412, …).
    const event = series({
      timing: { _tag: "allDay", date: "2025-03-20" },
      recurrence: { frequency: "yearly", interval: 1, end: { _tag: "never" } }
    })

    const occurrences = eventOccurrences({
      events: [source(event)],
      from: "2025-01-01",
      to: "2035-12-31",
      timeZone: TEHRAN
    })

    expect(dates(occurrences)).toEqual([
      "2025-03-20",
      "2030-03-20",
      "2034-03-20"
    ])
    expect(occurrences.every((occurrence) => occurrence.timing._tag === "allDay")).toBe(true)
  })

  it("keeps wall-clock time across a DST change and disambiguates a gap", () => {
    const weeklySunday = (start: string, end: string): Event =>
      series({
        title: "قرار یکشنبه",
        timing: { _tag: "timed", start, end },
        timeZone: "America/New_York",
        recurrence: {
          frequency: "weekly",
          interval: 1,
          byDay: [7],
          end: { _tag: "never" }
        }
      })

    // Sundays at 00:30 local: 05:30Z before the 2026-03-08 spring-forward,
    // 04:30Z after it — the same 00:30 wall time.
    const midnight = eventOccurrences({
      events: [
        source(
          weeklySunday(
            "2026-03-01T05:30:00.000Z",
            "2026-03-01T06:30:00.000Z"
          )
        )
      ],
      from: "2026-03-01",
      to: "2026-03-15",
      timeZone: "America/New_York"
    })
    expect(midnight.map((occurrence) => occurrence.date)).toEqual([
      "2026-03-01",
      "2026-03-08",
      "2026-03-15"
    ])
    expect(
      midnight.map((occurrence) =>
        occurrence.timing._tag === "timed" ? occurrence.timing.start : null
      )
    ).toEqual([
      "2026-03-01T05:30:00.000Z",
      "2026-03-08T05:30:00.000Z",
      "2026-03-15T04:30:00.000Z"
    ])

    // 02:30 on the spring-forward day does not exist; `compatible` moves it to
    // 03:30 EDT (07:30Z) instead of dropping the occurrence.
    const gap = eventOccurrences({
      events: [
        source(
          weeklySunday(
            "2026-03-01T07:30:00.000Z",
            "2026-03-01T08:30:00.000Z"
          )
        )
      ],
      from: "2026-03-08",
      to: "2026-03-08",
      timeZone: "America/New_York"
    })
    expect(gap).toHaveLength(1)
    expect(gap[0]!.timing).toEqual({
      _tag: "timed",
      start: "2026-03-08T07:30:00.000Z",
      end: "2026-03-08T08:30:00.000Z"
    })
  })

  it("places a timed occurrence by the viewer's wall day, not the event's", () => {
    // 10:00 Tehran is 06:30Z; in Los Angeles that is still 2026-10-20.
    const event = series()
    const occurrences = eventOccurrences({
      events: [source(event)],
      from: "2026-10-20",
      to: "2026-10-20",
      timeZone: "America/Los_Angeles"
    })
    expect(occurrences.map((occurrence) => occurrence.date)).toEqual(["2026-10-20"])
    expect(occurrences[0]!.instanceId).toBe("2026-10-21")
  })

  it("expands a series handed over twice only once", () => {
    // The month read model unions the grid's rows with a second query for an
    // out-of-grid drill-down, and both queries return every recurring row.
    const event = series()
    const once = eventOccurrences({
      events: [source(event)],
      from: "2026-10-18",
      to: "2026-10-31",
      timeZone: TEHRAN
    })
    const twice = eventOccurrences({
      events: [source(event), source(event)],
      from: "2026-10-18",
      to: "2026-10-31",
      timeZone: TEHRAN
    })

    expect(twice.map((occurrence) => occurrence.key)).toEqual(
      once.map((occurrence) => occurrence.key)
    )
    expect(new Set(twice.map((occurrence) => occurrence.key)).size).toBe(twice.length)
  })

  it("skips an unreadable stored series instead of failing the whole window", () => {
    // `LocalDate` on the wire is a pattern, so a sync push can store a date
    // that is not a day. One such row must not 500 every calendar read.
    const badException = series({
      exceptions: [
        {
          id: uuidV7() as EventExceptionId,
          instanceId: "2026-02-30" as LocalDate,
          action: "delete",
          overrides: null,
          createdAt: NOW
        }
      ]
    })
    const badAnchor = series({
      timing: {
        _tag: "timed",
        start: "not-an-instant",
        end: "not-an-instant"
      }
    })
    const healthy = series()

    const occurrences = eventOccurrences({
      events: [source(badException), source(badAnchor), source(healthy)],
      from: "2026-10-18",
      to: "2026-11-01",
      timeZone: TEHRAN
    })

    // The bad exception is ignored, so its series still paints its rule; the
    // unreadable anchor drops only that series.
    const byEvent = new Map<string, Array<string>>()
    for (const occurrence of occurrences) {
      const list = byEvent.get(occurrence.id) ?? []
      list.push(occurrence.instanceId)
      byEvent.set(occurrence.id, list)
    }
    expect(byEvent.get(badException.id)).toEqual(["2026-10-21", "2026-10-28"])
    expect(byEvent.get(healthy.id)).toEqual(["2026-10-21", "2026-10-28"])
    expect(byEvent.has(badAnchor.id)).toBe(false)
  })
})

describe("occurrence identity and edits", () => {
  it("knows which dates are occurrences (count-bounded)", () => {
    const event = series()
    expect(eventAnchorDate(event)).toBe("2026-10-21")
    expect(isEventOccurrence(event, "2026-10-21")).toBe(true)
    expect(isEventOccurrence(event, "2026-10-28")).toBe(true)
    expect(isEventOccurrence(event, "2026-10-29")).toBe(false)
    // Count 10 from 2026-10-21 ends 2026-12-23.
    expect(isEventOccurrence(event, "2026-12-23")).toBe(true)
    expect(isEventOccurrence(event, "2026-12-30")).toBe(false)
  })

  it("adds a this-occurrence override without touching the series", () => {
    const event = series()
    const next = overrideEventOccurrence({
      event,
      instanceId: "2026-10-28",
      overrides: { title: "جلسهٔ کوتاه" },
      exceptionId: uuidV7(),
      now: NOW
    })

    expect(next.version).toBe(event.version + 1)
    expect(next.title).toBe(event.title)
    expect(next.timing).toEqual(event.timing)
    expect(next.recurrence).toEqual(event.recurrence)
    expect(next.exceptions).toHaveLength(1)
    expect(next.exceptions[0]).toMatchObject({
      instanceId: "2026-10-28",
      action: "override",
      overrides: { title: "جلسهٔ کوتاه" }
    })
  })

  it("replaces an existing exception rather than duplicating its key", () => {
    const event = series({
      exceptions: [
        {
          id: uuidV7() as EventExceptionId,
          instanceId: "2026-10-28",
          action: "override",
          overrides: { title: "قدیمی" },
          createdAt: NOW
        }
      ]
    })
    const deleted = deleteEventOccurrence({
      event,
      instanceId: "2026-10-28",
      exceptionId: uuidV7(),
      now: NOW
    })
    expect(deleted.exceptions).toHaveLength(1)
    expect(deleted.exceptions[0]!.action).toBe("delete")
  })

  it("patches a one-off event instead of storing an exception", () => {
    const event = series({ recurrence: null })
    const next = patchEventSeries(event, { title: "قرار تازه" }, NOW)
    expect(next.title).toBe("قرار تازه")
    expect(next.exceptions).toEqual([])
    expect(next.recurrence).toBeNull()
    expect(next.version).toBe(2)
  })

  it("patches the whole series when this-and-following starts at the first occurrence", () => {
    // "First occurrence" here carries a stored override: the whole-series edit
    // must fold it into the series and drop the now-redundant exception, not
    // leave it shadowing the new values.
    const event = series({
      exceptions: [
        {
          id: uuidV7() as EventExceptionId,
          instanceId: "2026-10-21",
          action: "override",
          overrides: { location: "کافه" },
          createdAt: NOW
        },
        {
          id: uuidV7() as EventExceptionId,
          instanceId: "2026-11-11",
          action: "override",
          overrides: { title: "بعدی" },
          createdAt: NOW
        }
      ]
    })
    const next = patchEventSeries(event, { title: "قرار تازه" }, NOW)

    expect(next.title).toBe("قرار تازه")
    // The first occurrence's old override is folded in, then dropped.
    expect(next.location).toBe("کافه")
    expect(next.exceptions.map((exception) => exception.instanceId)).toEqual(["2026-11-11"])
    // The rule keeps running: the later occurrences still exist.
    expect(next.recurrence).toEqual(weeklyTen)
    expect(next.timing).toEqual(event.timing)
  })

  it("splits a series for this-and-following", () => {
    const event = series({
      exceptions: [
        {
          id: uuidV7() as EventExceptionId,
          instanceId: "2026-10-28",
          action: "delete",
          overrides: null,
          createdAt: NOW
        },
        {
          id: uuidV7() as EventExceptionId,
          instanceId: "2026-11-11",
          action: "override",
          overrides: { title: "بعدی" },
          createdAt: NOW
        }
      ]
    })
    const followingId = uuidV7()
    const split = splitEventSeries({
      event,
      instanceId: "2026-11-04",
      overrides: { title: "جلسهٔ تازه", location: "دفتر" },
      followingId,
      now: NOW
    })!

    // The old row stops the day before the split and keeps earlier exceptions.
    expect(split.previous.recurrence).toEqual({
      ...weeklyTen,
      end: { _tag: "until", date: "2026-11-03" }
    })
    expect(split.previous.exceptions.map((exception) => exception.instanceId)).toEqual([
      "2026-10-28"
    ])
    expect(split.previous.version).toBe(2)

    // The new row starts at the split and carries the later exceptions.
    expect(split.following.id).toBe(followingId)
    expect(split.following.title).toBe("جلسهٔ تازه")
    expect(split.following.location).toBe("دفتر")
    expect(split.following.version).toBe(1)
    expect(split.following.createdAt).toBe(NOW)
    expect(split.following.timing).toEqual(eventTimingOn(event, "2026-11-04"))
    expect(split.following.exceptions.map((exception) => exception.instanceId)).toEqual([
      "2026-11-11"
    ])
    // Two occurrences (10-21, 10-28) were consumed by the old row.
    expect(split.following.recurrence?.end).toEqual({ _tag: "count", count: 8 })
  })

  it("expands the two halves into one continuous schedule", () => {
    const event = series()
    const split = splitEventSeries({
      event,
      instanceId: "2026-11-04",
      overrides: { title: "جلسهٔ تازه" },
      followingId: uuidV7(),
      now: NOW
    })!

    const occurrences = eventOccurrences({
      events: [source(split.previous), source(split.following)],
      from: "2026-10-18",
      to: "2026-11-30",
      timeZone: TEHRAN
    })

    expect(occurrences.map((occurrence) => [occurrence.instanceId, occurrence.title])).toEqual([
      ["2026-10-21", "جلسهٔ هفتگی"],
      ["2026-10-28", "جلسهٔ هفتگی"],
      ["2026-11-04", "جلسهٔ تازه"],
      ["2026-11-11", "جلسهٔ تازه"],
      ["2026-11-18", "جلسهٔ تازه"],
      ["2026-11-25", "جلسهٔ تازه"]
    ])
    // The new half's anchor is a real row; its later weeks are projected.
    const splitOccurrence = occurrences.find(
      (occurrence) => occurrence.instanceId === "2026-11-04"
    )!
    expect(splitOccurrence.projected).toBe(false)
    expect(splitOccurrence.id).toBe(split.following.id)
  })

  it("truncates or tombstones for a this-and-following delete", () => {
    const event = series()
    const truncated = truncateEventSeries({ event, instanceId: "2026-11-04", now: NOW })
    expect(truncated.recurrence?.end).toEqual({ _tag: "until", date: "2026-11-03" })
    expect(truncated.deletedAt).toBeNull()

    const all = truncateEventSeries({ event, instanceId: "2026-10-21", now: NOW })
    expect(all.deletedAt).toBe(NOW)

    expect(trashEvent(event, NOW).deletedAt).toBe(NOW)
    expect(localDayBefore("2026-11-04")).toBe("2026-11-03")
  })

  it("does not split at the first occurrence or outside the rule", () => {
    const event = series()
    expect(
      splitEventSeries({
        event,
        instanceId: "2026-10-21",
        overrides: { title: "x" },
        followingId: uuidV7(),
        now: NOW
      })
    ).toBeNull()
    expect(
      splitEventSeries({
        event,
        instanceId: "2026-10-22" as LocalDate,
        overrides: { title: "x" },
        followingId: uuidV7(),
        now: NOW
      })
    ).toBeNull()
  })
})
