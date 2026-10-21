import { describe, expect, it } from "vitest"
import {
  MISSED_INBOX_HOURS,
  QUIET_HOURS_END_MINUTES,
  QUIET_HOURS_START_MINUTES,
  SNOOZE_PRESETS_MINUTES,
  allDayReminderInstant,
  inboxStateOf,
  isMissed,
  isOnTime,
  isQuietHoursInstant,
  isSnoozeMinutes,
  quietHoursEndAfter,
  reminderDeliverAt,
  reminderFireAt,
  reminderFirstFireAt,
  reminderNextFireAfter,
  reminderNextFireAfterNow,
  reminderTierFor,
  snoozeInstant
} from "./reminder-policy.js"

/**
 * The scheduling policy (ticket #13, ADR-0005) as a pure contract.
 *
 * These are the rules #61 must not re-implement: quiet hours in the owner's
 * zone, the medication bypass, silence as suppression, snooze presets, the
 * 24-hour inbox roll-off and the root-anchored on-time window.
 */

const TEHRAN = "Asia/Tehran"
// Tehran is UTC+03:30 with no DST since 2022.
const atLocal = (local: string): string => new Date(local).toISOString()

describe("quiet hours", () => {
  it("is 23:00–07:00 local with the documented boundaries", () => {
    expect(QUIET_HOURS_START_MINUTES).toBe(23 * 60)
    expect(QUIET_HOURS_END_MINUTES).toBe(7 * 60)
    // 22:59 Tehran (19:29Z) is outside; 23:00 (19:30Z) is inside.
    expect(isQuietHoursInstant("2026-10-20T19:29:00.000Z", TEHRAN)).toBe(false)
    expect(isQuietHoursInstant("2026-10-20T19:30:00.000Z", TEHRAN)).toBe(true)
    // 06:59 is inside; 07:00 is outside.
    expect(isQuietHoursInstant("2026-10-21T03:29:00.000Z", TEHRAN)).toBe(true)
    expect(isQuietHoursInstant("2026-10-21T03:30:00.000Z", TEHRAN)).toBe(false)
  })

  it("flushes a late-evening hold at 07:00 the next local morning", () => {
    // 23:30 on 2026-10-20 in Tehran.
    expect(quietHoursEndAfter("2026-10-20T20:00:00.000Z", TEHRAN))
      .toBe("2026-10-21T03:30:00.000Z")
  })

  it("flushes an early-morning hold at 07:00 the same local morning", () => {
    // 02:00 on 2026-10-21 in Tehran.
    expect(quietHoursEndAfter("2026-10-20T22:30:00.000Z", TEHRAN))
      .toBe("2026-10-21T03:30:00.000Z")
  })

  it("returns null outside the window", () => {
    expect(quietHoursEndAfter("2026-10-20T08:00:00.000Z", TEHRAN)).toBeNull()
  })

  it("uses the owner's zone, not a fixed offset", () => {
    // 23:30 in Tehran is 16:00 in New York — still outside its quiet hours.
    const instant = "2026-10-20T20:00:00.000Z"
    expect(isQuietHoursInstant(instant, TEHRAN)).toBe(true)
    expect(isQuietHoursInstant(instant, "America/New_York")).toBe(false)
  })
})

describe("onClaim", () => {
  const scheduledFor = "2026-10-20T20:00:00.000Z"

  it("holds a normal reminder until the next 07:00", () => {
    expect(
      reminderDeliverAt({ tier: "normal", silencedUntil: null }, TEHRAN, scheduledFor)
    ).toEqual({ _tag: "claim", deliverAt: "2026-10-21T03:30:00.000Z" })
  })

  it("lets the medication tier bypass quiet hours untouched", () => {
    expect(
      reminderDeliverAt({ tier: "critical", silencedUntil: null }, TEHRAN, scheduledFor)
    ).toEqual({ _tag: "claim", deliverAt: scheduledFor })
  })

  it("suppresses a fire inside an explicit silence", () => {
    expect(
      reminderDeliverAt(
        { tier: "critical", silencedUntil: "2026-10-25T00:00:00.000Z" },
        TEHRAN,
        scheduledFor
      )
    ).toEqual({ _tag: "suppress" })
  })

  it("does not suppress a fire after the silence has passed", () => {
    expect(
      reminderDeliverAt(
        { tier: "critical", silencedUntil: "2026-10-19T00:00:00.000Z" },
        TEHRAN,
        scheduledFor
      )
    ).toEqual({ _tag: "claim", deliverAt: scheduledFor })
  })

  it("leaves a daytime normal fire at its scheduled instant", () => {
    const daytime = "2026-10-20T10:00:00.000Z"
    expect(
      reminderDeliverAt({ tier: "normal", silencedUntil: null }, TEHRAN, daytime)
    ).toEqual({ _tag: "claim", deliverAt: daytime })
  })
})

