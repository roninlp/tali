import { describe, expect, it } from "vitest"
import { Temporal } from "temporal-polyfill/full"
import {
  addJalaliDays,
  addJalaliMonths,
  addJalaliYears,
  daysInJalaliMonth,
  daysInJalaliYear,
  endOfJalaliMonth,
  endOfJalaliYear,
  formatJalaliDate,
  formatJalaliMonth,
  isJalaliLeapYear,
  isSameJalaliMonth,
  jalaliDate,
  jalaliMonthGrid,
  jalaliWeek,
  startOfJalaliMonth,
  startOfJalaliYear,
  startOfJalaliWeek,
  toIsoDate,
  toJalaliDate,
  toJalaliDateInZone,
  toJalaliFields,
  todayInTimeZone
} from "./jalali.js"

const iso = (year: number, month: number, day: number) => toIsoDate(jalaliDate(year, month, day))

describe("Jalali conversion", () => {
  it("converts known Jalali dates to Gregorian", () => {
    expect(iso(1403, 1, 1)).toBe("2024-03-20")
    expect(iso(1403, 7, 15)).toBe("2024-10-06")
    expect(iso(1403, 12, 30)).toBe("2025-03-20")
    expect(iso(1404, 1, 1)).toBe("2025-03-21")
  })

  it("converts Gregorian ISO dates to Jalali fields", () => {
    expect(toJalaliFields(toJalaliDate("2024-03-19"))).toEqual({ year: 1402, month: 12, day: 29 })
    expect(toJalaliFields(toJalaliDate("2024-03-20"))).toEqual({ year: 1403, month: 1, day: 1 })
    expect(toJalaliFields(toJalaliDate("2024-10-06"))).toEqual({ year: 1403, month: 7, day: 15 })
    expect(toJalaliFields(toJalaliDate("2025-03-20"))).toEqual({ year: 1403, month: 12, day: 30 })
    expect(toJalaliFields(toJalaliDate("2025-03-21"))).toEqual({ year: 1404, month: 1, day: 1 })
  })

  it("round-trips through ISO", () => {
    expect(toIsoDate(toJalaliDate("2024-10-06"))).toBe("2024-10-06")
    expect(toIsoDate(toJalaliDate("2026-03-21"))).toBe("2026-03-21")
  })
})

describe("Jalali leap years and month boundaries", () => {
  it("knows leap years", () => {
    for (const year of [1399, 1403, 1408]) expect(isJalaliLeapYear(year)).toBe(true)
    for (const year of [1400, 1401, 1402, 1404, 1405]) expect(isJalaliLeapYear(year)).toBe(false)
  })

  it("knows month and year lengths", () => {
    expect(daysInJalaliYear(1403)).toBe(366)
    expect(daysInJalaliYear(1404)).toBe(365)
    for (const month of [1, 2, 3, 4, 5, 6]) expect(daysInJalaliMonth(1403, month)).toBe(31)
    for (const month of [7, 8, 9, 10, 11]) expect(daysInJalaliMonth(1403, month)).toBe(30)
    expect(daysInJalaliMonth(1403, 12)).toBe(30)
    expect(daysInJalaliMonth(1404, 12)).toBe(29)
  })

  it("computes month and year boundaries", () => {
    expect(toIsoDate(startOfJalaliMonth(jalaliDate(1403, 7, 15)))).toBe("2024-09-22")
    expect(toIsoDate(endOfJalaliMonth(jalaliDate(1403, 7, 15)))).toBe("2024-10-21")
    expect(toIsoDate(startOfJalaliYear(jalaliDate(1403, 7, 15)))).toBe("2024-03-20")
    expect(toIsoDate(endOfJalaliYear(jalaliDate(1403, 7, 15)))).toBe("2025-03-20")
  })

  it("rolls over the farvardin boundary", () => {
    expect(toIsoDate(addJalaliDays(jalaliDate(1403, 12, 29), 1))).toBe("2025-03-20")
    expect(toIsoDate(addJalaliDays(jalaliDate(1403, 12, 30), 1))).toBe("2025-03-21")
    expect(toJalaliFields(addJalaliDays(jalaliDate(1403, 12, 30), 1))).toEqual({
      year: 1404,
      month: 1,
      day: 1
    })
  })

  it("clamps or rejects Esfand 30 when the target year is common", () => {
    expect(toIsoDate(addJalaliYears(jalaliDate(1403, 12, 30), 1))).toBe("2026-03-20")
    expect(toJalaliFields(addJalaliYears(jalaliDate(1403, 12, 30), 1))).toEqual({
      year: 1404,
      month: 12,
      day: 29
    })
    expect(() =>
      addJalaliYears(jalaliDate(1403, 12, 30), 1, { overflow: "reject" })
    ).toThrow(RangeError)
  })

  it("adds months without losing the calendar", () => {
    const next = addJalaliMonths(jalaliDate(1403, 6, 31), 1)
    expect(toJalaliFields(next)).toEqual({ year: 1403, month: 7, day: 30 })
    expect(next.calendarId).toBe("persian")
    expect(isSameJalaliMonth(next, jalaliDate(1403, 7, 1))).toBe(true)
  })
})

