import {
  createContext,
  createEffect,
  createSignal,
  useContext,
  type ParentProps
} from "solid-js"
import {
  defaultPreferences,
  type PreferencesPatch,
  type UserId,
  type UserPreferences
} from "@tali/domain"
import { useAuth } from "./auth"
import { preferencesApi, type PreferencesFailureCode } from "./preferences-api"
import { cachePreferences, readCachedPreferences } from "./preferences-cache"

/**
 * The client preferences store (ticket #35).
 *
 * Resolution order for what renders: the last server response cached on this
 * device (synchronous, so an offline boot already has the right week start and
 * digits) → the account profile/defaults → the Persian-first domain defaults.
 * A successful GET or PATCH updates the signal *and* the cache in the same
 * tick, so `/today`, `/settings` and any future week grid re-render without a
 * reload.
 *
 * Preferences are deliberately **not** written through `writeLocal()`/the sync
 * outbox. They are server-of-record display settings edited while online;
 * queueing them would mean a stale week start could be pushed over a newer
 * value from the other device. A failed PATCH shows a retryable error and the
 * cache keeps the last confirmed value. See ADR-0002.
 */

export type PreferencesSource = "default" | "cache" | "server"

/** The fields the settings surface edits on one save. */
export type DisplayFields = Pick<UserPreferences, "timeZone" | "weekStart" | "digits">

/**
 * The PATCH for a display-settings save: only the fields whose draft differs
 * from the last value this device has confirmed.
 *
 * Sending the whole form would re-persist drafts that were never confirmed
 * here — the profile defaults while the first `GET` is still in flight, or a
 * cache another device has since outgrown — over the untouched fields. That is
 * the silent revert ADR-0002 rules out. Omitted fields keep their stored value
 * server-side, and an empty patch just returns the authoritative row (which
 * also corrects a stale draft).
 */
export const changedDisplayFields = (
  saved: DisplayFields,
  draft: DisplayFields
): PreferencesPatch => {
  const patch: { -readonly [K in keyof PreferencesPatch]: PreferencesPatch[K] } = {}
  if (draft.timeZone !== saved.timeZone) patch.timeZone = draft.timeZone
  if (draft.weekStart !== saved.weekStart) patch.weekStart = draft.weekStart
  if (draft.digits !== saved.digits) patch.digits = draft.digits
  return patch
}

export type PreferencesUpdateResult =
  | { readonly ok: true; readonly value: UserPreferences }
  | { readonly ok: false; readonly code: PreferencesFailureCode }

export interface PreferencesStore {
  preferences: () => UserPreferences
  /** Where the current value came from (useful for an offline hint/tests). */
  source: () => PreferencesSource
  saving: () => boolean
  /** Last fetch/save failure, cleared by the next success. */
  error: () => PreferencesFailureCode | undefined
  update: (patch: PreferencesPatch) => Promise<PreferencesUpdateResult>
  refresh: () => Promise<void>
}

/**
 * Only used while signed out, where route guards render a splash and never
 * read preferences. Keeping a value here means the accessor is total.
 */
const SIGNED_OUT_USER = "00000000-0000-4000-8000-000000000000" as UserId

const PreferencesContext = createContext<PreferencesStore>()

export function PreferencesProvider(props: ParentProps) {
  const auth = useAuth()

  const [loaded, setLoaded] = createSignal<UserPreferences>()
  const [source, setSource] = createSignal<PreferencesSource>("default")
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<PreferencesFailureCode>()

  /** The profile values a user who never saved preferences should see. */
  const profileDefaults = () => {
    const user = auth.session()?.user
    if (user === undefined) return undefined
    return defaultPreferences(user.id, {
      timeZone: user.timeZone,
      weekStart: user.weekStart,
      digits: user.digits
    })
  }

  const preferences = (): UserPreferences =>
    loaded() ??
    profileDefaults() ??
    defaultPreferences(SIGNED_OUT_USER)

  /**
   * A response may only be applied while the same account is still signed in:
   * a `GET`/`PATCH` that settles after a sign-out (or a different sign-in)
   * must never paint one user's display settings for another. The cache write
   * is safe either way — the server-stamped `userId` is its key.
   */
  const stillSignedInAs = (userId: UserId): boolean =>
    auth.session()?.user.id === userId

  /**
   * On each signed-in identity: adopt the cache synchronously, then reconcile
   * with the server. Offline (or a failed GET) keeps the cached values and
   * records the failure; it never clears them.
   */
  createEffect(
    () => ({
      status: auth.status(),
      userId: auth.session()?.user.id,
      timeZone: auth.session()?.user.timeZone,
      weekStart: auth.session()?.user.weekStart,
      digits: auth.session()?.user.digits
    }),
    (current) => {
      if (current.status !== "signedIn" || current.userId === undefined) {
        setLoaded(undefined)
        setSource("default")
        setError(undefined)
        return
      }

      const cached = readCachedPreferences(current.userId)
      if (cached !== undefined) {
        setLoaded(cached)
        setSource("cache")
      } else {
        setLoaded(undefined)
        setSource("default")
      }
      setError(undefined)

      const userId = current.userId
      let cancelled = false
      void (async () => {
        const result = await preferencesApi.get()
        if (cancelled || !stillSignedInAs(userId)) return
        if (result.ok) {
          cachePreferences(result.value)
          setLoaded(result.value)
          setSource("server")
          setError(undefined)
        } else {
          // Keep whatever the cache/profile gave us; a display preference is
          // never worth blocking the screen for.
          setError(result.error.code)
        }
      })()

      return () => {
        cancelled = true
      }
    }
  )

  const refresh = async (): Promise<void> => {
    const user = auth.session()?.user
    if (user === undefined) return
    const result = await preferencesApi.get()
    if (!result.ok) {
      setError(result.error.code)
      return
    }
    cachePreferences(result.value)
    if (!stillSignedInAs(user.id)) return
    setLoaded(result.value)
    setSource("server")
    setError(undefined)
  }

  const update = async (patch: PreferencesPatch): Promise<PreferencesUpdateResult> => {
    const user = auth.session()?.user
    if (user === undefined) {
      return { ok: false, code: "Unauthorized" }
    }
    setSaving(true)
    setError(undefined)
    const result = await preferencesApi.patch(patch)
    setSaving(false)
    if (!result.ok) {
      setError(result.error.code)
      return { ok: false, code: result.error.code }
    }
    // Cache first, then the signal: both are synchronous, so every consumer
    // sees the new week start/digits in the same render tick.
    cachePreferences(result.value)
    if (!stillSignedInAs(user.id)) return { ok: true, value: result.value }
    setLoaded(result.value)
    setSource("server")
    return { ok: true, value: result.value }
  }

  const store: PreferencesStore = {
    preferences,
    source,
    saving,
    error,
    update,
    refresh
  }

  return <PreferencesContext value={store}>{props.children}</PreferencesContext>
}

export function usePreferences(): PreferencesStore {
  return useContext(PreferencesContext)
}
