import type { HouseholdId, UserId, Visibility } from './common.js'
import type { ItemType } from './planning/common.js'

/**
 * Per-aggregate visibility policy (ADR-0011).
 *
 * Visibility is **not** a user-facing field on every aggregate. Each aggregate
 * belongs to exactly one of four classes:
 *
 * - `ownerOnly`  — never shared, no user control; always resolves to `private`.
 * - `household`  — always shared, no user control; always resolves to `shared`.
 * - `inherited`  — resolved from the parent row; never independently set.
 * - `shareable`  — the only class with a user-facing choice, with one default.
 *
 * The policy is the single source of truth: services, the sync registry and the
 * client all resolve through the helpers below rather than inventing a
 * `?? "shared"` fallback of their own.
 */

/**
 * An aggregate that has a visibility policy. It is every syncable item type
 * plus the four owner-only rows that deliberately never carry `visibility`.
 */
export type VisibilityAggregate =
  | ItemType
  | 'userPreferences'
  | 'session'
  | 'pushSubscription'
  | 'reminderDispatch'

export type VisibilityPolicy =
  | { readonly _tag: 'ownerOnly' }
  | { readonly _tag: 'household' }
  | { readonly _tag: 'inherited'; readonly parent: VisibilityAggregate }
  | { readonly _tag: 'shareable'; readonly default: Visibility }

const ownerOnly: VisibilityPolicy = { _tag: 'ownerOnly' }
const household: VisibilityPolicy = { _tag: 'household' }
const inherited = (parent: VisibilityAggregate): VisibilityPolicy => ({
  _tag: 'inherited',
  parent,
})
const shareable = (defaultVisibility: Visibility): VisibilityPolicy => ({
  _tag: 'shareable',
  default: defaultVisibility,
})

/**
 * The settled per-aggregate table.
 *
 * `Record<VisibilityAggregate, …>` is exhaustive on purpose: adding an
 * `ItemType` without a policy is a compile error, so a new aggregate cannot
 * silently inherit the old "everything is shared" behaviour.
 */
export const VISIBILITY_POLICY: Readonly<
  Record<VisibilityAggregate, VisibilityPolicy>
> = {
  // Owner-only rows: single-member records that predate the household model.
  userPreferences: ownerOnly,
  session: ownerOnly,
  pushSubscription: ownerOnly,
  reminderDispatch: ownerOnly,
  // Children follow their parent; neither carries its own control.
  habitEntry: inherited('habit'),
  listItem: inherited('list'),
  // Household-wide vocabulary: both members see every row by definition.
  project: household,
  tag: household,
  // The only class with a choice, and one default per aggregate.
  list: shareable('shared'),
  event: shareable('shared'),
  task: shareable('shared'),
  note: shareable('private'),
  habit: shareable('private'),
  reminder: shareable('private'),
  occasion: shareable('private'),
}

/**
 * Children of this class may be **narrower** than their parent (a private item
 * inside a shared list). Every other inherited row copies the parent exactly.
 */
const NARROWABLE_INHERITANCE: ReadonlySet<VisibilityAggregate> = new Set([
  'listItem',
])

export const visibilityPolicyOf = (
  aggregate: VisibilityAggregate,
): VisibilityPolicy => VISIBILITY_POLICY[aggregate]

/** True only for the class that shows a user-facing visibility control. */
export const isShareableVisibility = (
  aggregate: VisibilityAggregate,
): boolean => VISIBILITY_POLICY[aggregate]._tag === 'shareable'

/**
 * The resolved visibility of a new row of this aggregate.
 *
 * `inherited` is a programmer error here: the caller must read the parent row
 * and use `resolveInheritedVisibility` instead, because a child cannot pick a
 * value of its own.
 */
export const defaultVisibilityFor = (
  aggregate: VisibilityAggregate,
): Visibility => {
  const policy = VISIBILITY_POLICY[aggregate]
  switch (policy._tag) {
    case 'ownerOnly':
      return 'private'
    case 'household':
      return 'shared'
    case 'shareable':
      return policy.default
    case 'inherited':
      return defaultVisibilityFor(policy.parent)
  }
}

/**
 * Resolve the visibility of a create whose class may still take a user choice.
 *
 * `ownerOnly`, `household` and `inherited` ignore `requested`: the policy — not
 * the payload — decides. `inherited` throws because the parent must be read
 * first; the schemas for those aggregates do not accept `visibility` at all.
 */
export const resolveCreateVisibility = (
  aggregate: VisibilityAggregate,
  requested?: Visibility | undefined,
): Visibility => {
  const policy = VISIBILITY_POLICY[aggregate]
  switch (policy._tag) {
    case 'ownerOnly':
      return 'private'
    case 'household':
      return 'shared'
    case 'shareable':
      return requested ?? policy.default
    case 'inherited':
      throw new Error(
        `${aggregate} inherits visibility from ${policy.parent}; read the parent row instead`,
      )
  }
}

export type InheritedVisibilityResolution =
  | { readonly _tag: 'resolved'; readonly visibility: Visibility }
  | { readonly _tag: 'refused' }

/**
 * Resolve a child's visibility from its parent row.
 *
 * A child may never be wider than its parent: asking for `shared` under a
 * private parent is refused rather than silently clamped. Narrowing is only
 * allowed where the policy says so (`listItem` may be private in a shared
 * list); every other inherited row copies the parent exactly, so an explicit
 * different value is a change attempt and is refused.
 */
export const resolveInheritedVisibility = (
  aggregate: VisibilityAggregate,
  parentVisibility: Visibility,
  requested?: Visibility | undefined,
): InheritedVisibilityResolution => {
  const policy = VISIBILITY_POLICY[aggregate]
  if (policy._tag !== 'inherited') {
    throw new Error(`${aggregate} does not inherit visibility`)
  }
  if (requested === undefined || requested === parentVisibility) {
    return { _tag: 'resolved', visibility: parentVisibility }
  }
  if (parentVisibility === 'private') {
    return { _tag: 'refused' }
  }
  return NARROWABLE_INHERITANCE.has(aggregate)
    ? { _tag: 'resolved', visibility: requested }
    : { _tag: 'refused' }
}

/** The three columns every read-path scope guard needs from a stored row. */
export interface VisibilityRow {
  readonly householdId: HouseholdId
  readonly ownerId: UserId
  readonly visibility: Visibility
}

/** The two facts every read-path scope guard needs about the caller. */
export interface VisibilityViewer {
  readonly householdId: HouseholdId
  readonly userId: UserId
}

/**
 * The read-authorization predicate for a row that carries a visibility.
 *
 * `null` means the viewer may read the row. A row in another household is
 * denied as `household` before its own `visibility` is even considered, so
 * `household` wins over `private` — the same precedence every service's
 * hand-written cascade used. The check is ordered, not a boolean, because the
 * caller maps the reason into its own tagged error.
 */
export const visibilityDenial = (
  row: VisibilityRow,
  viewer: VisibilityViewer,
): 'household' | 'private' | null =>
  row.householdId !== viewer.householdId
    ? 'household'
    : row.visibility === 'private' && row.ownerId !== viewer.userId
      ? 'private'
      : null

/** Boolean form of `visibilityDenial`, for predicates that want no reason. */
export const canView = (
  row: VisibilityRow,
  viewer: VisibilityViewer,
): boolean => visibilityDenial(row, viewer) === null
