import { describe, expect, it } from 'vite-plus/test'
import { Effect, Layer } from 'effect'
import {
  Note,
  Reminder,
  Task,
  onceReminderRepeat,
  uuidV7,
  type HouseholdId,
  type NoteId,
  type ReminderId,
  type TaskId,
  type UserId,
} from '@tali/domain'
import {
  NoteRepo,
  NoteRepoLive,
  ReminderRepo,
  ReminderRepoLive,
  TaskRepo,
  TaskRepoLive,
} from '@tali/sql'
import { makeHarnessCore, type HarnessEnv } from './harness.js'

/**
 * The ADR-0011 read scope is one SQL definition (`visibleScopeSql`), and this
 * runs it against real SQLite through the repos that consume it.
 *
 * Three outcomes are pinned for every scoped read: a `shared` row is visible to
 * both members, a `private` row only to its owner, and a tombstone is absent by
 * default. The trash views are the exception — `trash: 'only'` is the note trash
 * list, and `includeDeleted` is the reminder list's undo path, which used to be
 * the ad-hoc `deleted_at IS NULL` branch at its call site.
 */

const NOW = '2026-10-20T09:30:00.000Z'
const TRASHED_AT = '2026-10-21T09:30:00.000Z'
const HOUSEHOLD = 'household-1' as HouseholdId
const USER_A = 'user-a' as UserId
const USER_B = 'user-b' as UserId

const serviceLayer = ({ d1 }: HarnessEnv) =>
  Layer.mergeAll(TaskRepoLive, ReminderRepoLive, NoteRepoLive).pipe(
    Layer.provide(d1),
  )

const makeHarness = () => makeHarnessCore(serviceLayer)

type Harness = ReturnType<typeof makeHarness>

const common = {
  householdId: HOUSEHOLD,
  color: null,
  createdAt: NOW,
  updatedAt: NOW,
  version: 1,
}

const task = (input: {
  readonly ownerId: UserId
  readonly visibility: 'private' | 'shared'
  readonly deletedAt?: string | null
}) =>
  new Task({
    ...common,
    id: uuidV7() as TaskId,
    type: 'task',
    title: 'task',
    description: null,
    ownerId: input.ownerId,
    visibility: input.visibility,
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    dueDate: '2026-10-20',
    timeZone: 'UTC',
    projectId: null,
    tagIds: [],
    recurrence: null,
    recurrenceMode: null,
    startedAt: null,
    completedAt: null,
    deletedAt: input.deletedAt ?? null,
  })

const reminder = (input: {
  readonly ownerId: UserId
  readonly visibility: 'private' | 'shared'
  readonly deletedAt?: string | null
}) =>
  new Reminder({
    ...common,
    type: 'reminder',
    id: uuidV7() as ReminderId,
    title: 'reminder',
    note: null,
    ownerId: input.ownerId,
    visibility: input.visibility,
    kind: 'general',
    tier: 'normal',
    repeat: onceReminderRepeat(),
    fireAt: NOW,
    offsetMinutes: 0,
    link: { _tag: 'none' },
    silencedUntil: null,
    timeZone: 'UTC',
    deletedAt: input.deletedAt ?? null,
  })

const note = (input: {
  readonly ownerId: UserId
  readonly visibility: 'private' | 'shared'
  readonly deletedAt?: string | null
}) =>
  new Note({
    ...common,
    type: 'note',
    id: uuidV7() as NoteId,
    title: 'note',
    body: null,
    plainText: '',
    ownerId: input.ownerId,
    visibility: input.visibility,
    isPinned: false,
    isArchived: false,
    tagIds: [],
    deletedAt: input.deletedAt ?? null,
  })

const ids = (rows: ReadonlyArray<{ readonly id: string }>): Array<string> =>
  rows.map(row => row.id).sort()

const tasksOf = (harness: Harness, userId: UserId) =>
  harness.run(
    Effect.gen(function* () {
      const repo = yield* TaskRepo
      return yield* repo.listVisible({ householdId: HOUSEHOLD, userId })
    }),
  )

const remindersOf = (
  harness: Harness,
  userId: UserId,
  includeDeleted?: boolean,
) =>
  harness.run(
    Effect.gen(function* () {
      const repo = yield* ReminderRepo
      return yield* repo.listVisible({
        householdId: HOUSEHOLD,
        userId,
        includeDeleted,
      })
    }),
  )

