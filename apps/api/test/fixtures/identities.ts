import type { HouseholdId, UserId } from '@tali/domain'

/**
 * The cast every service-level suite shares. Fixture ids and the pinned clock
 * are part of the tests' expectations, so they live in one place.
 */

export const USER_A = 'user-a' as UserId
export const USER_B = 'user-b' as UserId
export const HOUSEHOLD = 'household-a' as HouseholdId
export const OTHER_HOUSEHOLD = 'household-b' as HouseholdId

/** Tehran is UTC+03:30 (Iran dropped DST in 2022). */
export const TZ = 'Asia/Tehran'
export const NOW = '2026-10-20T09:30:00.000Z'

interface ViewerIdentity {
  readonly userId: UserId
  readonly householdId: HouseholdId
}

/**
 * A viewer builder for USER_A in HOUSEHOLD. `base` carries the file's own
 * fields (`timeZone` today), so call sites keep their plain `viewer()` /
 * `viewer({ userId: USER_B })` shape.
 */
export const makeViewer =
  <V extends ViewerIdentity>(
    base: Partial<Omit<V, keyof ViewerIdentity>> = {},
  ) =>
  (overrides: Partial<V> = {}): V =>
    ({ userId: USER_A, householdId: HOUSEHOLD, ...base, ...overrides }) as V

/** USER_B's viewer, for the "another household" authorization cases. */
export const otherHouseholdViewer = <V extends ViewerIdentity>(
  base: Partial<Omit<V, keyof ViewerIdentity>> = {},
): V =>
  ({
    userId: USER_B,
    householdId: OTHER_HOUSEHOLD,
    ...base,
  }) as V
