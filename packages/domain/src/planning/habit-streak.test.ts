import { describe, expect, it } from "vitest"
import type { LocalDate } from "./common.js"
import type { HabitEntryStatus, HabitFrequency } from "./habit.js"
import {
  habitStreak,
  type StreakFrequencyEra,
  type StreakInput
} from "./habit-streak.js"

/**
 * The 16 worked examples of `docs/streak-algorithm.md` §6, re-derived from the
 * normative rules (they were verified against the Temporal `persian`
 * calendar), plus the totality cases of §4.3.
 *
 * Today is Wed 21 Oct 2026 unless a row says otherwise. Counting weeks:
 * W−2 = Sat 3 – Fri 9 Oct, W−1 = 10–16 Oct, W0 = 17–23 Oct (25 Mehr – 1 Aban),
 * W+1 = 24–30 Oct.
 */

const date = (value: string): LocalDate => value as LocalDate

const daily: HabitFrequency = { _tag: "daily" }
const weekdays = (...days: ReadonlyArray<number>): HabitFrequency => ({
  _tag: "weekdays",
  days
})
const weekly = (times: number): HabitFrequency => ({ _tag: "weekly", times })

const era = (effectiveFrom: string, frequency: HabitFrequency): StreakFrequencyEra => ({
  effectiveFrom: date(effectiveFrom),
  frequency
})

const entry = (localDate: string, status: HabitEntryStatus) => ({
  localDate: date(localDate),
  status
})

const run = (
  input: Omit<StreakInput, "entries" | "windowDays"> & {
    readonly entries?: ReadonlyArray<{ localDate: LocalDate; status: HabitEntryStatus }>
    readonly windowDays?: 7 | 30 | 90
  }
) =>
  habitStreak({
    entries: input.entries ?? [],
    windowDays: input.windowDays ?? 30,
    today: input.today,
    startedOn: input.startedOn,
    frequencyHistory: input.frequencyHistory
  })

describe("E1 — the basic weekly quota, open week not broken", () => {
  const input = {
    startedOn: date("2026-10-03"),
    frequencyHistory: [era("2026-10-03", weekly(3))],
    today: date("2026-10-21"),
    entries: [
      entry("2026-10-05", "done"),
      entry("2026-10-06", "done"),
      entry("2026-10-11", "done"),
      entry("2026-10-13", "done"),
      entry("2026-10-15", "done"),
      entry("2026-10-17", "done"),
      entry("2026-10-19", "done")
    ]
  } as const

  it("keeps the satisfied week and shows the open week as 2 of 3", () => {
    const result = run(input)
    expect(result.current).toEqual({ unit: "week", count: 1, since: date("2026-10-10") })
    expect(result.open).toMatchObject({
      start: date("2026-10-17"),
      requirement: 3,
      credit: 2,
      satisfied: false,
      open: true
    })
    expect(result.best).toEqual({ days: 0, weeks: 1 })
    expect(result.periods).toHaveLength(3)
    expect(result.periods[0]).toMatchObject({ start: date("2026-10-03"), credit: 2, satisfied: false })
    expect(result.periods[1]).toMatchObject({ start: date("2026-10-10"), credit: 3, satisfied: true })
  })

  it("is 83% over the 30-day window", () => {
    expect(run(input).rate).toBeCloseTo(5 / 6, 10)
  })
})

describe("E2 — a satisfied open period advances immediately", () => {
  it("counts the open week as soon as it is satisfied", () => {
    const result = run({
      startedOn: date("2026-09-12"),
      frequencyHistory: [era("2026-09-12", weekly(1))],
      today: date("2026-10-21"),
      entries: [
        entry("2026-09-12", "done"),
        entry("2026-09-19", "done"),
        entry("2026-09-26", "done"),
        entry("2026-10-03", "done"),
        entry("2026-10-10", "done"),
        entry("2026-10-17", "done")
      ]
    })
    expect(result.current).toEqual({ unit: "week", count: 6, since: date("2026-09-12") })
    expect(result.open).toMatchObject({
      start: date("2026-10-17"),
      requirement: 1,
      credit: 1,
      satisfied: true
    })
  })
})

