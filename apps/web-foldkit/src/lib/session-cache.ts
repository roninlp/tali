import { Option, Schema } from 'effect'

import { Session } from '../session'

/**
 * A local hint of the last known session, ported from
 * `apps/web/src/lib/session-cache.ts`.
 *
 * This is not a credential: the HTTP-only session cookie remains the only
 * thing the server accepts. The cache carries the public profile and household
 * id the client already rendered, and it is cleared on sign-out or when the
 * server says `Unauthorized`. Storing it lets the shell boot offline instead
 * of dead-ending on a failed `/auth/me`.
 */

const KEY = 'tali.session.v1'

const CachedSessionJson = Schema.fromJsonString(Session)

const storage = (): Storage | undefined => {
  if (typeof localStorage === 'undefined') {
    return undefined
  }

  try {
    return localStorage
  } catch {
    return undefined
  }
}

export const readCachedSession = (): Option.Option<Session> => {
  const raw = storage()?.getItem(KEY)

  if (raw === null || raw === undefined) {
    return Option.none()
  }

  return Schema.decodeOption(CachedSessionJson)(raw)
}

export const cacheSession = (session: Session): void => {
  try {
    storage()?.setItem(KEY, JSON.stringify(session))
  } catch {
    return
  }
}

export const clearCachedSession = (): void => {
  try {
    storage()?.removeItem(KEY)
  } catch {
    return
  }
}
