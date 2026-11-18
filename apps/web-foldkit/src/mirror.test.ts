import { describe, expect, test } from 'vite-plus/test'

import { DEFAULT_TIME_ZONE } from '@tali/domain'
import type { MirrorRecord } from '@tali/sync-client'

import { ServerTask } from './lib/today-api'
import {
  pendingIdsOf,
  pendingIdSetOf,
  toTaskRow,
  taskRowFromServer,
} from './mirror'

/**
 * The mirror-consumption rules the screens share: reading one entity type's
 * ids out of the pending `type\0id` keys, and the TaskRow fallback policy both
 * projectors decode through.
 */

const record = (data: MirrorRecord['data']): MirrorRecord => ({
  entityType: 'task',
  entityId: 'task-1',
  version: 1,
  updatedAt: '2026-10-20T09:40:00.000Z',
  deletedAt: null,
  data,
})

describe('pending key extraction', () => {
  test('reads one entity type ids out of the pending keys', () => {
    const keys = [
      'habit\u0000habit-1',
      'task\u0000task-1',
      'habit\u0000habit-2',
      'habitEntry\u0000entry-1',
    ]

    expect(pendingIdsOf('habit', keys)).toEqual(['habit-1', 'habit-2'])
    expect(pendingIdsOf('task', keys)).toEqual(['task-1'])
    expect(pendingIdsOf('habitEntry', keys)).toEqual(['entry-1'])
    expect(pendingIdsOf('note', keys)).toEqual([])
  })

  test('the set form deduplicates the extracted ids', () => {
    expect(
      pendingIdSetOf('task', ['task\u0000t1', 'task\u0000t1', 'task\u0000t2']),
    ).toEqual(new Set(['t1', 't2']))
  })
})

describe('task row defaults', () => {
  test('a server row decodes through the same defaults as the mirror', () => {
    const row = taskRowFromServer(
      ServerTask.make({
        id: 'task-1',
        title: 'از سرور',
        status: 'wip',
        priority: 'urgent',
        timeZone: 'Mars/Olympus',
      }),
    )

    expect(row.status).toBe('todo')
    expect(row.priority).toBe('medium')
    expect(row.timeZone).toBe(DEFAULT_TIME_ZONE)
    expect(row.visibility).toBe('shared')
  })

  test('a settled server visibility passes through untouched', () => {
    const row = taskRowFromServer(
      ServerTask.make({
        id: 'task-1',
        title: 'از سرور',
        visibility: 'private',
      }),
    )

    expect(row.visibility).toBe('private')
  })

  test('an unusable mirror zone or visibility falls back to the policy', () => {
    const row = toTaskRow(
      record({
        title: 'از آینه',
        timeZone: 'Mars/Olympus',
        visibility: 'public',
      }),
    )

    expect(row.timeZone).toBe(DEFAULT_TIME_ZONE)
    expect(row.visibility).toBe('shared')
  })
})
