import { describe, expect, it } from "vitest"
import type { RecurrenceRule } from "../recurrence.js"
import { nextRecurrenceDue } from "./task-recurrence.js"

/**
 * Ticket #38: the next task instance's due fields, including the two modes,
 * Jalali leap days, time-zone edges and DST. The completed instance's own
 * due date/instant is the input, never the completion clock, for `onDueDate`.
 */

const rule = (value: Partial<RecurrenceRule>): RecurrenceRule => ({
  frequency: "daily",
  interval: 1,
  end: { _tag: "never" },
  ...value
})

const ALL_DAY = { dueDate: "2026-10-20" as string | null, dueAt: null as string | null }
const TEHRAN = "Asia/Tehran"
const NEW_YORK = "America/New_York"

describe("onDueDate", () => {
  it("advances one all-day occurrence from the completed instance's due date", () => {
    // Completing three days late still advances the schedule by one day: the
    // next turn was already scheduled.
    expect(
      nextRecurrenceDue({
        rule: rule({}),
        mode: "onDueDate",
        ...ALL_DAY,
        timeZone: TEHRAN,
        completedAt: "2026-10-23T09:30:00.000Z"
      })
    ).toEqual({ dueDate: "2026-10-21", dueAt: null })
  })

  it("keeps the rule when only the due date was moved", () => {
    // The task's due date was edited from 2026-10-20 to 2026-10-22 before it
    // was completed; the rule is intact and advances from the moved date.
    expect(
      nextRecurrenceDue({
        rule: rule({ interval: 2 }),
        mode: "onDueDate",
        dueDate: "2026-10-22",
        dueAt: null,
        timeZone: TEHRAN,
        completedAt: "2026-10-22T09:30:00.000Z"
      })
    ).toEqual({ dueDate: "2026-10-24", dueAt: null })
  })

  it("preserves the local time of a timed task across spring-forward DST", () => {
    // 09:00 EST (14:00Z) on Mar 7 2026 → 09:00 EDT (13:00Z) on Mar 8.
    expect(
      nextRecurrenceDue({
        rule: rule({}),
        mode: "onDueDate",
        dueDate: null,
        dueAt: "2026-03-07T14:00:00.000Z",
        timeZone: NEW_YORK,
        completedAt: "2026-03-07T15:00:00.000Z"
      })
    ).toEqual({ dueDate: null, dueAt: "2026-03-08T13:00:00.000Z" })
  })

  it("preserves the local time across fall-back DST", () => {
    // 09:00 EDT (13:00Z) on Oct 31 2026 → 09:00 EST (14:00Z) on Nov 1.
    expect(
      nextRecurrenceDue({
        rule: rule({}),
        mode: "onDueDate",
        dueDate: null,
        dueAt: "2026-10-31T13:00:00.000Z",
        timeZone: NEW_YORK,
        completedAt: "2026-10-31T14:00:00.000Z"
      })
    ).toEqual({ dueDate: null, dueAt: "2026-11-01T14:00:00.000Z" })
  })

  it("moves a nonexistent spring-forward wall time forward by the gap", () => {
    // 02:30 EST (07:30Z) on Mar 7; Mar 8 has no 02:30, so `compatible`
    // resolves to 03:30 EDT, which is still 07:30Z.
    expect(
      nextRecurrenceDue({
        rule: rule({}),
        mode: "onDueDate",
        dueDate: null,
        dueAt: "2026-03-07T07:30:00.000Z",
        timeZone: NEW_YORK,
        completedAt: "2026-03-07T08:00:00.000Z"
      })
    ).toEqual({ dueDate: null, dueAt: "2026-03-08T07:30:00.000Z" })
  })

  it("uses the item zone, not UTC, to find the due local date", () => {
    // 21:00Z on Oct 20 is already Oct 21 in Tehran.
    expect(
      nextRecurrenceDue({
        rule: rule({}),
        mode: "onDueDate",
        dueDate: null,
        dueAt: "2026-10-20T21:00:00.000Z",
        timeZone: TEHRAN,
        completedAt: "2026-10-20T21:30:00.000Z"
      })
    ).toEqual({ dueDate: null, dueAt: "2026-10-21T21:00:00.000Z" })
  })

  it("skips impossible Jalali dates instead of clamping", () => {
    // Monthly on the 31st from 1405/07/28: the next 31st is 1406/01/31.
    expect(
      nextRecurrenceDue({
        rule: rule({ frequency: "monthly", byMonthDay: [31] }),
        mode: "onDueDate",
        ...ALL_DAY,
        timeZone: TEHRAN,
        completedAt: "2026-10-20T09:30:00.000Z"
      })
    ).toEqual({ dueDate: "2027-04-20", dueAt: null })
  })

  it("has no next instance after the last count/until occurrence", () => {
    expect(
      nextRecurrenceDue({
        rule: rule({ end: { _tag: "count", count: 1 } }),
        mode: "onDueDate",
        ...ALL_DAY,
        timeZone: TEHRAN,
        completedAt: "2026-10-20T09:30:00.000Z"
      })
    ).toBeNull()
    expect(
      nextRecurrenceDue({
        rule: rule({ end: { _tag: "until", date: "2026-10-20" } }),
        mode: "onDueDate",
        ...ALL_DAY,
        timeZone: TEHRAN,
        completedAt: "2026-10-20T09:30:00.000Z"
      })
    ).toBeNull()
  })
})

