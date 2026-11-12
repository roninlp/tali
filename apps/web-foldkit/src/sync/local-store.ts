import { Data, Effect } from 'effect'
import { ManagedResource } from 'foldkit'

import { type LocalStore, openLocalStore } from '@tali/sync-client'

/**
 * The IndexedDB mirror as a Foldkit Managed Resource.
 *
 * The resource exists exactly while a signed-in user has a store: its
 * requirements are that user's id, so signing out releases (closes) it and
 * signing back in opens a fresh connection. Commands reach it with
 * `LocalStoreResource.get`.
 */
export const LocalStoreResource =
  ManagedResource.tag<LocalStore>()('LocalStore')

export type LocalStoreService = ManagedResource.ServiceOf<
  typeof LocalStoreResource
>

const LOCAL_STORE_UNAVAILABLE = 'ذخیره‌سازی محلی در دسترس نیست'

export class LocalStoreError extends Data.TaggedError('LocalStoreError')<{
  readonly message: string
  readonly cause: unknown
}> {}

const storeError = (cause: unknown): LocalStoreError =>
  new LocalStoreError({
    message: cause instanceof Error ? cause.message : LOCAL_STORE_UNAVAILABLE,
    cause,
  })

export const openStore = (
  userId: string,
): Effect.Effect<LocalStore, LocalStoreError> =>
  Effect.tryPromise({
    try: () => openLocalStore(userId),
    catch: storeError,
  })

export const closeStore = (store: LocalStore): Effect.Effect<void> =>
  Effect.sync(() => store.close())

export const storeErrorMessage = (cause: unknown): string => {
  if (cause instanceof LocalStoreError) {
    return cause.message
  }

  return cause instanceof Error ? cause.message : LOCAL_STORE_UNAVAILABLE
}
