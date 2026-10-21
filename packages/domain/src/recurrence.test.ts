import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  expandOccurrences,
  nextOccurrence,
  occurrenceDates,
  RecurrenceRule,
  type RecurrenceRule as RecurrenceRuleType
} from "./recurrence.js"

/**
 * Ticket #38 unit tests for the hand-rolled recurrence engine.
 *
 * Expected dates were derived from the Jalali calendar: anchors and assertions
 * are chosen at month lengths, leap days and year boundaries, not just at
 * arbitrary Gregorian dates. `1405/07/28` is 2026-10-20, `1405/12/29` is
 * 2027-03-20, and Esfand 30 exists only in Jalali leap years (1403, 1408, …).
 */

const rule = (value: Partial<RecurrenceRuleType>): RecurrenceRuleType => ({
  frequency: "daily",
  interval: 1,
  end: { _tag: "never" },
  ...value
})

const dates = (value: RecurrenceRuleType, start: string, limit?: number): ReadonlyArray<string> =>
  occurrenceDates(value, start, limit === undefined ? {} : { limit })

describe("RecurrenceRule validation", () => {
  it("accepts the structured daily/weekly/monthly/yearly shapes", () => {
    expect(Schema.is(RecurrenceRule)(rule({ frequency: "daily" }))).toBe(true)
    expect(
      Schema.is(RecurrenceRule)(rule({ frequency: "weekly", byDay: [1, 6] }))
    ).toBe(true)
    expect(
      Schema.is(RecurrenceRule)(rule({ frequency: "monthly", byMonthDay: [1, 15, 31] }))
    ).toBe(true)
    expect(
      Schema.is(RecurrenceRule)(
        rule({ frequency: "monthly", nthWeekday: { nth: -1, day: 5 } })
      )
    ).toBe(true)
    expect(
      Schema.is(RecurrenceRule)(rule({ frequency: "yearly", interval: 2 }))
    ).toBe(true)
  })

  it("rejects combinators that do not belong to the frequency", () => {
    expect(Schema.is(RecurrenceRule)(rule({ frequency: "daily", byDay: [1] }))).toBe(false)
    expect(
      Schema.is(RecurrenceRule)(rule({ frequency: "weekly", byMonthDay: [1] }))
    ).toBe(false)
    expect(
      Schema.is(RecurrenceRule)(rule({ frequency: "monthly", byDay: [1] }))
    ).toBe(false)
    expect(
      Schema.is(RecurrenceRule)(
        rule({ frequency: "monthly", byMonthDay: [1], nthWeekday: { nth: 1, day: 1 } })
      )
    ).toBe(false)
  })

  it("rejects impossible field values", () => {
    expect(Schema.is(RecurrenceRule)(rule({ interval: 0 }))).toBe(false)
    expect(Schema.is(RecurrenceRule)(rule({ frequency: "weekly", byDay: [0] }))).toBe(false)
    expect(Schema.is(RecurrenceRule)(rule({ frequency: "weekly", byDay: [8] }))).toBe(false)
    expect(
      Schema.is(RecurrenceRule)(rule({ frequency: "monthly", byMonthDay: [32] }))
    ).toBe(false)
    expect(
      Schema.is(RecurrenceRule)(rule({ frequency: "monthly", nthWeekday: { nth: 0, day: 1 } }))
    ).toBe(false)
    expect(Schema.is(RecurrenceRule)(rule({ end: { _tag: "count", count: 0 } }))).toBe(false)
  })
})

describe("daily", () => {
  it("honours the interval", () => {
    expect(dates(rule({ frequency: "daily", interval: 3 }), "2026-10-20", 5)).toEqual([
      "2026-10-20",
      "2026-10-23",
      "2026-10-26",
      "2026-10-29",
      "2026-11-01"
    ])
  })

  it("crosses a Jalali month boundary without special cases", () => {
    // 1405/07/28 → 1405/08/01 is 2026-10-22 → 2026-10-23.
    expect(dates(rule({ frequency: "daily" }), "2026-10-22", 2)).toEqual([
      "2026-10-22",
      "2026-10-23"
    ])
  })
})

