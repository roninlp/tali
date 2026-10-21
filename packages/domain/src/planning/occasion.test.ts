import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { uuidV7 } from "../ids.js"
import type { HouseholdId, UserId } from "../common.js"
import type { LocalDate, OccasionId } from "./common.js"
import { Occasion } from "./occasion.js"
import {
  isOccasionOccurrence,
  nextOccasionOccurrence,
  occasionAdvanceReminder,
  occasionAdvanceReminders,
  occasionDateInJalaliYear,
  occasionOccurrences,
  occasionPreparationTaskTitle,
  type OccasionSource
} from "./occasion-projection.js"

/**
 * Ticket #59 exit criteria, at the domain seam:
 *
 * - an occasion projects onto its Jalali date every year (the Gregorian date
 *   is derived, never stored);
 * - Esfand 30 clamps to Esfand 29 in a common year instead of vanishing;
 * - the advance reminder is `occurrence − offset`, not a stored per-year rule;
 * - the one-off marker keeps a date on its origin only.
 */

const NOW = "2026-10-20T09:30:00.000Z"
const USER = "user-1" as UserId
const HOUSEHOLD = "household-1" as HouseholdId

const source = (overrides: Partial<OccasionSource> = {}): OccasionSource => ({
  id: overrides.id ?? "occasion-1",
  title: overrides.title ?? "تولد مامان",
  color: overrides.color ?? null,
  originDate: overrides.originDate ?? "1990-04-01",
  timeZone: overrides.timeZone ?? "Asia/Tehran",
  yearly: overrides.yearly ?? true,
  advanceReminderDays:
    overrides.advanceReminderDays === undefined ? 7 : overrides.advanceReminderDays
})

describe("Occasion model", () => {
  it("round-trips the aggregate with the yearly marker and the offset", () => {
    const occasion = {
      id: uuidV7(1_700_000_000_100) as OccasionId,
      type: "occasion" as const,
      title: "سالگرد ازدواج",
      originDate: "2018-06-15",
      timeZone: "Asia/Tehran",
      yearly: true,
      advanceReminderDays: 14,
      preparationTaskId: null,
      ownerId: USER,
      householdId: HOUSEHOLD,
      visibility: "shared" as const,
      color: "#f4b6c2",
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
      deletedAt: null
    }
    const decoded = Schema.decodeUnknownSync(Occasion)(occasion)
    expect(decoded.originDate).toBe("2018-06-15")
    expect(decoded.yearly).toBe(true)
    expect(decoded.advanceReminderDays).toBe(14)
  })

  it("rejects an offset outside 0…365 days", () => {
    expect(() =>
      Schema.decodeUnknownSync(Occasion)({
        id: uuidV7(1_700_000_000_101) as OccasionId,
        type: "occasion",
        title: "تولد",
        originDate: "1990-04-01",
        timeZone: "Asia/Tehran",
        yearly: true,
        advanceReminderDays: 400,
        preparationTaskId: null,
        ownerId: USER,
        householdId: HOUSEHOLD,
        visibility: "shared",
        color: null,
        createdAt: NOW,
        updatedAt: NOW,
        version: 1,
        deletedAt: null
      })
    ).toThrow()
  })
})

