import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

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

const syncedTask: TaskRow = {
  ...task,
  status: 'done',
  updatedAt: '2026-10-20T09:00:05.000Z',
}

const emptySnapshot = {
  at: 500,
  pending: 0,
  maybeFailed: Option.none<number>(),
  failedRefreshedAt: 0,
  tasks: [] satisfies ReadonlyArray<TaskRow>,
}

const queuedSnapshot = {
  at: 600,
  pending: 1,
  maybeFailed: Option.none<number>(),
  failedRefreshedAt: 0,
  tasks: [task] satisfies ReadonlyArray<TaskRow>,
}

const drainedSnapshot = {
  at: 700,
  pending: 0,
  maybeFailed: Option.some(0),
  failedRefreshedAt: 700,
  tasks: [syncedTask] satisfies ReadonlyArray<TaskRow>,
}

const offline = (): Sync.Model =>
  modifyFields(syncModel(), { isOnline: () => false })

describe('local store lifecycle', () => {
  test('opening the store reads the mirror and starts the first pull', () => {
    story(
      Sync.update,
      given(syncModel(Sync.StoreStatus.Opening())),
      message(Sync.Message.OpenedLocalStore()),
      model(next => {
        expect(next.status).toStrictEqual(Sync.StoreStatus.Ready())
      }),
      Command.expectExact(
        Sync.ReadMirror({ pendingBefore: 0, failedRefreshedAt: 0 }),
      ),
      Command.resolve(
        Sync.ReadMirror,
        Sync.Message.SucceededReadMirror(emptySnapshot),
      ),
      Command.expectExact(
        Sync.RunSyncPass({ pendingBefore: 0, failedRefreshedAt: 0 }),
      ),
      Command.resolve(
        Sync.RunSyncPass,
        Sync.Message.SucceededSyncPass(emptySnapshot),
      ),
    )
  })

  test('a failed open records the reason and stays out of the sync loop', () => {
    story(
      Sync.update,
      given(syncModel(Sync.StoreStatus.Opening())),
      message(
        Sync.Message.FailedOpenLocalStore({ message: 'IndexedDB unavailable' }),
      ),
      model(next => {
        expect(next.status).toStrictEqual(
          Sync.StoreStatus.Failed({ message: 'IndexedDB unavailable' }),
        )
        expect(next.maybeError).toStrictEqual(
          Option.some('IndexedDB unavailable'),
        )
      }),
      message(Sync.Message.FocusedApp()),
      Command.expectNone(),
    )
  })

  test('signing out releases the store and clears every snapshot', () => {
    story(
      Sync.update,
      given(
        modifyFields(syncModel(), {
          pending: () => 3,
          failed: () => 1,
          tasks: () => [task],
          draft: () => 'نیمه‌نوشته',
        }),
      ),
      message(Sync.Message.ReleasedLocalStore()),
      model(next => {
        expect(next.status).toStrictEqual(Sync.StoreStatus.Idle())
        expect(next.pending).toBe(0)
        expect(next.failed).toBe(0)
        expect(next.tasks).toStrictEqual([])
        expect(next.draft).toBe('')
      }),
      Command.expectNone(),
    )
  })
})

describe('offline quick-add', () => {
  test('an offline task is written locally and survives without a sync pass', () => {
    story(
      Sync.update,
      given(offline()),
      message(Sync.Message.UpdatedQuickAddDraft({ value: 'نان' })),
      message(Sync.Message.SubmittedQuickAdd({ timeZone: 'Asia/Tehran' })),
      model(next => {
        expect(next.isCreatingTask).toBe(true)
      }),
      Command.expectExact(
        Sync.CreateTask({ title: 'نان', timeZone: 'Asia/Tehran' }),
      ),
      Command.resolve(
        Sync.CreateTask,
        Sync.Message.CompletedCreateTask({ taskId: task.id }),
      ),
      model(next => {
        expect(next.draft).toBe('')
        expect(next.isCreatingTask).toBe(false)
      }),
      Command.expectExact(
        Sync.ReadMirror({ pendingBefore: 0, failedRefreshedAt: 0 }),
      ),
      Command.resolve(
        Sync.ReadMirror,
        Sync.Message.SucceededReadMirror(queuedSnapshot),
      ),
      model(next => {
        expect(next.pending).toBe(1)
        expect(next.tasks).toStrictEqual([task])
      }),
      Command.expectNone(),
    )
  })

  test('reconnecting starts the pass that drains the offline outbox', () => {
    story(
      Sync.update,
      given(
        modifyFields(offline(), {
          pending: () => 1,
          tasks: () => [task],
        }),
      ),
      message(Sync.Message.WentOnline()),
      model(next => {
        expect(next.isOnline).toBe(true)
        expect(next.isSyncing).toBe(true)
      }),
      Command.expectExact(
        Sync.RunSyncPass({ pendingBefore: 1, failedRefreshedAt: 0 }),
      ),
      Command.resolve(
        Sync.RunSyncPass,
        Sync.Message.SucceededSyncPass(drainedSnapshot),
      ),
      model(next => {
        expect(next.isSyncing).toBe(false)
        expect(next.pending).toBe(0)
        expect(next.failed).toBe(0)
        expect(next.failures).toBe(0)
        expect(next.tasks).toStrictEqual([syncedTask])
      }),
      Command.expectNone(),
    )
  })

  test('an empty or whitespace title never creates a task', () => {
    story(
      Sync.update,
      given(modifyFields(offline(), { draft: () => '   ' })),
      message(Sync.Message.SubmittedQuickAdd({ timeZone: 'Asia/Tehran' })),
      model(next => {
        expect(next.isCreatingTask).toBe(false)
      }),
      Command.expectNone(),
    )
  })
})

