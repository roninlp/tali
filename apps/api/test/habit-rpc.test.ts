import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import { RpcClient, RpcGroup } from 'effect/rpc'
import * as RpcTest from 'effect/rpc/RpcTest'
import { ApiRpcs } from '@tali/rpc'
import { type HabitId, habitLogWindow, localDateIn, uuidV7 } from '@tali/domain'
import { AuthServiceLive } from '../src/auth-service.js'
import { HabitServiceLive } from '../src/habit-service.js'
import { PreferencesServiceLive } from '../src/preferences-service.js'
import { RpcHandlers } from '../src/rpc-handlers.js'
import {
  seedHousehold,
  seedMembership,
  seedSession,
  seedUser,
} from './fixtures/seed.js'
import { makeHarnessCore, type HarnessEnv } from './harness.js'

/**
 * Ticket #63 at the RPC seam: the derived client drives the habit aggregate
 * over the real handler map, with the session cookie in the request headers —
 * the path the browser takes. The create/edit/delete/restore round-trip is the
 * shape the habits screen (#66) will call.
 */

const NOW = new Date().toISOString()
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()

const TOKEN_A = 'habit-token-a'
const TOKEN_C = 'habit-token-c'
const USER_A = uuidV7()
const USER_C = uuidV7()
const HOUSEHOLD = uuidV7()

const serviceLayer = ({ d1 }: HarnessEnv) =>
  Layer.mergeAll(
    RpcHandlers,
    HabitServiceLive,
    AuthServiceLive,
    PreferencesServiceLive,
  ).pipe(Layer.provide(d1))

const makeHarness = async () => {
  const harness = makeHarnessCore(serviceLayer)
  const { db } = harness

  seedUser(db, { id: USER_A, email: 'habit-a@example.com', now: NOW })
  seedUser(db, { id: USER_C, email: 'habit-c@example.com', now: NOW })
  seedHousehold(db, {
    id: HOUSEHOLD,
    creator: USER_A,
    inviteCode: 'habit-invite',
    name: 'خانه',
    now: NOW,
  })
  seedMembership(db, USER_A, HOUSEHOLD, { role: 'owner', now: NOW })
  seedSession(db, USER_A, TOKEN_A, { now: NOW, expiresAt: FUTURE })
  seedSession(db, USER_C, TOKEN_C, { now: NOW, expiresAt: FUTURE })

  const { run } = harness

  type TestClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ApiRpcs>>

  const withClient = <A, E>(
    token: string,
    f: (client: TestClient) => Effect.Effect<A, E>,
  ): Promise<A> =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(ApiRpcs)
          return yield* RpcClient.withHeaders({
            cookie: `tali_session=${token}`,
          })(f(client))
        }),
      ),
    )

  return { db, withClient }
}

