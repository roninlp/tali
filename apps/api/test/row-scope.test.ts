import { describe, expect, it } from 'vitest'
import { Cause, Effect, Exit, Option } from 'effect'
import type { HouseholdId, UserId } from '@tali/domain'
import {
  readScoped,
  scopeViolation,
  type ScopeViolation,
} from '../src/row-scope.js'

/**
 * The row guard every service read path shares. These pin the ordering, not
 * just the verdict: which violation wins when several apply is part of the
 * authorization contract, and each service chose it deliberately.
 */

const HOUSEHOLD = 'household-1' as HouseholdId
const OTHER_HOUSEHOLD = 'household-2' as HouseholdId
const OWNER = 'user-owner' as UserId
const PARTNER = 'user-partner' as UserId

const owner = { householdId: HOUSEHOLD, userId: OWNER }
const partner = { householdId: HOUSEHOLD, userId: PARTNER }
// A member of the *other* household: the foreign viewer for a HOUSEHOLD row.
const outsider = { householdId: OTHER_HOUSEHOLD, userId: OWNER }

interface Row {
  readonly householdId: HouseholdId
  readonly ownerId: UserId
  readonly visibility: 'private' | 'shared'
  readonly deletedAt: string | null
}

const row = (overrides: Partial<Row> = {}): Row => ({
  householdId: HOUSEHOLD,
  ownerId: OWNER,
  visibility: 'shared',
  deletedAt: null,
  ...overrides,
})

const live = row()
const sharedInOtherHousehold = row({ householdId: OTHER_HOUSEHOLD })
const privateOfOwner = row({ visibility: 'private' })
const trashedShared = row({ deletedAt: '2026-01-01T00:00:00.000Z' })
const trashedPrivateOfOwner = row({
  visibility: 'private',
  deletedAt: '2026-01-01T00:00:00.000Z',
})
const trashedInOtherHousehold = row({
  householdId: OTHER_HOUSEHOLD,
  deletedAt: '2026-01-01T00:00:00.000Z',
})

const verdict = (
  viewer: { householdId: HouseholdId; userId: UserId },
  maybeRow: Option.Option<Row>,
  options?: { includeTrashed?: boolean; trash?: 'first' | 'last' },
): ScopeViolation | null =>
  Option.getOrNull(scopeViolation(viewer, maybeRow, options))

describe('scopeViolation', () => {
  it('reads a missing row as notFound', () => {
    expect(verdict(owner, Option.none())).toBe('notFound')
  })

  it('lets a household member read a shared row', () => {
    expect(verdict(partner, Option.some(live))).toBeNull()
  })

  it('lets the owner read their own private row', () => {
    expect(verdict(owner, Option.some(privateOfOwner))).toBeNull()
  })

  it('denies another member a private row as private', () => {
    expect(verdict(partner, Option.some(privateOfOwner))).toBe('private')
  })

  it('denies a row from another household as household', () => {
    expect(verdict(outsider, Option.some(live))).toBe('household')
    expect(verdict(outsider, Option.some(privateOfOwner))).toBe('household')
    // …and in the other direction, with the foreign row in the other household.
    expect(verdict(owner, Option.some(sharedInOtherHousehold))).toBe(
      'household',
    )
  })

  it('reports a tombstone as trashed when the caller excludes trash', () => {
    expect(verdict(owner, Option.some(trashedShared))).toBe('trashed')
  })

  it('lets the replay guard read a tombstone with includeTrashed', () => {
    expect(
      verdict(owner, Option.some(trashedShared), { includeTrashed: true }),
    ).toBeNull()
    expect(
      verdict(owner, Option.some(trashedPrivateOfOwner), {
        includeTrashed: true,
      }),
    ).toBeNull()
  })

  it('still denies another household when includeTrashed', () => {
    expect(
      verdict(owner, Option.some(trashedInOtherHousehold), {
        includeTrashed: true,
      }),
    ).toBe('household')
  })

  describe("trash: 'last' (the default)", () => {
    it('answers household before trash', () => {
      expect(
        verdict(owner, Option.some(trashedInOtherHousehold), {
          trash: 'last',
        }),
      ).toBe('household')
    })

    it('answers private before trash', () => {
      expect(
        verdict(partner, Option.some(trashedPrivateOfOwner), {
          trash: 'last',
        }),
      ).toBe('private')
    })

    it('answers trash on a row the viewer could otherwise read', () => {
      expect(
        verdict(partner, Option.some(trashedShared), { trash: 'last' }),
      ).toBe('trashed')
    })

    it('is the order used when no options are passed', () => {
      expect(verdict(owner, Option.some(trashedInOtherHousehold))).toBe(
        'household',
      )
    })
  })

  describe("trash: 'first'", () => {
    it('answers trash before household', () => {
      expect(
        verdict(owner, Option.some(trashedInOtherHousehold), {
          trash: 'first',
        }),
      ).toBe('trashed')
    })

    it('answers trash before private', () => {
      expect(
        verdict(partner, Option.some(trashedPrivateOfOwner), {
          trash: 'first',
        }),
      ).toBe('trashed')
    })

    it('still answers notFound before either check', () => {
      expect(verdict(outsider, Option.none(), { trash: 'first' })).toBe(
        'notFound',
      )
    })

    it('ignores trash entirely when includeTrashed is true', () => {
      expect(
        verdict(owner, Option.some(trashedInOtherHousehold), {
          trash: 'first',
          includeTrashed: true,
        }),
      ).toBe('household')
    })
  })
})

