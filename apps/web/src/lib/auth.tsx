import { createContext, createSignal, onSettled, useContext, type ParentProps } from "solid-js"
import type {
  ChangePasswordInput,
  CreateHouseholdInput,
  JoinHouseholdInput,
  LoginInput,
  RegisterInput,
  SessionContext
} from "@tali/domain"
import { authApi, type ApiResult, type AuthFailure } from "./auth-api"
import { cacheSession, clearCachedSession, readCachedSession } from "./session-cache"

/**
 * The client session store.
 *
 * Auth state is one signal: `checking` until `/auth/me` settles on boot, then
 * `signedOut`, `signedIn` with the server's `SessionContext`, or `error` when
 * the boot request failed and no cached session exists to fall back to. Forms
 * call the `signIn`/`register`/… methods, which both hit the API and update the
 * store; route guards read `status()` so a reload keeps the user signed in.
 *
 * When the server is unreachable but a session was cached, the store boots
 * `signedIn` with that cache (and records `bootFailure`) so the local-first
 * mirror and outbox remain usable offline.
 */

export type AuthStatus = "checking" | "signedOut" | "signedIn" | "error"

export interface HouseholdSummary {
  readonly name: string
  readonly inviteCode: string
}

export interface AuthStore {
  status: () => AuthStatus
  session: () => SessionContext | undefined
  /** The user's household id, if the session has one. */
  householdId: () => string | undefined
  /** Set when the boot `/auth/me` failed, even if a cached session kept us signed in. */
  bootFailure: () => AuthFailure | undefined
  signIn: (input: LoginInput) => Promise<ApiResult<void>>
  signUp: (input: RegisterInput) => Promise<ApiResult<void>>
  /** Swap the credential after proving the current login key. */
  changePassword: (input: ChangePasswordInput) => Promise<ApiResult<void>>
  signOut: () => Promise<ApiResult<void>>
  createHousehold: (input: CreateHouseholdInput) => Promise<ApiResult<HouseholdSummary>>
  joinHousehold: (input: JoinHouseholdInput) => Promise<ApiResult<HouseholdSummary>>
  /** Re-read the session from the server (also slides the cookie's expiry). */
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthStore>()

export function AuthProvider(props: ParentProps) {
  const [status, setStatus] = createSignal<AuthStatus>("checking")
  const [session, setSession] = createSignal<SessionContext>()
  const [bootFailure, setBootFailure] = createSignal<AuthFailure>()

  const applySession = (next: SessionContext) => {
    cacheSession(next)
    setSession(next)
    setBootFailure(undefined)
    setStatus("signedIn")
  }

  const clearSession = () => {
    clearCachedSession()
    setSession(undefined)
    setBootFailure(undefined)
    setStatus("signedOut")
  }

  /**
   * Boot/refresh: `Unauthorized` means "signed out". A 5xx or a network
   * failure is normally a boot error the UI retries — but if a previous
   * session was cached, the shell boots from that instead so the local mirror
   * and unsent outbox stay usable offline. The cookie is still the only thing
   * the server accepts, so nothing is trusted beyond rendering local data.
   */
  const refresh = async () => {
    setStatus("checking")
    setBootFailure(undefined)
    const result = await authApi.me()
    if (result.ok) {
      applySession(result.value)
      return
    }
    if (result.error.code === "Unauthorized") {
      clearSession()
      return
    }
    const cached = readCachedSession()
    if (cached !== undefined) {
      setSession(cached)
      setBootFailure(result.error)
      setStatus("signedIn")
      return
    }
    setBootFailure(result.error)
    setStatus("error")
  }

  // One session restore per app boot; guards show a splash until it settles.
  onSettled(() => {
    void refresh()
  })

  /** A 401 anywhere means the server-side session is gone: drop it locally. */
  function fail<A>(error: AuthFailure): ApiResult<A> {
    if (error.code === "Unauthorized") {
      clearSession()
    }
    return { ok: false, error }
  }

  const signIn = async (input: LoginInput): Promise<ApiResult<void>> => {
    const result = await authApi.login(input)
    if (!result.ok) return fail(result.error)
    applySession(result.value)
    return { ok: true, value: undefined }
  }

  const signUp = async (input: RegisterInput): Promise<ApiResult<void>> => {
    const result = await authApi.register(input)
    if (!result.ok) return fail(result.error)
    // Registration returns the full session context, householdId included.
    applySession(result.value)
    return { ok: true, value: undefined }
  }

  const changePassword = async (input: ChangePasswordInput): Promise<ApiResult<void>> => {
    const result = await authApi.changePassword(input)
    if (!result.ok) return fail(result.error)
    return { ok: true, value: undefined }
  }

  const signOut = async (): Promise<ApiResult<void>> => {    const result = await authApi.logout()
    // The cookie is HTTP-only: only the server can revoke it. If the call
    // fails, keep the session so the UI can say so instead of lying.
    if (!result.ok) return fail(result.error)
    clearSession()
    return { ok: true, value: undefined }
  }

  const createHousehold = async (
    input: CreateHouseholdInput
  ): Promise<ApiResult<HouseholdSummary>> => {
    const result = await authApi.createHousehold(input)
    if (!result.ok) return fail(result.error)
    const current = session()
    if (current !== undefined) {
      applySession({ ...current, householdId: result.value.household.id })
    }
    return {
      ok: true,
      value: { name: result.value.household.name, inviteCode: result.value.household.inviteCode }
    }
  }

  const joinHousehold = async (input: JoinHouseholdInput): Promise<ApiResult<HouseholdSummary>> => {
    const result = await authApi.joinHousehold(input)
    if (!result.ok) return fail(result.error)
    const current = session()
    if (current !== undefined) {
      applySession({ ...current, householdId: result.value.household.id })
    }
    return {
      ok: true,
      value: { name: result.value.household.name, inviteCode: result.value.household.inviteCode }
    }
  }

  const store: AuthStore = {
    status,
    session,
    householdId: () => session()?.householdId ?? undefined,
    bootFailure,
    signIn,
    signUp,
    changePassword,
    signOut,
    createHousehold,
    joinHousehold,
    refresh
  }

  return <AuthContext value={store}>{props.children}</AuthContext>
}

export function useAuth(): AuthStore {
  return useContext(AuthContext)
}
