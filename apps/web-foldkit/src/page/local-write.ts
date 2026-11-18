import { Clock, Data, Effect, Predicate } from 'effect'

import { uuidV7 } from '@tali/domain'
import type { LocalStore } from '@tali/sync-client'

import { LocalStoreResource } from '../sync/local-store'
import type { LocalStoreService } from '../sync/local-store'

/**
 * The scaffold shared by the local-first write Commands.
 *
 * Every write Command reaches the IndexedDB mirror, stamps the row with the
 * clock instant, and reports a failure Message instead of crashing the app.
 * `localWrite` owns that sequence so each Command only names its write and its
 * two result Messages; `localCreate` adds the one step a create needs, minting
 * the row's id inside `execute`.
 */

const WRITE_FAILURE_MESSAGE = 'ذخیره در حافظه‌ی محلی ناموفق بود'

const failureMessage = (cause: unknown, fallbackMessage: string): string => {
  if (cause instanceof Error) {
    return cause.message
  }

  if (
    Predicate.hasProperty(cause, 'message') &&
    Predicate.isString(cause.message)
  ) {
    return cause.message
  }

  return fallbackMessage
}

export const storeFailureMessage = (cause: unknown): string =>
  failureMessage(cause, WRITE_FAILURE_MESSAGE)

/** The clock instant a Command's result needs for server-stamped fields. */
export const currentIso: Effect.Effect<string> = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

class LocalWriteError extends Data.TaggedError('LocalWriteError')<{
  readonly message: string
}> {}

type LocalWriteConfig<Ok, Fail, WriteResult> = Readonly<{
  /** The mirror write, run with the current store and clock instant. */
  readonly run: (store: LocalStore, now: string) => Promise<WriteResult>
  readonly onSuccess: () => Ok
  readonly onFailure: (message: string) => Fail
  /** Copy used when the cause carries no message of its own. */
  readonly fallbackMessage?: string
}>

export const localWrite = <Ok, Fail, WriteResult>(
  config: LocalWriteConfig<Ok, Fail, WriteResult>,
): Effect.Effect<Ok | Fail, never, LocalStoreService> =>
  Effect.gen(function* () {
    const store = yield* LocalStoreResource.get
    const now = yield* currentIso

    yield* Effect.tryPromise({
      try: () => config.run(store, now),
      catch: cause =>
        new LocalWriteError({
          message: failureMessage(
            cause,
            config.fallbackMessage ?? WRITE_FAILURE_MESSAGE,
          ),
        }),
    })

    return config.onSuccess()
  }).pipe(
    Effect.catch(error =>
      Effect.succeed(config.onFailure(storeFailureMessage(error))),
    ),
  )

/** What a local create mints inside `execute`: the clock, ISO instant, and fresh id. */
export interface CreateStamp {
  readonly now: number
  readonly instant: string
  readonly id: string
}

type LocalCreateConfig<Ok, Fail, WriteResult> = Readonly<{
  /** The mirror write, run with the current store and the minted stamp. */
  readonly run: (store: LocalStore, stamp: CreateStamp) => Promise<WriteResult>
  /** Builds the Command's Ok Message from the minted id. */
  readonly onSuccess: (id: string) => Ok
  readonly onFailure: (message: string) => Fail
  /** Copy used when the cause carries no message of its own. */
  readonly fallbackMessage?: string
}>

/**
 * `localWrite` for the create Commands: the row's UUIDv7 id is minted inside
 * `execute` (Command args only carry values the Model already holds) and
 * returned in the Ok Message, so a create reports the id it committed under.
 */
export const localCreate = <Ok, Fail, WriteResult>(
  config: LocalCreateConfig<Ok, Fail, WriteResult>,
): Effect.Effect<Ok | Fail, never, LocalStoreService> =>
  Effect.gen(function* () {
    const store = yield* LocalStoreResource.get
    const now = yield* Clock.currentTimeMillis

    const stamp: CreateStamp = {
      now,
      instant: new Date(now).toISOString(),
      id: uuidV7(now),
    }

    yield* Effect.tryPromise({
      try: () => config.run(store, stamp),
      catch: cause =>
        new LocalWriteError({
          message: failureMessage(
            cause,
            config.fallbackMessage ?? WRITE_FAILURE_MESSAGE,
          ),
        }),
    })

    return config.onSuccess(stamp.id)
  }).pipe(
    Effect.catch(error =>
      Effect.succeed(config.onFailure(storeFailureMessage(error))),
    ),
  )
