import { Effect, Option } from 'effect'

/**
 * Compare-and-swap retry loop shared by every mutating service: the
 * service-side form of `docs/sync-protocol-draft.md` §4.2 ("Server apply,
 * idempotent + atomic on D1"), where the entity upsert is guarded by
 * `WHERE id = :id AND version = :baseVersion` and `applied_mutations`
 * dedupes replays.
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

/**
 * The common shape: the row that is read is the row that is written, and a
 * `null` plan is the idempotent no-op that returns the read row untouched.
 */
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
 * The opt-in shape for a service whose answer is *not* the row it writes:
 * `prepareTask` answers with the occasion and the task it inserted together,
 * so its success value (and its idempotent answer) is a pair, not the occasion.
 *
 * `settled` is the idempotent answer for the freshly read row: `Some` finishes
 * the attempt without writing (a second tap returns the task the first one
 * produced), `None` lets the attempt plan a write. `plan` always writes in this
 * shape, so the value it returns is both the write payload and the success
 * answer; nothing nullable has to be threaded through `A`.
 */
export interface SettlingCasUpdate<A, E, R> {
  /** Attempts before the conflict; defaults to `MAX_CAS_ATTEMPTS`. */
  readonly attempts?: number
  /** Read the row the attempt is based on. Re-run on every attempt. */
  readonly read: Effect.Effect<A, E>
  /**
   * Answer the request from the fresh row without writing, or decline with
   * `None`. Checked on every attempt, before `plan`.
   */
  readonly settled: (current: A) => Effect.Effect<Option.Option<R>, E>
  /** Produce the value to commit. Carries the caller's success answer too. */
  readonly plan: (current: A) => Effect.Effect<R, E>
  /**
   * Commit `next` against the read row (a batch of gated statements).
   * `false` means the row moved underneath us: retry.
   */
  readonly write: (current: A, next: R) => Effect.Effect<boolean, E>
  /** The typed error raised once every attempt has lost. */
  readonly conflict: () => E
}

interface CasRetry<E, X> {
  readonly attempts?: number
  /** `Some` answers the request; `None` is a lost CAS and retries. */
  readonly attempt: Effect.Effect<Option.Option<X>, E>
  readonly conflict: () => E
}

/**
 * Run `attempt` until it answers, up to `attempts` times, then fail with
 * `conflict`. Defects are not caught: an infrastructure failure is not a lost
 * CAS and must not be retried.
 */
const retryAttempts = <E, X>(input: CasRetry<E, X>): Effect.Effect<X, E> =>
  Effect.gen(function* () {
    const attempts = input.attempts ?? MAX_CAS_ATTEMPTS
    for (let index = 0; index < attempts; index += 1) {
      const answer = yield* input.attempt
      if (Option.isSome(answer)) return answer.value
    }
    return yield* Effect.fail(input.conflict())
  })

const retryingUpdate = <A, E>(input: CasUpdate<A, E>): Effect.Effect<A, E> =>
  retryAttempts({
    attempts: input.attempts,
    attempt: Effect.gen(function* () {
      const current = yield* input.read
      const next = yield* input.plan(current)
      if (next === null) return Option.some(current)
      const applied = yield* input.write(current, next)
      return applied ? Option.some(next) : Option.none()
    }),
    conflict: input.conflict,
  })

const settlingUpdate = <A, E, R>(
  input: SettlingCasUpdate<A, E, R>,
): Effect.Effect<R, E> =>
  retryAttempts({
    attempts: input.attempts,
    attempt: Effect.gen(function* () {
      const current = yield* input.read
      const settled = yield* input.settled(current)
      if (Option.isSome(settled)) return settled
      const next = yield* input.plan(current)
      const applied = yield* input.write(current, next)
      return applied ? Option.some(next) : Option.none()
    }),
    conflict: input.conflict,
  })

/**
 * Run the read/plan/write cycle against a fresh read, up to `attempts` times.
 *
 * Without `settled`, returns the written row on success and the current row
 * when `plan` reports no change. With it, returns the settled answer or the
 * value `plan` committed — the shape `prepareTask` needs.
 */
export function casUpdate<A, E>(input: CasUpdate<A, E>): Effect.Effect<A, E>
export function casUpdate<A, E, R>(
  input: SettlingCasUpdate<A, E, R>,
): Effect.Effect<R, E>
export function casUpdate<A, E, R>(
  input: CasUpdate<A, E> | SettlingCasUpdate<A, E, R>,
): Effect.Effect<A | R, E> {
  return 'settled' in input ? settlingUpdate(input) : retryingUpdate(input)
}