describe("tier and snooze presets", () => {
  it("derives critical only for medication", () => {
    expect(reminderTierFor("medication")).toBe("critical")
    expect(reminderTierFor("exercise")).toBe("normal")
    expect(reminderTierFor("chore")).toBe("normal")
    expect(reminderTierFor("general")).toBe("normal")
  })

  it("accepts exactly the five presets", () => {
    expect(SNOOZE_PRESETS_MINUTES).toEqual([5, 10, 15, 30, 60])
    for (const minutes of SNOOZE_PRESETS_MINUTES) {
      expect(isSnoozeMinutes(minutes)).toBe(true)
    }
    expect(isSnoozeMinutes(7)).toBe(false)
    expect(isSnoozeMinutes(0)).toBe(false)
  })

  it("snoozes this occurrence from the response instant", () => {
    expect(snoozeInstant("2026-10-20T08:00:00.000Z", 10))
      .toBe("2026-10-20T08:10:00.000Z")
    expect(snoozeInstant("2026-10-20T08:00:00.000Z", 7)).toBeNull()
  })
})

describe("missed inbox", () => {
  const now = "2026-10-20T12:00:00.000Z"

  it("is unanswered AND past — delivery is irrelevant", () => {
    expect(isMissed({ response: null, scheduledFor: "2026-10-20T10:00:00.000Z" }, now)).toBe(true)
    expect(isMissed({ response: "done", scheduledFor: "2026-10-20T10:00:00.000Z" }, now)).toBe(false)
    expect(isMissed({ response: null, scheduledFor: "2026-10-20T13:00:00.000Z" }, now)).toBe(false)
  })

  it("shows unanswered rows under 24 h and rolls older ones to history", () => {
    expect(inboxStateOf({ response: null, scheduledFor: "2026-10-20T10:00:00.000Z" }, now))
      .toBe("inbox")
    expect(inboxStateOf({ response: null, scheduledFor: "2026-10-19T11:00:00.000Z" }, now))
      .toBe("history")
    expect(
      inboxStateOf(
        { response: null, scheduledFor: "2026-10-19T11:00:00.000Z" },
        "2026-10-20T10:59:00.000Z"
      )
    ).toBe("inbox")
    expect(MISSED_INBOX_HOURS).toBe(24)
  })

  it("keeps answered and upcoming rows out of the inbox", () => {
    expect(inboxStateOf({ response: "dismiss", scheduledFor: "2026-10-19T10:00:00.000Z" }, now))
      .toBe("answered")
    expect(inboxStateOf({ response: null, scheduledFor: "2026-10-20T13:00:00.000Z" }, now))
      .toBe("upcoming")
  })
})

describe("on-time adherence", () => {
  const rootScheduledFor = "2026-10-20T08:00:00.000Z"

  it("counts done within 30 minutes of the root fire", () => {
    expect(
      isOnTime({
        response: "done",
        rootScheduledFor,
        respondedAt: "2026-10-20T08:30:00.000Z"
      })
    ).toBe(true)
    expect(
      isOnTime({
        response: "done",
        rootScheduledFor,
        respondedAt: "2026-10-20T08:31:00.000Z"
      })
    ).toBe(false)
  })

  it("counts an early answer as on time", () => {
    expect(
      isOnTime({
        response: "done",
        rootScheduledFor,
        respondedAt: "2026-10-20T07:45:00.000Z"
      })
    ).toBe(true)
  })

  it("does not reset the window for a snooze child", () => {
    // The child fires 15 minutes later but still measures from the root.
    expect(
      isOnTime({
        response: "done",
        rootScheduledFor,
        respondedAt: "2026-10-20T08:20:00.000Z"
      })
    ).toBe(true)
    expect(
      isOnTime({
        response: "dismiss",
        rootScheduledFor,
        respondedAt: "2026-10-20T08:05:00.000Z"
      })
    ).toBe(false)
    expect(isOnTime({ response: null, rootScheduledFor, respondedAt: null })).toBe(false)
  })
})

