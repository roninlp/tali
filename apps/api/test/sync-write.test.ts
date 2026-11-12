import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import { type NoteId, Note, NoteValidationError, uuidV7 } from '@tali/domain'
import { type SyncEntityState, SyncRepo, SyncRepoLive } from '@tali/sql'
import { makeSyncKit } from '../src/sync-write.js'
import { HOUSEHOLD, NOW, USER_A } from './fixtures/identities.js'
import { makeHarnessCore, type HarnessEnv } from './harness.js'

/**
 * The shared sync write kit, at its own seam.
 *
 * Every service mutation used to carry its own copy of
 * "write + feed + ledger", and only `note` and `reminder` also asked the
 * registry for its `index` statements. These tests pin the kit's contract:
 *
 * 1. a committed entry always carries the aggregate's registry index hook
 *    (the note search index is the observable one today);
 * 2. an aggregate with no hook still commits exactly write + feed + ledger, so
 *    the pre-kit batch is unchanged where there was nothing to index.
 */

const serviceLayer = ({ d1 }: HarnessEnv) =>
  SyncRepoLive.pipe(Layer.provide(d1))

const makeHarness = () => {
  const harness = makeHarnessCore(serviceLayer)

  /** The kit over the real registry, with a note-flavoured validation error. */
  const kitOf = () =>
    Effect.gen(function* () {
      const sync = yield* SyncRepo
      return makeSyncKit<NoteValidationError>({
        sync,
        invalid: (field, message) =>
          Effect.fail(
            new NoteValidationError({ issues: [{ field, message }] }),
          ),
      })
    })

  const count = (table: string): number =>
    (
      harness.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number
      }
    ).n

  const note = (text: string): Note =>
    new Note({
      id: uuidV7() as NoteId,
      type: 'note',
      title: text,
      body: null,
      plainText: text,
      ownerId: USER_A,
      householdId: HOUSEHOLD,
      visibility: 'private',
      color: null,
      isPinned: false,
      isArchived: false,
      tagIds: [],
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
      deletedAt: null,
    })

  return { ...harness, kitOf, count, note }
}

describe('sync write kit', () => {
  it('appends the registry index hook to a committed entry', async () => {
    const h = makeHarness()

    const result = await h.run(
      Effect.gen(function* () {
        const kit = yield* h.kitOf()
        const state = kit.stateOf('note', h.note('خرید نان'))
        const statements = kit.entryStatements({
          householdId: HOUSEHOLD,
          now: NOW,
          entries: [
            {
              state,
              expectedVersion: null,
              clientMutationId: 'm-note',
            },
          ],
        })
        const applied = yield* kit.commitEntries({
          householdId: HOUSEHOLD,
          now: NOW,
          entries: [
            {
              state,
              expectedVersion: null,
              clientMutationId: 'm-note',
            },
          ],
        })
        return { statements: statements.length, applied: [...applied] }
      }),
    )

    // write + feed + ledger + the note search index pair.
    expect(result.statements).toBe(5)
    expect(result.applied).toEqual(['m-note'])
    // The index rows really landed in the same batch as the row.
    expect(h.count('notes')).toBe(1)
    expect(h.count('notes_fts')).toBe(1)
    expect(h.count('change_feed')).toBe(1)
    expect(h.count('applied_mutations')).toBe(1)
  })

  it('keeps write + feed + ledger for an aggregate with no index hook', async () => {
    const h = makeHarness()
    const habit: SyncEntityState = {
      entityType: 'habit',
      entityId: uuidV7(),
      householdId: HOUSEHOLD,
      ownerId: USER_A,
      visibility: 'private',
      version: 2,
      updatedAt: NOW,
      deletedAt: null,
      data: { title: 'پیاده‌روی' },
    }

    const result = await h.run(
      Effect.gen(function* () {
        const kit = yield* h.kitOf()
        return {
          hooked: kit.definition('habit').index !== undefined,
          statements: kit.entryStatements({
            householdId: HOUSEHOLD,
            now: NOW,
            entries: [
              { state: habit, expectedVersion: 1, clientMutationId: 'm-habit' },
            ],
          }).length,
        }
      }),
    )

    // No registry hook for `habit` (only `note` and `reminder` have one today),
    // so the batch is exactly the pre-kit shape: entity write, gated feed
    // append, gated ledger row.
    expect(result.hooked).toBe(false)
    expect(result.statements).toBe(3)
  })

  it('a fully-applied replay performs no batch and one ledger read', async () => {
    const h = makeHarness()

    const result = await h.run(
      Effect.gen(function* () {
        const kit = yield* h.kitOf()
        const state = kit.stateOf('note', h.note('خرید نان'))
        const entries = [
          { state, expectedVersion: null, clientMutationId: 'm-note' },
        ]
        yield* kit.commitEntries({
          householdId: HOUSEHOLD,
          now: NOW,
          entries,
          skipApplied: true,
        })
        const batchCalls = h.fake.batchCalls
        const statementCalls = h.fake.statementCalls
        const applied = yield* kit.commitEntries({
          householdId: HOUSEHOLD,
          now: NOW,
          entries,
          skipApplied: true,
        })
        return {
          applied: [...applied],
          batches: h.fake.batchCalls - batchCalls,
          statements: h.fake.statementCalls - statementCalls,
        }
      }),
    )

    expect(result.applied).toEqual(['m-note'])
    expect(result.batches).toBe(0)
    // The plan's ledger read is the replay's whole budget: no empty batch, and
    // no second read to re-learn what the plan already saw.
    expect(result.statements).toBe(1)
    expect(h.count('notes')).toBe(1)
    expect(h.count('applied_mutations')).toBe(1)
  })
})
