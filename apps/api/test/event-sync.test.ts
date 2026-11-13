import { describe, expect, it } from 'vite-plus/test'
import { Effect, Layer } from 'effect'
import { type SyncPullResponse, type SyncPushEntry, uuidV7 } from '@tali/domain'
import { SyncService, SyncServiceLive } from '../src/sync-service.js'
import { makeHarnessCore, type HarnessEnv } from './harness.js'

/**
 * Ticket #57 at the sync seam: an event has to travel through the real push
 * and pull path — the same path the web client's outbox uses — so the registry
 * entry, the wire shape and the household filter are exercised together.
 *
 * These run the real service + repository SQL against SQLite (D1's engine),
 * through a D1-shaped batch so atomicity and `changes()` gating behave like
 * production.
 */

const HOUSEHOLD = 'household-a'
const USER_A = 'user-a'
const USER_B = 'user-b'
const HOUSEHOLD_B = 'household-b'

const serviceLayer = ({ d1 }: HarnessEnv) =>
  SyncServiceLive.pipe(Layer.provide(d1))

const makeHarness = () => makeHarnessCore(serviceLayer)

type Harness = ReturnType<typeof makeHarness>

const pull = (
  harness: Harness,
  input: {
    readonly userId: string
    readonly householdId: string
    readonly cursor: number
  },
): Promise<SyncPullResponse> =>
  harness.run(
    Effect.gen(function* () {
      const sync = yield* SyncService
      return yield* sync.pull(input)
    }),
  )

const push = (
  harness: Harness,
  input: {
    readonly userId: string
    readonly householdId: string
    readonly entries: ReadonlyArray<SyncPushEntry>
  },
) =>
  harness.run(
    Effect.gen(function* () {
      const sync = yield* SyncService
      return yield* sync.push(input)
    }),
  )

const entry = (input: {
  readonly entityId: string
  readonly baseVersion: number
  readonly patch?: Record<string, unknown>
  readonly op?: 'upsert' | 'delete'
  readonly clientMutationId?: string
}): SyncPushEntry => ({
  clientMutationId: input.clientMutationId ?? uuidV7(),
  entityType: 'event',
  entityId: input.entityId,
  baseVersion: input.baseVersion,
  op: input.op ?? 'upsert',
  patch: input.patch ?? {},
  clientUpdatedAt: new Date().toISOString(),
})

const timed = {
  _tag: 'timed',
  start: '2026-10-21T10:00:00.000Z',
  end: '2026-10-21T11:00:00.000Z',
}