describe('readScoped', () => {
  const found = (value: Row) => Option.some(value)

  type Options = {
    readonly includeTrashed?: boolean
    readonly trash?: 'first' | 'last'
  }

  const read = (
    viewer: { householdId: HouseholdId; userId: UserId },
    maybeRow: Option.Option<Row>,
    options?: Options,
  ) =>
    readScoped({
      viewer,
      id: 'row-1',
      find: () => Effect.succeed(maybeRow),
      ...options,
      onViolation: violation => ({ _tag: 'Denied', violation }),
    })

  it('returns the row when the viewer may read it', async () => {
    await expect(Effect.runPromise(read(partner, found(live)))).resolves.toBe(
      live,
    )
  })

  it('maps notFound through onViolation', async () => {
    await expect(
      Effect.runPromise(Effect.flip(read(owner, Option.none()))),
    ).resolves.toEqual({ _tag: 'Denied', violation: 'notFound' })
  })

  it('maps each scope violation through onViolation', async () => {
    const cases: ReadonlyArray<{
      readonly viewer: { householdId: HouseholdId; userId: UserId }
      readonly row: Row
      readonly options?: { includeTrashed?: boolean; trash?: 'first' | 'last' }
      readonly violation: ScopeViolation
    }> = [
      {
        viewer: outsider,
        row: live,
        violation: 'household',
      },
      {
        viewer: partner,
        row: privateOfOwner,
        violation: 'private',
      },
      {
        viewer: owner,
        row: trashedShared,
        violation: 'trashed',
      },
      {
        viewer: owner,
        row: trashedInOtherHousehold,
        options: { trash: 'first' },
        violation: 'trashed',
      },
      {
        viewer: owner,
        row: trashedInOtherHousehold,
        options: { trash: 'last' },
        violation: 'household',
      },
    ]
    for (const testCase of cases) {
      const error = await Effect.runPromise(
        Effect.flip(
          read(testCase.viewer, found(testCase.row), testCase.options),
        ),
      )
      expect(error).toEqual({ _tag: 'Denied', violation: testCase.violation })
    }
  })

  it('treats a repository failure as a defect, not a violation', async () => {
    const exit = await Effect.runPromiseExit(
      readScoped({
        viewer: owner,
        id: 'row-1',
        find: () => Effect.fail(new Error('db down')),
        onViolation: violation => ({ _tag: 'Denied', violation }),
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.pretty(exit.cause)).toContain('db down')
    }
  })
})