describe('repository read scope (ADR-0011)', () => {
  it('shows a shared task to both members and a private task only to its owner', async () => {
    const h = makeHarness()
    const shared = task({ ownerId: USER_A, visibility: 'shared' })
    const ownPrivate = task({ ownerId: USER_A, visibility: 'private' })
    const spousePrivate = task({ ownerId: USER_B, visibility: 'private' })

    await h.run(
      Effect.gen(function* () {
        const repo = yield* TaskRepo
        for (const row of [shared, ownPrivate, spousePrivate]) {
          yield* repo.insert(row)
        }
      }),
    )

    expect(ids(await tasksOf(h, USER_A))).toEqual(
      [shared.id, ownPrivate.id].sort(),
    )
    expect(ids(await tasksOf(h, USER_B))).toEqual(
      [shared.id, spousePrivate.id].sort(),
    )
  })

  it('hides a tombstoned task from the live list', async () => {
    const h = makeHarness()
    const live = task({ ownerId: USER_A, visibility: 'shared' })
    const trashed = task({
      ownerId: USER_A,
      visibility: 'shared',
      deletedAt: TRASHED_AT,
    })

    await h.run(
      Effect.gen(function* () {
        const repo = yield* TaskRepo
        yield* repo.insert(live)
        yield* repo.insert(trashed)
      }),
    )

    expect(ids(await tasksOf(h, USER_B))).toEqual([live.id])
  })

  it('shows a shared reminder to both members and a private one only to its owner', async () => {
    const h = makeHarness()
    const shared = reminder({ ownerId: USER_A, visibility: 'shared' })
    const ownPrivate = reminder({ ownerId: USER_A, visibility: 'private' })
    const spousePrivate = reminder({ ownerId: USER_B, visibility: 'private' })

    await h.run(
      Effect.gen(function* () {
        const repo = yield* ReminderRepo
        for (const row of [shared, ownPrivate, spousePrivate]) {
          yield* repo.insert(row)
        }
      }),
    )

    expect(ids(await remindersOf(h, USER_A))).toEqual(
      [shared.id, ownPrivate.id].sort(),
    )
    expect(ids(await remindersOf(h, USER_B))).toEqual(
      [shared.id, spousePrivate.id].sort(),
    )
  })

  it('hides a tombstoned reminder by default but keeps it for includeDeleted', async () => {
    const h = makeHarness()
    const live = reminder({ ownerId: USER_A, visibility: 'shared' })
    const spouseTrashed = reminder({
      ownerId: USER_B,
      visibility: 'shared',
      deletedAt: TRASHED_AT,
    })

    await h.run(
      Effect.gen(function* () {
        const repo = yield* ReminderRepo
        yield* repo.insert(live)
        yield* repo.insert(spouseTrashed)
      }),
    )

    expect(ids(await remindersOf(h, USER_A))).toEqual([live.id])
    expect(ids(await remindersOf(h, USER_A, true))).toEqual(
      [live.id, spouseTrashed.id].sort(),
    )
    // `includeDeleted` widens trash only; a spouse's private row stays hidden.
    const privateTrashed = reminder({
      ownerId: USER_B,
      visibility: 'private',
      deletedAt: TRASHED_AT,
    })
    await h.run(
      Effect.gen(function* () {
        const repo = yield* ReminderRepo
        yield* repo.insert(privateTrashed)
      }),
    )
    expect(ids(await remindersOf(h, USER_A, true))).toEqual(
      [live.id, spouseTrashed.id].sort(),
    )
  })

  it('lists a trashed note in the trash view of members who may see it', async () => {
    const h = makeHarness()
    const live = note({ ownerId: USER_A, visibility: 'shared' })
    const sharedTrashed = note({
      ownerId: USER_A,
      visibility: 'shared',
      deletedAt: TRASHED_AT,
    })
    const privateTrashed = note({
      ownerId: USER_A,
      visibility: 'private',
      deletedAt: TRASHED_AT,
    })

    await h.run(
      Effect.gen(function* () {
        const repo = yield* NoteRepo
        for (const row of [live, sharedTrashed, privateTrashed]) {
          yield* repo.insert(row)
        }
      }),
    )

    const trashOf = (userId: UserId) =>
      h.run(
        Effect.gen(function* () {
          const repo = yield* NoteRepo
          return yield* repo.listTrashed({ householdId: HOUSEHOLD, userId })
        }),
      )

    expect(ids(await trashOf(USER_A))).toEqual(
      [sharedTrashed.id, privateTrashed.id].sort(),
    )
    expect(ids(await trashOf(USER_B))).toEqual([sharedTrashed.id])
  })
})