describe("weekly", () => {
  it("uses the selected ISO weekdays within Monday-based interval blocks", () => {
    // Anchor Tue 2026-10-20; Monday of its week is Oct 19, so the Monday in
    // the anchor week is before the series starts and is skipped.
    expect(
      dates(rule({ frequency: "weekly", byDay: [1, 6] }), "2026-10-20", 5)
    ).toEqual(["2026-10-24", "2026-10-26", "2026-10-31", "2026-11-02", "2026-11-07"])
  })

  it("steps whole weeks for an interval", () => {
    expect(
      dates(rule({ frequency: "weekly", interval: 2, byDay: [2] }), "2026-10-20", 4)
    ).toEqual(["2026-10-20", "2026-11-03", "2026-11-17", "2026-12-01"])
  })

  it("defaults to the anchor's weekday", () => {
    expect(dates(rule({ frequency: "weekly" }), "2026-10-20", 3)).toEqual([
      "2026-10-20",
      "2026-10-27",
      "2026-11-03"
    ])
  })

  it("is independent of the display week-start preference", () => {
    // Saturday 2026-10-24 is the weekday; the ISO block only decides which
    // weeks participate, so this stays Saturday whatever week start the user
    // has configured.
    expect(
      dates(rule({ frequency: "weekly", byDay: [6] }), "2026-10-20", 2)
    ).toEqual(["2026-10-24", "2026-10-31"])
  })
})

describe("monthly", () => {
  it("skips a selected day the Jalali month does not have (no clamping to 30)", () => {
    // 1405/07 … 1405/12 all have 30 or fewer days; the first 31st is 1406/01.
    expect(
      dates(rule({ frequency: "monthly", byMonthDay: [31] }), "2026-10-20", 6)
    ).toEqual([
      "2027-04-20",
      "2027-05-21",
      "2027-06-21",
      "2027-07-22",
      "2027-08-22",
      "2027-09-22"
    ])
  })

  it("supports multiple days per month in ascending order", () => {
    expect(
      dates(rule({ frequency: "monthly", byMonthDay: [1, 15] }), "2026-09-23", 5)
    ).toEqual([
      "2026-09-23",
      "2026-10-07",
      "2026-10-23",
      "2026-11-06",
      "2026-11-22"
    ])
  })

  it("supports the first/nth weekday of a Jalali month", () => {
    // 1405/07 starts 2026-09-23 (Wednesday); the first Saturday is the 26th.
    expect(
      dates(
        rule({ frequency: "monthly", nthWeekday: { nth: 1, day: 6 } }),
        "2026-09-23",
        4
      )
    ).toEqual(["2026-09-26", "2026-10-24", "2026-11-28", "2026-12-26"])
  })

  it("supports the last weekday", () => {
    expect(
      dates(
        rule({ frequency: "monthly", nthWeekday: { nth: -1, day: 5 } }),
        "2026-10-20",
        3
      )
    ).toEqual(["2026-11-20", "2026-12-18", "2027-01-15"])
  })

  it("skips a 5th weekday when the month only has four", () => {
    // The anchor month (1405/08, 2026-10-23 … 2026-11-21) and 1405/09 and
    // 1405/10 have only four Thursdays; 1405/11 starts on a Thursday, so its
    // fifth Thursday is 2027-02-18.
    expect(
      dates(
        rule({ frequency: "monthly", nthWeekday: { nth: 5, day: 4 } }),
        "2026-10-23",
        2
      )
    ).toEqual(["2027-02-18", "2027-05-20"])
  })

  it("defaults to the anchor's day and skips short months", () => {
    // Anchor is 1406/02/31 — a 31st that exists in the anchor month.
    expect(dates(rule({ frequency: "monthly" }), "2027-05-21", 3)).toEqual([
      "2027-05-21",
      "2027-06-21",
      "2027-07-22"
    ])
  })

  it("honours an interval across Jalali months", () => {
    expect(dates(rule({ frequency: "monthly", interval: 2 }), "2026-10-20", 3)).toEqual([
      "2026-10-20",
      "2026-12-19",
      "2027-02-17"
    ])
  })
})

