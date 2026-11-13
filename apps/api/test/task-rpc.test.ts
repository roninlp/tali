import { describe, expect, it } from 'vite-plus/test'
import { Effect, Layer } from 'effect'
import { RpcClient, RpcGroup } from 'effect/rpc'
import * as RpcTest from 'effect/rpc/RpcTest'
import { ApiRpcs } from '@tali/rpc'
import { type TaskId, uuidV7 } from '@tali/domain'
import { AuthServiceLive } from '../src/auth-service.js'
import { PreferencesServiceLive } from '../src/preferences-service.js'
import { RpcHandlers } from '../src/rpc-handlers.js'
import { TaskServiceLive } from '../src/task-service.js'
import {
  seedHousehold,
  seedMembership,
  seedSession,
  seedUser,
} from './fixtures/seed.js'
import { makeHarnessCore, type HarnessEnv } from './harness.js'

/**
 * Ticket #36 exit criterion at the RPC seam: the derived client talks to the
 * real handler map over the in-memory RPC transport, with the session cookie
 * carried in the request headers — the same path the browser takes.
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
    TaskServiceLive,
    AuthServiceLive,
    PreferencesServiceLive,
  ).pipe(Layer.provide(d1))

const makeHarness = async () => {
  const harness = makeHarnessCore(serviceLayer)
  const { db } = harness

  seedUser(db, {
    id: USER_A,
    email: 'a@example.com',
    timeZone: 'Asia/Tehran',
    now: NOW,
  })
  seedUser(db, {
    id: USER_B,
    email: 'b@example.com',
    timeZone: 'Europe/Berlin',
    now: NOW,
  })
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

describe('Task RPC round-trip', () => {
  it('create → filter → move → complete → undo over the derived client', async () => {
    const h = await makeHarness()
    const id = uuidV7() as TaskId

    const result = await h.withClient(TOKEN_A, client =>
      Effect.gen(function* () {
        const created = yield* client.CreateTask({
          id,
          clientMutationId: 'rpc-create',
          title: 'خرید نان',
        })
        const project = yield* client.CreateProject({
          clientMutationId: 'rpc-project',
          title: 'خانه',
        })
        const tag = yield* client.CreateTag({
          clientMutationId: 'rpc-tag',
          name: 'فوری',
        })
        const updated = yield* client.UpdateTask({
          id: created.id,
          clientMutationId: 'rpc-update',
          patch: { projectId: project.id, tagIds: [tag.id], priority: 'high' },
        })
        const listed = yield* client.ListTasks({
          filter: { projectId: project.id, tagIds: [tag.id] },
        })
        const moved = yield* client.MoveTask({
          id: created.id,
          clientMutationId: 'rpc-move',
          dueDate: '2026-10-21',
        })
        const completed = yield* client.CompleteTask({
          id: created.id,
          clientMutationId: 'rpc-complete',
        })
        const undone = yield* client.UndoTask({
          id: created.id,
          clientMutationId: 'rpc-undo',
        })
        const buckets = yield* client.GetTaskBuckets()
        return { created, updated, listed, moved, completed, undone, buckets }
      }),
    )

    expect(result.created.title).toBe('خرید نان')
    expect(result.created.status).toBe('todo')
    expect(result.created.timeZone).toBe('Asia/Tehran')
    expect(result.updated).toMatchObject({
      projectId: result.updated.projectId,
      priority: 'high',
      version: 2,
    })
    expect(result.listed.map(task => task.id)).toEqual([id])
    expect(result.moved).toMatchObject({ dueDate: '2026-10-21', dueAt: null })
    expect(result.completed.status).toBe('done')
    expect(result.completed.completedAt).toEqual(expect.any(String))
    expect(result.undone.status).toBe('todo')
    expect(result.undone.completedAt).toBeNull()
    expect(result.undone.dueDate).toBe('2026-10-21')
    expect(result.buckets.timeZone).toBe('Asia/Tehran')
  })

  it("keeps another member's private task out of reads and writes", async () => {
    const h = await makeHarness()
    const id = uuidV7() as TaskId

    await h.withClient(TOKEN_A, client =>
      client.CreateTask({
        id,
        clientMutationId: 'rpc-private',
        title: 'خصوصی',
        visibility: 'private',
      }),
    )

    const forB = await h.withClient(TOKEN_B, client =>
      Effect.gen(function* () {
        const listed = yield* client.ListTasks({})
        const failed = yield* client.GetTask({ id }).pipe(Effect.flip)
        return { listed, failed }
      }),
    )
    expect(forB.listed.map(task => task.id)).not.toContain(id)
    expect(forB.failed._tag).toBe('TaskForbidden')

    const missingSession = await h.withClient('not-a-session', client =>
      client.ListTasks({}).pipe(Effect.flip),
    )
    expect(missingSession._tag).toBe('Unauthorized')
  })

  it('replays the same mutation id without a second write', async () => {
    const h = await makeHarness()
    const id = uuidV7() as TaskId
    const input = { id, clientMutationId: 'rpc-replay', title: 'یک‌بار' }

    const { first, replay } = await h.withClient(TOKEN_A, client =>
      Effect.gen(function* () {
        const first = yield* client.CreateTask(input)
        const replay = yield* client.CreateTask(input)
        return { first, replay }
      }),
    )
    expect(replay.id).toBe(first.id)
    expect(replay.version).toBe(first.version)
    expect(
      (
        h.db.prepare('SELECT COUNT(*) AS n FROM change_feed').get() as {
          readonly n: number
        }
      ).n,
    ).toBe(1)
  })
})
