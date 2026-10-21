import { describe, expect, it } from "vitest"
import {
  buildMonthReadModel,
  buildWeekReadModel,
  busyLevelOf,
  jalaliMonthOf,
  monthRange,
  taskOccurrences,
  weekDates,
  weekRange,
  type CalendarTaskSource
} from "./planning/calendar.js"
import type { RecurrenceRule } from "./recurrence.js"

/**
 * Ticket #43 at the domain seam: the week/month builders are the single
 * projection shared by the API read models and the offline mirror, so the
 * boundaries pinned here are the behaviour both paths inherit.
 */

const weekly = (days: ReadonlyArray<number>): RecurrenceRule => ({
  frequency: "weekly",
  interval: 1,
  byDay: [...days],
  end: { _tag: "never" }
})

const task = (
  input: Partial<CalendarTaskSource> & { readonly id: string }
): CalendarTaskSource => ({
  title: input.title ?? input.id,
  status: input.status ?? "todo",
  priority: input.priority ?? "medium",
  dueDate: input.dueDate ?? null,
  dueAt: input.dueAt ?? null,
  recurrence: input.recurrence ?? null,
  recurrenceMode: input.recurrenceMode ?? null,
  id: input.id
})

describe("week ranges", () => {
  it("starts on the configured week day", () => {
    expect(weekRange("2026-03-25", "saturday")).toMatchObject({
      start: "2026-03-21",
      end: "2026-03-27",
      endExclusive: "2026-03-28"
    })
    expect(weekRange("2026-03-25", "sunday")).toMatchObject({
      start: "2026-03-22",
      end: "2026-03-28",
      endExclusive: "2026-03-29"
    })
    expect(weekRange("2026-03-25", "monday")).toMatchObject({
      start: "2026-03-23",
      end: "2026-03-29",
      endExclusive: "2026-03-30"
    })
    expect(weekDates("2026-03-25", "saturday")).toHaveLength(7)
  })

  it("crosses a Jalali month edge without losing a day", () => {
    // 2026-03-21 is 1 Farvardin 1405 (Nowruz); the week spans into Farvardin.
    const range = weekRange("2026-03-21", "saturday")
    expect(range.start).toBe("2026-03-21")
    expect(range.end).toBe("2026-03-27")
    expect(monthRange(1405, 1, "saturday").start).toBe("2026-03-21")
    expect(jalaliMonthOf("2026-03-20")).toEqual({ year: 1404, month: 12 })
    expect(jalaliMonthOf("2026-03-21")).toEqual({ year: 1405, month: 1 })
  })
})

describe("week read model", () => {
  it("places all-day tasks on their day and drops done rows", () => {
    const model = buildWeekReadModel({
      anchor: "2026-03-21",
      weekStart: "saturday",
      timeZone: "Asia/Tehran",
      tasks: [
        task({ id: "a", title: "شنبه", dueDate: "2026-03-21" }),
        task({ id: "b", title: "یکشنبه", dueDate: "2026-03-22", priority: "high" }),
        task({ id: "c", title: "انجام‌شده", dueDate: "2026-03-22", status: "done" }),
        task({ id: "d", title: "هفته بعد", dueDate: "2026-03-28" })
      ]
    })
    expect(model.days).toHaveLength(7)
    expect(model.days[0]!.date).toBe("2026-03-21")
    expect(model.days[0]!.tasks.map((item) => item.title)).toEqual(["شنبه"])
    expect(model.days[1]!.tasks.map((item) => item.title)).toEqual(["یکشنبه"])
    expect(model.days[2]!.tasks).toEqual([])
    expect(model.totals.tasks).toBe(2)
    expect(model.totals.events).toBe(0)
    expect(model.empty).toEqual({
      tasks: false,
      events: true,
      reminders: true,
      habits: true
    })
  })

  it("places timed tasks by the viewer's local day across a DST change", () => {
    const model = buildWeekReadModel({
      anchor: "2026-03-08",
      weekStart: "sunday",
      timeZone: "America/New_York",
      tasks: [
        // 01:30 EST on 8 March.
        task({ id: "a", dueAt: "2026-03-08T06:30:00.000Z" }),
        // 23:30 EDT on 8 March (the clock has already sprung forward).
        task({ id: "b", dueAt: "2026-03-09T03:30:00.000Z" }),
        // 00:30 EDT on 9 March.
        task({ id: "c", dueAt: "2026-03-09T04:30:00.000Z" })
      ]
    })
    const sunday = model.days.find((day) => day.date === "2026-03-08")!
    const monday = model.days.find((day) => day.date === "2026-03-09")!
    expect(sunday.tasks.map((item) => item.id)).toEqual(["a", "b"])
    expect(monday.tasks.map((item) => item.id)).toEqual(["c"])
  })

  it("projects an on-due-date series as read-only occurrences", () => {
    const series = task({
      id: "series",
      title: "ورزش",
      dueDate: "2026-03-25",
      recurrence: weekly([3]),
      recurrenceMode: "onDueDate"
    })
    // The live row is in the previous week; the next week still shows the
    // schedule, marked projected.
    const model = buildWeekReadModel({
      anchor: "2026-04-01",
      weekStart: "sunday",
      timeZone: "Asia/Tehran",
      tasks: [series]
    })
    const wednesday = model.days.find((day) => day.date === "2026-04-01")!
    expect(wednesday.tasks).toHaveLength(1)
    expect(wednesday.tasks[0]).toMatchObject({
      id: "series",
      projected: true,
      recurring: true,
      key: "series@2026-04-01"
    })

    // The real anchor is not projected on top of its own row.
    const anchorWeek = buildWeekReadModel({
      anchor: "2026-03-25",
      weekStart: "sunday",
      timeZone: "Asia/Tehran",
      tasks: [series]
    })
    const anchorDay = anchorWeek.days.find((day) => day.date === "2026-03-25")!
    expect(anchorDay.tasks).toHaveLength(1)
    expect(anchorDay.tasks[0]!.projected).toBe(false)
  })

  it("does not project on-completion series and respects a count bound", () => {
    const model = buildWeekReadModel({
      anchor: "2026-04-01",
      weekStart: "sunday",
      timeZone: "Asia/Tehran",
      tasks: [
        task({
          id: "completion",
          dueDate: "2026-03-25",
          recurrence: weekly([3]),
          recurrenceMode: "onCompletion"
        }),
        task({
          id: "bounded",
          dueDate: "2026-03-25",
          recurrence: { ...weekly([3]), end: { _tag: "count", count: 2 } },
          recurrenceMode: "onDueDate"
        })
      ]
    })
    const items = model.days.flatMap((day) => day.tasks)
    expect(items.some((item) => item.id === "completion")).toBe(false)
    // The anchor itself consumes one of the two occurrences, so only one
    // projected date remains.
    expect(items.filter((item) => item.id === "bounded")).toHaveLength(1)
    expect(items.find((item) => item.id === "bounded")!.projected).toBe(true)
  })

  it("does not double-paint a row supplied twice", () => {
    const row = task({ id: "one", dueDate: "2026-03-22" })
    const items = taskOccurrences({
      tasks: [row, row],
      range: weekRange("2026-03-22", "sunday"),
      timeZone: "UTC"
    })
    expect(items).toHaveLength(1)
  })
})

