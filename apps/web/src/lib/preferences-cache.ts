import { Option, Schema } from "effect"
import { UserPreferences } from "@tali/domain"

/**
 * The last server-confirmed preferences, keyed per user.
 *
 * Mirrors `session-cache.ts`: localStorage (synchronous, no IndexedDB open
 * race) and a defensive Schema decode, so an offline boot can render the
 * last-known week start and digits before any network call settles. It is a
 * read cache, not an outbox: preferences are edited online only (ADR-0002),
 * and a cache miss simply falls back to the profile/defaults.
 *
 * The key includes the user id so two household members sharing a browser
 * never see each other's display settings.
 */

const KEY_PREFIX = "tali.preferences.v1."

const keyFor = (userId: string): string => `${KEY_PREFIX}${userId}`

const storage = (): Storage | undefined => {
  if (typeof localStorage === "undefined") return undefined
  try {
    return localStorage
  } catch {
    // Storage can be disabled (privacy mode); the defaults still render.
    return undefined
  }
}

export const readCachedPreferences = (userId: string): UserPreferences | undefined => {
  const raw = storage()?.getItem(keyFor(userId))
  if (raw === null || raw === undefined) return undefined
  try {
    const decoded = Schema.decodeUnknownOption(UserPreferences)(JSON.parse(raw))
    return Option.isSome(decoded) ? decoded.value : undefined
  } catch {
    return undefined
  }
}

export const cachePreferences = (preferences: UserPreferences): void => {
  try {
    storage()?.setItem(keyFor(preferences.userId), JSON.stringify(preferences))
  } catch {
    // Quota/disabled storage: the cache is an optimization, never required.
  }
}

export const clearCachedPreferences = (userId: string): void => {
  try {
    storage()?.removeItem(keyFor(userId))
  } catch {
    // Nothing to do — the next read simply fails.
  }
}
