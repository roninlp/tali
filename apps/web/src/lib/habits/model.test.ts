import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import { uuidV7, type LocalDate } from "@tali/domain"
import { openLocalStore } from "../local-store/store"
import type { LocalStore } from "../local-store/types"
import { tapHabitEntry } from "./log"
import {
  HABIT_WINDOW_DAYS,
  createHabitInMirror,
  habitBadgeLabel,
  habitEntryOn,
  habitFrequencyLabel,
  habitHeatmapMonth,
  habitRateCopy,
  habitStatsFor,
  liveHabitEntryRows,
  liveHabitRows,
  updateHabitInMirror
} from "./model"

/**
 * Ticket #66 at the client seam: habits are created and tapped locally first,
 * the streak badge recomputes from the mirror (so it moves before any sync and
 * with the network down), the rate distinguishes "null" from "0%", and the
 * heatmap paints the same raw statuses the streak consumes.
 */

const TZ = "UTC"
const NOW = "2026-10-21T09:30:00.000Z"
const TODAY = "2026-10-21" as LocalDate

const open = (): Promise<LocalStore> => openLocalStore(`habits-${uuidV7()}`)

const readHabits = async (store: LocalStore) => liveHabitRows(await store.list("habit"))
const readEntries = async (store: LocalStore) =>
  liveHabitEntryRows(await store.list("habitEntry"))

