import { describe, expect, it } from 'vitest'
import { Data, Effect, Exit } from 'effect'
import { casUpdate, MAX_CAS_ATTEMPTS } from '../src/cas.js'

/**
 * The CAS retry loop every mutating service shares. These pin the contract the
 * services rely on: the read re-runs per attempt, a lost write retries against
 * the fresh row, a no-op short-circuits without writing, and exhaustion is the
 * only path to the typed conflict.
 */

interface Row {
  readonly value: string
  readonly version: number
}

class Conflict extends Data.TaggedError('Conflict')<{
  readonly id: string
}> {}

const row = (version: number): Row => ({ value: `v${version}`, version })

/** The edit every plan applies: one version bump with a suffix. */
const edit =
  (suffix: string) =>
  (current: Row): Row => ({
    value: `${current.value}-${suffix}`,
    version: current.version + 1,
  })

const conflict = () => new Conflict({ id: 'row' })

describe('casUpdate', () => {
  it('writes once and returns the new row', async () => {
    let stored = row(1)
    let writes = 0

    const result = await Effect.runPromise(
      casUpdate<Row, Conflict>({
        read: Effect.sync(() => stored),
        plan: current => Effect.succeed(edit('a')(current)),
        write: (_, next) =>
          Effect.sync(() => {
            writes += 1
            stored = next
            return true
          }),
        conflict,
      }),
    )

    expect(result).toEqual({ value: 'v1-a', version: 2 })
    expect(stored).toEqual(result)
    expect(writes).toBe(1)
  })

  it('returns the current row untouched when the plan has nothing to do', async () => {
    let writes = 0

    const result = await Effect.runPromise(
      casUpdate<Row, Conflict>({
        read: Effect.succeed(row(4)),
        plan: () => Effect.succeed(null),
        write: () =>
          Effect.sync(() => {
            writes += 1
            return true
          }),
        conflict,
      }),
    )

    expect(result).toEqual(row(4))
    expect(writes).toBe(0)
  })

  it('retries a lost CAS against the freshly read row', async () => {
    let stored = row(1)
    let reads = 0
    let writes = 0

    const result = await Effect.runPromise(
      casUpdate<Row, Conflict>({
        read: Effect.sync(() => {
          reads += 1
          return stored
        }),
        plan: current => Effect.succeed(edit('b')(current)),
        write: (current, next) =>
          Effect.sync(() => {
            writes += 1
            if (writes === 1) {
              // Another writer lands between our read and our write.
              stored = row(current.version + 1)
              return false
            }
            stored = next
            return true
          }),
        conflict,
      }),
    )

    // The retry plans against v2, not the v1 the first attempt read.
    expect(result).toEqual({ value: 'v2-b', version: 3 })
    expect(reads).toBe(2)
  })

  it('fails with the conflict after every attempt has lost', async () => {
    let writes = 0

    const exit = await Effect.runPromiseExit(
      casUpdate<Row, Conflict>({
        read: Effect.succeed(row(1)),
        plan: current => Effect.succeed(edit('c')(current)),
        write: () =>
          Effect.sync(() => {
            writes += 1
            return false
          }),
        conflict,
      }),
    )

    expect(exit).toEqual(Exit.fail(new Conflict({ id: 'row' })))
    expect(writes).toBe(MAX_CAS_ATTEMPTS)
  })

  it('reads again on every attempt', async () => {
    let reads = 0

    await Effect.runPromiseExit(
      casUpdate<Row, Conflict>({
        read: Effect.sync(() => {
          reads += 1
          return row(1)
        }),
        plan: current => Effect.succeed(edit('d')(current)),
        write: () => Effect.succeed(false),
        conflict,
      }),
    )

    expect(reads).toBe(MAX_CAS_ATTEMPTS)
  })

  it('honours a caller-supplied attempt budget', async () => {
    let reads = 0

    const exit = await Effect.runPromiseExit(
      casUpdate<Row, Conflict>({
        attempts: 1,
        read: Effect.sync(() => {
          reads += 1
          return row(1)
        }),
        plan: current => Effect.succeed(edit('e')(current)),
        write: () => Effect.succeed(false),
        conflict,
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(reads).toBe(1)
  })

  it('propagates a plan refusal without writing or retrying', async () => {
    let reads = 0
    let writes = 0

    const exit = await Effect.runPromiseExit(
      casUpdate<Row, Conflict>({
        read: Effect.sync(() => {
          reads += 1
          return row(1)
        }),
        plan: () => Effect.fail(new Conflict({ id: 'refused' })),
        write: () =>
          Effect.sync(() => {
            writes += 1
            return true
          }),
        conflict,
      }),
    )

    expect(exit).toEqual(Exit.fail(new Conflict({ id: 'refused' })))
    expect(reads).toBe(1)
    expect(writes).toBe(0)
  })

  it('does not retry a defect', async () => {
    let reads = 0

    const exit = await Effect.runPromiseExit(
      casUpdate<Row, Conflict>({
        read: Effect.sync(() => {
          reads += 1
          return row(1)
        }),
        plan: () => Effect.die(new Error('boom')),
        write: () => Effect.succeed(false),
        conflict,
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(reads).toBe(1)
  })
})
