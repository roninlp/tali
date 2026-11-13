import { describe, expect, it } from 'vite-plus/test'
import { Effect, Layer } from 'effect'
import { RpcClient, RpcGroup } from 'effect/rpc'
import * as RpcTest from 'effect/rpc/RpcTest'
import { ApiRpcs } from '@tali/rpc'
import { type EventId, uuidV7 } from '@tali/domain'
import { AuthServiceLive } from '../src/auth-service.js'
import { EventServiceLive } from '../src/event-service.js'
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
 * Ticket #58 at the RPC seam: the derived client drives the event aggregate and
 * the occurrence edits over the real handler map, with the session cookie in the
 * request headers — the path the browser takes.
 */

const NOW = new Date().toISOString()
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()

const TOKEN_A = 'event-token-a'
const TOKEN_C = 'event-token-c'
const USER_A = uuidV7()
const USER_C = uuidV7()
const HOUSEHOLD = uuidV7()

const serviceLayer = ({ d1 }: HarnessEnv) =>
  Layer.mergeAll(
    RpcHandlers,
    EventServiceLive,
    AuthServiceLive,
    PreferencesServiceLive,
  ).pipe(Layer.provide(d1))

const makeHarness = async () => {
  const harness = makeHarnessCore(serviceLayer)
  const { db } = harness

  seedUser(db, { id: USER_A, email: 'event-a@example.com', now: NOW })
  seedUser(db, { id: USER_C, email: 'event-c@example.com', now: NOW })
  seedHousehold(db, {
    id: HOUSEHOLD,
    creator: USER_A,
    inviteCode: 'event-invite',
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

const timed = {
  _tag: 'timed' as const,
  start: '2026-10-21T06:30:00.000Z',
  end: '2026-10-21T07:30:00.000Z',
}

describe('Event RPC round-trip', () => {
  it('creates a series, moves one occurrence and splits the rest', async () => {
    const h = await makeHarness()
    const id = uuidV7() as EventId
    const followingId = uuidV7() as EventId

    const result = await h.withClient(TOKEN_A, client =>
      Effect.gen(function* () {
        const created = yield* client.CreateEvent({
          id,
          clientMutationId: 'rpc-event-create',
          title: 'جلسهٔ هفتگی',
          timing: timed,
          location: 'خانه',
          recurrence: {
            frequency: 'weekly',
            interval: 1,
            byDay: [3],
            end: { _tag: 'count', count: 10 },
          },
        })
        const week = yield* client.ListEventOccurrences({
          from: '2026-10-18',
          before: '2026-11-01',
        })
        const moved = yield* client.EditEventOccurrence({
          id,
          instanceId: '2026-10-21',
          clientMutationId: 'rpc-event-move',
          scope: 'thisOccurrence',
          overrides: { title: 'جلسهٔ کوتاه' },
        })
        const skipped = yield* client.DeleteEventOccurrence({
          id,
          instanceId: '2026-10-28',
          clientMutationId: 'rpc-event-skip',
          scope: 'thisOccurrence',
        })
        const split = yield* client.EditEventOccurrence({
          id,
          instanceId: '2026-11-04',
          clientMutationId: 'rpc-event-split',
          followingId,
          followingMutationId: 'rpc-event-split-tail',
          scope: 'thisAndFollowing',
          overrides: { title: 'جلسهٔ تازه', location: 'دفتر' },
        })
        const listed = yield* client.ListEvents({})
        const current = yield* client.GetEvent({ id: followingId })
        return { created, week, moved, skipped, split, listed, current }
      }),
    )

    expect(result.created.version).toBe(1)
    expect(result.week.map(occurrence => occurrence.instanceId)).toEqual([
      '2026-10-21',
      '2026-10-28',
    ])
    expect(result.moved.series.exceptions[0]).toMatchObject({
      instanceId: '2026-10-21',
      action: 'override',
      overrides: { title: 'جلسهٔ کوتاه' },
    })
    expect(
      result.skipped.series.exceptions.map(exception => exception.action),
    ).toEqual(['override', 'delete'])
    expect(result.split.series.recurrence?.end).toEqual({
      _tag: 'until',
      date: '2026-11-03',
    })
    expect(result.split.following).toMatchObject({
      id: followingId,
      title: 'جلسهٔ تازه',
      location: 'دفتر',
      version: 1,
    })
    expect(result.listed.map(event => event.id).sort()).toEqual(
      [id, followingId].sort(),
    )
    expect(result.current.id).toBe(followingId)
  })

  it('maps a member without a household to EventForbidden', async () => {
    const h = await makeHarness()

    const failure = await h
      .withClient(TOKEN_C, client =>
        client.CreateEvent({
          clientMutationId: 'rpc-event-no-household',
          title: 'قرار',
          timing: timed,
        }),
      )
      .catch((cause: unknown) => cause)

    expect(failure).toMatchObject({
      _tag: 'EventForbidden',
      reason: 'noHousehold',
    })
  })
})