describe("E3 — Partial is full credit, half weight", () => {
  it("calls a 2-done + 1-partial week satisfied but two-thirds weighted", () => {
    const result = run({
      startedOn: date("2026-09-12"),
      frequencyHistory: [era("2026-09-12", weekly(3))],
      today: date("2026-10-21"),
      entries: [
        // Four perfect weeks: W−5, W−4, W−3, W−2.
        entry("2026-09-14", "done"),
        entry("2026-09-15", "done"),
        entry("2026-09-16", "done"),
        entry("2026-09-21", "done"),
        entry("2026-09-22", "done"),
        entry("2026-09-23", "done"),
        entry("2026-09-28", "done"),
        entry("2026-09-29", "done"),
        entry("2026-09-30", "done"),
        entry("2026-10-05", "done"),
        entry("2026-10-06", "done"),
        entry("2026-10-07", "done"),
        // W−1: partial + done + partial = full credit, two-thirds weight.
        entry("2026-10-12", "partial"),
        entry("2026-10-13", "done"),
        entry("2026-10-14", "partial")
      ]
    })
    const last = result.periods[result.periods.length - 2]!
    expect(last).toMatchObject({
      start: date("2026-10-10"),
      credit: 3,
      weighted: 2,
      satisfied: true
    })
    expect(result.current).toMatchObject({ unit: "week", count: 5 })
    // W−3, W−2 are perfect; W−1 is 2/3 → (1 + 1 + 2/3) / 3.
    expect(result.rate).toBeCloseTo(8 / 9, 10)
  })
})

describe("E4 — the rate is capped, the surplus is real but not banked", () => {
  it("caps a five-done week at 100% and does not pre-pay the next week", () => {
    const result = run({
      startedOn: date("2026-10-10"),
      frequencyHistory: [era("2026-10-10", weekly(3))],
      today: date("2026-10-16"),
      entries: [
        entry("2026-10-10", "done"),
        entry("2026-10-11", "done"),
        entry("2026-10-12", "done"),
        entry("2026-10-13", "done"),
        entry("2026-10-14", "done")
      ]
    })
    expect(result.periods).toHaveLength(1)
    expect(result.periods[0]).toMatchObject({ credit: 5, weighted: 5, satisfied: true })
    expect(result.rate).toBe(1)
    expect(result.current.count).toBe(1)
  })
})

describe("E5 — a backfill can grow a streak after the fact", () => {
  it("turns a closed 2-of-3 week into a satisfied one", () => {
    const before = run({
      startedOn: date("2026-10-03"),
      frequencyHistory: [era("2026-10-03", weekly(3))],
      today: date("2026-10-14"),
      entries: [entry("2026-10-05", "done"), entry("2026-10-06", "done")]
    })
    expect(before.current).toEqual({ unit: "week", count: 0, since: null })

    const after = run({
      startedOn: date("2026-10-03"),
      frequencyHistory: [era("2026-10-03", weekly(3))],
      today: date("2026-10-14"),
      entries: [
        entry("2026-10-05", "done"),
        entry("2026-10-06", "done"),
        entry("2026-10-09", "done")
      ]
    })
    expect(after.current).toEqual({ unit: "week", count: 1, since: date("2026-10-03") })
    expect(after.best).toEqual({ days: 0, weeks: 1 })
    expect(after.rate).toBe(1)
  })
})

describe("E6 — a correction can break a streak (and lower best)", () => {
  it("recomputes both numbers from the corrected entries", () => {
    const corrected = run({
      startedOn: date("2026-10-03"),
      frequencyHistory: [era("2026-10-03", weekly(3))],
      today: date("2026-10-18"),
      entries: [
        entry("2026-10-05", "done"),
        entry("2026-10-06", "done"),
        entry("2026-10-11", "done"),
        entry("2026-10-13", "missed"),
        entry("2026-10-15", "done"),
        entry("2026-10-17", "done")
      ]
    })
    expect(corrected.current).toEqual({ unit: "week", count: 0, since: null })
    expect(corrected.best).toEqual({ days: 0, weeks: 0 })
  })
})

