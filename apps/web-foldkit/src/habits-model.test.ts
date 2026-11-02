import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

import { uuidV7 } from '@tali/domain'
import type { StreakResult } from '@tali/domain'
import {
  type LocalStore,
  type MirrorRecord,
  openLocalStore,
} from '@tali/sync-client'

import {
  HABIT_WINDOW_DAYS,
  type HabitHeatCell,
  habitBadgeLabel,
  habitEntryOn,
  habitFrequencyLabel,
  habitHeatmapMonth,
  habitRateCopy,
  habitStatsFor,
  habitStatusIcon,
  habitStatusLabel,
  pendingHabitIds,
  toHabitRow,
} from './habits-model'
import { tapHabitEntry } from './lib/habit-log'
import {
  createHabitInMirror,
  deleteHabitInMirror,
  restoreHabitInMirror,
  updateHabitInMirror,
} from './lib/habit-writes'
import { habitEntryRowsFromMirror, habitRowsFromMirror } from './mirror'

/**
 * Ticket #66 at the client seam, ported from
 * `apps/web/src/lib/habits/model.test.ts`: habits are created and tapped
 * locally first, the streak badge recomputes from the mirror (so it moves
 * before any sync and with the network down), the rate distinguishes "null"
 * from "0%", and the heatmap paints the same raw statuses the streak consumes.
 */

const TZ = 'UTC'
const NOW = '2026-10-21T09:30:00.000Z'
const TODAY = '2026-10-21'

const open = (): Promise<LocalStore> => openLocalStore(`habits-${uuidV7()}`)

const readHabits = async (store: LocalStore) =>
  habitRowsFromMirror(await store.list('habit'))

const readEntries = async (store: LocalStore) =>
  habitEntryRowsFromMirror(await store.list('habitEntry'))

