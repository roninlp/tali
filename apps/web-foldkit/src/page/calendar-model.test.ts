import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { addJalaliMonths, toIsoDate, toJalaliDate } from '@tali/domain'

import { occasionSourceOf } from '../lib/occasion-writes'
import { entityKey } from '../mirror'
import {
  calendarViewOf,
  dayLabel,
  jalaliDayNumber,
  monthDayLabel,
  monthTitle,
  overlayCalendarSources,
  overlayOccasionSources,
  shiftDay,
  shiftMonth,
  shortDayLabel,
  todayIn,
  weekDaysFor,
  weekFromMirror,
  weekTitle,
  weekdayOf,
} from './calendar-model'
import {
  TODAY,
  WEEK_END,
  WEEK_START,
  calendarInputs,
  calendarTask,
  eventRow,
  mirrorWith,
  occasionRow,
  timedEventRow,
  weekPayload,
} from './calendar-test-fixtures'

/**
 * The `/calendar` pure model, ported from
 * `apps/web/src/lib/calendar/model.ts` plus the overlay and source-selection
 * rules the legacy screen applied in its memos.
 */

const display = calendarInputs().display

const weekView = (
  overrides: Readonly<{
    maybeServerWeek?: ReturnType<typeof weekPayload>
    pendingKeys?: ReadonlyArray<string>
    mirror?: ReturnType<typeof mirrorWith>
    isOnline?: boolean
  }> = {},
) =>
  calendarViewOf({
    view: 'week',
    anchor: TODAY,
    maybeSelectedDay: Option.none(),
    maybeServerWeek: Option.fromNullishOr(overrides.maybeServerWeek),
    maybeServerMonth: Option.none(),
    dirtyTaskIds: [],
    dirtyEventIds: [],
    now: Date.parse('2026-10-30T09:30:00.000Z'),
    inputs: calendarInputs({
      display,
      mirror: overrides.mirror ?? mirrorWith({}),
      pendingKeys: overrides.pendingKeys ?? [],
      isOnline: overrides.isOnline ?? true,
    }),
  })

describe('calendar labels', () => {
  it('formats the week, month and day in Jalali', () => {
    expect(dayLabel(TODAY, 'persian')).toBe('جمعه ۸ آبان ۱۴۰۵')
    expect(shortDayLabel(TODAY, 'persian')).toBe('۸ آبان')
    expect(weekTitle(WEEK_START, WEEK_END, 'persian')).toBe('۲ آبان – ۸ آبان')
    expect(monthTitle(TODAY, 'persian')).toBe('آبان ۱۴۰۵')
    expect(monthDayLabel(TODAY, 'persian')).toBe('جمعه ۸ آبان ۱۴۰۵')
    expect(jalaliDayNumber(TODAY, 'persian')).toBe('۸')
    expect(weekdayOf(TODAY)).toBe('جمعه')
  })

  it('shifts months across the Jalali year boundary', () => {
    expect(shiftMonth('2026-03-21', -1)).toBe('2026-02-20')
    expect(shiftMonth('2026-03-21', 1)).toBe('2026-04-21')
    expect(shiftDay(TODAY, 1)).toBe('2026-10-31')
    expect(shiftDay(WEEK_START, -1)).toBe('2026-10-23')
  })

  it('reads today in the viewer zone', () => {
    expect(todayIn('Asia/Tehran', new Date('2026-10-30T20:30:00.000Z'))).toBe(
      '2026-10-31',
    )
    expect(todayIn('UTC', new Date('2026-10-30T20:30:00.000Z'))).toBe(
      '2026-10-30',
    )
  })

  it('orders the month weekday header from the configured week start', () => {
    const days = weekDaysFor(TODAY, 'saturday')

    expect(days).toHaveLength(7)
    expect(days[0]?.weekday).toBe('شنبه')
    expect(days[6]?.weekday).toBe('جمعه')
    expect(days[0]?.shortWeekday).toBe('ش')
  })
})

describe('mirror projection', () => {
  it('projects tasks, events and annual occasions onto the week', () => {
    const week = weekFromMirror({
      tasks: [calendarTask()],
      events: [eventRow(), timedEventRow()],
      occasions: [occasionSourceOf(occasionRow())],
      anchor: TODAY,
      weekStart: 'saturday',
      timeZone: 'Asia/Tehran',
    })

    const today = week.days.find(day => day.date === TODAY)

    expect(week.start).toBe(WEEK_START)
    expect(week.end).toBe(WEEK_END)
    expect(today?.tasks.map(task => task.title)).toEqual(['خرید نان'])
    expect(today?.events.map(event => event.title)).toEqual(['سفر', 'جلسه'])
    expect(today?.occasions.map(occasion => occasion.title)).toEqual([
      'تولد مامان',
    ])
    expect(week.totals.tasks).toBe(1)
    expect(week.totals.events).toBe(2)
    expect(week.totals.occasions).toBe(1)
  })
})

it('projects an annual occasion onto this year’s Jalali date', () => {
  const origin = toIsoDate(addJalaliMonths(toJalaliDate(TODAY), -36))
  const week = weekFromMirror({
    tasks: [],
    events: [],
    occasions: [occasionSourceOf(occasionRow({ originDate: origin }))],
    anchor: TODAY,
    weekStart: 'saturday',
    timeZone: 'Asia/Tehran',
  })

  const today = week.days.find(day => day.date === TODAY)

  expect(today?.occasions.map(occasion => occasion.title)).toEqual([
    'تولد مامان',
  ])
})

