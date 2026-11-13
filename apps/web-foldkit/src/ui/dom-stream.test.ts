import { Deferred, Effect, Fiber, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, test } from 'vite-plus/test'

import { clockEvents, eventStream } from './dom-stream'

const runWithTestClock = <A, E>(
  effect: Effect.Effect<A, E, TestClock.TestClock>,
) => Effect.runPromise(Effect.provide(effect, TestClock.layer()))

describe('clockEvents', () => {
  test('emits one immediate tick before the first interval', async () => {
    const ticks = await runWithTestClock(
      Effect.gen(function* () {
        const collected = yield* clockEvents(now => now).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        )

        return yield* Fiber.join(collected)
      }),
    )

    expect(ticks).toStrictEqual([0])
  })

  test('repeats on the minute boundary', async () => {
    const ticks = await runWithTestClock(
      Effect.gen(function* () {
        const collected = yield* clockEvents(now => now).pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        )

        yield* TestClock.adjust('60 seconds')
        yield* TestClock.adjust('60 seconds')

        return yield* Fiber.join(collected)
      }),
    )

    expect(ticks).toStrictEqual([0, 60_000, 120_000])
  })

  test('a custom interval sets the repeat period', async () => {
    const ticks = await runWithTestClock(
      Effect.gen(function* () {
        const collected = yield* clockEvents(now => now, {
          intervalMs: 30_000,
        }).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)

        yield* TestClock.adjust('30 seconds')

        return yield* Fiber.join(collected)
      }),
    )

    expect(ticks).toStrictEqual([0, 30_000])
  })

  test('immediate: false waits for the first interval', async () => {
    const ticks = await runWithTestClock(
      Effect.gen(function* () {
        const collected = yield* clockEvents(now => now, {
          intervalMs: 30_000,
          immediate: false,
        }).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)

        yield* TestClock.adjust('30 seconds')

        return yield* Fiber.join(collected)
      }),
    )

    expect(ticks).toStrictEqual([30_000])
  })

  test('maps the tick to the caller message', async () => {
    const messages = await runWithTestClock(
      Effect.gen(function* () {
        const collected = yield* clockEvents(now => ({
          now,
          kind: 'tick',
        })).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)

        return yield* Fiber.join(collected)
      }),
    )

    expect(messages).toStrictEqual([{ now: 0, kind: 'tick' }])
  })
})

describe('eventStream', () => {
  test('emits every value the subscription callback pushes', async () => {
    const values = await Effect.runPromise(
      Effect.gen(function* () {
        const handoff = yield* Deferred.make<(value: number) => void>()

        const collected = yield* eventStream<number>(emit => {
          Deferred.doneUnsafe(handoff, Effect.succeed(emit))

          return () => {}
        }).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)

        const emit = yield* Deferred.await(handoff)
        emit(1)
        emit(2)

        return yield* Fiber.join(collected)
      }),
    )

    expect(values).toStrictEqual([1, 2])
  })

  test('runs the returned unsubscribe when its scope closes', async () => {
    const state = { isUnsubscribed: false }

    await Effect.runPromise(
      Effect.gen(function* () {
        const handoff = yield* Deferred.make<(value: number) => void>()

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* eventStream<number>(emit => {
              Deferred.doneUnsafe(handoff, Effect.succeed(emit))

              return () => {
                state.isUnsubscribed = true
              }
            }).pipe(Stream.runDrain, Effect.forkScoped)

            yield* Deferred.await(handoff)
          }),
        )
      }),
    )

    expect(state.isUnsubscribed).toBe(true)
  })
})
