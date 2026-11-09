import { Effect } from 'effect'
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

export const openStore = (userId: string): Effect.Effect<LocalStore, Error> =>
  Effect.tryPromise({
    try: () => openLocalStore(userId),
    catch: cause =>
      cause instanceof Error
        ? cause
        : new Error('IndexedDB is not available in this environment'),
  })

export const closeStore = (store: LocalStore): Effect.Effect<void> =>
  Effect.sync(() => store.close())

export const storeErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'ذخیره‌سازی محلی در دسترس نیست'
