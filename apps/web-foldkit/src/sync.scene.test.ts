import { expect, given, role, scene } from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import * as Sync from './sync'
import { syncModel } from './test-fixtures'

const offline = (): Sync.Model =>
  modifyFields(syncModel(), { isOnline: () => false })

describe('sync status view', () => {
  test('a ready, online, drained store reads as synced', () => {
    scene(
      { update: Sync.update, view: Sync.view },
      given(syncModel()),
      expect(role('status')).toHaveText('همگام'),
    )
  })

  test('offline wins over a drained queue', () => {
    scene(
      { update: Sync.update, view: Sync.view },
      given(offline()),
      expect(role('status')).toHaveText('آفلاین'),
    )
  })

  test('pending work is announced with Persian digits', () => {
    scene(
      { update: Sync.update, view: Sync.view },
      given(modifyFields(syncModel(), { pending: () => 2 })),
      expect(role('status')).toHaveText('۲ تغییر در انتظار ارسال'),
    )
  })

  test('a durable rejection is an error, not a pending hint', () => {
    scene(
      { update: Sync.update, view: Sync.view },
      given(modifyFields(syncModel(), { failed: () => 1 })),
      expect(role('status')).toHaveText('۱ تغییر ذخیره نشد'),
      expect(role('status')).toHaveAttr('data-sync-tone', 'error'),
    )
  })

  test('an unavailable store explains itself', () => {
    scene(
      { update: Sync.update, view: Sync.view },
      given(
        syncModel(
          Sync.StoreStatus.Failed({ message: 'IndexedDB unavailable' }),
        ),
      ),
      expect(role('status')).toHaveText('حافظه‌ی محلی در دسترس نیست'),
    )
  })

  test('an account without a household has a local store but no sync loop', () => {
    scene(
      { update: Sync.update, view: Sync.view },
      given(modifyFields(syncModel(), { hasHousehold: () => false })),
      expect(role('status')).toHaveText('حافظه‌ی محلی فعال'),
    )
  })

  test('a pass in flight adds the quiet ellipsis', () => {
    scene(
      { update: Sync.update, view: Sync.view },
      given(modifyFields(syncModel(), { isSyncing: () => true })),
      expect(role('status')).toContainText('همگام'),
      expect(role('status')).toContainText('…'),
    )
  })
})