describe("annual projection", () => {
  it("projects the origin's Jalali month/day into every year", () => {
    // Origin 1990-04-01 is 12 Farvardin 1369; 1405-01-12 is 2026-04-01.
    const occasion = source()
    expect(occasionDateInJalaliYear(occasion, 1369)).toBe("1990-04-01")
    expect(occasionDateInJalaliYear(occasion, 1405)).toBe("2026-04-01")
    expect(occasionDateInJalaliYear(occasion, 1406)).toBe("2027-04-01")
    // An occasion never projects before its origin.
    expect(occasionDateInJalaliYear(occasion, 1368)).toBeNull()
  })

  it("returns both calendars for the month grid", () => {
    const [occurrence] = occasionOccurrences({
      occasions: [source({ advanceReminderDays: null })],
      range: { from: "2026-03-01"as LocalDate, to: "2026-03-31"as LocalDate }
    })
    expect(occurrence).toBeUndefined()

    const [april] = occasionOccurrences({
      occasions: [source({ advanceReminderDays: null })],
      range: { from: "2026-04-01"as LocalDate, to: "2026-04-30"as LocalDate }
    })
    expect(april?.date).toBe("2026-04-01")
    expect(april?.jalali).toEqual({ year: 1405, month: 1, day: 12 })
    expect(april?.gregorian).toEqual({ year: 2026, month: 4, day: 1 })
    expect(april?.projected).toBe(true)
    expect(april?.key).toBe("occasion-1@2026-04-01")
  })

  it("clamps Esfand 30 to Esfand 29 in a common year", () => {
    // 1375 is a Jalali leap year; 1376 is common. Both dates are Esfand 30/29.
    const occasion = source({
      originDate: "1997-03-20", // 1375-12-30 (leap)
      advanceReminderDays: null
    })
    const leap = occasionDateInJalaliYear(occasion, 1375)
    const common = occasionDateInJalaliYear(occasion, 1376)
    expect(leap).toBe("1997-03-20")
    expect(common).not.toBeNull()
    const next = occasionOccurrences({
      occasions: [occasion],
      range: { from: "1998-01-01"as LocalDate, to: "1998-12-31"as LocalDate }
    })
    expect(next).toHaveLength(1)
    expect(next[0]?.jalali).toEqual({ year: 1376, month: 12, day: 29 })
  })

  it("keeps a one-off date on its origin only", () => {
    const occasion = source({ yearly: false, advanceReminderDays: null })
    expect(occasionDateInJalaliYear(occasion, 1369)).toBe("1990-04-01")
    expect(occasionDateInJalaliYear(occasion, 1405)).toBeNull()
    expect(
      occasionOccurrences({
        occasions: [occasion],
        range: { from: "2026-01-01"as LocalDate, to: "2026-12-31"as LocalDate }
      })
    ).toEqual([])
  })

  it("can answer what the next occurrence is", () => {
    const occasion = source()
    expect(nextOccasionOccurrence(occasion, "2026-10-21")?.date).toBe("2027-04-01")
    expect(nextOccasionOccurrence(occasion, "2026-04-01")?.date).toBe("2026-04-01")
    expect(isOccasionOccurrence(occasion, "2026-04-01")).toBe(true)
    expect(isOccasionOccurrence(occasion, "2026-04-02")).toBe(false)
  })
})

describe("advance reminder", () => {
  it("subtracts the offset from the occurrence, year after year", () => {
    const occasion = source({ advanceReminderDays: 7 })
    const reminder = occasionAdvanceReminder(occasion, "2026-04-01")
    expect(reminder?.dueDate).toBe("2026-03-25")
    expect(reminder?.advanceDays).toBe(7)
    expect(reminder?.occurrenceDate).toBe("2026-04-01")
    expect(reminder?.reminderKey).toBe("occasion-1:2026-04-01")
    expect(reminder?.link).toEqual({ _tag: "occasion", occasionId: "occasion-1" })
    // 09:00 Tehran time is 05:30 UTC (Iran has no DST since 2022).
    expect(reminder?.fireAt).toBe("2026-03-25T05:30:00Z")
    // The next year's reminder is derived too — never stored.
    expect(occasionAdvanceReminder(occasion, "2027-04-01")?.dueDate).toBe("2027-03-25")
  })

  it("has no reminder when the offset is cleared", () => {
    expect(occasionAdvanceReminder(source({ advanceReminderDays: null }), "2026-04-01")).toBeNull()
  })

  it("lists only reminders whose due date is inside the window", () => {
    const occasions = [
      source({ id: "seven", advanceReminderDays: 7 }),
      source({ id: "none", advanceReminderDays: null }),
      source({
        id: "one-off",
        originDate: "2020-05-01",
        yearly: false,
        advanceReminderDays: 3
      })
    ]
    const reminders = occasionAdvanceReminders({
      occasions,
      range: { from: "2026-03-20"as LocalDate, to: "2026-03-31"as LocalDate }
    })
    expect(reminders.map((reminder) => reminder.occasionId)).toEqual(["seven"])
    expect(reminders[0]?.dueDate).toBe("2026-03-25")
  })

  it("defaults the preparation task title from the occasion", () => {
    expect(occasionPreparationTaskTitle("تولد سارا")).toBe("آماده‌سازی برای تولد سارا")
  })
})
