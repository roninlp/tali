import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import { RpcClient, RpcGroup } from 'effect/rpc'
import * as RpcTest from 'effect/rpc/RpcTest'
import { ApiRpcs } from '@tali/rpc'
import { ListForbidden, uuidV7 } from '@tali/domain'
import { AuthServiceLive } from '../src/auth-service.js'
import { ListServiceLive } from '../src/list-service.js'
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
 * Ticket #39 at the RPC seam: the derived client talks to the real handler map
 * over the in-memory transport with the session cookie in the request headers.
 * The viewer is derived from the cookie; a payload can never choose a user or
 * household.
 */

const NOW = new Date().toISOString()
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()

const TOKEN_A = 'token-for-user-a'
const TOKEN_B = 'token-for-user-b'
const USER_A = uuidV7()
const USER_B = uuidV7()
const HOUSEHOLD = uuidV7()

const serviceLayer = ({ d1 }: HarnessEnv) =>
  Layer.mergeAll(
    RpcHandlers,
    ListServiceLive,
    AuthServiceLive,
    PreferencesServiceLive,
  ).pipe(Layer.provide(d1))

const makeHarness = async () => {
  const harness = makeHarnessCore(serviceLayer)
  const { db } = harness

  seedUser(db, { id: USER_A, email: 'a@example.com', now: NOW })
  seedUser(db, { id: USER_B, email: 'b@example.com', now: NOW })
  seedHousehold(db, {
    id: HOUSEHOLD,
    creator: USER_A,
    inviteCode: 'invite-code',
    name: 'خانه',
    now: NOW,
  })
  seedMembership(db, USER_A, HOUSEHOLD, { role: 'owner', now: NOW })
  seedMembership(db, USER_B, HOUSEHOLD, { role: 'member', now: NOW })
  seedSession(db, USER_A, TOKEN_A, { now: NOW, expiresAt: FUTURE })
  seedSession(db, USER_B, TOKEN_B, { now: NOW, expiresAt: FUTURE })

  const { run } = harness

  const as = <A, E>(
    token: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    RpcClient.withHeaders({ cookie: `tali_session=${token}` })(effect)

  type TestClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ApiRpcs>>

  const withClient = <A, E>(
    token: string,
    f: (client: TestClient) => Effect.Effect<A, E>,
  ): Promise<A> =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(ApiRpcs)
          return yield* as(token, f(client))
        }),
      ),
    )

  return { db, withClient }
}

describe('List RPC round-trip', () => {
  it('creates, lists, appends, checks, reorders and renames over the derived client', async () => {
    const h = await makeHarness()
    const listId = uuidV7()
    const itemIds = [uuidV7(), uuidV7(), uuidV7()]

    const created = await h.withClient(TOKEN_A, client =>
      client.CreateList({
        id: listId as never,
        clientMutationId: 'create-list',
        title: 'خرید',
        color: '#0f9d8f',
        icon: '🛒',
        checkedPlacement: 'bottom',
      }),
    )
    expect(created).toMatchObject({ id: listId, title: 'خرید', version: 1 })

    const lists = await h.withClient(TOKEN_B, client => client.ListLists())
    expect(lists.map(entry => entry.id)).toContain(listId)

    const appended = await h.withClient(TOKEN_A, client =>
      client.AppendListItems({
        listId: listId as never,
        clientMutationId: 'append',
        items: [
          { id: itemIds[0] as never, name: 'نان' },
          { id: itemIds[1] as never, name: 'شیر' },
          { id: itemIds[2] as never, name: 'پنیر' },
        ],
      }),
    )
    expect(appended.map(item => item.name)).toEqual(['نان', 'شیر', 'پنیر'])

    const checked = await h.withClient(TOKEN_B, client =>
      client.SetListItemChecked({
        id: itemIds[1] as never,
        clientMutationId: 'b-check',
        checked: true,
      }),
    )
    expect(checked.done).toBe(true)
    expect(checked.checkedAt).not.toBeNull()

    const reordered = await h.withClient(TOKEN_A, client =>
      client.ReorderListItems({
        listId: listId as never,
        clientMutationId: 'reorder',
        itemIds: [itemIds[2], itemIds[0], itemIds[1]] as never,
      }),
    )
    expect(reordered.map(item => item.id)).toEqual([
      itemIds[2],
      itemIds[0],
      itemIds[1],
    ])

    const renamed = await h.withClient(TOKEN_B, client =>
      client.UpdateList({
        id: listId as never,
        clientMutationId: 'rename',
        patch: { title: 'خرید هفتگی', sort: 'alpha' },
      }),
    )
    expect(renamed).toMatchObject({ title: 'خرید هفتگی', sort: 'alpha' })

    const items = await h.withClient(TOKEN_A, client =>
      client.ListListItems({ listId: listId as never }),
    )
    expect(items.map(item => item.name)).toEqual(['پنیر', 'نان', 'شیر'])
  })

  it("returns the list-specific forbidden tag for another member's private list", async () => {
    const h = await makeHarness()
    const privateId = uuidV7()
    await h.withClient(TOKEN_A, client =>
      client.CreateList({
        id: privateId as never,
        clientMutationId: 'private',
        title: 'خصوصی',
        visibility: 'private',
      }),
    )

    const failure = await h
      .withClient(TOKEN_B, client => client.GetList({ id: privateId as never }))
      .catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(ListForbidden)
    expect((failure as ListForbidden).reason).toBe('private')
  })

  it('rejects an unauthenticated call', async () => {
    const h = await makeHarness()
    const failure = await h
      .withClient('not-a-session', client => client.ListLists())
      .catch((cause: unknown) => cause)
    expect((failure as { _tag?: string })._tag).toBe('Unauthorized')
  })
})