describe('Habit RPC round-trip', () => {
  it('creates, edits, deletes and restores a habit over the derived client', async () => {
    const h = await makeHarness()
    const id = uuidV7() as HabitId

    const result = await h.withClient(TOKEN_A, client =>
      Effect.gen(function* () {
        const created = yield* client.CreateHabit({
          id,
          clientMutationId: 'rpc-habit-create',
          title: 'پیاده‌روی صبح',
          description: 'بیست دقیقه',
          icon: '🚶',
          color: '#2f9e44',
          frequency: { _tag: 'weekdays', days: [1, 3, 5] },
          reminderTime: '07:30',
        })
        const listed = yield* client.ListHabits()
        const edited = yield* client.UpdateHabit({
          id,
          clientMutationId: 'rpc-habit-edit',
          patch: {
            frequency: { _tag: 'weekly', times: 3 },
            reminderTime: null,
          },
        })
        const fetched = yield* client.GetHabit({ id })
        const deleted = yield* client.DeleteHabit({
          id,
          clientMutationId: 'rpc-habit-delete',
        })
        const afterDelete = yield* client.ListHabits()
        const restored = yield* client.RestoreHabit({
          id,
          clientMutationId: 'rpc-habit-restore',
        })
        const afterRestore = yield* client.ListHabits()
        return {
          created,
          listed,
          edited,
          fetched,
          deleted,
          afterDelete,
          restored,
          afterRestore,
        }
      }),
    )

    expect(result.created).toMatchObject({
      id,
      title: 'پیاده‌روی صبح',
      frequency: { _tag: 'weekdays', days: [1, 3, 5] },
      reminderTime: '07:30',
      timeZone: 'Asia/Tehran',
      visibility: 'private',
      version: 1,
    })
    expect(result.listed.map(habit => habit.id)).toEqual([id])
    expect(result.edited).toMatchObject({
      frequency: { _tag: 'weekly', times: 3 },
      reminderTime: null,
      version: 2,
    })
    // The history keeps the original rhythm (#65's stats read it), even though
    // both edits may land on the same local day in a fast test run.
    expect(result.edited.frequencyHistory.length).toBeGreaterThanOrEqual(1)
    expect(result.edited.frequencyHistory.at(-1)?.frequency).toEqual({
      _tag: 'weekly',
      times: 3,
    })
    expect(result.fetched.version).toBe(2)
    expect(result.deleted.deletedAt).not.toBeNull()
    expect(result.afterDelete).toEqual([])
    expect(result.restored).toMatchObject({ id, deletedAt: null, version: 4 })
    expect(result.afterRestore.map(habit => habit.id)).toEqual([id])
  })

  it('validates the frequency union at the RPC edge', async () => {
    const h = await makeHarness()

    const failure = await h
      .withClient(TOKEN_A, client =>
        client.CreateHabit({
          clientMutationId: 'rpc-habit-bad',
          title: 'بی‌ریتم',
          frequency: { _tag: 'weekdays', days: [] },
        }),
      )
      .catch((cause: unknown) => cause)

    // The payload never reaches the handler: the contract rejects it, so no
    // habit row exists and the failure is a transport/schema error, not a Habit.
    expect(failure).not.toBeNull()
    expect(failure).not.toHaveProperty('id')
    expect(failure).not.toHaveProperty('frequency')
    const count = h.db.prepare('SELECT COUNT(*) AS n FROM habits').get() as {
      readonly n: number
    }
    expect(count.n).toBe(0)
  })

  it('logs a day, cycles the status in place, and reads the range (#64)', async () => {
    const h = await makeHarness()
    const habitId = uuidV7() as HabitId

    const today = localDateIn(new Date().toISOString(), 'Asia/Tehran')
    const window = habitLogWindow(today)
    const shift = (date: string, days: number): string => {
      const instant = new Date(`${date}T00:00:00.000Z`)
      instant.setUTCDate(instant.getUTCDate() + days)
      return instant.toISOString().slice(0, 10)
    }
    const tooOld = shift(window.earliest, -1)
    const nextDay = shift(today, 1)

    const result = await h.withClient(TOKEN_A, client =>
      Effect.gen(function* () {
        yield* client.CreateHabit({
          id: habitId,
          clientMutationId: 'rpc-entry-habit',
          title: 'کتاب',
          frequency: { _tag: 'daily' },
        })
        const first = yield* client.LogHabitEntry({
          clientMutationId: 'rpc-entry-1',
          habitId,
          localDate: today,
          status: 'done',
        })
        const second = yield* client.LogHabitEntry({
          clientMutationId: 'rpc-entry-2',
          habitId,
          localDate: today,
          status: 'partial',
        })
        const entries = yield* client.ListHabitEntries({
          from: today,
          before: nextDay,
        })
        return { first, second, entries }
      }),
    )

    expect(result.first).toMatchObject({
      localDate: today,
      status: 'done',
      version: 1,
    })
    expect(result.second).toMatchObject({
      id: result.first.id,
      status: 'partial',
      version: 2,
    })
    expect(result.entries.map(entry => [entry.id, entry.status])).toEqual([
      [result.first.id, 'partial'],
    ])
    const count = h.db
      .prepare('SELECT COUNT(*) AS n FROM habit_entries WHERE habit_id = ?')
      .get(habitId) as { readonly n: number }
    expect(count.n).toBe(1)

    const failure = await h
      .withClient(TOKEN_A, client =>
        client.LogHabitEntry({
          clientMutationId: 'rpc-entry-old',
          habitId,
          localDate: tooOld,
          status: 'done',
        }),
      )
      .catch((cause: unknown) => cause)

    expect(failure).toMatchObject({
      _tag: 'HabitEntryOutOfWindow',
      localDate: tooOld,
      earliest: window.earliest,
      latest: window.latest,
    })
  })

  it('maps a member without a household to HabitForbidden', async () => {
    const h = await makeHarness()

    const failure = await h
      .withClient(TOKEN_C, client =>
        client.CreateHabit({
          clientMutationId: 'rpc-habit-no-household',
          title: 'عادت',
          frequency: { _tag: 'daily' },
        }),
      )
      .catch((cause: unknown) => cause)

    expect(failure).toMatchObject({
      _tag: 'HabitForbidden',
      reason: 'noHousehold',
    })
  })
})