describe('habit local-first writes', () => {
  it('creates on one call with startedOn and era 0 in the mirror and the outbox', async () => {
    const store = await open()
    const id = uuidV7(Date.parse(NOW))
    await createHabitInMirror(
      store,
      { title: '  کتاب  ', frequency: { _tag: 'daily' }, timeZone: TZ },
      id,
      NOW,
    )

    const habit = (await readHabits(store)).find(row => row.id === id)

    expect(habit).toMatchObject({
      title: 'کتاب',
      startedOn: TODAY,
      frequency: { _tag: 'daily' },
    })
    expect(habit?.frequencyHistory).toEqual([
      { effectiveFrom: TODAY, frequency: { _tag: 'daily' } },
    ])

    const pending = await store.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      entityType: 'habit',
      entityId: id,
      op: 'upsert',
    })
    expect(pending[0]?.patch).toMatchObject({
      title: 'کتاب',
      startedOn: TODAY,
      frequencyHistory: [
        { effectiveFrom: TODAY, frequency: { _tag: 'daily' } },
      ],
    })

    store.close()
  })

  it('moves the badge on a tap with no sync, then cycles Done → Partial → Missed', async () => {
    const store = await open()
    const id = await createHabitInMirror(
      store,
      { title: 'آب', frequency: { _tag: 'daily' }, timeZone: TZ },
      uuidV7(Date.parse('2026-10-19T09:00:00.000Z')),
      '2026-10-19T09:00:00.000Z',
    )

    for (const day of ['2026-10-19', '2026-10-20']) {
      await tapHabitEntry(store, {
        habitId: id,
        localDate: day,
        timeZone: TZ,
        id: uuidV7(Date.parse(NOW)),
        now: NOW,
      })
    }

    await tapHabitEntry(store, {
      habitId: id,
      localDate: TODAY,
      timeZone: TZ,
      id: uuidV7(Date.parse(NOW)),
      now: NOW,
    })
    const afterDone = habitStatsFor(
      (await readHabits(store))[0]!,
      await readEntries(store),
      TODAY,
      7,
    )
    expect(afterDone.current).toEqual({
      unit: 'day',
      count: 3,
      since: '2026-10-19',
    })
    expect(afterDone.rate).toBe(1)

    const second = await tapHabitEntry(store, {
      habitId: id,
      localDate: TODAY,
      timeZone: TZ,
      id: uuidV7(Date.parse(NOW)),
      now: NOW,
    })
    expect(second.data.status).toBe('partial')
    const afterPartial = habitStatsFor(
      (await readHabits(store))[0]!,
      await readEntries(store),
      TODAY,
      7,
    )
    expect(afterPartial.current.count).toBe(3)
    expect(afterPartial.rate).toBeCloseTo(2.5 / 3, 10)

    const third = await tapHabitEntry(store, {
      habitId: id,
      localDate: TODAY,
      timeZone: TZ,
      id: uuidV7(Date.parse(NOW)),
      now: NOW,
    })
    expect(third.data.status).toBe('missed')
    const afterMissed = habitStatsFor(
      (await readHabits(store))[0]!,
      await readEntries(store),
      TODAY,
      7,
    )
    expect(afterMissed.current.count).toBe(2)
    expect(afterMissed.open).toMatchObject({ credit: 0, satisfied: false })

    expect(await readEntries(store)).toHaveLength(3)
    expect(await store.pending()).toHaveLength(4)

    store.close()
  })

  it('renders an X-per-week 7-day rate as progress, never 0%', async () => {
    const store = await open()
    const id = await createHabitInMirror(
      store,
      { title: 'ورزش', frequency: { _tag: 'weekly', times: 3 }, timeZone: TZ },
      uuidV7(Date.parse('2026-10-17T09:00:00.000Z')),
      '2026-10-17T09:00:00.000Z',
    )
    const habit = (await readHabits(store))[0]!
    expect(habit.frequencyHistory[0]?.effectiveFrom).toBe('2026-10-17')

    for (const day of ['2026-10-19', '2026-10-20']) {
      await tapHabitEntry(store, {
        habitId: id,
        localDate: day,
        timeZone: TZ,
        id: uuidV7(Date.parse(NOW)),
        now: NOW,
      })
    }

    const partialWeek = habitStatsFor(habit, await readEntries(store), TODAY, 7)
    expect(partialWeek.rate).toBeNull()
    const copy = habitRateCopy(partialWeek)
    expect(copy.kind).toBe('progress')
    expect(copy.label).toBe('۲ از ۳ این هفته')

    await tapHabitEntry(store, {
      habitId: id,
      localDate: TODAY,
      timeZone: TZ,
      id: uuidV7(Date.parse(NOW)),
      now: NOW,
    })
    const satisfiedWeek = habitStatsFor(
      habit,
      await readEntries(store),
      TODAY,
      7,
    )
    expect(satisfiedWeek.rate).toBe(1)
    expect(habitRateCopy(satisfiedWeek)).toEqual({
      kind: 'rate',
      label: '۱۰۰٪',
    })

    store.close()
  })

  it('keeps one row per day and shows the answer', async () => {
    const store = await open()
    const id = await createHabitInMirror(
      store,
      { title: 'مدیتیشن', frequency: { _tag: 'daily' }, timeZone: TZ },
      uuidV7(Date.parse(NOW)),
      NOW,
    )
    await tapHabitEntry(store, {
      habitId: id,
      localDate: TODAY,
      timeZone: TZ,
      id: uuidV7(Date.parse(NOW)),
      now: NOW,
    })
    const entries = await readEntries(store)
    expect(habitEntryOn(entries, id, TODAY)?.status).toBe('done')
    expect(habitEntryOn(entries, id, '2026-10-20')).toBeUndefined()

    store.close()
  })

  it('appends an era when the frequency changes, so history is not rewritten', async () => {
    const store = await open()
    const id = await createHabitInMirror(
      store,
      { title: 'شنا', frequency: { _tag: 'daily' }, timeZone: TZ },
      uuidV7(Date.parse('2026-10-10T09:00:00.000Z')),
      '2026-10-10T09:00:00.000Z',
    )
    const habit = (await readHabits(store))[0]!
    await updateHabitInMirror(
      store,
      habit,
      { frequency: { _tag: 'weekly', times: 2 } },
      NOW,
    )
    const updated = (await readHabits(store))[0]!
    expect(updated.id).toBe(id)
    expect(updated.frequency).toEqual({ _tag: 'weekly', times: 2 })
    expect(updated.frequencyHistory).toHaveLength(2)
    expect(updated.frequencyHistory[1]).toEqual({
      effectiveFrom: '2026-10-24',
      frequency: { _tag: 'weekly', times: 2 },
    })
    expect(updated.frequencyHistory[0]).toEqual({
      effectiveFrom: '2026-10-10',
      frequency: { _tag: 'daily' },
    })

    store.close()
  })

  it('trims an edited title and refuses an empty one', async () => {
    const store = await open()
    await createHabitInMirror(
      store,
      { title: 'آب', frequency: { _tag: 'daily' }, timeZone: TZ },
      uuidV7(Date.parse(NOW)),
      NOW,
    )
    const habit = (await readHabits(store))[0]!

    await updateHabitInMirror(store, habit, { title: '  آب کافی  ' }, NOW)
    expect((await readHabits(store))[0]?.title).toBe('آب کافی')

    await expect(
      updateHabitInMirror(store, habit, { title: '   ' }, NOW),
    ).rejects.toThrow('a habit needs a title')

    store.close()
  })

  it('soft deletes and restores the same row, history intact', async () => {
    const store = await open()
    const id = await createHabitInMirror(
      store,
      { title: 'پیاده‌روی', frequency: { _tag: 'daily' }, timeZone: TZ },
      uuidV7(Date.parse(NOW)),
      NOW,
    )

    await deleteHabitInMirror(store, id, NOW)
    expect(await readHabits(store)).toHaveLength(0)
    const trashed = await store.listTrashed('habit')
    expect(trashed).toHaveLength(1)
    expect(trashed[0]?.entityId).toBe(id)

    await restoreHabitInMirror(store, id, NOW)
    const live = await readHabits(store)
    expect(live).toHaveLength(1)
    expect(live[0]?.id).toBe(id)

    const pending = await store.pending()
    const last = pending[pending.length - 1]
    expect(last).toMatchObject({
      entityType: 'habit',
      entityId: id,
      op: 'upsert',
    })
    expect(pending[pending.length - 2]).toMatchObject({ op: 'delete' })

    store.close()
  })
})

