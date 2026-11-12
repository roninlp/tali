import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import { RpcClient, RpcGroup } from 'effect/rpc'
import * as RpcTest from 'effect/rpc/RpcTest'
import { ApiRpcs } from '@tali/rpc'
import { uuidV7 } from '@tali/domain'
import { AuthServiceLive } from '../src/auth-service.js'
import { NoteServiceLive } from '../src/note-service.js'
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
 * Ticket #40 at the RPC seam: the derived client talks to the real handler
 * map over the in-memory RPC transport with the session cookie in the request
 * headers — the same path the browser takes.
 */

const NOW = new Date().toISOString()
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()

const TOKEN_A = 'token-for-user-a'
const TOKEN_B = 'token-for-user-b'
const USER_A = uuidV7()
const USER_B = uuidV7()
const HOUSEHOLD = uuidV7()

const doc = (text: string): unknown => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

const serviceLayer = ({ d1 }: HarnessEnv) =>
  Layer.mergeAll(
    RpcHandlers,
    NoteServiceLive,
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

describe('Note RPC round-trip', () => {
  it('quick create → save → pin → archive → trash → restore', async () => {
    const h = await makeHarness()
    const id = uuidV7()

    const result = await h.withClient(TOKEN_A, client =>
      Effect.gen(function* () {
        const created = yield* client.CreateNote({
          id,
          clientMutationId: 'n-create',
        })
        const saved = yield* client.SaveNote({
          id: created.id,
          clientMutationId: 'n-save',
          baseVersion: created.version,
          body: doc('یادداشت تازه'),
        })
        const repeated = yield* client.SaveNote({
          id: created.id,
          clientMutationId: 'n-save-2',
          baseVersion: saved.version,
          body: doc('یادداشت تازه'),
        })
        const conflict = yield* client
          .SaveNote({
            id: created.id,
            clientMutationId: 'n-stale',
            baseVersion: 1,
            body: doc('متن قدیمی'),
          })
          .pipe(Effect.flip)
        const pinned = yield* client.SetNotePinned({
          id: created.id,
          clientMutationId: 'n-pin',
          value: true,
        })
        const dashboard = yield* client.ListPinnedNotes()
        const archived = yield* client.SetNoteArchived({
          id: created.id,
          clientMutationId: 'n-archive',
          value: true,
        })
        const active = yield* client.ListNotes({})
        const archivedList = yield* client.ListNotes({ includeArchived: true })
        const trashed = yield* client.TrashNote({
          id: created.id,
          clientMutationId: 'n-trash',
        })
        const trash = yield* client.ListTrashNotes()
        const restored = yield* client.RestoreNote({
          id: created.id,
          clientMutationId: 'n-restore',
        })
        return {
          created,
          saved,
          repeated,
          conflict,
          pinned,
          dashboard,
          archived,
          active,
          archivedList,
          trashed,
          trash,
          restored,
        }
      }),
    )

    expect(result.created).toMatchObject({ title: '', body: null, version: 1 })
    expect(result.saved).toMatchObject({
      plainText: 'یادداشت تازه',
      version: 2,
    })
    // Identical autosave is a no-op, not a duplicate version.
    expect(result.repeated.version).toBe(2)
    expect(result.conflict).toMatchObject({ _tag: 'NoteConflict', version: 2 })
    expect(result.pinned).toMatchObject({ isPinned: true, version: 3 })
    expect(result.dashboard.map(note => note.id)).toEqual([id])
    expect(result.archived).toMatchObject({ isArchived: true, version: 4 })
    expect(result.active).toEqual([])
    expect(result.archivedList.map(note => note.id)).toEqual([id])
    expect(result.trashed.deletedAt).not.toBeNull()
    expect(result.trash.map(note => note.id)).toEqual([id])
    expect(result.restored.deletedAt).toBeNull()
  })

  it("keeps another member's private note out of reads and requires a session", async () => {
    const h = await makeHarness()
    const sharedId = uuidV7()
    const privateId = uuidV7()

    await h.withClient(TOKEN_A, client =>
      Effect.gen(function* () {
        yield* client.CreateNote({
          id: sharedId,
          clientMutationId: 'p-shared',
          title: 'مشترک',
          body: doc('مشترک'),
          visibility: 'shared',
        })
        yield* client.CreateNote({
          id: privateId,
          clientMutationId: 'p-private',
          title: 'خصوصی',
          visibility: 'private',
        })
      }),
    )

    const forB = await h.withClient(TOKEN_B, client =>
      Effect.gen(function* () {
        const listed = yield* client.ListNotes({})
        const pinned = yield* client.ListPinnedNotes()
        const failed = yield* client
          .GetNote({ id: privateId })
          .pipe(Effect.flip)
        return { listed, pinned, failed }
      }),
    )
    expect(forB.listed.map(note => note.id)).toEqual([sharedId])
    expect(forB.pinned).toEqual([])
    expect(forB.failed._tag).toBe('NoteForbidden')

    const missingSession = await h.withClient('not-a-session', client =>
      client.ListNotes({}).pipe(Effect.flip),
    )
    expect(missingSession._tag).toBe('Unauthorized')
  })

  it('replays the same mutation id without a second version', async () => {
    const h = await makeHarness()
    const id = uuidV7()
    const input = { id, clientMutationId: 'rpc-replay', title: 'یک‌بار' }

    const { first, replay } = await h.withClient(TOKEN_A, client =>
      Effect.gen(function* () {
        const first = yield* client.CreateNote(input)
        const replay = yield* client.CreateNote(input)
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
