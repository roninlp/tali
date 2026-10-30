import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'

import {
  type SyncBootstrapResponse,
  type SyncPullResponse,
  type SyncPushEntry,
  type SyncPushResponse,
  uuidV7,
} from '@tali/domain'
import {
  type LocalStore,
  type SyncTransport,
  createSyncEngine,
  openLocalStore,
} from '@tali/sync-client'

import { nextItemOrder, toListItemRow, toListRow } from '../lists-model'
import {
  createListInMirror,
  createListItemInMirror,
  deleteListInMirror,
  deleteListItemInMirror,
  reorderListItemsInMirror,
  setListItemCheckedInMirror,
  uncheckListItemInMirror,
  updateListInMirror,
  writeListSettingIfLatest,
} from './list-writes'

/**
 * Ticket #39 local-first writes: five continuous Enters queue five items,
 * check/undo is idempotent, reorder persists, and the queued batch drains on
 * reconnect. This is the real IndexedDB store (fake-indexeddb).
 */

const open = (): Promise<LocalStore> => openLocalStore(`user-${uuidV7()}`)

const transport = (parts: {
  readonly pull?: (cursor: number, limit: number) => Promise<SyncPullResponse>
  readonly push?: (
    entries: ReadonlyArray<SyncPushEntry>,
  ) => Promise<SyncPushResponse>
}): SyncTransport => ({
  pull:
    parts.pull ??
    (async cursor => ({
      entries: [],
      items: [],
      removed: [],
      nextCursor: cursor,
      hasMore: false,
      resetRequired: false,
    })),
  bootstrap: async (): Promise<SyncBootstrapResponse> => ({
    items: [],
    nextOffset: 0,
    hasMore: false,
    cursor: 0,
  }),
  push: parts.push ?? (async () => ({ results: [], cursor: 0 })),
})

