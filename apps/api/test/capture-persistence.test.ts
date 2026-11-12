import { describe, expect, it } from 'vitest'
import { Layer, Option } from 'effect'
import { type Capture, type CaptureId, type UserId, uuidV7 } from '@tali/domain'
import { CaptureRepo, CaptureRepoLive } from '@tali/sql'
import { makeServiceHarness, type HarnessEnv } from './harness.js'

/**
 * Capture persistence (ticket #101; ADR-0012 §6).
 *
 * The point of these tests is the *absence* of sync machinery: a capture
 * insert/update must not touch `change_feed`, `applied_mutations`, or any
 * aggregate version. Capture is a server-of-record log, not a synced row.
 */

const OWNER = 'user-a' as UserId
const OTHER = 'user-b' as UserId
const NOW = '2026-11-08T12:00:00.000Z'

const serviceLayer = ({ d1 }: HarnessEnv) =>
  CaptureRepoLive.pipe(Layer.provide(d1))

const makeHarness = () => {
  const harness = makeServiceHarness(serviceLayer, CaptureRepo)

  const count = (table: string): number =>
    (
      harness.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        readonly n: number
      }
    ).n

  return { ...harness, repo: harness.svc, count }
}

const captureOf = (overrides: Partial<Capture> = {}): Capture => ({
  id: uuidV7() as CaptureId,
  ownerId: OWNER,
  text: 'فردا ساعت ۵ دکتر',
  status: 'pending',
  drafts: [],
  createdIds: [],
  error: null,
  createdAt: NOW,
  committedAt: null,
  ...overrides,
})

describe('CaptureRepo', () => {
  it('stores and reads a capture without touching the sync machinery', async () => {
    const h = makeHarness()
    const capture = captureOf()

    const inserted = await h.repo(repo => repo.insert(capture, 'dedupe'))
    expect(inserted).toMatchObject({ id: capture.id, status: 'pending' })

    const found = await h.repo(repo => repo.findById(capture.id))
    expect(Option.isSome(found)).toBe(true)
    if (Option.isSome(found)) {
      expect(found.value.text).toBe(capture.text)
      expect(found.value.drafts).toEqual([])
    }

    // No feed row, no replay-ledger row, no aggregate version.
    expect(h.count('change_feed')).toBe(0)
    expect(h.count('applied_mutations')).toBe(0)
    expect(h.count('tasks')).toBe(0)
  })

  it("lists one owner's captures newest first", async () => {
    const h = makeHarness()
    await h.repo(repo =>
      repo.insert(captureOf({ createdAt: '2026-11-08T10:00:00.000Z' }), 'a'),
    )
    await h.repo(repo =>
      repo.insert(
        captureOf({ createdAt: '2026-11-08T11:00:00.000Z', text: 'دوم' }),
        'b',
      ),
    )
    await h.repo(repo =>
      repo.insert(captureOf({ ownerId: OTHER, text: 'دیگری' }), 'c'),
    )

    const rows = await h.repo(repo =>
      repo.listByOwner({ ownerId: OWNER, limit: 10 }),
    )
    expect(rows.map(row => row.text)).toEqual(['دوم', 'فردا ساعت ۵ دکتر'])
  })

  it('returns the recent identical capture and excludes a failed one', async () => {
    const h = makeHarness()
    const parsed = captureOf({ status: 'parsed' })
    await h.repo(repo => repo.insert(parsed, 'same'))

    const recent = await h.repo(repo =>
      repo.findRecentByDedupe({
        ownerId: OWNER,
        dedupeKey: 'same',
        since: '2026-11-08T11:59:00.000Z',
      }),
    )
    expect(Option.map(recent, row => row.id)).toEqual(Option.some(parsed.id))

    const failed = captureOf({
      status: 'failed',
      text: 'متن دیگر',
      createdAt: '2026-11-08T12:00:30.000Z',
    })
    await h.repo(repo => repo.insert(failed, 'failed-key'))

    const notRecent = await h.repo(repo =>
      repo.findRecentByDedupe({
        ownerId: OWNER,
        dedupeKey: 'failed-key',
        since: '2026-11-08T11:59:00.000Z',
      }),
    )
    expect(Option.isNone(notRecent)).toBe(true)
  })

  it('purges rows older than the cutoff and keeps newer ones', async () => {
    const h = makeHarness()
    const old = captureOf({ createdAt: '2026-08-01T00:00:00.000Z' })
    const fresh = captureOf({ createdAt: '2026-11-01T00:00:00.000Z' })
    await h.repo(repo => repo.insert(old, 'old'))
    await h.repo(repo => repo.insert(fresh, 'fresh'))

    const purged = await h.repo(repo => repo.purge('2026-08-10T00:00:00.000Z'))
    expect(purged).toEqual([old.id])
    expect(h.count('capture')).toBe(1)
  })
})
