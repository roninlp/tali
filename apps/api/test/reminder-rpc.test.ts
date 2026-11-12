import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import { RpcClient, RpcGroup } from 'effect/rpc'
import * as RpcTest from 'effect/rpc/RpcTest'
import { ApiRpcs } from '@tali/rpc'
import { uuidV7 } from '@tali/domain'
import { AuthServiceLive } from '../src/auth-service.js'
import { PreferencesServiceLive } from '../src/preferences-service.js'
import { ReminderServiceLive } from '../src/reminder-service.js'
import { RpcHandlers } from '../src/rpc-handlers.js'
import {
  seedHousehold,
  seedMembership,
  seedSession,
  seedUser,
} from './fixtures/seed.js'
import { makeHarnessCore, type HarnessEnv } from './harness.js'

/**
 * Ticket #60 at the RPC seam: the derived client drives the reminder aggregate
 * over the real handler map with the session cookie in the request headers —
 * the path the browser takes for reminder CRUD. The ledger's inbox/response
 * routes are plain HTTP and are covered through the service tests.
 */

const NOW = new Date().toISOString()
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()

const TOKEN_A = 'reminder-token-a'
const USER_A = uuidV7()
const HOUSEHOLD = uuidV7()

const serviceLayer = ({ d1 }: HarnessEnv) =>
  Layer.mergeAll(
    RpcHandlers,
    ReminderServiceLive,
    AuthServiceLive,
    PreferencesServiceLive,
  ).pipe(Layer.provide(d1))

const makeHarness = async () => {
  const harness = makeHarnessCore(serviceLayer)
  const { db } = harness

  seedUser(db, {
    id: USER_A,
    email: 'reminder@example.com',
    displayName: 'یادآور',
    now: NOW,
  })
  seedHousehold(db, {
    id: HOUSEHOLD,
    creator: USER_A,
    inviteCode: 'rem-rpc-invite',
    name: 'خانه',
    now: NOW,
  })
  seedMembership(db, USER_A, HOUSEHOLD, { role: 'owner', now: NOW })
  seedSession(db, USER_A, TOKEN_A, { now: NOW, expiresAt: FUTURE })

  const { run } = harness

  type TestClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ApiRpcs>>

  const withClient = <A, E>(
    token: string | undefined,
    f: (client: TestClient) => Effect.Effect<A, E>,
  ): Promise<A> =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(ApiRpcs)
          return yield* token === undefined
            ? f(client)
            : RpcClient.withHeaders({ cookie: `tali_session=${token}` })(
                f(client),
              )
        }),
      ),
    )

  return { db, withClient }
}

describe('Reminder RPC round-trip', () => {
  it('creates, lists, edits and deletes through the derived client', async () => {
    const h = await makeHarness()
    const id = uuidV7()

    const created = await h.withClient(TOKEN_A, client =>
      client.CreateReminder({
        id: id as never,
        clientMutationId: 'rpc-create',
        title: 'دارو',
        kind: 'medication',
        repeat: { _tag: 'interval', hours: 8 },
        fireAt: '2026-10-21T08:00:00.000Z',
      }),
    )
    expect(created).toMatchObject({
      id,
      title: 'دارو',
      kind: 'medication',
      tier: 'critical',
      version: 1,
    })

    const listed = await h.withClient(TOKEN_A, client =>
      client.ListReminders({}),
    )
    expect(listed.map(reminder => reminder.id)).toEqual([id])

    const updated = await h.withClient(TOKEN_A, client =>
      client.UpdateReminder({
        id: id as never,
        clientMutationId: 'rpc-rename',
        patch: { title: 'داروی فشار' },
      }),
    )
    expect(updated).toMatchObject({
      title: 'داروی فشار',
      fireAt: created.fireAt,
      version: 2,
    })

    const deleted = await h.withClient(TOKEN_A, client =>
      client.DeleteReminder({
        id: id as never,
        clientMutationId: 'rpc-delete',
      }),
    )
    expect(deleted.deletedAt).not.toBeNull()
    const after = await h.withClient(TOKEN_A, client =>
      client.ListReminders({}),
    )
    expect(after).toEqual([])
  })

  it('rejects an unauthenticated call with Unauthorized', async () => {
    const h = await makeHarness()
    await expect(
      h.withClient(undefined, client => client.ListReminders({})),
    ).rejects.toMatchObject({ _tag: 'Unauthorized' })
  })
})