describe('source selection and overlays', () => {
  it('falls back to the mirror when no server snapshot exists', () => {
    const view = weekView({
      mirror: mirrorWith({ tasks: [calendarTask()] }),
    })

    expect(view.source).toBe('mirror')
    expect(
      view.week.days.flatMap(day => day.tasks.map(task => task.title)),
    ).toEqual(['خرید نان'])
  })

  it('prefers the server snapshot when it still describes the window', () => {
    const serverTask = {
      id: calendarTask().id,
      title: 'از سرور',
      status: 'todo' as const,
      priority: 'medium' as const,
      dueDate: TODAY,
      dueAt: null,
      recurrence: null,
      recurrenceMode: null,
    }

    const view = weekView({
      maybeServerWeek: weekPayload({ tasks: [serverTask] }),
      isOnline: true,
    })

    expect(view.source).toBe('server')
    expect(
      view.week.days.flatMap(day => day.tasks.map(task => task.title)),
    ).toEqual(['از سرور'])
  })

  it('overlays a pending local write on the server rows', () => {
    const task = calendarTask({ title: 'محلی' })
    const view = weekView({
      maybeServerWeek: weekPayload({
        tasks: [
          {
            id: task.id,
            title: 'از سرور',
            status: 'todo',
            priority: 'medium',
            dueDate: TODAY,
            dueAt: null,
            recurrence: null,
            recurrenceMode: null,
          },
        ],
      }),
      mirror: mirrorWith({ tasks: [task] }),
      pendingKeys: [entityKey('task', task.id)],
    })

    expect(
      view.week.days.flatMap(day => day.tasks.map(item => item.title)),
    ).toContain('محلی')
    expect(
      view.week.days.flatMap(day => day.tasks.map(item => item.title)),
    ).not.toContain('از سرور')
  })

  it('drops a locally deleted series from the server snapshot', () => {
    const row = eventRow()
    const view = weekView({
      maybeServerWeek: weekPayload({
        events: [
          {
            id: row.id,
            title: row.title,
            description: null,
            location: null,
            category: null,
            color: null,
            people: [],
            timing: row.timing,
            timeZone: row.timeZone,
            recurrence: null,
            exceptions: [],
          },
        ],
      }),
      mirror: mirrorWith({ trashedEvents: [row] }),
      pendingKeys: [entityKey('event', row.id)],
    })

    expect(
      view.week.days.flatMap(day => day.events.map(event => event.title)),
    ).toEqual([])
  })

  it('ignores the server snapshot while offline', () => {
    const view = weekView({
      maybeServerWeek: weekPayload({
        tasks: [
          {
            id: calendarTask().id,
            title: 'از سرور',
            status: 'todo',
            priority: 'medium',
            dueDate: TODAY,
            dueAt: null,
            recurrence: null,
            recurrenceMode: null,
          },
        ],
      }),
      mirror: mirrorWith({ tasks: [calendarTask()] }),
      isOnline: false,
    })

    expect(view.source).toBe('mirror')
    expect(
      view.week.days.flatMap(day => day.tasks.map(task => task.title)),
    ).toEqual(['خرید نان'])
  })

  it('merges only the overlaid task ids', () => {
    const base = {
      id: calendarTask().id,
      title: 'از سرور',
      status: 'todo' as const,
      priority: 'medium' as const,
      dueDate: TODAY,
      dueAt: null,
      recurrence: null,
      recurrenceMode: null,
    }

    const merged = overlayCalendarSources({
      base: [base],
      mirror: [
        calendarTask({ title: 'محلی' }),
        calendarTask({
          id: '0192f0a0-0000-7000-8000-000000000099',
          title: 'ناشناس',
        }),
      ],
      overlayIds: new Set([base.id]),
    })

    expect(merged.map(task => task.title)).toEqual(['محلی'])
  })

  it('drops a locally deleted occasion', () => {
    const row = occasionRow()
    const merged = overlayOccasionSources({
      base: [occasionSourceOf(row)],
      mirror: [],
      overlayIds: new Set([row.id]),
      deletedIds: new Set([row.id]),
    })

    expect(merged).toEqual([])
  })
})

describe('month drill-down', () => {
  it('builds the selected day with its three lanes', () => {
    const view = calendarViewOf({
      view: 'month',
      anchor: TODAY,
      maybeSelectedDay: Option.some(TODAY),
      maybeServerWeek: Option.none(),
      maybeServerMonth: Option.none(),
      dirtyTaskIds: [],
      dirtyEventIds: [],
      now: Date.parse('2026-10-30T09:30:00.000Z'),
      inputs: calendarInputs({
        mirror: mirrorWith({
          tasks: [calendarTask()],
          events: [eventRow()],
          occasions: [occasionRow()],
        }),
      }),
    })

    expect(view.month.day?.date).toBe(TODAY)
    expect(view.month.day?.tasks).toHaveLength(1)
    expect(view.month.day?.events).toHaveLength(1)
    expect(view.month.day?.occasions).toHaveLength(1)
    expect(view.month.year).toBe(1405)
    expect(view.month.month).toBe(8)
  })
})