describe('habit read model', () => {
  it('projects a mirrored row and keeps its sync-error marker', () => {
    const record: MirrorRecord = {
      entityType: 'habit',
      entityId: 'habit-1',
      version: 2,
      updatedAt: '2026-10-20T09:00:00.000Z',
      deletedAt: null,
      syncError: {
        code: 'InvalidPatch',
        message: 'bad',
        at: '2026-10-20T09:00:00.000Z',
        clientMutationId: 'mutation-1',
      },
      data: {
        title: '',
        frequency: { _tag: 'weekdays', days: [3, 1, 3] },
        timeZone: TZ,
        createdAt: '2026-10-10T09:00:00.000Z',
      },
    }

    const row = toHabitRow(record)
    expect(row.title).toBe('بدون نام')
    expect(row.frequency).toEqual({ _tag: 'weekdays', days: [1, 3] })
    expect(row.startedOn).toBe('2026-10-10')
    expect(row.hasSyncError).toBe(true)
  })

  it('paints the raw statuses the streak consumes, including a rest-day bonus', async () => {
    const store = await open()
    const id = await createHabitInMirror(
      store,
      {
        title: 'پیاده‌روی',
        frequency: { _tag: 'weekdays', days: [6, 1, 3] },
        timeZone: TZ,
      },
      uuidV7(Date.parse('2026-10-17T09:00:00.000Z')),
      '2026-10-17T09:00:00.000Z',
    )
    const now = '2026-10-22T09:30:00.000Z'
    for (const day of ['2026-10-19', '2026-10-21', '2026-10-22']) {
      await tapHabitEntry(store, {
        habitId: id,
        localDate: day,
        timeZone: TZ,
        id: uuidV7(Date.parse(now)),
        now,
      })
    }
    const entries = await readEntries(store)
    const streak = habitStatsFor(
      (await readHabits(store))[0]!,
      entries,
      '2026-10-22',
      30,
    )
    expect(streak.current).toEqual({
      unit: 'day',
      count: 2,
      since: '2026-10-19',
    })

    const month = habitHeatmapMonth({
      habitId: id,
      entries,
      year: 1405,
      month: 7,
    })
    const cell = (date: string) =>
      month.weeks.flat().find(entry => entry.date === date)!

    expect(cell('2026-10-19').status).toBe('done')
    expect(cell('2026-10-21').status).toBe('done')
    expect(cell('2026-10-22').status).toBe('done')
    expect(cell('2026-10-20').status).toBeNull()
    expect(streak.periods.map(period => period.start)).not.toContain(
      '2026-10-22',
    )

    store.close()
  })

  it('paints the same entries in the Jalali month each local day belongs to (E15)', async () => {
    const store = await open()
    const id = await createHabitInMirror(
      store,
      { title: 'کتاب', frequency: { _tag: 'weekly', times: 3 }, timeZone: TZ },
      uuidV7(Date.parse('2026-10-17T09:00:00.000Z')),
      '2026-10-17T09:00:00.000Z',
    )
    for (const day of [
      '2026-10-17',
      '2026-10-19',
      '2026-10-21',
      '2026-10-23',
    ]) {
      await tapHabitEntry(store, {
        habitId: id,
        localDate: day,
        timeZone: TZ,
        id: uuidV7(Date.parse('2026-10-23T09:30:00.000Z')),
        now: '2026-10-23T09:30:00.000Z',
      })
    }
    const entries = await readEntries(store)
    const mehr = habitHeatmapMonth({
      habitId: id,
      entries,
      year: 1405,
      month: 7,
    })
    const aban = habitHeatmapMonth({
      habitId: id,
      entries,
      year: 1405,
      month: 8,
    })
    const find = (month: typeof mehr, day: string): HabitHeatCell =>
      month.weeks.flat().find(cell => cell.date === day)!

    expect(find(mehr, '2026-10-22').inMonth).toBe(true)
    expect(find(mehr, '2026-10-23').inMonth).toBe(false)
    expect(find(aban, '2026-10-23')).toMatchObject({
      inMonth: true,
      status: 'done',
    })
    expect(find(aban, '2026-10-17').inMonth).toBe(false)

    store.close()
  })

  it('aligns the heatmap weekday labels with the display week start', () => {
    const saturday = habitHeatmapMonth({
      habitId: 'habit-1',
      entries: [],
      year: 1405,
      month: 8,
    })
    const sunday = habitHeatmapMonth({
      habitId: 'habit-1',
      entries: [],
      year: 1405,
      month: 8,
      weekStart: 'sunday',
    })

    expect(saturday.weekdayLabels).toEqual([
      'شنبه',
      'یکشنبه',
      'دوشنبه',
      'سه‌شنبه',
      'چهارشنبه',
      'پنج‌شنبه',
      'جمعه',
    ])
    expect(sunday.weekdayLabels[0]).toBe('یکشنبه')
    expect(saturday.label).toBe('۱ آبان ۱۴۰۵')
  })

  it('reads pending habit ids out of the sync keys', () => {
    expect(
      pendingHabitIds([
        'habit\u0000habit-1',
        'task\u0000task-1',
        'habit\u0000habit-2',
      ]),
    ).toEqual(['habit-1', 'habit-2'])
  })

  it('labels statuses for the tap button and the heatmap', () => {
    expect(habitStatusLabel('done')).toBe('انجام شد')
    expect(habitStatusLabel('partial')).toBe('نیمه')
    expect(habitStatusLabel('missed')).toBe('از دست رفت')
    expect(habitStatusLabel(null)).toBe('ثبت نشده')
    expect(habitStatusIcon('done')).toBe('✓')
    expect(habitStatusIcon(null)).toBe('○')
  })
})