describe("yearly", () => {
  it("uses the Jalali month/day and skips Esfand 30 in common years", () => {
    // Esfand 30 exists in 1403 (2025-03-20), then 1408 (2030-03-20).
    expect(dates(rule({ frequency: "yearly" }), "2025-03-20", 4)).toEqual([
      "2025-03-20",
      "2030-03-20",
      "2034-03-20",
      "2038-03-20"
    ])
  })

  it("supports a byMonthDay override that lands on the leap day", () => {
    expect(
      dates(rule({ frequency: "yearly", byMonthDay: [30] }), "2027-03-20", 4)
    ).toEqual(["2030-03-20", "2034-03-20", "2038-03-20", "2042-03-20"])
  })

  it("supports nth weekday within the anchor's Jalali month", () => {
    expect(
      dates(
        rule({ frequency: "yearly", nthWeekday: { nth: 1, day: 6 } }),
        "2026-09-26",
        3
      )
    ).toEqual(["2026-09-26", "2027-09-25", "2028-09-23"])
  })

  it("honours an interval", () => {
    expect(dates(rule({ frequency: "yearly", interval: 2 }), "2026-10-20", 3)).toEqual([
      "2026-10-20",
      "2028-10-19",
      "2030-10-20"
    ])
  })
})

describe("end bounds and exceptions", () => {
  it("stops after count occurrences", () => {
    expect(
      dates(rule({ end: { _tag: "count", count: 3 } }), "2026-10-20")
    ).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"])
  })

  it("treats until as an inclusive local-date bound", () => {
    expect(
      dates(
        rule({ end: { _tag: "until", date: "2026-10-23" } }),
        "2026-10-20"
      )
    ).toEqual(["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"])
  })

  it("removes exception dates without shifting the schedule", () => {
    expect(
      dates(
        rule({ end: { _tag: "count", count: 4 } }),
        "2026-10-20",
        undefined
      )
    ).toHaveLength(4)
    expect(
      occurrenceDates(rule({ end: { _tag: "count", count: 4 } }), "2026-10-20", {
        exceptions: ["2026-10-21"]
      })
    ).toEqual(["2026-10-20", "2026-10-22", "2026-10-23"])
  })

  it("does not extend a count when exceptions remove occurrences", () => {
    // count counts generated candidates before exceptions (RFC 5545), so the
    // series is simply shorter.
    expect(
      occurrenceDates(rule({ end: { _tag: "count", count: 2 } }), "2026-10-20", {
        exceptions: ["2026-10-20", "2026-10-21"]
      })
    ).toEqual([])
  })

  it("honours from/to when expanding a range", () => {
    expect(
      occurrenceDates(rule({}), "2026-10-20", {
        from: "2026-10-22",
        to: "2026-10-25",
        limit: 10
      })
    ).toEqual(["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"])
  })
})

describe("impossible and sparse rules terminate", () => {
  it("returns nothing for a rule that can never match", () => {
    // Mehr (month 7) always has 30 days, so the 31st never exists.
    const impossible = rule({ frequency: "yearly", byMonthDay: [31] })
    expect(expandOccurrences(impossible, "2026-10-20")).toEqual([])
    expect(nextOccurrence(impossible, "2026-10-20", "2026-10-20")).toBeNull()
  })

  it("finds the next leap-day occurrence without scanning unbounded", () => {
    const leapDay = rule({ frequency: "yearly" })
    expect(nextOccurrence(leapDay, "2025-03-20", "2025-03-20")?.toString()).toBe(
      "2030-03-20"
    )
  })

  it("returns null when a bounded series is exhausted", () => {
    const once = rule({ end: { _tag: "count", count: 1 } })
    expect(nextOccurrence(once, "2026-10-20", "2026-10-20")).toBeNull()
  })
})