describe("Jalali calendar grid", () => {
  it("starts weeks on Saturday and pads with adjacent-month days", () => {
    // 1403-07-01 is Sunday 2024-09-22, so the grid opens on Saturday 1403-06-31.
    const grid = jalaliMonthGrid(1403, 7)

    expect(grid.weeks).toHaveLength(5)
    expect(grid.weeks.every((week) => week.days.length === 7)).toBe(true)
    expect(toJalaliFields(grid.start)).toEqual({ year: 1403, month: 6, day: 31 })
    expect(toJalaliFields(grid.end)).toEqual({ year: 1403, month: 8, day: 4 })
    expect(grid.start.withCalendar("iso8601").dayOfWeek).toBe(6)

    const cells = grid.weeks.flatMap((week) => week.days)
    expect(cells).toHaveLength(35)
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(30)
    expect(cells[0]?.inMonth).toBe(false)
    expect(cells[1]?.inMonth).toBe(true)

    for (let index = 1; index < cells.length; index += 1) {
      expect(
        Temporal.PlainDate.compare(
          cells[index]!.date,
          cells[index - 1]!.date.add({ days: 1 })
        )
      ).toBe(0)
    }
  })

  it("honours the configured week start", () => {
    const monday = jalaliMonthGrid(1403, 7, { weekStart: "monday" })
    expect(monday.start.withCalendar("iso8601").dayOfWeek).toBe(1)
    expect(monday.weeks).toHaveLength(6)
    expect(monday.weeks.flatMap((week) => week.days).filter((cell) => cell.inMonth)).toHaveLength(30)

    const sunday = jalaliMonthGrid(1403, 7, { weekStart: "sunday" })
    expect(sunday.start.withCalendar("iso8601").dayOfWeek).toBe(7)
    expect(sunday.start.equals(jalaliDate(1403, 7, 1))).toBe(true)
  })

  it("returns the seven days of a week", () => {
    const week = jalaliWeek(jalaliDate(1403, 7, 15))
    expect(week).toHaveLength(7)
    expect(startOfJalaliWeek(jalaliDate(1403, 7, 15)).withCalendar("iso8601").dayOfWeek).toBe(6)
    expect(toJalaliFields(week[0]!)).toEqual({ year: 1403, month: 7, day: 14 })
    expect(toJalaliFields(week[6]!)).toEqual({ year: 1403, month: 7, day: 20 })
  })
})

describe("timezone-aware today", () => {
  const instant = Temporal.Instant.from("2026-10-19T20:30:00Z")

  it("uses the user's IANA timezone, not UTC", () => {
    expect(toJalaliFields(todayInTimeZone("UTC", instant))).toEqual({
      year: 1405,
      month: 7,
      day: 27
    })
    // 20:30 UTC is 00:00 on the next day in Tehran (UTC+03:30).
    expect(toJalaliFields(todayInTimeZone("Asia/Tehran", instant))).toEqual({
      year: 1405,
      month: 7,
      day: 28
    })
    expect(toJalaliFields(toJalaliDateInZone(new Date("2026-10-19T20:30:00Z"), "Asia/Tehran"))).toEqual({
      year: 1405,
      month: 7,
      day: 28
    })
  })

  it("rejects an unknown timezone", () => {
    expect(() => todayInTimeZone("Not/AZone", instant)).toThrow(RangeError)
  })
})

describe("Jalali display formatting", () => {
  const date = jalaliDate(1403, 7, 15)

  it("defaults to Persian digits", () => {
    expect(formatJalaliDate(date)).toBe("یکشنبه ۱۵ مهر ۱۴۰۳")
    expect(formatJalaliDate(date, { style: "medium" })).toBe("۱۵ مهر ۱۴۰۳")
    expect(formatJalaliDate(date, { style: "short" })).toBe("۱۵ مهر")
    expect(formatJalaliDate(date, { style: "numeric" })).toBe("۱۴۰۳/۰۷/۱۵")
  })

  it("offers a Latin-digit opt-out", () => {
    expect(formatJalaliDate(date, { digits: "latin" })).toBe("یکشنبه 15 مهر 1403")
    expect(formatJalaliDate(date, { digits: "latin", style: "numeric" })).toBe("1403/07/15")
  })

  it("formats a month heading", () => {
    expect(formatJalaliMonth(1403, 7)).toBe("مهر ۱۴۰۳")
    expect(formatJalaliMonth(1403, 7, "latin")).toBe("مهر 1403")
  })
})
