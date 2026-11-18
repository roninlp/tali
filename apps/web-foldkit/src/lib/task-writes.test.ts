import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vite-plus/test'

import { uuidV7 } from '@tali/domain'
import { type LocalStore, openLocalStore } from '@tali/sync-client'

import { createTaskInMirror, todayInZone } from './task-writes'

/**
 * Ported from `packages/sync-client/test/task.test.ts` when the P2.4
 * placeholder was retired (#124): the quick-add commits the registry-shaped
 * mirror row and the outbox entry together, an empty title is refused before
 * any write, and the local date follows the account's zone.
 */

const open = (): Promise<LocalStore> => openLocalStore(`user-${uuidV7()}`)

const NOW = '2026-10-20T09:00:00.000Z'

const draft = {
  title: '  نان  ',
  dueDate: '2026-10-20',
  priority: 'medium',
  projectId: null,
  tagIds: [],
  timeZone: 'Asia/Tehran',
} as const

describe('task quick create', () => {
  test('writes the registry-shaped quick-add into the mirror and outbox together', async () => {
    const store = await open()
    const id = await createTaskInMirror(store, draft, 'task-1', NOW)

    expect(id).toBe('task-1')
    const record = await store.get('task', 'task-1')
    expect(record).toMatchObject({
      entityId: 'task-1',
      version: 0,
      deletedAt: null,
      data: {
        id: 'task-1',
        type: 'task',
        title: 'نان',
        description: null,
        status: 'todo',
        priority: 'medium',
        dueAt: null,
        dueDate: '2026-10-20',
        timeZone: 'Asia/Tehran',
        projectId: null,
        tagIds: [],
        color: null,
        visibility: 'shared',
        createdAt: NOW,
        ownerId: store.userId,
      },
    })
    const pending = await store.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ entityType: 'task', entityId: 'task-1' })
    store.close()
  })

  test('rejects an empty title before any write', async () => {
    const store = await open()

    await expect(
      createTaskInMirror(store, { ...draft, title: '   ' }, 'task-1', NOW),
    ).rejects.toThrow('a task needs a title')
    expect(await store.list('task')).toEqual([])
    expect(await store.pending()).toEqual([])
    store.close()
  })

  test("derives the local date in the account's zone", () => {
    const now = new Date('2026-10-20T21:30:00.000Z')
    expect(todayInZone(now, 'Asia/Tehran')).toBe('2026-10-21')
    expect(todayInZone(now, 'UTC')).toBe('2026-10-20')
    // An invalid zone falls back instead of throwing in the form path.
    expect(todayInZone(now, 'Not/AZone')).toBe('2026-10-20')
  })
})
