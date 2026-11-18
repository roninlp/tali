import { describe, expect, it } from 'vite-plus/test'

import type { MirrorRecord } from '../src/local-store/types'
import {
  countFailedRows,
  failedRows,
  liveRows,
  trashedRows,
} from '../src/local-store/mirror'

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
