/**
 * The Capture composer's crash-safe text cache (ADR-0012 §10).
 *
 * Capture needs the network, so there is no outbox and no mirror row. The text
 * the user typed is the one thing a reload must not lose, so it lives in
 * localStorage keyed by user id — the same synchronous, per-account pattern as
 * the task view cache.
 */

const KEY_PREFIX = 'tali.capture.text.v1.'

const keyFor = (userId: string | undefined): string =>
  `${KEY_PREFIX}${userId ?? 'anonymous'}`

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

export const loadCaptureText = (userId: string | undefined): string => {
  const store = storage()
  if (store === undefined) {
    return ''
  }
  return store.getItem(keyFor(userId)) ?? ''
}

export const saveCaptureText = (userId: string | undefined, text: string): void => {
  const store = storage()
  if (store === undefined) {
    return
  }
  if (text === '') {
    store.removeItem(keyFor(userId))
    return
  }
  store.setItem(keyFor(userId), text)
}