describe("habit local-first model", () => {
  it("creates on one call with startedOn and era 0 in the mirror and the outbox", async () => {
    const store = await open()
    const id = await createHabitInMirror(
      store,
      { title: "  کتاب  ", frequency: { _tag: "daily" }, timeZone: TZ },
      NOW
    )

    const habit = (await readHabits(store)).find((row) => row.id === id)!
    expect(habit).toMatchObject({
      title: "کتاب",
      startedOn: TODAY,
      frequency: { _tag: "daily" }
    })
    expect(habit.frequencyHistory).toEqual([
      { effectiveFrom: TODAY, frequency: { _tag: "daily" } }
    ])

    const pending = await store.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ entityType: "habit", entityId: id, op: "upsert" })
    expect(pending[0]!.patch).toMatchObject({
      title: "کتاب",
      startedOn: TODAY,
      frequencyHistory: [{ effectiveFrom: TODAY, frequency: { _tag: "daily" } }]
    })

    store.close()
  })

  it("moves the badge on a tap with no sync, then cycles Done → Partial → Missed", async () => {
    const store = await open()
    const id = await createHabitInMirror(
      store,
      { title: "آب", frequency: { _tag: "daily" }, timeZone: TZ },
      "2026-10-19T09:00:00.000Z"
    )
    // A two-day run behind today, so the open-day answers are observable.
    for (const day of ["2026-10-19", "2026-10-20"]) {
      await tapHabitEntry(store, { habitId: id, localDate: day, timeZone: TZ, now: NOW })
    }

    // Nothing has been pushed: the mirror + outbox are the whole state.
    await tapHabitEntry(store, { habitId: id, localDate: TODAY, timeZone: TZ, now: NOW })
    const afterDone = habitStatsFor(
      (await readHabits(store))[0]!,
      await readEntries(store),
      TODAY,
      7
    )
    expect(afterDone.current).toEqual({ unit: "day", count: 3, since: "2026-10-19" })
    expect(afterDone.rate).toBe(1)

    const second = await tapHabitEntry(store, {
      habitId: id,
      localDate: TODAY,
      timeZone: TZ,
      now: NOW
    })
    expect(second.data.status).toBe("partial")
    const afterPartial = habitStatsFor(
      (await readHabits(store))[0]!,
      await readEntries(store),
      TODAY,
      7
    )
    // Partial is full credit for the streak and half weight for the rate.
    expect(afterPartial.current.count).toBe(3)
    expect(afterPartial.rate).toBeCloseTo(2.5 / 3, 10)

    const third = await tapHabitEntry(store, {
      habitId: id,
      localDate: TODAY,
      timeZone: TZ,
      now: NOW
    })
    expect(third.data.status).toBe("missed")
    const afterMissed = habitStatsFor(
      (await readHabits(store))[0]!,
      await readEntries(store),
      TODAY,
      7
    )
    // An explicit miss today is visible; the run falls back to the two
    // satisfied days behind it but is not broken (the open day has not closed).
    expect(afterMissed.current.count).toBe(2)
    expect(afterMissed.open).toMatchObject({ credit: 0, satisfied: false })

    // One row per day for all time; every tap queued, still offline.
    expect(await readEntries(store)).toHaveLength(3)
    expect(await store.pending()).toHaveLength(6)

    store.close()
  })

  it("renders an X-per-week 7-day rate as progress, never 0%", async () => {
    const store = await open()
    const id = await createHabitInMirror(
      store,
      { title: "ورزش", frequency: { _tag: "weekly", times: 3 }, timeZone: TZ },
      "2026-10-17T09:00:00.000Z"
    )
    const habit = (await readHabits(store))[0]!
    expect(habit.frequencyHistory[0]!.effectiveFrom).toBe("2026-10-17")

    await tapHabitEntry(store, {
      habitId: id,
      localDate: "2026-10-19",
      timeZone: TZ,
      now: NOW
    })
    await tapHabitEntry(store, {
      habitId: id,
      localDate: "2026-10-20",
      timeZone: TZ,
      now: NOW
    })

    const partialWeek = habitStatsFor(habit, await readEntries(store), TODAY, 7)
    expect(partialWeek.rate).toBeNull()
    const copy = habitRateCopy(partialWeek)
    expect(copy.kind).toBe("progress")
    expect(copy.label).toBe("۲ از ۳ این هفته")

    await tapHabitEntry(store, {
      habitId: id,
      localDate: TODAY,
      timeZone: TZ,
      now: NOW
    })
    const satisfiedWeek = habitStatsFor(habit, await readEntries(store), TODAY, 7)
    expect(satisfiedWeek.rate).toBe(1)
    expect(habitRateCopy(satisfiedWeek)).toEqual({ kind: "rate", label: "۱۰۰٪" })

    store.close()
  })

  it("paints the raw statuses the streak consumes, including a rest-day bonus", async () => {
    const store = await open()
    const start = "2026-10-17T09:00:00.000Z"
    const id = await createHabitInMirror(
      store,
      { title: "پیاده‌روی", frequency: { _tag: "weekdays", days: [6, 1, 3] }, timeZone: TZ },
      start
    )
    const now = "2026-10-22T09:30:00.000Z"
    for (const day of ["2026-10-19", "2026-10-21", "2026-10-22"]) {
      await tapHabitEntry(store, { habitId: id, localDate: day, timeZone: TZ, now })
    }
    const entries = await readEntries(store)
    const streak = habitStatsFor((await readHabits(store))[0]!, entries, "2026-10-22" as LocalDate, 30)
    expect(streak.current).toEqual({ unit: "day", count: 2, since: "2026-10-19" })

    const month = habitHeatmapMonth({ habitId: id, entries, year: 1405, month: 7 })
    const cell = (date: string) =>
      month.weeks.flat().find((entry) => entry.date === date)!
    expect(cell("2026-10-19").status).toBe("done")
    expect(cell("2026-10-21").status).toBe("done")
    expect(cell("2026-10-22").status).toBe("done")
    expect(cell("2026-10-20").status).toBeNull()
    // Thursday is not an expected day, so it paints but cannot extend the run.
    expect(streak.periods.map((period) => period.start)).not.toContain("2026-10-22")

    store.close()
  })

  it("paints the same entries in the Jalali month each local day belongs to (E15)", async () => {
    const store = await open()
    const id = await createHabitInMirror(
      store,
      { title: "کتاب", frequency: { _tag: "weekly", times: 3 }, timeZone: TZ },
      "2026-10-17T09:00:00.000Z"
    )
    for (const day of ["2026-10-17", "2026-10-19", "2026-10-21", "2026-10-23"]) {
      await tapHabitEntry(store, {
        habitId: id,
        localDate: day,
        timeZone: TZ,
        now: "2026-10-23T09:30:00.000Z"
      })
    }
    const entries = await readEntries(store)
    // W0 is 25 Mehr – 1 Aban: one counting week, painted day-by-day in the month
    // that owns each local date.
    const mehr = habitHeatmapMonth({ habitId: id, entries, year: 1405, month: 7 })
    const aban = habitHeatmapMonth({ habitId: id, entries, year: 1405, month: 8 })
    const find = (month: typeof mehr, day: string) =>
      month.weeks.flat().find((cell) => cell.date === day)!
    expect(find(mehr, "2026-10-22").inMonth).toBe(true)
    expect(find(mehr, "2026-10-23").inMonth).toBe(false)
    expect(find(aban, "2026-10-23")).toMatchObject({ inMonth: true, status: "done" })
    expect(find(aban, "2026-10-17").inMonth).toBe(false)

    store.close()
  })

  it("keeps one row per day and shows today's answer", async () => {
    const store = await open()
    const id = await createHabitInMirror(
      store,
      { title: "مدیتیشن", frequency: { _tag: "daily" }, timeZone: TZ },
      NOW
    )
    await tapHabitEntry(store, { habitId: id, localDate: TODAY, timeZone: TZ, now: NOW })
    const entries = await readEntries(store)
    expect(habitEntryOn(entries, id, TODAY)?.status).toBe("done")
    expect(habitEntryOn(entries, id, "2026-10-20" as LocalDate)).toBeUndefined()

    store.close()
  })

  it("appends an era when the frequency changes, so history is not rewritten", async () => {
    const store = await open()
    await createHabitInMirror(
      store,
      { title: "شنا", frequency: { _tag: "daily" }, timeZone: TZ },
      "2026-10-10T09:00:00.000Z"
    )
    const habit = (await readHabits(store))[0]!
    await updateHabitInMirror(
      store,
      habit,
      { frequency: { _tag: "weekly", times: 2 } },
      NOW
    )
    const updated = (await readHabits(store))[0]!
    expect(updated.frequency).toEqual({ _tag: "weekly", times: 2 })
    expect(updated.frequencyHistory).toHaveLength(2)
    expect(updated.frequencyHistory[1]).toEqual({
      // A mid-week change takes effect at the next Saturday boundary.
      effectiveFrom: "2026-10-24",
      frequency: { _tag: "weekly", times: 2 }
    })
    expect(updated.frequencyHistory[0]).toEqual({
      effectiveFrom: "2026-10-10",
      frequency: { _tag: "daily" }
    })

    store.close()
  })
})

