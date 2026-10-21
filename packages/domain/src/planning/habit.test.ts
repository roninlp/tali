import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import type { HouseholdId, UserId } from "../common.js"
import { uuidV7 } from "../ids.js"
import {
  Habit,
  HabitCreateInput,
  HabitEntry,
  HabitEntryStatus,
  HabitFrequency,
  type HabitFrequencyChange,
  habitFrequencyHistoryAfter,
  HabitPatch,
  HabitReminderTime,
  localDateIn,
  localDateInOption,
  sameHabitFrequency
} from "./index.js"
import type { HabitEntryId, HabitId } from "./common.js"

/**
 * Ticket #63 exit criterion at the model seam: a habit round-trips through its
 * Schema model, and the frequency union + the local reminder time reject the
 * payloads a client could send.
 */

const NOW = "2026-10-20T09:30:00.000Z"
const USER = "user-1" as UserId
const HOUSEHOLD = "household-1" as HouseholdId

const base = {
  type: "habit" as const,
  ownerId: USER,
  householdId: HOUSEHOLD,
  visibility: "shared" as const,
  color: null,
  createdAt: NOW,
  updatedAt: NOW,
  version: 1,
  deletedAt: null
}

const dailyHabit = {
  ...base,
  id: uuidV7(1_700_000_000_030) as HabitId,
  title: "پیاده‌روی",
  description: "هر روز صبح",
  icon: "🚶",
  startedOn: "2026-10-20",
  frequency: { _tag: "daily" as const },
  frequencyHistory: [{ effectiveFrom: "2026-10-20", frequency: { _tag: "daily" as const } }],
  reminderTime: "07:30",
  timeZone: "Asia/Tehran"
}

const weekdayHabit = {
  ...dailyHabit,
  id: uuidV7(1_700_000_000_031) as HabitId,
  title: "ورزش",
  frequency: { _tag: "weekdays" as const, days: [1, 3, 5] },
  frequencyHistory: [
    { effectiveFrom: "2026-10-20", frequency: { _tag: "weekdays" as const, days: [1, 3, 5] } }
  ],
  reminderTime: null
}

const weeklyHabit = {
  ...dailyHabit,
  id: uuidV7(1_700_000_000_032) as HabitId,
  title: "کتاب خواندن",
  frequency: { _tag: "weekly" as const, times: 3 },
  frequencyHistory: [
    { effectiveFrom: "2026-10-20", frequency: { _tag: "weekly" as const, times: 3 } }
  ]
}

