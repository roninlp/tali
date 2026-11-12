import { Effect, Option } from 'effect'
import {
  visibilityDenial,
  type VisibilityRow,
  type VisibilityViewer,
} from '@tali/domain'

/**
 * The read-path row guard, in one place.
 *
 * Every service's `readX` answers the same four questions in a fixed order:
 * does the row exist, is it in the caller's household, is it another member's
 * private row, and is it in the trash. The order is part of the contract — a
 * tombstone can read as `notFound` before or after the household/owner checks,
 * and callers depend on which one wins. `scopeViolation` keeps that ordering
 * parameterized instead of letting each service re-derive it.
 *
 * The household/private half comes from `visibilityDenial` in the domain
 * package (ADR-0011), so the predicate itself has exactly one definition.
 */

export type ScopeViolation = 'notFound' | 'household' | 'private' | 'trashed'

export interface ScopeOptions {
  readonly includeTrashed?: boolean
  /**
   * `'first'` = a tombstone reads as `notFound` before the household/private
   * checks; `'last'` = household/private are answered first. Default `'last'`.
   */
  readonly trash?: 'first' | 'last'
}

const isTrashed = (
  row: { readonly deletedAt: string | null },
  includeTrashed: boolean,
): boolean => !includeTrashed && row.deletedAt !== null

/**
 * Why the viewer may not read this row, or `none` when they may.
 *
 * `trashed` only appears when `includeTrashed` is false; every caller maps it
 * to the same "gone" error as `notFound`, so ordering against `notFound` is a
 * reporting choice, not a different outcome.
 */
export const scopeViolation = <
  A extends VisibilityRow & { deletedAt: string | null },
>(
  viewer: VisibilityViewer,
  maybeRow: Option.Option<A>,
  options?: ScopeOptions,
): Option.Option<ScopeViolation> => {
  const includeTrashed = options?.includeTrashed ?? false
  const trash = options?.trash ?? 'last'
  if (Option.isNone(maybeRow)) return Option.some('notFound')
  const row = maybeRow.value
  if (trash === 'first' && isTrashed(row, includeTrashed)) {
    return Option.some('trashed')
  }
  const denial = visibilityDenial(row, viewer)
  if (denial !== null) return Option.some(denial)
  if (trash === 'last' && isTrashed(row, includeTrashed)) {
    return Option.some('trashed')
  }
  return Option.none()
}

/**
 * Find one row by id and return it only if the viewer may read it.
 *
 * Repository failures are defects (the caller has nothing better to do with a
 * broken connection), and `onViolation` maps a scope denial into the service's
 * own tagged error, so this helper carries no service requirements.
 */
export const readScoped = <
  Id extends string,
  A extends VisibilityRow & { deletedAt: string | null },
  E,
>(input: {
  readonly viewer: VisibilityViewer
  readonly id: Id
  readonly find: (id: Id) => Effect.Effect<Option.Option<A>, unknown>
  readonly includeTrashed?: boolean
  readonly trash?: 'first' | 'last'
  readonly onViolation: (violation: ScopeViolation) => E
}): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const maybeRow = yield* input.find(input.id).pipe(Effect.orDie)
    if (Option.isNone(maybeRow)) {
      return yield* Effect.fail(input.onViolation('notFound'))
    }
    const violation = scopeViolation(input.viewer, maybeRow, input)
    if (Option.isSome(violation)) {
      return yield* Effect.fail(input.onViolation(violation.value))
    }
    return maybeRow.value
  })