describe('list mirror writes', () => {
  test('adds five items continuously and queues each write', async () => {
    const store = await open()
    const listId = uuidV7(1_700_000_000_000)
    await createListInMirror(
      store,
      {
        title: 'خرید',
        color: '#0f9d8f',
        icon: '🛒',
        checkedPlacement: 'bottom',
      },
      listId,
      '2026-10-20T09:00:00.000Z',
    )

    const names = ['نان', 'شیر', 'تخم‌مرغ', 'پنیر', 'سبزی']
    const ids = names.map((_, index) => uuidV7(1_700_000_000_100 + index))
    await Promise.all(
      names.map((name, index) =>
        createListItemInMirror(
          store,
          listId,
          { name, order: index + 1 },
          ids[index] ?? uuidV7(1_700_000_000_200 + index),
          '2026-10-20T09:01:00.000Z',
        ),
      ),
    )

    expect(await store.pending()).toHaveLength(6)
    const listRecord = await store.get('list', listId)
    expect(
      listRecord === undefined ? undefined : toListRow(listRecord),
    ).toMatchObject({
      title: 'خرید',
      checkedPlacement: 'bottom',
      icon: '🛒',
    })

    const items = (await store.list('listItem'))
      .map(toListItemRow)
      .sort((a, b) => a.order - b.order)
    expect(items.map(item => item.name)).toEqual(names)
    expect(items.map(item => item.order)).toEqual([1, 2, 3, 4, 5])
    expect(nextItemOrder(items)).toBe(6)

    const first = await store.get('listItem', ids[0] ?? '')
    expect(first?.data).toMatchObject({
      title: 'نان',
      name: 'نان',
      checked: false,
      done: false,
      sortOrder: 1,
      ordering: 1,
      listId,
    })

    store.close()
  })

  test('checks with an audit timestamp, tolerates a repeat, and undoes', async () => {
    const store = await open()
    const listId = await createListInMirror(
      store,
      { title: 'کارها' },
      uuidV7(1_700_000_000_300),
      '2026-10-20T09:00:00.000Z',
    )
    const id = await createListItemInMirror(
      store,
      listId,
      { name: 'ظرف‌ها', order: 1 },
      uuidV7(1_700_000_000_301),
      '2026-10-20T09:00:00.000Z',
    )
    const before = (await store.list('listItem')).map(toListItemRow)[0]

    if (before === undefined) {
      throw new Error('expected the seed row')
    }

    const now = '2026-10-20T09:30:00.000Z'
    await setListItemCheckedInMirror(store, before, true, now)
    const checked = (await store.list('listItem')).map(toListItemRow)[0]
    expect(checked?.done).toBe(true)
    expect(checked?.checkedAt).toBe(now)

    if (checked === undefined) {
      throw new Error('expected the checked row')
    }

    const pendingAfterCheck = (await store.pending()).length
    await setListItemCheckedInMirror(store, checked, true, now)
    expect((await store.pending()).length).toBe(pendingAfterCheck)

    await setListItemCheckedInMirror(store, checked, false, now)
    const undone = (await store.list('listItem')).map(toListItemRow)[0]
    expect(undone?.done).toBe(false)
    expect(undone?.checkedAt).toBeNull()
    expect(undone?.id).toBe(id)

    store.close()
  })

  test('forces an undo even when the local row already looks unchecked', async () => {
    const store = await open()
    const listId = await createListInMirror(
      store,
      { title: 'بازگردانی' },
      uuidV7(1_700_000_000_310),
      '2026-10-20T09:00:00.000Z',
    )
    const id = await createListItemInMirror(
      store,
      listId,
      { name: 'شیر', order: 1 },
      uuidV7(1_700_000_000_311),
      '2026-10-20T09:00:00.000Z',
    )
    const pendingBefore = (await store.pending()).length

    await uncheckListItemInMirror(store, id, '2026-10-20T09:31:00.000Z')

    // The write coalesces into the queued create entry, but the forced
    // unchecked patch is what that entry now carries.
    expect((await store.pending()).length).toBe(pendingBefore)
    const queued = (await store.pending()).find(entry => entry.entityId === id)
    expect(queued?.patch).toMatchObject({
      checked: false,
      done: false,
      checkedAt: null,
    })
    const row = (await store.list('listItem')).map(toListItemRow)[0]
    expect(row?.done).toBe(false)
    expect(row?.checkedAt).toBeNull()

    store.close()
  })

  test('persists a manual reorder and only queues changed positions', async () => {
    const store = await open()
    const listId = await createListInMirror(
      store,
      { title: 'ترتیب' },
      uuidV7(1_700_000_000_320),
      '2026-10-20T09:00:00.000Z',
    )
    const names = ['یک', 'دو', 'سه']
    const ids = names.map((_, index) => uuidV7(1_700_000_000_321 + index))
    await Promise.all(
      names.map((name, index) =>
        createListItemInMirror(
          store,
          listId,
          { name, order: index + 1 },
          ids[index] ?? uuidV7(1_700_000_000_330 + index),
          '2026-10-20T09:00:00.000Z',
        ),
      ),
    )
    const items = (await store.list('listItem')).map(toListItemRow)
    const ordered = [ids[2] ?? '', ids[0] ?? '', ids[1] ?? '']

    await reorderListItemsInMirror(
      store,
      items,
      ordered,
      '2026-10-20T09:10:00.000Z',
    )
    const reordered = (await store.list('listItem'))
      .map(toListItemRow)
      .sort((a, b) => a.order - b.order)
    expect(reordered.map(item => item.name)).toEqual(['سه', 'یک', 'دو'])
    expect(reordered.map(item => item.order)).toEqual([1, 2, 3])

    const pendingBefore = (await store.pending()).length
    await reorderListItemsInMirror(
      store,
      reordered,
      ordered,
      '2026-10-20T09:11:00.000Z',
    )
    expect((await store.pending()).length).toBe(pendingBefore)

    store.close()
  })

  test('deletes the list and its locally known items', async () => {
    const store = await open()
    const listId = await createListInMirror(
      store,
      { title: 'حذف' },
      uuidV7(1_700_000_000_340),
      '2026-10-20T09:00:00.000Z',
    )
    const itemId = await createListItemInMirror(
      store,
      listId,
      { name: 'نان', order: 1 },
      uuidV7(1_700_000_000_341),
      '2026-10-20T09:00:00.000Z',
    )

    await deleteListInMirror(
      store,
      listId,
      [itemId],
      '2026-10-20T09:20:00.000Z',
    )

    expect(await store.list('list')).toHaveLength(0)
    expect(await store.list('listItem')).toHaveLength(0)
    expect((await store.get('list', listId))?.deletedAt).toBe(
      '2026-10-20T09:20:00.000Z',
    )

    store.close()
  })

  test('updates a list title and preference fields from the store user', async () => {
    const store = await open()
    const listId = await createListInMirror(
      store,
      { title: 'قبلی' },
      uuidV7(1_700_000_000_350),
      '2026-10-20T09:00:00.000Z',
    )

    await updateListInMirror(
      store,
      listId,
      { title: 'تازه', sort: 'alpha', visibility: 'private' },
      '2026-10-20T09:05:00.000Z',
    )

    const row = await store.get('list', listId)
    expect(row === undefined ? undefined : toListRow(row)).toMatchObject({
      title: 'تازه',
      sort: 'alpha',
      visibility: 'private',
      ownerId: store.userId,
    })

    store.close()
  })

  test('a stale setting write cannot overwrite a newer one', async () => {
    const store = await open()
    const listId = uuidV7(1_700_000_000_900)
    const now = '2026-10-20T09:00:00.000Z'
    await createListInMirror(store, { title: 'خرید' }, listId, now)

    await writeListSettingIfLatest(
      store,
      'sort',
      listId,
      1,
      { sort: 'alpha' },
      now,
    )
    await writeListSettingIfLatest(
      store,
      'sort',
      listId,
      2,
      { sort: 'manual' },
      now,
    )
    // The older command finally runs; it must not clobber the newer intent.
    await writeListSettingIfLatest(
      store,
      'sort',
      listId,
      1,
      { sort: 'status' },
      now,
    )

    const record = await store.get('list', listId)
    expect(record === undefined ? undefined : toListRow(record).sort).toBe(
      'manual',
    )
  })

  test('drains an offline list+items queue on reconnect', async () => {
    const store = await open()
    const listId = await createListInMirror(
      store,
      { title: 'آفلاین' },
      uuidV7(1_700_000_000_360),
      '2026-10-20T09:00:00.000Z',
    )
    await Promise.all(
      ['الف', 'ب', 'پ'].map((name, index) =>
        createListItemInMirror(
          store,
          listId,
          { name, order: index + 1 },
          uuidV7(1_700_000_000_361 + index),
          '2026-10-20T09:00:00.000Z',
        ),
      ),
    )
    expect((await store.pending()).length).toBe(4)

    const pushed: Array<ReadonlyArray<SyncPushEntry>> = []
    const engine = createSyncEngine(
      transport({
        push: async entries => {
          pushed.push(entries)
          return {
            results: entries.map(entry => ({
              _tag: 'applied' as const,
              clientMutationId: entry.clientMutationId,
              entityType: entry.entityType,
              entityId: entry.entityId,
              version: 1,
              seq: 1,
            })),
            cursor: 1,
          }
        },
      }),
    )

    await engine.sync(store)
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toHaveLength(4)
    expect(await store.pending()).toHaveLength(0)
    await engine.sync(store)
    expect((await store.pending()).length).toBe(0)
    expect((await store.list('listItem')).length).toBe(3)

    store.close()
  })

  test('adopts the server-stamped last writer for the updated-by label', async () => {
    const store = await open()
    const id = uuidV7(1_700_000_000_370)
    await store.mergeServer([
      {
        entityType: 'listItem',
        entityId: id,
        version: 2,
        updatedAt: '2026-10-20T09:30:00.000Z',
        deletedAt: null,
        data: {
          listId: 'list-1',
          name: 'شیر',
          done: false,
          order: 1,
          lastWriterId: 'user-b',
        },
      },
    ])

    const row = (await store.list('listItem')).map(toListItemRow)[0]
    expect(row?.lastWriterId).toBe('user-b')

    store.close()
  })

  test('deletes one item without touching the list', async () => {
    const store = await open()
    const listId = await createListInMirror(
      store,
      { title: 'تک‌مورد' },
      uuidV7(1_700_000_000_380),
      '2026-10-20T09:00:00.000Z',
    )
    const itemId = await createListItemInMirror(
      store,
      listId,
      { name: 'نان', order: 1 },
      uuidV7(1_700_000_000_381),
      '2026-10-20T09:00:00.000Z',
    )

    await deleteListItemInMirror(store, itemId, '2026-10-20T09:15:00.000Z')

    expect(await store.list('list')).toHaveLength(1)
    expect(await store.list('listItem')).toHaveLength(0)

    store.close()
  })
})
