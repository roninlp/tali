import { Clock, Data, Effect, Predicate } from 'effect'

import type { LocalStore } from '@tali/sync-client'

import { LocalStoreResource } from '../sync/local-store'
import type { LocalStoreService } from '../sync/local-store'

/**
 * The scaffold shared by the local-first write Commands.
 *
 * Every write Command reaches the IndexedDB mirror, stamps the row with the
 * clock instant, and reports a failure Message instead of crashing the app.
 * `localWrite` owns that sequence so each Command only names its write and its
 * two result Messages.
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