describe('sync scheduling', () => {
  test('going offline stops the loop from starting a pass', () => {
    story(
      Sync.update,
      given(syncModel()),
      message(Sync.Message.WentOffline()),
      message(Sync.Message.TickedSyncSchedule()),
      model(next => {
        expect(next.isOnline).toBe(false)
        expect(next.isSyncing).toBe(false)
      }),
      Command.expectNone(),
    )
  })

  test('a wake that landed during a pass becomes exactly one trailing pass', () => {
    story(
      Sync.update,
      given(
        modifyFields(syncModel(), {
          isSyncing: () => true,
          wakePending: () => true,
        }),
      ),
      message(Sync.Message.SucceededSyncPass(emptySnapshot)),
      model(next => {
        expect(next.isSyncing).toBe(true)
        expect(next.wakePending).toBe(false)
      }),
      Command.expectExact(
        Sync.RunSyncPass({ pendingBefore: 0, failedRefreshedAt: 0 }),
      ),
      Command.resolve(
        Sync.RunSyncPass,
        Sync.Message.SucceededSyncPass(emptySnapshot),
      ),
      Command.expectNone(),
    )
  })

  test('a focus or visibility return wakes an immediate pass', () => {
    story(
      Sync.update,
      given(syncModel()),
      message(Sync.Message.FocusedApp()),
      Command.expectExact(
        Sync.RunSyncPass({ pendingBefore: 0, failedRefreshedAt: 0 }),
      ),
      Command.resolve(
        Sync.RunSyncPass,
        Sync.Message.SucceededSyncPass(emptySnapshot),
      ),
      message(Sync.Message.ChangedVisibility({ isVisible: true })),
      Command.expectExact(
        Sync.RunSyncPass({ pendingBefore: 0, failedRefreshedAt: 0 }),
      ),
      Command.resolve(
        Sync.RunSyncPass,
        Sync.Message.SucceededSyncPass(emptySnapshot),
      ),
    )
  })

  test('failures back off and a 401 halts the loop until a new store', () => {
    story(
      Sync.update,
      given(syncModel()),
      message(Sync.Message.TickedSyncSchedule()),
      Command.resolve(
        Sync.RunSyncPass,
        Sync.Message.FailedSyncPass({
          message: 'network',
          maybeCode: Option.none(),
        }),
      ),
      model(next => {
        expect(next.failures).toBe(1)
        expect(next.isSyncing).toBe(false)
        expect(next.maybeError).toStrictEqual(Option.some('network'))
        expect(next.isHalted).toBe(false)
      }),
      message(Sync.Message.TickedSyncSchedule()),
      Command.expectExact(
        Sync.RunSyncPass({ pendingBefore: 0, failedRefreshedAt: 0 }),
      ),
      Command.resolve(
        Sync.RunSyncPass,
        Sync.Message.FailedSyncPass({
          message: 'Unauthorized',
          maybeCode: Option.some('Unauthorized'),
        }),
      ),
      model(next => {
        expect(next.failures).toBe(2)
        expect(next.isHalted).toBe(true)
      }),
      message(Sync.Message.WentOnline()),
      message(Sync.Message.FocusedApp()),
      Command.expectNone(),
    )
  })

  test('a signed-in account without a household never polls the sync API', () => {
    story(
      Sync.update,
      given(modifyFields(syncModel(), { hasHousehold: () => false })),
      message(Sync.Message.WentOnline()),
      message(Sync.Message.FocusedApp()),
      message(Sync.Message.TickedSyncSchedule()),
      model(next => {
        expect(next.isSyncing).toBe(false)
      }),
      Command.expectNone(),
    )
  })

  test('a failed pass never reads the failure count through the stale gate', () => {
    story(
      Sync.update,
      given(
        modifyFields(syncModel(), {
          pending: () => 2,
          failed: () => 1,
          failedRefreshedAt: () => 100,
        }),
      ),
      message(Sync.Message.TickedSyncSchedule()),
      Command.resolve(
        Sync.RunSyncPass,
        Sync.Message.FailedSyncPass({
          message: 'network',
          maybeCode: Option.none(),
        }),
      ),
      model(next => {
        expect(next.failed).toBe(1)
        expect(next.failedRefreshedAt).toBe(100)
      }),
    )
  })
})