describe('habit copy', () => {
  it('labels each frequency without a bare number', () => {
    expect(habitFrequencyLabel({ _tag: 'daily' })).toBe('هر روز')
    expect(habitFrequencyLabel({ _tag: 'weekdays', days: [3, 1] })).toBe(
      'دوشنبه، چهارشنبه',
    )
    expect(habitFrequencyLabel({ _tag: 'weekly', times: 3 })).toBe(
      '۳ بار در هفته',
    )
  })

  it("prints the open period's progress on the badge, not just the count", () => {
    const openPeriod: NonNullable<StreakResult['open']> = {
      unit: 'week',
      start: '2026-10-17',
      end: '2026-10-23',
      frequency: { _tag: 'weekly', times: 3 },
      requirement: 3,
      credit: 2,
      weighted: 2,
      satisfied: false,
      open: true,
      inWindow: false,
    }
    const result: StreakResult = {
      current: { unit: 'week', count: 1, since: '2026-10-10' },
      open: openPeriod,
      best: { days: 0, weeks: 1 },
      rate: 0.5,
      periods: [],
      unitChanges: [],
    }
    expect(habitBadgeLabel(result)).toBe('۱ هفته پیاپی · ۲ از ۳ این هفته')
    expect(
      habitBadgeLabel({
        ...result,
        open: { ...openPeriod, credit: 3, weighted: 3, satisfied: true },
      }),
    ).toBe('۱ هفته پیاپی')
    expect(habitBadgeLabel({ ...result, open: null })).toBe('۱ هفته پیاپی')
  })

  it('offers all three rate windows', () => {
    expect(HABIT_WINDOW_DAYS).toEqual([7, 30, 90])
  })
})