describe('event sync', () => {
  it('carries an event from /sync/push to /sync/pull', async () => {
    const h = makeHarness()
    const id = uuidV7()

    const pushed = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityId: id,
          baseVersion: 0,
          patch: {
            title: 'جلسهٔ هم‌اندیشی',
            timing: timed,
            timeZone: 'Asia/Tehran',
            location: 'خانه',
            category: 'work',
            people: ['سارا'],
            recurrence: {
              frequency: 'weekly',
              interval: 1,
              byDay: [6],
              end: { _tag: 'count', count: 4 },
            },
            exceptions: [
              {
                id: uuidV7(),
                instanceId: '2026-10-28',
                action: 'override',
                overrides: { title: 'جلسهٔ کوتاه' },
                createdAt: '2026-10-20T09:30:00.000Z',
              },
            ],
          },
        }),
      ],
    })

    expect(pushed.results[0]).toMatchObject({
      _tag: 'applied',
      entityType: 'event',
      entityId: id,
      version: 1,
    })

    const page = await pull(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      cursor: 0,
    })
    const item = page.items.find(row => row.entityId === id)
    expect(item).toBeDefined()
    expect(item!.version).toBe(1)
    expect(item!.data).toMatchObject({
      title: 'جلسهٔ هم‌اندیشی',
      timing: timed,
      timeZone: 'Asia/Tehran',
      location: 'خانه',
      category: 'work',
      people: ['سارا'],
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byDay: [6],
        end: { _tag: 'count', count: 4 },
      },
      ownerId: USER_A,
      householdId: HOUSEHOLD,
      visibility: 'shared',
    })
    expect(
      (item!.data.exceptions as ReadonlyArray<{ instanceId: string }>)[0]!
        .instanceId,
    ).toBe('2026-10-28')

    // The row behind the wire shape holds one timing shape only.
    const row = h.db
      .prepare(
        'SELECT start_at AS startAt, end_at AS endAt, all_day_date AS allDayDate FROM events WHERE id = ?',
      )
      .get(id) as {
      readonly startAt: string
      readonly endAt: string
      readonly allDayDate: string | null
    }
    expect(row.startAt).toBe('2026-10-21T10:00:00.000Z')
    expect(row.endAt).toBe('2026-10-21T11:00:00.000Z')
    expect(row.allDayDate).toBeNull()
  })

  it('applies an offline edit and a delete through the same path', async () => {
    const h = makeHarness()
    const id = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityId: id,
          baseVersion: 0,
          patch: { title: 'قرار', timing: timed },
        }),
      ],
    })

    const edited = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityId: id,
          baseVersion: 1,
          patch: {
            title: 'قرار تازه',
            timing: { _tag: 'allDay', date: '2026-10-22' },
          },
        }),
      ],
    })
    expect(edited.results[0]).toMatchObject({ _tag: 'applied', version: 2 })

    const deleted = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 2, op: 'delete' })],
    })
    expect(deleted.results[0]).toMatchObject({ _tag: 'applied', version: 3 })

    const page = await pull(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      cursor: 0,
    })
    const item = page.items.find(row => row.entityId === id)
    expect(item!.deletedAt).not.toBeNull()
    expect(item!.data).toMatchObject({ title: 'قرار تازه' })
  })

  it('keeps the newer server edit when a stale offline edit arrives', async () => {
    const h = makeHarness()
    const id = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityId: id,
          baseVersion: 0,
          patch: { title: 'قرار', timing: timed },
        }),
      ],
    })

    // The other device moves the event: a newer edit, already stored.
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityId: id,
          baseVersion: 1,
          patch: {
            timing: {
              _tag: 'timed',
              start: '2026-10-22T10:00:00.000Z',
              end: '2026-10-22T11:00:00.000Z',
            },
          },
        }),
      ],
    })
    const moved = h.db
      .prepare('SELECT start_at AS startAt FROM events WHERE id = ?')
      .get(id) as {
      readonly startAt: string
    }
    expect(moved.startAt).toBe('2026-10-22T10:00:00.000Z')

    // A stale offline edit (written before the move) arrives on top.
    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        {
          ...entry({
            entityId: id,
            baseVersion: 1,
            patch: {
              timing: {
                _tag: 'timed',
                start: '2026-10-23T10:00:00.000Z',
                end: '2026-10-23T11:00:00.000Z',
              },
            },
          }),
          clientUpdatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })

    // Field-level LWW: the stale edit lost, so the stored timing stands.
    const after = h.db
      .prepare('SELECT start_at AS startAt FROM events WHERE id = ?')
      .get(id) as {
      readonly startAt: string
    }
    expect(after.startAt).toBe('2026-10-22T10:00:00.000Z')
  })

  it('tombstones an event the server never saw without breaking the row shape', async () => {
    const h = makeHarness()
    const id = uuidV7()

    const deleted = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [entry({ entityId: id, baseVersion: 0, op: 'delete' })],
    })
    expect(deleted.results[0]).toMatchObject({ _tag: 'applied', entityId: id })

    // The tombstone row is a structurally valid event: the delete-only patch
    // carries no timing, so the row falls back to an all-day event.
    const row = h.db
      .prepare('SELECT * FROM events WHERE id = ?')
      .get(id) as Record<string, unknown>
    expect(row.deleted_at).not.toBeNull()
    expect(row.all_day_date).not.toBeNull()
    expect(row.start_at).toBeNull()

    const page = await pull(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      cursor: 0,
    })
    const item = page.items.find(candidate => candidate.entityId === id)
    expect(item!.deletedAt).not.toBeNull()
  })

  it('keeps a private event away from the other member of the household', async () => {
    const h = makeHarness()
    const id = uuidV7()

    await push(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityId: id,
          baseVersion: 0,
          patch: { title: 'قرار خصوصی', timing: timed, visibility: 'private' },
        }),
      ],
    })

    // The owner sees it.
    const own = await pull(h, {
      userId: USER_B,
      householdId: HOUSEHOLD,
      cursor: 0,
    })
    expect(own.items.map(row => row.entityId)).toContain(id)

    // The spouse does not: the row is reported as removed, never as data.
    const other = await pull(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      cursor: 0,
    })
    expect(other.items.map(row => row.entityId)).not.toContain(id)
    expect(other.removed).toEqual([{ entityType: 'event', entityId: id }])
    expect(JSON.stringify(other)).not.toContain('قرار خصوصی')
  })

  it('refuses to write a row of another household', async () => {
    const h = makeHarness()
    const id = uuidV7()

    await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD,
      entries: [
        entry({
          entityId: id,
          baseVersion: 0,
          patch: { title: 'قرار', timing: timed },
        }),
      ],
    })

    const foreign = await push(h, {
      userId: USER_A,
      householdId: HOUSEHOLD_B,
      entries: [
        entry({ entityId: id, baseVersion: 1, patch: { title: 'ربوده‌شده' } }),
      ],
    }).catch((cause: unknown) => cause)

    expect(foreign).toMatchObject({ _tag: 'SyncEntityForbidden' })
  })
})