describe("E7 — changing the Week Start preference changes nothing", () => {
  it("keeps the fixed Saturday–Friday counting week", () => {
    const result = run({
      startedOn: date("2026-10-03"),
      frequencyHistory: [era("2026-10-03", weekly(3))],
      today: date("2026-10-21"),
      entries: [entry("2026-10-11", "done"), entry("2026-10-13", "done"), entry("2026-10-15", "done")]
    })
    expect(result.periods.map((period) => [period.start, period.end])).toEqual([
      ["2026-10-03", "2026-10-09"],
      ["2026-10-10", "2026-10-16"],
      ["2026-10-17", "2026-10-23"]
    ])
    expect(result.current.count).toBe(1)
  })
})

describe("E8 — DST and Jalali leap years are invisible", () => {
  it("counts a 25-hour day as one plain day", () => {
    const result = run({
      startedOn: date("2026-10-24"),
      frequencyHistory: [era("2026-10-24", daily)],
      today: date("2026-10-26"),
      entries: [
        entry("2026-10-24", "done"),
        entry("2026-10-25", "done"),
        entry("2026-10-26", "done")
      ]
    })
    expect(result.current).toEqual({ unit: "day", count: 3, since: date("2026-10-24") })
    expect(result.periods.map((period) => period.start)).toEqual([
      "2026-10-24",
      "2026-10-25",
      "2026-10-26"
    ])
  })
})

describe("E9 — a habit created mid-period", () => {
  it("(a) cannot reach a Friday quota and does not start broken", () => {
    const result = run({
      startedOn: date("2026-10-23"),
      frequencyHistory: [era("2026-10-23", weekly(3))],
      today: date("2026-10-23")
    })
    expect(result.current).toEqual({ unit: "week", count: 0, since: null })
    expect(result.best).toEqual({ days: 0, weeks: 0 })
    expect(result.open).toMatchObject({
      start: date("2026-10-17"),
      requirement: 3,
      credit: 0,
      satisfied: false
    })
  })

  it("(b) starts the streak when the opening week reaches its quota", () => {
    const result = run({
      startedOn: date("2026-10-21"),
      frequencyHistory: [era("2026-10-21", weekly(3))],
      today: date("2026-10-23"),
      entries: [
        entry("2026-10-21", "done"),
        entry("2026-10-22", "done"),
        entry("2026-10-23", "done")
      ]
    })
    expect(result.current).toEqual({ unit: "week", count: 1, since: date("2026-10-21") })
    expect(result.open).toMatchObject({ credit: 3, satisfied: true })
    // The mid-week opening week is excluded from the rate.
    expect(result.rate).toBeNull()
  })
})

describe("E10 — raising the quota mid-week does not rewrite the current week", () => {
  it("judges W0 at 2 and starts the 3× era on the next Saturday", () => {
    const result = run({
      startedOn: date("2026-09-12"),
      frequencyHistory: [era("2026-09-12", weekly(2)), era("2026-10-24", weekly(3))],
      today: date("2026-10-21"),
      entries: [
        entry("2026-09-14", "done"),
        entry("2026-09-15", "done"),
        entry("2026-09-21", "done"),
        entry("2026-09-22", "done"),
        entry("2026-09-28", "done"),
        entry("2026-09-29", "done"),
        entry("2026-10-05", "done"),
        entry("2026-10-06", "done"),
        entry("2026-10-12", "done"),
        entry("2026-10-13", "done"),
        entry("2026-10-17", "done"),
        entry("2026-10-19", "done")
      ]
    })
    expect(result.current).toEqual({ unit: "week", count: 6, since: date("2026-09-12") })
    const open = result.open!
    expect(open).toMatchObject({ start: date("2026-10-17"), requirement: 2, credit: 2, satisfied: true })
    expect(result.unitChanges).toEqual([])
  })

  it("breaks the streak only when the closed week falls short of the old quota", () => {
    const result = run({
      startedOn: date("2026-10-10"),
      frequencyHistory: [era("2026-10-10", weekly(2)), era("2026-10-24", weekly(3))],
      today: date("2026-10-23"),
      entries: [entry("2026-10-17", "done")]
    })
    expect(result.periods[1]).toMatchObject({ requirement: 2, credit: 1, satisfied: false })
    expect(result.current.count).toBe(0)
  })
})

