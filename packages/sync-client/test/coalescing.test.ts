import { describe, expect, it } from 'vitest'

import {
  coalesceOutboxEntry,
  coalescible,
  laterInstant,
  newOutboxEntry,
  nextMirrorRecord,
  withoutSyncError,
} from '../src/local-store/coalescing'
import type {
  LocalWrite,
  MirrorRecord,
  OutboxRecord,
} from '../src/local-store/types'

const write = (overrides: Partial<LocalWrite> = {}): LocalWrite => ({
  entityType: 'task',
  entityId: 'task-1',
  op: 'upsert',
  patch: { title: 'نان' },
  ...overrides,
})

const mirror = (overrides: Partial<MirrorRecord> = {}): MirrorRecord => ({
  entityType: 'task',
  entityId: 'task-1',
  version: 0,
  updatedAt: '2026-10-20T09:00:00.000Z',
  deletedAt: null,
  data: {},
  ...overrides,
})

const outbox = (overrides: Partial<OutboxRecord> = {}): OutboxRecord => ({
  seq: 1,
  clientMutationId: 'mutation-1',
  entityType: 'task',
  entityId: 'task-1',
  baseVersion: 0,
  op: 'upsert',
  patch: { title: 'نان' },
  clientUpdatedAt: '2026-10-20T09:00:00.000Z',
  sent: false,
  ...overrides,
})

describe('local store write rules', () => {
  it('keeps the server version and clears nothing when a local edit lands', () => {
    const next = nextMirrorRecord(
      mirror({ version: 4, data: { title: 'نان', checked: false } }),
      write({ patch: { checked: true } }),
      '2026-10-20T09:00:01.000Z',
    )

    expect(next.version).toBe(4)
    expect(next.updatedAt).toBe('2026-10-20T09:00:01.000Z')
    expect(next.data).toEqual({ title: 'نان', checked: true })
    expect(next.deletedAt).toBeNull()
  })

  it('tombstones a delete but preserves a tombstone across an upsert', () => {
    const deleted = nextMirrorRecord(
      mirror({ version: 2 }),
      write({ op: 'delete', patch: {} }),
      '2026-10-20T09:00:01.000Z',
    )
    expect(deleted.deletedAt).toBe('2026-10-20T09:00:01.000Z')

    const restored = nextMirrorRecord(
      deleted,
      write({ patch: {}, deletedAt: null }),
      '2026-10-20T09:00:02.000Z',
    )
    expect(restored.deletedAt).toBeNull()
  })

  it('keeps a rejected marker until a push result clears it', () => {
    const marker = {
      code: 'InvalidPatch',
      message: 'bad patch',
      at: '2026-10-20T09:00:00.000Z',
      clientMutationId: 'mutation-1',
    }
    const next = nextMirrorRecord(
      mirror({ syncError: marker }),
      write({ patch: { checked: true } }),
      '2026-10-20T09:00:01.000Z',
    )
    expect(next.syncError).toEqual(marker)
    expect(withoutSyncError(next).syncError).toBeUndefined()
  })

  it('folds only unsent, non-empty upsert pairs', () => {
    expect(coalescible(outbox(), write())).toBe(true)
    expect(coalescible(outbox({ sent: true }), write())).toBe(false)
    expect(coalescible(outbox(), write({ op: 'delete', patch: {} }))).toBe(
      false,
    )
    expect(coalescible(outbox(), write({ patch: {} }))).toBe(false)
    expect(coalescible(outbox({ patch: {} }), write())).toBe(false)
    expect(coalescible(undefined, write())).toBe(false)
  })

  it('merges patches and keeps the newer edit instant', () => {
    const folded = coalesceOutboxEntry(
      outbox(),
      write({ patch: { checked: true } }),
      '2026-10-20T09:00:01.000Z',
    )

    expect(folded).toMatchObject({
      seq: 1,
      clientMutationId: 'mutation-1',
      patch: { title: 'نان', checked: true },
      clientUpdatedAt: '2026-10-20T09:00:01.000Z',
      sent: false,
    })
  })

  it('does not let a folded patch move the timestamp backwards', () => {
    const folded = coalesceOutboxEntry(
      outbox({ clientUpdatedAt: '2026-10-20T09:00:05.000Z' }),
      write({ patch: { checked: true } }),
      '2026-10-20T09:00:01.000Z',
    )
    expect(folded?.clientUpdatedAt).toBe('2026-10-20T09:00:05.000Z')
  })

  it('compares instants rather than raw strings', () => {
    expect(
      laterInstant('2026-10-20T09:00:00.000Z', '2026-10-20T12:30:00+03:00'),
    ).toBe('2026-10-20T12:30:00+03:00')
    expect(
      laterInstant('2026-10-20T12:00:00.000Z', '2026-10-20T09:00:00.000Z'),
    ).toBe('2026-10-20T12:00:00.000Z')
  })

  it('anchors a new outbox entry at the last server version', () => {
    const entry = newOutboxEntry(
      mirror({ version: 7 }),
      write({ patch: { checked: true } }),
      'mutation-9',
      '2026-10-20T09:00:01.000Z',
    )
    expect(entry).toEqual({
      clientMutationId: 'mutation-9',
      entityType: 'task',
      entityId: 'task-1',
      baseVersion: 7,
      op: 'upsert',
      patch: { checked: true },
      clientUpdatedAt: '2026-10-20T09:00:01.000Z',
      sent: false,
    })
  })
})
