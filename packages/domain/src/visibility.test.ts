import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import type { HouseholdId, UserId } from './common.js'
import {
  ListCreateInput,
  ListItemCreateInput,
  NoteCreateInput,
  ProjectCreateInput,
  TagCreateInput,
  TaskCreateInput,
} from './planning/index.js'
import {
  VISIBILITY_POLICY,
  canView,
  defaultVisibilityFor,
  isShareableVisibility,
  resolveCreateVisibility,
  resolveInheritedVisibility,
  visibilityDenial,
  visibilityPolicyOf,
  type VisibilityRow,
  type VisibilityViewer,
} from './visibility.js'

/**
 * ADR-0011: the per-aggregate visibility policy is the single source of truth,
 * and only the `shareable` class accepts a user value.
 */

describe('the per-aggregate visibility table', () => {
  it('classifies every aggregate into one of the four classes', () => {
    expect(visibilityPolicyOf('userPreferences')._tag).toBe('ownerOnly')
    expect(visibilityPolicyOf('session')._tag).toBe('ownerOnly')
    expect(visibilityPolicyOf('pushSubscription')._tag).toBe('ownerOnly')
    expect(visibilityPolicyOf('reminderDispatch')._tag).toBe('ownerOnly')

    expect(visibilityPolicyOf('habitEntry')).toEqual({
      _tag: 'inherited',
      parent: 'habit',
    })
    expect(visibilityPolicyOf('listItem')).toEqual({
      _tag: 'inherited',
      parent: 'list',
    })

    expect(visibilityPolicyOf('project')._tag).toBe('household')
    expect(visibilityPolicyOf('tag')._tag).toBe('household')
  })

  it('gives shareable aggregates exactly one default', () => {
    expect(VISIBILITY_POLICY.list).toEqual({
      _tag: 'shareable',
      default: 'shared',
    })
    expect(VISIBILITY_POLICY.event).toEqual({
      _tag: 'shareable',
      default: 'shared',
    })
    expect(VISIBILITY_POLICY.task).toEqual({
      _tag: 'shareable',
      default: 'shared',
    })
    expect(VISIBILITY_POLICY.note).toEqual({
      _tag: 'shareable',
      default: 'private',
    })
    expect(VISIBILITY_POLICY.habit).toEqual({
      _tag: 'shareable',
      default: 'private',
    })
    expect(VISIBILITY_POLICY.reminder).toEqual({
      _tag: 'shareable',
      default: 'private',
    })
    expect(VISIBILITY_POLICY.occasion).toEqual({
      _tag: 'shareable',
      default: 'private',
    })
  })

  it('reports which aggregates own a user-facing control', () => {
    const shareable = [
      'list',
      'event',
      'task',
      'note',
      'habit',
      'reminder',
      'occasion',
    ].filter(aggregate => isShareableVisibility(aggregate as never))

    expect(shareable).toEqual([
      'list',
      'event',
      'task',
      'note',
      'habit',
      'reminder',
      'occasion',
    ])
    expect(isShareableVisibility('project')).toBe(false)
    expect(isShareableVisibility('listItem')).toBe(false)
    expect(isShareableVisibility('reminderDispatch')).toBe(false)
  })
})

describe('resolved create visibility', () => {
  it('always resolves owner-only rows to private', () => {
    expect(defaultVisibilityFor('session')).toBe('private')
    expect(resolveCreateVisibility('userPreferences')).toBe('private')
    expect(resolveCreateVisibility('pushSubscription', 'shared')).toBe(
      'private',
    )
    expect(resolveCreateVisibility('reminderDispatch', 'shared')).toBe(
      'private',
    )
  })

  it('always resolves household rows to shared', () => {
    expect(defaultVisibilityFor('project')).toBe('shared')
    expect(resolveCreateVisibility('tag')).toBe('shared')
    expect(resolveCreateVisibility('project', 'private')).toBe('shared')
  })

  it('uses the aggregate default unless the user chooses', () => {
    expect(resolveCreateVisibility('note')).toBe('private')
    expect(resolveCreateVisibility('note', 'shared')).toBe('shared')
    expect(resolveCreateVisibility('task')).toBe('shared')
    expect(resolveCreateVisibility('task', 'private')).toBe('private')
    expect(resolveCreateVisibility('occasion')).toBe('private')
    expect(resolveCreateVisibility('event')).toBe('shared')
  })

  it('refuses to invent a value for an inherited row', () => {
    expect(() => resolveCreateVisibility('habitEntry')).toThrow(
      /inherits visibility/,
    )
    expect(defaultVisibilityFor('habitEntry')).toBe('private')
    expect(defaultVisibilityFor('listItem')).toBe('shared')
  })
})