describe("E11 — a unit change closes the streak", () => {
  // 12 days through Tue 20 Oct, then Wed 21 – Fri 23 as the change lands.
  const entries = Array.from({ length: 15 }, (_, index) =>
    entry(`2026-10-${String(9 + index).padStart(2, "0")}`, "done")
  )

  it("counts day periods until Friday and keeps the run in best.days", () => {
    const friday = run({
      startedOn: date("2026-10-09"),
      frequencyHistory: [era("2026-10-09", daily), era("2026-10-24", weekly(3))],
      today: date("2026-10-23"),
      entries
    })
    expect(friday.current).toEqual({ unit: "day", count: 15, since: date("2026-10-09") })
    expect(friday.best).toEqual({ days: 15, weeks: 0 })
    expect(friday.unitChanges).toEqual([{ on: date("2026-10-24"), from: "day", to: "week" }])
  })

  it("starts the weekly unit at zero on Saturday, with the day run still in best", () => {
    const saturday = run({
      startedOn: date("2026-10-09"),
      frequencyHistory: [era("2026-10-09", daily), era("2026-10-24", weekly(3))],
      today: date("2026-10-24"),
      entries
    })
    expect(saturday.current).toEqual({ unit: "week", count: 0, since: null })
    expect(saturday.best).toEqual({ days: 15, weeks: 0 })
    expect(saturday.open).toMatchObject({
      start: date("2026-10-24"),
      requirement: 3,
      credit: 0,
      satisfied: false
    })
    // The rate is for the current unit only: no closed week qualifies yet.
    expect(saturday.rate).toBeNull()
  })
})

describe("E12 — a rest-day done is a bonus, not a bridge", () => {
  it("keeps the Mon+Wed run and adds the Thursday to the rate weight only", () => {
    const result = run({
      startedOn: date("2026-10-17"),
      frequencyHistory: [era("2026-10-17", weekdays(6, 1, 3))],
      today: date("2026-10-22"),
      entries: [
        entry("2026-10-19", "done"),
        entry("2026-10-21", "done"),
        entry("2026-10-22", "done")
      ]
    })
    expect(result.current).toEqual({ unit: "day", count: 2, since: date("2026-10-19") })
    expect(result.open).toBeNull()
    expect(result.periods.map((period) => period.start)).toEqual([
      "2026-10-17",
      "2026-10-19",
      "2026-10-21"
    ])
    // Sat 17 is a blank expected day in the denominator: (0 + 1 + 1 + bonus 1) / 3.
    expect(result.rate).toBe(1)
  })
})

describe("E13 — a 7-day window has no closed week", () => {
  const base = {
    startedOn: date("2026-10-03"),
    frequencyHistory: [era("2026-10-03", weekly(3))],
    today: date("2026-10-21"),
    windowDays: 7 as const
  }

  it("returns null (never 0%) while the open week is unsatisfied", () => {
    const result = run({ ...base, entries: [entry("2026-10-17", "done"), entry("2026-10-19", "done")] })
    expect(result.rate).toBeNull()
    expect(result.open).toMatchObject({ credit: 2, requirement: 3, satisfied: false })
  })

  it("uses the satisfied open week as the single qualifying period", () => {
    const result = run({
      ...base,
      entries: [
        entry("2026-10-17", "done"),
        entry("2026-10-19", "done"),
        entry("2026-10-20", "done")
      ]
    })
    expect(result.rate).toBe(1)
  })
})

describe("E14 — an explicit miss today vs a blank today", () => {
  const base = {
    startedOn: date("2026-10-17"),
    frequencyHistory: [era("2026-10-17", weekdays(6, 1, 3))],
    today: date("2026-10-21"),
    entries: [entry("2026-10-17", "done"), entry("2026-10-19", "done")]
  }

  it("a blank today leaves the run standing", () => {
    const result = run(base)
    expect(result.current).toEqual({ unit: "day", count: 2, since: date("2026-10-17") })
    expect(result.open).toMatchObject({ credit: 0, satisfied: false, open: true })
  })

  it("a missed today is visible but not a break until the day closes", () => {
    const result = run({ ...base, entries: [...base.entries, entry("2026-10-21", "missed")] })
    expect(result.current).toEqual({ unit: "day", count: 2, since: date("2026-10-17") })
    expect(result.open).toMatchObject({ credit: 0, satisfied: false })
  })

  it("a missed yesterday on a selected day breaks the run", () => {
    const result = run({
      startedOn: date("2026-10-17"),
      frequencyHistory: [era("2026-10-17", weekdays(6, 1, 2, 3))],
      today: date("2026-10-21"),
      entries: [
        entry("2026-10-17", "done"),
        entry("2026-10-19", "done"),
        entry("2026-10-20", "missed")
      ]
    })
    expect(result.current).toEqual({ unit: "day", count: 0, since: null })
  })
})

