import { describe, expect, it } from "vitest"
import { taskBucketBounds, taskBucketOf } from "./planning/buckets.js"

/**
 * Ticket #36 bucket boundaries: Today must follow the viewer's wall clock,
 * including DST days and Jalali month edges (persian calendar is display-only,
 * so the stored date is the ISO date).
 */

const task = (input: {
  readonly dueDate?: string | null
  readonly dueAt?: string | null
  readonly status?: "todo" | "doing" | "done"
}) => ({
  dueDate: input.dueDate ?? null,
  dueAt: input.dueAt ?? null,
  status: input.status ?? ("todo" as const)
})

describe("task bucket bounds", () => {
  it("uses a 23-hour day across the Berlin spring-forward transition", () => {
    const bounds = taskBucketBounds("Europe/Berlin", "2026-03-29T10:00:00.000Z")
    expect(bounds.today).toBe("2026-03-29")
    expect(bounds.todayStart).toBe("2026-03-28T23:00:00Z")
    expect(bounds.tomorrowStart).toBe("2026-03-29T22:00:00Z")
    expect(
      Date.parse(bounds.tomorrowStart) - Date.parse(bounds.todayStart)
    ).toBe(23 * 60 * 60 * 1000)
  })

  it("uses a 25-hour day across the New York fall-back transition", () => {
    const bounds = taskBucketBounds("America/New_York", "2026-11-01T12:00:00.000Z")
    expect(bounds.today).toBe("2026-11-01")
    expect(bounds.todayStart).toBe("2026-11-01T04:00:00Z")
    expect(bounds.tomorrowStart).toBe("2026-11-02T05:00:00Z")
    expect(
      Date.parse(bounds.tomorrowStart) - Date.parse(bounds.todayStart)
    ).toBe(25 * 60 * 60 * 1000)
  })

  it("places all-day tasks across a Nowruz month edge", () => {
    // 2026-03-21 is 1 Farvardin 1405 (Nowruz) in Tehran.
    const bounds = taskBucketBounds("Asia/Tehran", "2026-03-21T10:00:00+03:30")
    expect(bounds.today).toBe("2026-03-21")
    expect(taskBucketOf(task({ dueDate: "2026-03-20" }), bounds)).toBe("overdue")
    expect(taskBucketOf(task({ dueDate: "2026-03-21" }), bounds)).toBe("today")
    expect(taskBucketOf(task({ dueDate: "2026-03-22" }), bounds)).toBe("tomorrow")
    expect(taskBucketOf(task({ dueDate: "2026-03-28" }), bounds)).toBe("thisWeek")
    expect(taskBucketOf(task({ dueDate: "2026-03-29" }), bounds)).toBe("later")
  })

  it("places all-day tasks across the end of Farvardin", () => {
    // Farvardin 1405 has 31 days; 2026-04-20 is 31 Farvardin.
    const bounds = taskBucketBounds("Asia/Tehran", "2026-04-20T12:00:00+03:30")
    expect(bounds.today).toBe("2026-04-20")
    expect(taskBucketOf(task({ dueDate: "2026-04-19" }), bounds)).toBe("overdue")
    expect(taskBucketOf(task({ dueDate: "2026-04-20" }), bounds)).toBe("today")
    expect(taskBucketOf(task({ dueDate: "2026-04-21" }), bounds)).toBe("tomorrow")
  })

  it("treats timed boundaries exactly at the zoned day starts", () => {
    const bounds = taskBucketBounds("Europe/Berlin", "2026-03-29T10:00:00.000Z")
    expect(taskBucketOf(task({ dueAt: "2026-03-28T22:59:59.999Z" }), bounds)).toBe(
      "overdue"
    )
    expect(taskBucketOf(task({ dueAt: bounds.todayStart }), bounds)).toBe("today")
    expect(taskBucketOf(task({ dueAt: bounds.tomorrowStart }), bounds)).toBe("tomorrow")
    expect(taskBucketOf(task({ dueAt: bounds.dayAfterTomorrowStart }), bounds)).toBe(
      "thisWeek"
    )
    expect(taskBucketOf(task({ dueAt: bounds.weekEndExclusive }), bounds)).toBe("later")
  })

  it("never puts a no-date task in Today, and excludes done tasks", () => {
    const bounds = taskBucketBounds("Asia/Tehran", "2026-03-21T10:00:00+03:30")
    expect(taskBucketOf(task({}), bounds)).toBe("noDate")
    expect(taskBucketOf(task({ dueDate: "2026-03-21", status: "done" }), bounds)).toBe(
      "done"
    )
  })
})
