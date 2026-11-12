import { Effect } from 'effect'

/**
 * Compare-and-swap retry loop shared by every mutating service (ADR-0007).
 *
 * The write path is always the same: a client sends a mutation with the
 * version it last saw, the service re-reads the row, applies the patch to the
 * *fresh* row, and commits only if the version still matches. A lost CAS means
 * another writer got there first, so the whole read-plan-write cycle is
 * retried against the new row. Bounded, because a hot row must eventually
 * surface a typed conflict rather than spin forever.
 *
 * Each service keeps its own replay guard (the mutation-id ledger) in front of
 * this loop: a retried request must return the row the *first* attempt wrote,
 * which is a ledger question, not a CAS question.
 */
export const MAX_CAS_ATTEMPTS = 3

export interface CasUpdate<A, E> {
  /** Attempts before the conflict; defaults to `MAX_CAS_ATTEMPTS`. */
  readonly attempts?: number
  /** Read the row the write is based on. Re-run on every attempt. */
  readonly read: Effect.Effect<A, E>
  /**
   * Turn the freshly read row into the row to write, or `null` when the
   * request is a no-op — an idempotent tap must return the current row
   * untouched rather than mint a version.
   *
   * `plan` may fail: the preconditions that decide whether the mutation is
   * allowed at all (scope, transition, a derived schedule) are checked against
   * the same fresh row, so they belong here and re-run on every attempt.
   */
  readonly plan: (current: A) => Effect.Effect<A | null, E>
  /**
   * Commit `next` against `current.version` (a gated insert for a new row).
   * `false` means the row moved underneath us: retry.
   */
  readonly write: (current: A, next: A) => Effect.Effect<boolean, E>
  /** The typed error raised once every attempt has lost. */
  readonly conflict: () => E
}

/**
 * Run `plan`/`write` against a fresh read, up to `attempts` times.
 *
 * Returns the written row on success and the current row when `plan` reports
 * no change. Defects are not caught: an infrastructure failure is not a lost
 * CAS and must not be retried.
 */
export const casUpdate = <A, E>(input: CasUpdate<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const attempts = input.attempts ?? MAX_CAS_ATTEMPTS
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = yield* input.read
      const next = yield* input.plan(current)
      if (next === null) return current
      const applied = yield* input.write(current, next)
      if (applied) return next
    }
    return yield* Effect.fail(input.conflict())
  })