describe("month read model", () => {
  it("marks busy days and returns the day drill-down", () => {
    const model = buildMonthReadModel({
      year: 1405,
      month: 1,
      weekStart: "saturday",
      timeZone: "Asia/Tehran",
      day: "2026-03-22",
      tasks: [
        task({ id: "a", title: "یک", dueDate: "2026-03-21" }),
        task({ id: "b", title: "دو", dueDate: "2026-03-22" }),
        task({ id: "c", title: "سه", dueDate: "2026-03-22", priority: "high" }),
        task({ id: "d", title: "انجام‌شده", dueDate: "2026-03-22", status: "done" })
      ]
    })
    expect(model.start).toBe("2026-03-21")
    expect(model.days[0]).toMatchObject({ date: "2026-03-21", inMonth: true })
    const second = model.days.find((day) => day.date === "2026-03-22")!
    expect(second).toMatchObject({
      isBusy: true,
      tasks: 2,
      busyLevel: 1,
      inMonth: true
    })
    expect(second.counts).toEqual({ tasks: 2, events: 0, reminders: 0, habits: 0 })
    expect(model.totals).toEqual({ busyDays: 2, tasks: 3 })
    expect(model.day?.date).toBe("2026-03-22")
    expect(model.day?.tasks.map((item) => item.title)).toEqual(["سه", "دو"])
  })

  it("includes adjacent-month cells without counting them in the month totals", () => {
    // Ordibehesht 1405 starts 2026-04-21 (Tuesday), so Saturday-start weeks
    // borrow three days from Farvardin.
    const model = buildMonthReadModel({
      year: 1405,
      month: 2,
      weekStart: "saturday",
      timeZone: "Asia/Tehran",
      tasks: [
        task({ id: "prev", dueDate: "2026-04-20" }),
        task({ id: "this", dueDate: "2026-04-21" })
      ]
    })
    const borrowed = model.days.filter((day) => !day.inMonth)
    expect(borrowed.length).toBeGreaterThan(0)
    expect(model.days.find((day) => day.date === "2026-04-20")).toMatchObject({
      inMonth: false,
      isBusy: true
    })
    expect(model.totals).toEqual({ busyDays: 1, tasks: 1 })
  })

  it("scales the busy mark to three dots", () => {
    expect(busyLevelOf(0)).toBe(0)
    expect(busyLevelOf(2)).toBe(1)
    expect(busyLevelOf(4)).toBe(2)
    expect(busyLevelOf(9)).toBe(3)
  })

  it("projects a drill-down day that lies outside the month grid", () => {
    const model = buildMonthReadModel({
      year: 1405,
      month: 1,
      weekStart: "saturday",
      timeZone: "Asia/Tehran",
      day: "2026-06-01",
      tasks: [task({ id: "far", title: "دور", dueDate: "2026-06-01" })]
    })
    expect(model.days.some((cell) => cell.date === "2026-06-01")).toBe(false)
    expect(model.day?.date).toBe("2026-06-01")
    expect(model.day?.tasks.map((item) => item.id)).toEqual(["far"])
    expect(model.totals).toEqual({ busyDays: 0, tasks: 0 })
  })
})
