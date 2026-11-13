import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vite-plus/test'

import type { MirrorRecord } from '../src/local-store/types'
import {
  countFailedRows,
  failedRows,
  liveRows,
  trashedRows,
} from '../src/local-store/mirror'
import {
  createTaskInMirror,
  readTaskRows,
  taskCreatePatch,
  taskRowsFromMirror,
  todayInZone,
} from '../src/task'
import { openLocalStore } from '../src/local-store/store'

const record = (overrides: Partial<MirrorRecord> = {}): MirrorRecord => ({
  entityType: 'task',
  entityId: 'task-1',
  version: 1,
  updatedAt: '2026-10-20T09:00:00.000Z',
  deletedAt: null,
  data: { title: 'نان', status: 'todo', dueDate: '2026-10-20' },
  ...overrides,
})

describe('mirror projections', () => {
  it('splits live, trashed and failed rows', () => {
    const live = record()
    const trashed = record({
      entityId: 'task-2',
      deletedAt: '2026-10-19T09:00:00.000Z',
    })
    const failed = record({
      entityId: 'task-3',
      syncError: {
        code: 'InvalidPatch',
        message: 'bad patch',
        at: '2026-10-20T09:00:00.000Z',
        clientMutationId: 'mutation-1',
      },
    })
    const rows = [live, trashed, failed]

    expect(liveRows(rows).map(row => row.entityId)).toEqual([
      'task-1',
      'task-3',
    ])
    expect(trashedRows(rows).map(row => row.entityId)).toEqual(['task-2'])
    expect(failedRows(rows).map(row => row.entityId)).toEqual(['task-3'])
    expect(countFailedRows(rows)).toBe(1)
  })
})

describe('task projection', () => {
  it('decodes only rows with a title and keeps the sync marker', () => {
    const rows = taskRowsFromMirror([
      record(),
      record({ entityId: 'task-2', data: { status: 'todo' } }),
      record({
        entityId: 'task-3',
        data: { title: 'شیر', status: 'done' },
        syncError: {
          code: 'UniqueViolation',
          message: 'conflict',
          at: '2026-10-20T09:00:00.000Z',
          clientMutationId: 'mutation-1',
        },
      }),
    ])

    expect(rows).toEqual([
      {
        id: 'task-1',
        title: 'نان',
        status: 'todo',
        dueDate: '2026-10-20',
        updatedAt: '2026-10-20T09:00:00.000Z',
        hasSyncError: false,
      },
      {
        id: 'task-3',
        title: 'شیر',
        status: 'done',
        dueDate: null,
        updatedAt: '2026-10-20T09:00:00.000Z',
        hasSyncError: true,
      },
    ])
  })

  it('builds the registry-shaped create patch and rejects an empty title', () => {
    const patch = taskCreatePatch(
      {
        title: '  نان  ',
        dueDate: '2026-10-20',
        priority: 'medium',
        projectId: null,
        tagIds: [],
        timeZone: 'Asia/Tehran',
      },
      'task-1',
      '2026-10-20T09:00:00.000Z',
    )

    expect(patch).toMatchObject({
      id: 'task-1',
      type: 'task',
      title: 'نان',
      status: 'todo',
      priority: 'medium',
      dueDate: '2026-10-20',
      timeZone: 'Asia/Tehran',
      visibility: 'shared',
      createdAt: '2026-10-20T09:00:00.000Z',
    })
    expect(() =>
      taskCreatePatch(
        {
          title: '   ',
          dueDate: null,
          priority: 'medium',
          projectId: null,
          tagIds: [],
          timeZone: 'Asia/Tehran',
        },
        'task-1',
        '2026-10-20T09:00:00.000Z',
      ),
    ).toThrow('a task needs a title')
  })

  it('writes the quick-add into the mirror and outbox together', async () => {
    const store = await openLocalStore('task-user')
    const id = await createTaskInMirror(
      store,
      {
        title: 'نان',
        dueDate: '2026-10-20',
        priority: 'medium',
        projectId: null,
        tagIds: [],
        timeZone: 'Asia/Tehran',
      },
      'task-1',
      '2026-10-20T09:00:00.000Z',
    )

    expect(id).toBe('task-1')
    expect(await readTaskRows(store)).toEqual([
      {
        id: 'task-1',
        title: 'نان',
        status: 'todo',
        dueDate: '2026-10-20',
        updatedAt: '2026-10-20T09:00:00.000Z',
        hasSyncError: false,
      },
    ])
    const pending = await store.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ entityType: 'task', entityId: 'task-1' })
    store.close()
  })

  it("derives the local date in the account's zone", () => {
    const now = new Date('2026-10-20T21:30:00.000Z')
    expect(todayInZone(now, 'Asia/Tehran')).toBe('2026-10-21')
    expect(todayInZone(now, 'UTC')).toBe('2026-10-20')
    // An invalid zone falls back instead of throwing in the form path.
    expect(todayInZone(now, 'Not/AZone')).toBe('2026-10-20')
  })
})
