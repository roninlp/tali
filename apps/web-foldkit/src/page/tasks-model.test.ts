import { describe, expect, test } from 'vitest'

import type { TaskRow } from '../mirror'
import {
  COMPLETED_TASK_RETENTION_MS,
  DEFAULT_TASK_FILTERS,
  DEFAULT_TASK_SORT,
  ProjectFilter,
  activeFilterCount,
  buildTaskView,
  compareTasks,
  dueLabel,
  recentCompletions,
  shiftLocalDate,
  sortTasks,
  tagColor,
} from './tasks-model'

/**
 * The `/tasks` client model: mirror-first board grouping, the filter/sort bar,
 * the seven-day completion window, and stable date/tag copy. Ported from
 * `apps/web/src/lib/tasks/model.test.ts`.
 */

const NOW = '2026-10-21T10:00:00.000Z'
const ZONE = 'UTC'

const makeTask = (overrides: Partial<TaskRow> = {}): TaskRow => ({
  id: '0192f0a0-0000-7000-8000-000000000001',
  title: 'کار',
  description: null,
  status: 'todo',
  priority: 'medium',
  dueDate: null,
  dueAt: null,
  timeZone: ZONE,
  projectId: null,
  tagIds: [],
  startedAt: null,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  version: 1,
  hasSyncError: false,
  ...overrides,
})

const view = (
  rows: ReadonlyArray<TaskRow>,
  filters: Partial<typeof DEFAULT_TASK_FILTERS> = {},
  sort: Partial<typeof DEFAULT_TASK_SORT> = {},
) =>
  buildTaskView(rows, {
    timeZone: ZONE,
    now: NOW,
    filters: { ...DEFAULT_TASK_FILTERS, ...filters },
    sort: { ...DEFAULT_TASK_SORT, ...sort },
  })

const titles = (rows: ReadonlyArray<TaskRow>) => rows.map(task => task.title)

describe('board grouping', () => {
  test('places every live task in exactly one bucket and hides completed ones', () => {
    const rows = [
      makeTask({ title: 'عقب', dueDate: '2026-10-20' }),
      makeTask({ title: 'امروز', dueDate: '2026-10-21' }),
      makeTask({ title: 'فردا', dueDate: '2026-10-22' }),
      makeTask({ title: 'این‌هفته', dueDate: '2026-10-25' }),
      makeTask({ title: 'بعدتر', dueDate: '2026-11-02' }),
      makeTask({ title: 'بی‌تاریخ' }),
      makeTask({ title: 'تمام', status: 'done', completedAt: NOW }),
    ]

    const result = view(rows)
    expect(titles(result.today.groups[0]?.tasks ?? [])).toEqual(['عقب'])
    expect(titles(result.today.groups[1]?.tasks ?? [])).toEqual(['امروز'])
    expect(titles(result.upcoming.groups[0]?.tasks ?? [])).toEqual(['فردا'])
    expect(titles(result.upcoming.groups[1]?.tasks ?? [])).toEqual(['این‌هفته'])
    expect(titles(result.upcoming.groups[2]?.tasks ?? [])).toEqual(['بعدتر'])
    expect(titles(result.inbox.groups[0]?.tasks ?? [])).toEqual(['بی‌تاریخ'])
    expect(result.counts).toEqual({ today: 2, upcoming: 3, inbox: 1 })
    expect(result.total).toBe(6)
    expect(result.visible.some(entry => entry.title === 'تمام')).toBe(false)
  })

  test('uses the viewer zone at a day boundary (Tehran, not UTC)', () => {
    const rows = [makeTask({ title: 'تهران فردا', dueDate: '2026-10-22' })]
    const tehran = buildTaskView(rows, {
      timeZone: 'Asia/Tehran',
      now: '2026-10-21T22:30:00.000Z',
      filters: DEFAULT_TASK_FILTERS,
      sort: DEFAULT_TASK_SORT,
    })

    expect(titles(tehran.today.groups[1]?.tasks ?? [])).toEqual(['تهران فردا'])
    expect(tehran.upcoming.count).toBe(0)
  })

  test('sorts the default view by due date, then priority', () => {
    const rows = [
      makeTask({ title: 'کم', dueDate: '2026-10-21', priority: 'low' }),
      makeTask({ title: 'زیاد', dueDate: '2026-10-21', priority: 'high' }),
    ]

    expect(titles(view(rows).today.groups[1]?.tasks ?? [])).toEqual([
      'زیاد',
      'کم',
    ])
  })
})