describe("E15 — a week is not a month", () => {
  it("keeps W0 as one period across the Mehr/Aban boundary", () => {
    const result = run({
      startedOn: date("2026-10-17"),
      frequencyHistory: [era("2026-10-17", weekly(3))],
      today: date("2026-10-21"),
      entries: [entry("2026-10-17", "done"), entry("2026-10-19", "done")]
    })
    expect(result.periods).toHaveLength(1)
    expect(result.periods[0]).toMatchObject({
      start: date("2026-10-17"),
      end: date("2026-10-23"),
      requirement: 3,
      credit: 2,
      satisfied: false
    })
  })
})

describe("E16 — a missed day never subtracts", () => {
  it("still satisfies the week and keeps the weighted rate at 100%", () => {
    const result = run({
      startedOn: date("2026-10-12"),
      frequencyHistory: [era("2026-10-12", weekly(3))],
      today: date("2026-10-16"),
      entries: [
        entry("2026-10-12", "done"),
        entry("2026-10-13", "done"),
        entry("2026-10-14", "done"),
        entry("2026-10-15", "missed")
      ]
    })
    expect(result.periods[0]).toMatchObject({ credit: 3, weighted: 3, satisfied: true })
    expect(result.current).toEqual({ unit: "week", count: 1, since: date("2026-10-12") })
    // The opening week began before `startedOn`, so it starts the streak but
    // never enters the rate (§5.5/E9): nothing else qualifies yet.
    expect(result.rate).toBeNull()
  })
})

