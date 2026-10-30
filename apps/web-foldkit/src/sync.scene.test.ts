import { Option } from 'effect'
import {
  Command,
  expect,
  given,
  label,
  role,
  scene,
  submit,
  text,
  type,
  withViewInputs,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import type { TaskRow } from '@tali/sync-client'

import * as Sync from './sync'
import { syncModel } from './test-fixtures'

const task: TaskRow = {
  id: '0192f0a0-0000-7000-8000-000000000010',
  title: 'نان',
  status: 'todo',
  dueDate: '2026-10-20',
  updatedAt: '2026-10-20T09:00:00.000Z',
  hasSyncError: false,
}

const offline = (): Sync.Model =>
  modifyFields(syncModel(), { isOnline: () => false })

const todayView = withViewInputs(Sync.todayView, { timeZone: 'Asia/Tehran' })

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

describe('offline quick-add through the view', () => {
  test('a task written offline appears without waiting for the network', () => {
    scene(
      { update: Sync.update, view: todayView() },
      given(modifyFields(offline(), { tasks: () => [task] })),
      expect(label('کار تازه برای امروز')).toBeEnabled(),
      expect(text(task.title)).toExist(),
      type(label('کار تازه برای امروز'), 'شیر'),
      expect(role('button', { name: 'افزودن کار' })).toBeEnabled(),
      submit(role('form')),
      Command.expectExact(
        Sync.CreateTask({ title: 'شیر', timeZone: 'Asia/Tehran' }),
      ),
      Command.resolve(
        Sync.CreateTask,
        Sync.Message.CompletedCreateTask({
          taskId: '0192f0a0-0000-7000-8000-000000000011',
        }),
      ),
      Command.expectExact(
        Sync.ReadMirror({ pendingBefore: 0, failedRefreshedAt: 0 }),
      ),
      Command.resolve(
        Sync.ReadMirror,
        Sync.Message.SucceededReadMirror({
          at: 600,
          pending: 1,
          maybeFailed: Option.none(),
          failedRefreshedAt: 0,
          tasks: [
            task,
            {
              ...task,
              id: '0192f0a0-0000-7000-8000-000000000011',
              title: 'شیر',
            },
          ],
        }),
      ),
      expect(text('شیر')).toExist(),
      // The device is offline, so the read never starts a pass.
      Command.expectNone(),
    )
  })

  test('the form is disabled until the store is ready', () => {
    scene(
      { update: Sync.update, view: todayView() },
      given(syncModel(Sync.StoreStatus.Opening())),
      expect(label('کار تازه برای امروز')).toBeDisabled(),
      expect(role('button', { name: 'افزودن کار' })).toBeDisabled(),
    )
  })
})