describe("habit copy", () => {
  it("labels each frequency without a bare number", () => {
    expect(habitFrequencyLabel({ _tag: "daily" })).toBe("هر روز")
    expect(habitFrequencyLabel({ _tag: "weekdays", days: [3, 1] })).toBe("دوشنبه، چهارشنبه")
    expect(habitFrequencyLabel({ _tag: "weekly", times: 3 })).toBe("۳ بار در هفته")
  })

  it("prints the open period's progress on the badge, not just the count", () => {
    const result = {
      current: { unit: "week" as const, count: 1, since: "2026-10-10" as LocalDate },
      open: {
        unit: "week" as const,
        start: "2026-10-17" as LocalDate,
        end: "2026-10-23" as LocalDate,
        frequency: { _tag: "weekly" as const, times: 3 },
        requirement: 3,
        credit: 2,
        weighted: 2,
        satisfied: false,
        open: true,
        inWindow: false
      },
      best: { days: 0, weeks: 1 },
      rate: 0.5,
      periods: [],
      unitChanges: []
    }
    expect(habitBadgeLabel(result)).toBe("۱ هفته پیاپی · ۲ از ۳ این هفته")
    expect(habitBadgeLabel({
      ...result,
      open: { ...result.open, credit: 3, weighted: 3, satisfied: true }
    })).toBe("۱ هفته پیاپی")
    expect(habitBadgeLabel({ ...result, open: null })).toBe("۱ هفته پیاپی")
  })

  it("offers all three rate windows", () => {
    expect(HABIT_WINDOW_DAYS).toEqual([7, 30, 90])
  })
})
