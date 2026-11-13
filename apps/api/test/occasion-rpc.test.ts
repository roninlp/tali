import { describe, expect, it } from 'vite-plus/test'
import { Effect, Layer } from 'effect'
import { RpcClient, RpcGroup } from 'effect/rpc'
import * as RpcTest from 'effect/rpc/RpcTest'
import { ApiRpcs } from '@tali/rpc'
import { type OccasionId, uuidV7 } from '@tali/domain'
import { AuthServiceLive } from '../src/auth-service.js'
import { OccasionServiceLive } from '../src/occasion-service.js'
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
 * Ticket #59 at the RPC seam: the derived client drives the occasion aggregate
 * over the real handler map, with the session cookie in the request headers —
 * the path the browser takes.
 */

const NOW = new Date().toISOString()
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()

const TOKEN_A = 'occasion-token-a'
const TOKEN_C = 'occasion-token-c'
const USER_A = uuidV7()
const USER_C = uuidV7()
const HOUSEHOLD = uuidV7()

const serviceLayer = ({ d1 }: HarnessEnv) =>
  Layer.mergeAll(
    RpcHandlers,
    OccasionServiceLive,
    AuthServiceLive,
    PreferencesServiceLive,
  ).pipe(Layer.provide(d1))

const makeHarness = async () => {
  const harness = makeHarnessCore(serviceLayer)
  const { db } = harness

  seedUser(db, { id: USER_A, email: 'occasion-a@example.com', now: NOW })
  seedUser(db, { id: USER_C, email: 'occasion-c@example.com', now: NOW })
  seedHousehold(db, {
    id: HOUSEHOLD,
    creator: USER_A,
    inviteCode: 'occasion-invite',
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

describe('Occasion RPC round-trip', () => {
  it('creates, projects, reminds and prepares through the shared contract', async () => {
    const h = await makeHarness()
    const id = uuidV7() as OccasionId

    const result = await h.withClient(TOKEN_A, client =>
      Effect.gen(function* () {
        const created = yield* client.CreateOccasion({
          id,
          clientMutationId: 'rpc-occasion-create',
          title: 'تولد مامان',
          originDate: '1990-04-01',
          advanceReminderDays: 7,
          color: '#f4b6c2',
        })
        const occurrences = yield* client.ListOccasionOccurrences({
          from: '2026-04-01',
          to: '2026-04-30',
        })
        const reminders = yield* client.ListOccasionReminders({
          from: '2026-03-20',
          to: '2026-03-31',
        })
        const detail = yield* client.GetOccasion({ id })
        const prepared = yield* client.PrepareOccasionTask({
          id,
          clientMutationId: 'rpc-occasion-prepare',
        })
        const listed = yield* client.ListOccasions()
        return { created, occurrences, reminders, detail, prepared, listed }
      }),
    )

    expect(result.created).toMatchObject({
      id,
      title: 'تولد مامان',
      originDate: '1990-04-01',
      yearly: true,
      advanceReminderDays: 7,
      color: '#f4b6c2',
      version: 1,
    })
    expect(result.occurrences).toHaveLength(1)
    expect(result.occurrences[0]?.jalali).toEqual({
      year: 1405,
      month: 1,
      day: 12,
    })
    expect(result.reminders[0]).toMatchObject({
      dueDate: '2026-03-25',
      fireAt: '2026-03-25T05:30:00Z',
      link: { _tag: 'occasion', occasionId: id },
    })
    expect(result.detail.next?.jalali).toEqual({
      year: 1406,
      month: 1,
      day: 12,
    })
    expect(result.prepared.created).toBe(true)
    expect(result.prepared.occasion.preparationTaskId).toBe(
      result.prepared.task.id,
    )
    const nextDate = result.detail.next!.date
    const dueDate = result.prepared.task.dueDate!
    expect(Date.parse(`${dueDate}T00:00:00Z`) + 7 * 86_400_000).toBe(
      Date.parse(`${nextDate}T00:00:00Z`),
    )
    expect(result.listed.map(occasion => occasion.id)).toEqual([id])
  })

  it('maps a member without a household to OccasionForbidden', async () => {
    const h = await makeHarness()

    const failure = await h
      .withClient(TOKEN_C, client =>
        client.CreateOccasion({
          clientMutationId: 'rpc-occasion-no-household',
          title: 'تولد',
          originDate: '1990-04-01',
        }),
      )
      .catch((cause: unknown) => cause)

    expect(failure).toMatchObject({
      _tag: 'OccasionForbidden',
      reason: 'noHousehold',
    })
  })
})