describe("Habit model", () => {
  it("round-trips each frequency shape", () => {
    for (const habit of [dailyHabit, weekdayHabit, weeklyHabit]) {
      const decoded = Schema.decodeUnknownSync(Habit)(habit)
      expect(decoded.frequency).toEqual(habit.frequency)
      expect(decoded.frequencyHistory).toEqual(habit.frequencyHistory)
      expect(decoded.title).toBe(habit.title)
      expect(decoded.timeZone).toBe("Asia/Tehran")
    }
  })

  it("keeps the frequency variants apart", () => {
    // Unknown extra keys are dropped, not merged: a `daily` frequency can never
    // carry a weekday selection into the store.
    expect(Schema.decodeUnknownSync(HabitFrequency)({ _tag: "daily", days: [1] })).toEqual({
      _tag: "daily"
    })
    expect(Schema.decodeUnknownSync(HabitFrequency)({ _tag: "weekdays", days: [1], times: 3 }))
      .toEqual({ _tag: "weekdays", days: [1] })
    expect(() => Schema.decodeUnknownSync(HabitFrequency)({ _tag: "monthly" })).toThrow()
  })

  it("rejects an empty or duplicate weekday selection", () => {
    expect(() => Schema.decodeUnknownSync(HabitFrequency)({ _tag: "weekdays", days: [] })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(HabitFrequency)({ _tag: "weekdays", days: [2, 2] })
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(HabitFrequency)({ _tag: "weekdays", days: [0, 1] })
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(HabitFrequency)({ _tag: "weekdays", days: [1, 8] })
    ).toThrow()
  })

  it("bounds the weekly target to 1..7", () => {
    expect(() => Schema.decodeUnknownSync(HabitFrequency)({ _tag: "weekly", times: 0 })).toThrow()
    expect(() => Schema.decodeUnknownSync(HabitFrequency)({ _tag: "weekly", times: 8 })).toThrow()
    expect(() => Schema.decodeUnknownSync(HabitFrequency)({ _tag: "weekly", times: 1.5 })).toThrow()
    expect(Schema.decodeUnknownSync(HabitFrequency)({ _tag: "weekly", times: 7 })).toEqual({
      _tag: "weekly",
      times: 7
    })
  })

  it("validates the local reminder time", () => {
    for (const valid of ["00:00", "07:30", "23:59"]) {
      expect(Schema.decodeUnknownSync(HabitReminderTime)(valid)).toBe(valid)
    }
    for (const invalid of ["7:30", "24:00", "07:60", "0730", "07:3"]) {
      expect(() => Schema.decodeUnknownSync(HabitReminderTime)(invalid)).toThrow()
    }
  })

  it("rejects a malformed habit", () => {
    expect(() => Schema.decodeUnknownSync(Habit)({ ...dailyHabit, type: "task" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Habit)({ ...dailyHabit, id: "not-a-uuid" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Habit)({ ...dailyHabit, timeZone: "Mars/Olympus" }))
      .toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Habit)({
        ...dailyHabit,
        frequencyHistory: [{ effectiveFrom: "1403/07/28", frequency: { _tag: "daily" } }]
      })
    ).toThrow()
    // #65: the era log is non-empty and strictly increasing (no overlap).
    expect(() =>
      Schema.decodeUnknownSync(Habit)({ ...dailyHabit, frequencyHistory: [] })
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Habit)({
        ...dailyHabit,
        frequencyHistory: [
          { effectiveFrom: "2026-10-21", frequency: dailyHabit.frequency },
          { effectiveFrom: "2026-10-21", frequency: dailyHabit.frequency }
        ]
      })
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Habit)({
        ...dailyHabit,
        frequencyHistory: [
          { effectiveFrom: "2026-10-21", frequency: dailyHabit.frequency },
          { effectiveFrom: "2026-10-20", frequency: dailyHabit.frequency }
        ]
      })
    ).toThrow()
  })

  it("decodes the create and patch inputs", () => {
    const created = Schema.decodeUnknownSync(HabitCreateInput)({
      clientMutationId: "m-1",
      title: "آب خوردن",
      frequency: { _tag: "daily" }
    })
    expect(created.title).toBe("آب خوردن")
    expect(created.frequency).toEqual({ _tag: "daily" })

    expect(() =>
      Schema.decodeUnknownSync(HabitCreateInput)({ clientMutationId: "m-2", title: "بی‌ریتم" })
    ).toThrow()

    // `frequencyHistory` is server-managed: the patch schema has no such field,
    // so a client cannot rewrite the past.
    const patched = Schema.decodeUnknownSync(HabitPatch)({
      title: "آب و چای",
      frequencyHistory: []
    })
    expect(patched).toEqual({ title: "آب و چای" })
  })
})