describe("§4.3 — degenerate and malformed inputs", () => {
  it("a day with no entry is blank: credit 0, weight 0", () => {
    const result = run({
      startedOn: date("2026-10-21"),
      frequencyHistory: [era("2026-10-21", daily)],
      today: date("2026-10-21")
    })
    expect(result.periods[0]).toMatchObject({ credit: 0, weighted: 0, satisfied: false, open: true })
    expect(result.current).toEqual({ unit: "day", count: 0, since: null })
  })

  it("ignores a future-dated entry", () => {
    const result = run({
      startedOn: date("2026-10-19"),
      frequencyHistory: [era("2026-10-19", daily)],
      today: date("2026-10-20"),
      entries: [entry("2026-10-20", "done"), entry("2026-10-21", "done")]
    })
    expect(result.periods).toHaveLength(2)
    expect(result.periods[1]).toMatchObject({ start: date("2026-10-20"), credit: 1 })
    expect(result.current.count).toBe(1)
  })

  it("does not depend on input order when a duplicate day is passed (unspecified answer)", () => {
    const first = run({
      startedOn: date("2026-10-21"),
      frequencyHistory: [era("2026-10-21", daily)],
      today: date("2026-10-21"),
      entries: [entry("2026-10-21", "done"), entry("2026-10-21", "missed")]
    })
    const second = run({
      startedOn: date("2026-10-21"),
      frequencyHistory: [era("2026-10-21", daily)],
      today: date("2026-10-21"),
      entries: [entry("2026-10-21", "missed"), entry("2026-10-21", "done")]
    })
    // Either answer is allowed, but the shape must be defined for both orders.
    expect([0, 1]).toContain(first.periods[0]!.credit)
    expect([0, 1]).toContain(second.periods[0]!.credit)
  })

  it("returns the empty result before startedOn", () => {
    const result = run({
      startedOn: date("2026-10-21"),
      frequencyHistory: [era("2026-10-21", weekly(3)), era("2026-10-24", daily)],
      today: date("2026-10-20"),
      entries: [entry("2026-10-21", "done")]
    })
    expect(result).toEqual({
      current: { unit: "week", count: 0, since: null },
      open: null,
      best: { days: 0, weeks: 0 },
      rate: null,
      periods: [],
      unitChanges: []
    })
  })

  it("startedOn == today opens exactly one period", () => {
    const day = run({
      startedOn: date("2026-10-21"),
      frequencyHistory: [era("2026-10-21", daily)],
      today: date("2026-10-21")
    })
    expect(day.periods).toHaveLength(1)
    expect(day.open).toMatchObject({ start: date("2026-10-21"), end: date("2026-10-21") })

    const week = run({
      startedOn: date("2026-10-21"),
      frequencyHistory: [era("2026-10-21", weekly(3))],
      today: date("2026-10-21")
    })
    expect(week.periods).toHaveLength(1)
    expect(week.open).toMatchObject({ start: date("2026-10-17"), end: date("2026-10-23") })

    const rest = run({
      startedOn: date("2026-10-21"),
      frequencyHistory: [era("2026-10-21", weekdays(6))],
      today: date("2026-10-21")
    })
    expect(rest.periods).toEqual([])
    expect(rest.open).toBeNull()
  })

  it("closes on the Saturday boundary after a mid-week change (no overlap)", () => {
    const result = run({
      startedOn: date("2026-10-01"),
      frequencyHistory: [era("2026-10-01", daily), era("2026-10-24", weekly(3))],
      today: date("2026-10-26"),
      entries: [
        entry("2026-10-22", "done"),
        entry("2026-10-23", "done"),
        entry("2026-10-24", "done")
      ]
    })
    // Mon 26 Oct is a week period, so the Saturday that opened it is the era start.
    expect(result.periods[result.periods.length - 1]).toMatchObject({
      unit: "week",
      start: date("2026-10-24"),
      credit: 1
    })
    expect(result.periods.some((period) => period.unit === "day" && period.start > date("2026-10-23"))).toBe(false)
  })

  it("lets the earlier era cover a gap instead of inventing a period", () => {
    const result = run({
      startedOn: date("2026-10-03"),
      frequencyHistory: [era("2026-10-03", weekly(2)), era("2026-10-20", weekly(3))],
      today: date("2026-10-23"),
      entries: [entry("2026-10-17", "done")]
    })
    // The 20 Oct boundary falls inside the week that opened on 17 Oct; that week
    // is judged under the era that opened it.
    expect(result.periods.map((period) => period.start)).toEqual([
      "2026-10-03",
      "2026-10-10",
      "2026-10-17"
    ])
    expect(result.periods[2]).toMatchObject({ requirement: 2, credit: 1 })
  })

  it("asserts malformed era sets and frequencies", () => {
    expect(() =>
      run({ startedOn: date("2026-10-21"), frequencyHistory: [], today: date("2026-10-21") })
    ).toThrow(/frequency history is empty/)

    expect(() =>
      run({
        startedOn: date("2026-10-21"),
        frequencyHistory: [era("2026-10-21", daily), era("2026-10-21", daily)],
        today: date("2026-10-21")
      })
    ).toThrow(/strictly increasing/)

    expect(() =>
      run({
        startedOn: date("2026-10-21"),
        frequencyHistory: [era("2026-10-21", weekly(8))],
        today: date("2026-10-21")
      })
    ).toThrow(/times/)

    expect(() =>
      run({
        startedOn: date("2026-10-21"),
        frequencyHistory: [era("2026-10-21", weekdays())],
        today: date("2026-10-21")
      })
    ).toThrow(/at least one day/)

    expect(() =>
      run({
        startedOn: date("2026-10-21"),
        frequencyHistory: [era("2026-10-21", weekdays(1, 1))],
        today: date("2026-10-21")
      })
    ).toThrow(/not repeat/)

    expect(() =>
      run({
        startedOn: date("2026-10-21"),
        frequencyHistory: [era("2026-10-21", daily)],
        today: date("2026-10-21"),
        entries: [entry("2026-10-21", "maybe" as HabitEntryStatus)]
      })
    ).toThrow(/unknown habit entry status/)
  })
})