describe("onCompletion", () => {
  it("restarts the interval on the completion day", () => {
    // 3-day rule, 10 days overdue: the next turn is 3 days after completion,
    // not the next slot of the old grid.
    expect(
      nextRecurrenceDue({
        rule: rule({ interval: 3 }),
        mode: "onCompletion",
        dueDate: "2026-10-10",
        dueAt: null,
        timeZone: TEHRAN,
        completedAt: "2026-10-20T09:30:00.000Z"
      })
    ).toEqual({ dueDate: "2026-10-23", dueAt: null })
  })

  it("uses the completion local date across a UTC midnight edge", () => {
    // 21:00Z Oct 20 is Oct 21 in Tehran, so a daily task is due Oct 22.
    expect(
      nextRecurrenceDue({
        rule: rule({}),
        mode: "onCompletion",
        dueDate: null,
        dueAt: null,
        timeZone: TEHRAN,
        completedAt: "2026-10-20T21:00:00.000Z"
      })
    ).toEqual({ dueDate: "2026-10-22", dueAt: null })
  })

  it("never moves the next turn before a future due date", () => {
    expect(
      nextRecurrenceDue({
        rule: rule({}),
        mode: "onCompletion",
        dueDate: "2026-10-25",
        dueAt: null,
        timeZone: TEHRAN,
        completedAt: "2026-10-20T09:30:00.000Z"
      })
    ).toEqual({ dueDate: "2026-10-26", dueAt: null })
  })

  it("keeps a timed task's wall time when restarting", () => {
    // Completing early on Oct 20 a task due Oct 25 at 09:00 Tehran keeps the
    // 09:00 wall time on Oct 26 (05:30Z).
    expect(
      nextRecurrenceDue({
        rule: rule({}),
        mode: "onCompletion",
        dueDate: null,
        dueAt: "2026-10-25T05:30:00.000Z",
        timeZone: TEHRAN,
        completedAt: "2026-10-20T09:30:00.000Z"
      })
    ).toEqual({ dueDate: null, dueAt: "2026-10-26T05:30:00.000Z" })
  })

  it("lands on the next Jalali leap day for a yearly Esfand 30 rule", () => {
    expect(
      nextRecurrenceDue({
        rule: rule({ frequency: "yearly" }),
        mode: "onCompletion",
        dueDate: "2025-03-20",
        dueAt: null,
        timeZone: TEHRAN,
        completedAt: "2025-03-20T09:30:00.000Z"
      })
    ).toEqual({ dueDate: "2030-03-20", dueAt: null })
  })
})