describe('filters', () => {
  const projectA = '11111111-1111-7111-8111-111111111111'
  const projectB = '22222222-2222-7222-8222-222222222222'
  const tagA = '33333333-3333-7333-8333-333333333333'
  const tagB = '44444444-4444-7444-8444-444444444444'
  const rows = [
    makeTask({
      title: 'الف',
      dueDate: '2026-10-21',
      projectId: projectA,
      tagIds: [tagA],
      priority: 'high',
    }),
    makeTask({
      title: 'ب',
      dueDate: '2026-10-22',
      projectId: projectB,
      tagIds: [tagA, tagB],
      status: 'doing',
    }),
    makeTask({ title: 'ج', dueDate: '2026-10-27', projectId: null }),
    makeTask({ title: 'د' }),
  ]

  test('filters by project, including the no-project inbox', () => {
    expect(
      titles(
        view(rows, {
          project: ProjectFilter.Project({ projectId: projectA }),
        }).visible,
      ),
    ).toEqual(['الف'])
    expect(
      titles(
        view(rows, {
          project: ProjectFilter.Project({ projectId: projectB }),
        }).visible,
      ),
    ).toEqual(['ب'])
    expect(
      titles(view(rows, { project: ProjectFilter.None() }).visible),
    ).toEqual(['ج', 'د'])
  })

  test('matches any selected tag (OR), the service semantics', () => {
    expect(titles(view(rows, { tagIds: [tagA] }).visible)).toEqual(['الف', 'ب'])
    expect(titles(view(rows, { tagIds: [tagB] }).visible)).toEqual(['ب'])
  })

  test('filters by priority, status and date preset', () => {
    expect(titles(view(rows, { priority: 'high' }).visible)).toEqual(['الف'])
    expect(titles(view(rows, { status: 'doing' }).visible)).toEqual(['ب'])
    expect(titles(view(rows, { date: 'overdue' }).visible)).toEqual([])
    expect(titles(view(rows, { date: 'tomorrow' }).visible)).toEqual(['ب'])
    expect(titles(view(rows, { date: 'none' }).visible)).toEqual(['د'])
    expect(titles(view(rows, { date: 'week' }).visible)).toEqual(['ج'])
  })

  test('counts active filters for the persistent bar', () => {
    expect(activeFilterCount(DEFAULT_TASK_FILTERS)).toBe(0)
    expect(
      activeFilterCount({
        project: ProjectFilter.None(),
        tagIds: [tagA],
        priority: 'high',
        status: 'doing',
        date: 'today',
      }),
    ).toBe(5)
  })
})

describe('sorting', () => {
  const rows = [
    makeTask({
      title: 'ب',
      dueDate: '2026-10-22',
      priority: 'low',
      status: 'todo',
    }),
    makeTask({
      title: 'الف',
      dueDate: '2026-10-21',
      priority: 'high',
      status: 'doing',
    }),
    makeTask({ title: 'ج', dueDate: null, priority: 'medium', status: 'todo' }),
  ]

  test('sorts by title and flips direction', () => {
    const sameDay = rows.map(row => ({ ...row, dueDate: '2026-10-21' }))
    const group = (direction: 'asc' | 'desc') =>
      view(sameDay, {}, { by: 'title', direction }).today.groups[1]?.tasks ?? []

    expect(titles(group('asc'))).toEqual(['الف', 'ب', 'ج'])
    expect(titles(group('desc'))).toEqual(['ج', 'ب', 'الف'])
  })

  test('sorts high priority first, and overdue days oldest-first', () => {
    const sameDay = rows.map(row => ({ ...row, dueDate: '2026-10-21' }))
    expect(
      titles(
        view(sameDay, {}, { by: 'priority', direction: 'asc' }).today.groups[1]
          ?.tasks ?? [],
      ),
    ).toEqual(['الف', 'ج', 'ب'])

    const overdue = [
      makeTask({ title: 'دیروز', dueDate: '2026-10-20' }),
      makeTask({ title: 'پریروز', dueDate: '2026-10-19' }),
    ]
    expect(titles(view(overdue).today.groups[0]?.tasks ?? [])).toEqual([
      'پریروز',
      'دیروز',
    ])
  })

  test('keeps the id tie-break stable and does not flip it', () => {
    const first = makeTask({
      id: '0192f0a0-0000-7000-8000-000000000001',
      title: 'هم',
      dueDate: '2026-10-21',
    })
    const second = makeTask({
      id: '0192f0a0-0000-7000-8000-000000000002',
      title: 'هم',
      dueDate: '2026-10-21',
    })

    expect(compareTasks(first, second, DEFAULT_TASK_SORT)).toBe(-1)
    expect(
      compareTasks(first, second, { by: 'dueDate', direction: 'desc' }),
    ).toBe(-1)
    expect(titles(sortTasks([second, first], DEFAULT_TASK_SORT))).toEqual([
      'هم',
      'هم',
    ])
  })

  test('labels overdue calmly and localizes the due chip', () => {
    const bounds = view([]).bounds
    expect(
      dueLabel(makeTask({ dueDate: '2026-10-20' }), bounds, 'persian'),
    ).toMatch(/^عقب‌افتاده · /)
    expect(
      dueLabel(makeTask({ dueDate: '2026-10-21' }), bounds, 'persian'),
    ).toBe('امروز')
    expect(dueLabel(makeTask(), bounds, 'persian')).toBe('بدون تاریخ')
  })
})

describe('completion history', () => {
  test('keeps seven days of completions, newest first', () => {
    const fresh = makeTask({
      title: 'تازه',
      status: 'done',
      completedAt: '2026-10-20T10:00:00.000Z',
    })
    const older = makeTask({
      title: 'قدیمی',
      status: 'done',
      completedAt: new Date(
        Date.parse(NOW) - COMPLETED_TASK_RETENTION_MS - 1000,
      ).toISOString(),
    })
    const live = makeTask({ title: 'باز' })

    expect(titles(recentCompletions([fresh, older, live], NOW))).toEqual([
      'تازه',
    ])
  })
})

describe('dates and tags', () => {
  test('shifts wall dates across a month boundary', () => {
    expect(shiftLocalDate('2026-10-21', 7)).toBe('2026-10-28')
    expect(shiftLocalDate('2026-03-20', 1)).toBe('2026-03-21')
  })

  test('a saved tag colour wins; otherwise the slot is stable', () => {
    expect(tagColor({ id: 'tag', color: '#123456' })).toBe('#123456')
    expect(tagColor({ id: 'tag', color: null })).toBe(
      tagColor({ id: 'tag', color: null }),
    )
    expect(tagColor({ id: 'tag', color: 'not-a-color' })).not.toBe(
      'not-a-color',
    )
  })
})
