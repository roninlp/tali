import { Option, Schema } from "effect"
import { SessionContext } from "@tali/domain"

/**
 * A local hint of the last known session, so a reload while offline can still
 * open the right user's mirror.
 *
 * This is **not** a credential: the HTTP-only session cookie remains the only
 * thing the server accepts. The cache only carries the public profile and
 * household id the client already rendered, and it is cleared on sign-out or
 * when the server says `Unauthorized`. Storing it is what lets the shell boot
 * offline instead of dead-ending on a failed `/auth/me`.
 */

const KEY = "tali.session.v1"

const storage = (): Storage | undefined => {
  if (typeof localStorage === "undefined") return undefined
  try {
    return localStorage
  } catch {
    // Storage can be disabled (privacy mode); offline boot is then unavailable.
    return undefined
  }
}

export const readCachedSession = (): SessionContext | undefined => {
  const raw = storage()?.getItem(KEY)
  if (raw === null || raw === undefined) return undefined
  try {
    const decoded = Schema.decodeUnknownOption(SessionContext)(JSON.parse(raw))
    return Option.isSome(decoded) ? decoded.value : undefined
  } catch {
    return undefined
  }
}

export const cacheSession = (session: SessionContext): void => {
  try {
    storage()?.setItem(KEY, JSON.stringify(session))
  } catch {
    // Quota/disabled storage: the cache is an optimization, never a requirement.
  }
}

export const clearCachedSession = (): void => {
  try {
    storage()?.removeItem(KEY)
  } catch {
    // Nothing to do — the next read simply fails.
  }
}