describe("next-fire derivation", () => {
  it("finds today's remaining daily time", () => {
    // 21:30 Tehran; the 22:00 fire is 30 minutes away.
    expect(
      reminderFirstFireAt({ _tag: "daily", time: "22:00" }, TEHRAN, "2026-10-20T18:00:00.000Z")
    ).toBe("2026-10-20T18:30:00.000Z")
  })

  it("rolls a passed daily time to tomorrow", () => {
    // 23:00 Tehran; the 22:00 fire is tomorrow.
    expect(
      reminderFirstFireAt({ _tag: "daily", time: "22:00" }, TEHRAN, "2026-10-20T19:30:00.000Z")
    ).toBe("2026-10-21T18:30:00.000Z")
  })

  it("finds the next selected weekday", () => {
    // 2026-10-20 is a Tuesday; Friday is 2026-10-23.
    expect(
      reminderFirstFireAt(
        { _tag: "weekly", days: [5], time: "10:00" },
        TEHRAN,
        "2026-10-20T08:00:00.000Z"
      )
    ).toBe("2026-10-23T06:30:00.000Z")
  })

  it("advances an interval from the claimed instant", () => {
    expect(
      reminderNextFireAfter(
        { _tag: "interval", hours: 8 },
        TEHRAN,
        "2026-10-20T08:00:00.000Z"
      )
    ).toBe("2026-10-20T16:00:00.000Z")
  })

  it("catches up to the first occurrence after the tick, not one per tick", () => {
    // Claimed occurrence: 08:00 Tehran on 2026-10-21. The tick runs three days
    // later, so the series must jump to 2026-10-25, not 2026-10-22.
    expect(
      reminderNextFireAfterNow(
        { _tag: "daily", time: "08:00" },
        TEHRAN,
        "2026-10-21T04:30:00.000Z",
        "2026-10-24T09:30:00.000Z"
      )
    ).toBe("2026-10-25T04:30:00.000Z")
  })

  it("keeps the interval grid when catching up", () => {
    // 8-hourly from 17:30Z; the tick is 2026-10-22T09:30Z, so the next grid
    // point is 17:30Z that day (not 01:30Z the day before).
    expect(
      reminderNextFireAfterNow(
        { _tag: "interval", hours: 8 },
        TEHRAN,
        "2026-10-20T17:30:00.000Z",
        "2026-10-22T09:30:00.000Z"
      )
    ).toBe("2026-10-22T17:30:00.000Z")
  })

  it("advances one occurrence when the tick is at the fire instant", () => {
    expect(
      reminderNextFireAfterNow(
        { _tag: "daily", time: "08:00" },
        TEHRAN,
        "2026-10-21T04:30:00.000Z",
        "2026-10-21T04:30:00.000Z"
      )
    ).toBe("2026-10-22T04:30:00.000Z")
  })

  it("has no next fire for a one-off", () => {
    expect(
      reminderNextFireAfter({ _tag: "once" }, TEHRAN, "2026-10-20T08:00:00.000Z")
    ).toBeNull()
  })

  it("derives a linked one-off as the item instant minus the offset", () => {
    expect(
      reminderFireAt({
        repeat: { _tag: "once" },
        timeZone: TEHRAN,
        now: "2026-10-20T08:00:00.000Z",
        offsetMinutes: 30,
        linkInstant: "2026-10-20T12:00:00.000Z"
      })
    ).toBe("2026-10-20T11:30:00.000Z")
  })

  it("uses an explicit fireAt for an unlinked one-off", () => {
    expect(
      reminderFireAt({
        repeat: { _tag: "once" },
        timeZone: TEHRAN,
        now: "2026-10-20T08:00:00.000Z",
        explicitFireAt: "2026-10-21T06:00:00.000Z"
      })
    ).toBe("2026-10-21T06:00:00.000Z")
  })

  it("returns null when a one-off has neither a link nor a fireAt", () => {
    expect(
      reminderFireAt({
        repeat: { _tag: "once" },
        timeZone: TEHRAN,
        now: "2026-10-20T08:00:00.000Z"
      })
    ).toBeNull()
  })

  it("places an all-day linked item at 09:00 local", () => {
    expect(allDayReminderInstant("2026-10-21", TEHRAN)).toBe("2026-10-21T05:30:00.000Z")
  })
})

describe("DST edges", () => {
  it("keeps the local daily wall time across a spring-forward", () => {
    // US DST starts 2027-03-14. 08:00 local is 13:00Z before and 12:00Z after.
    expect(
      reminderFirstFireAt(
        { _tag: "daily", time: "08:00" },
        "America/New_York",
        "2027-03-13T17:00:00.000Z"
      )
    ).toBe("2027-03-14T12:00:00.000Z")
  })

  it("flushes quiet hours at the local 07:00 across the same transition", () => {
    // 23:30 local on 2027-03-13 (04:30Z on the 14th).
    expect(quietHoursEndAfter("2027-03-14T04:30:00.000Z", "America/New_York"))
      .toBe("2027-03-14T11:00:00.000Z")
  })
})

describe("local helper sanity", () => {
  it("round-trips a local string", () => {
    expect(atLocal("2026-10-20T08:00:00.000Z")).toBe("2026-10-20T08:00:00.000Z")
  })
})