describe("habit frequency eras", () => {
  const daily = { _tag: "daily" as const }
  const weekdays = { _tag: "weekdays" as const, days: [1, 3, 5] }
  const weekly = { _tag: "weekly" as const, times: 3 }

  const historyFrom = (
    startedOn: string,
    frequency: HabitFrequency
  ): ReadonlyArray<HabitFrequencyChange> => [{ effectiveFrom: startedOn, frequency }]

  it("is a no-op when the frequency did not change", () => {
    const history = historyFrom("2026-10-20", daily)
    expect(habitFrequencyHistoryAfter({
      history,
      frequency: { _tag: "daily" },
      changeDate: "2026-11-01"
    })).toBe(history)
  })

  it("starts a change on the next day for a day-unit frequency", () => {
    expect(habitFrequencyHistoryAfter({
      history: historyFrom("2026-10-20", daily),
      frequency: weekdays,
      changeDate: "2026-10-22"
    })).toEqual([
      { effectiveFrom: "2026-10-20", frequency: daily },
      { effectiveFrom: "2026-10-23", frequency: weekdays }
    ])
  })

  it("keeps the current week under the old frequency when switching to a weekly unit (#65 E10/E11)", () => {
    // daily → 3×/week on Wed 21 Oct: the daily era covers 21–23 Oct and the
    // weekly era opens on Sat 24 Oct.
    expect(habitFrequencyHistoryAfter({
      history: historyFrom("2026-10-01", daily),
      frequency: weekly,
      changeDate: "2026-10-21"
    })).toEqual([
      { effectiveFrom: "2026-10-01", frequency: daily },
      { effectiveFrom: "2026-10-24", frequency: weekly }
    ])
  })

  it("keeps the current week under the old frequency when switching away from weekly (#65 E11)", () => {
    // 3×/week → daily on Wed 21 Oct: the week 17–23 is judged at 3× and the
    // daily era starts Sat 24 Oct, so no day is counted twice.
    expect(habitFrequencyHistoryAfter({
      history: historyFrom("2026-10-01", weekly),
      frequency: daily,
      changeDate: "2026-10-21"
    })).toEqual([
      { effectiveFrom: "2026-10-01", frequency: weekly },
      { effectiveFrom: "2026-10-24", frequency: daily }
    ])
  })

  it("starts a same-unit weekly change at the next counting week", () => {
    expect(habitFrequencyHistoryAfter({
      history: historyFrom("2026-10-03", weekly),
      frequency: { _tag: "weekly", times: 2 },
      changeDate: "2026-10-21"
    })).toEqual([
      { effectiveFrom: "2026-10-03", frequency: weekly },
      { effectiveFrom: "2026-10-24", frequency: { _tag: "weekly", times: 2 } }
    ])
  })

  it("never back-dates an era behind the previous boundary", () => {
    // Two changes before the pending Saturday boundary: the second replaces
    // the pending era instead of stacking a second one on the same date.
    const pending: ReadonlyArray<HabitFrequencyChange> = [
      { effectiveFrom: "2026-10-03", frequency: weekly },
      { effectiveFrom: "2026-10-24", frequency: { _tag: "weekly", times: 2 } }
    ]
    expect(habitFrequencyHistoryAfter({
      history: pending,
      frequency: { _tag: "weekly", times: 4 },
      changeDate: "2026-10-22"
    })).toEqual([
      { effectiveFrom: "2026-10-03", frequency: weekly },
      { effectiveFrom: "2026-10-24", frequency: { _tag: "weekly", times: 4 } }
    ])
  })

  it("clamps an impossible earlier boundary to the stored one", () => {
    // A change date before the stored era (a clock that crossed the boundary
    // between read and write) must not rewrite history backwards.
    expect(habitFrequencyHistoryAfter({
      history: [
        { effectiveFrom: "2026-10-01", frequency: daily },
        { effectiveFrom: "2026-10-10", frequency: weekly }
      ],
      frequency: weekdays,
      changeDate: "2026-10-05"
    })).toEqual([
      { effectiveFrom: "2026-10-01", frequency: daily },
      { effectiveFrom: "2026-10-10", frequency: weekdays }
    ])
  })

  it("seeds era 0 from an empty list", () => {
    expect(habitFrequencyHistoryAfter({ history: [], frequency: daily, changeDate: "2026-10-20" }))
      .toEqual([{ effectiveFrom: "2026-10-20", frequency: daily }])
  })

  it("compares frequency definitions structurally", () => {
    expect(sameHabitFrequency(daily, { _tag: "daily" })).toBe(true)
    expect(sameHabitFrequency(daily, weekly)).toBe(false)
    expect(sameHabitFrequency(
      { _tag: "weekdays", days: [1, 3] },
      { _tag: "weekdays", days: [1, 3] }
    )).toBe(true)
    // The weekday selection is a set: a differently ordered control is the
    // same frequency, not a new era.
    expect(sameHabitFrequency(
      { _tag: "weekdays", days: [3, 1] },
      { _tag: "weekdays", days: [1, 3] }
    )).toBe(true)
  })

  it("derives the start date in the habit's zone, not UTC", () => {
    // 21:30 UTC is already the 21st in Tehran (+03:30).
    expect(localDateIn("2026-10-20T21:30:00.000Z", "Asia/Tehran")).toBe("2026-10-21")
    expect(localDateIn("2026-10-20T21:30:00.000Z", "UTC")).toBe("2026-10-20")
    // The sync path uses the tolerant variant so a bad client value never throws.
    expect(localDateInOption("2026-10-20T21:30:00.000Z", "Mars/Olympus")).toBeNull()
    expect(localDateInOption("not-an-instant", "UTC")).toBeNull()
  })
})

describe("HabitEntry model", () => {
  const entry = {
    id: uuidV7(1_700_000_000_040) as HabitEntryId,
    habitId: weekdayHabit.id,
    ownerId: USER,
    householdId: HOUSEHOLD,
    visibility: "shared" as const,
    localDate: "2026-10-21",
    timeZone: "Asia/Tehran",
    status: "done" as const,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    deletedAt: null
  }

  it("round-trips a logged day", () => {
    const decoded = Schema.decodeUnknownSync(HabitEntry)(entry)
    expect(decoded.localDate).toBe("2026-10-21")
    expect(decoded.habitId).toBe(weekdayHabit.id)
    expect(decoded.status).toBe("done")
  })

  it("accepts exactly the three statuses", () => {
    for (const status of ["done", "partial", "missed"]) {
      expect(Schema.decodeUnknownSync(HabitEntryStatus)(status)).toBe(status)
    }
    expect(() => Schema.decodeUnknownSync(HabitEntryStatus)("skipped")).toThrow()
  })

  it("rejects a malformed entry", () => {
    expect(() => Schema.decodeUnknownSync(HabitEntry)({ ...entry, status: "skipped" })).toThrow()
    expect(() => Schema.decodeUnknownSync(HabitEntry)({ ...entry, localDate: "2026/10/21" }))
      .toThrow()
    expect(() => Schema.decodeUnknownSync(HabitEntry)({ ...entry, habitId: "habit-1" })).toThrow()
  })
})
