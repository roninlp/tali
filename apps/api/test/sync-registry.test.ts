import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { ITEM_TYPES } from '@tali/domain'
import { makeSyncRegistry, SYNC_ENTITY_TYPES } from '@tali/sql'
import { makeHarnessCore } from './harness.js'

/**
 * Registry coverage (#117).
 *
 * `SYNC_ENTITY_TYPES`'s `satisfies ReadonlyArray<SyncEntityType>` already
 * validates the registry's advertised key list against the domain's list at
 * compile time (the domain union is built from that list, so a type removed
 * there breaks this package's build). What the type checker cannot see is
 * the hand-written `definitions` array inside `makeSyncRegistry`, so this
 * suite asserts the two agree: every advertised entity type has a definition,
 * no definition is unadvertised, and none is duplicated.
 */

const registry = async () => {
  const harness = makeHarnessCore(({ d1 }) => d1)
  return harness.run(
    Effect.gen(function* () {
      return makeSyncRegistry(yield* SqlClient.SqlClient)
    }),
  )
}

describe('sync registry coverage', () => {
  it('registers exactly the advertised server-side entity types', async () => {
    const registered = (await registry())
      .all()
      .map(definition => definition.entityType)

    expect(new Set(registered).size).toBe(registered.length)
    expect([...registered].sort()).toEqual([...SYNC_ENTITY_TYPES].sort())
  })

  it('keeps every advertised entity type inside the domain list', () => {
    // A run-time echo of the compile-time `satisfies`: the registry may
    // legitimately lag the domain list (a new aggregate syncs later and
    // rejects as unsupported until then), but it may never leave it.
    for (const entityType of SYNC_ENTITY_TYPES) {
      expect(ITEM_TYPES).toContain(entityType)
    }
  })
})