describe('inherited resolution', () => {
  it('copies the parent when the child has no opinion', () => {
    expect(resolveInheritedVisibility('habitEntry', 'private')).toEqual({
      _tag: 'resolved',
      visibility: 'private',
    })
    expect(resolveInheritedVisibility('listItem', 'shared')).toEqual({
      _tag: 'resolved',
      visibility: 'shared',
    })
  })

  it('never lets a child be wider than its parent', () => {
    expect(
      resolveInheritedVisibility('habitEntry', 'private', 'shared'),
    ).toEqual({
      _tag: 'refused',
    })
    expect(resolveInheritedVisibility('listItem', 'private', 'shared')).toEqual(
      {
        _tag: 'refused',
      },
    )
  })

  it('refuses an independent value on an exact-inheritance child', () => {
    expect(
      resolveInheritedVisibility('habitEntry', 'shared', 'private'),
    ).toEqual({
      _tag: 'refused',
    })
  })

  it('allows a narrower list item inside a shared list', () => {
    expect(resolveInheritedVisibility('listItem', 'shared', 'private')).toEqual(
      {
        _tag: 'resolved',
        visibility: 'private',
      },
    )
  })
})

describe('create schemas only accept visibility where the policy is shareable', () => {
  it('strips visibility from project, tag and list-item creates', () => {
    expect(
      Schema.decodeUnknownSync(ProjectCreateInput)({
        clientMutationId: 'm1',
        title: 'خانه',
        visibility: 'private',
      }),
    ).not.toHaveProperty('visibility')

    expect(
      Schema.decodeUnknownSync(TagCreateInput)({
        clientMutationId: 'm2',
        name: 'کار',
        visibility: 'private',
      }),
    ).not.toHaveProperty('visibility')

    expect(
      Schema.decodeUnknownSync(ListItemCreateInput)({
        clientMutationId: 'm3',
        listId: '0198c9a0-0000-7000-8000-000000000001',
        name: 'نان',
        visibility: 'private',
      }),
    ).not.toHaveProperty('visibility')
  })

  it('keeps visibility on the shareable creates', () => {
    expect(
      Schema.decodeSync(NoteCreateInput)({
        clientMutationId: 'm4',
        visibility: 'shared',
      }),
    ).toMatchObject({ visibility: 'shared' })

    expect(
      Schema.decodeSync(ListCreateInput)({
        clientMutationId: 'm5',
        title: 'خرید',
        visibility: 'private',
      }),
    ).toMatchObject({ visibility: 'private' })

    expect(
      Schema.decodeSync(TaskCreateInput)({
        clientMutationId: 'm6',
        title: 'تماس',
        visibility: 'private',
      }),
    ).toMatchObject({ visibility: 'private' })
  })
})

/**
 * The read-authorization predicate every API read path shares. The truth table
 * is written out explicitly because the reason, not just the boolean, is what
 * each service turns into a tagged error.
 */
describe('visibilityDenial', () => {
  const owner = 'user-owner' as UserId
  const partner = 'user-partner' as UserId
  const household = 'household-1' as HouseholdId
  const otherHousehold = 'household-2' as HouseholdId

  const ownerViewer: VisibilityViewer = {
    householdId: household,
    userId: owner,
  }
  const partnerViewer: VisibilityViewer = {
    householdId: household,
    userId: partner,
  }
  const outsiderViewer: VisibilityViewer = {
    householdId: otherHousehold,
    userId: partner,
  }

  it('lets both members read a shared row in the same household', () => {
    const row: VisibilityRow = {
      householdId: household,
      ownerId: owner,
      visibility: 'shared',
    }
    expect(visibilityDenial(row, ownerViewer)).toBeNull()
    expect(visibilityDenial(row, partnerViewer)).toBeNull()
  })

  it('lets the owner read their own private row', () => {
    const row: VisibilityRow = {
      householdId: household,
      ownerId: owner,
      visibility: 'private',
    }
    expect(visibilityDenial(row, ownerViewer)).toBeNull()
  })

  it('denies the partner a private row in the same household', () => {
    const row: VisibilityRow = {
      householdId: household,
      ownerId: owner,
      visibility: 'private',
    }
    expect(visibilityDenial(row, partnerViewer)).toBe('private')
  })

  it('denies every row from another household', () => {
    const shared: VisibilityRow = {
      householdId: household,
      ownerId: owner,
      visibility: 'shared',
    }
    const priv: VisibilityRow = {
      householdId: household,
      ownerId: owner,
      visibility: 'private',
    }
    expect(visibilityDenial(shared, outsiderViewer)).toBe('household')
    expect(visibilityDenial(priv, outsiderViewer)).toBe('household')
  })

  it('answers household before private when both apply', () => {
    const row: VisibilityRow = {
      householdId: otherHousehold,
      ownerId: owner,
      visibility: 'private',
    }
    // The viewer owns the row but is not in its household.
    expect(visibilityDenial(row, ownerViewer)).toBe('household')
  })

  it('agrees with canView on every case', () => {
    const rows: ReadonlyArray<VisibilityRow> = [
      { householdId: household, ownerId: owner, visibility: 'shared' },
      { householdId: household, ownerId: owner, visibility: 'private' },
      { householdId: otherHousehold, ownerId: owner, visibility: 'private' },
    ]
    const viewers: ReadonlyArray<VisibilityViewer> = [
      ownerViewer,
      partnerViewer,
      outsiderViewer,
    ]
    for (const row of rows) {
      for (const viewer of viewers) {
        expect(canView(row, viewer)).toBe(
          visibilityDenial(row, viewer) === null,
        )
      }
    }
    expect(canView(rows[1]!, ownerViewer)).toBe(true)
    expect(canView(rows[1]!, partnerViewer)).toBe(false)
  })
})
