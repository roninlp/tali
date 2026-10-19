import { createContext, createSignal, onSettled, useContext, type ParentProps } from "solid-js"
import type {
  CreateHouseholdInput,
  JoinHouseholdInput,
  LoginInput,
  RegisterInput,
  SessionContext
} from "@tali/domain"
import { authApi, type ApiResult } from "./auth-api"

/**
 * The client session store.
 *
 * Auth state is one signal: `checking` until `/auth/me` settles on boot, then
 * `signedOut` or `signedIn` with the server's `SessionContext`. Forms call the
 * `signIn`/`register`/… methods, which both hit the API and update the store;
 * route guards read `status()` so a reload keeps the user signed in.
 */

export type AuthStatus = "checking" | "signedOut" | "signedIn"

export interface HouseholdSummary {
  readonly name: string
  readonly inviteCode: string
}

export interface AuthStore {
  status: () => AuthStatus
  session: () => SessionContext | undefined
  /** User-facing household id, if the session has one. */
  householdId: () => string | undefined
  signIn: (input: LoginInput) => Promise<ApiResult<void>>
  signUp: (input: RegisterInput) => Promise<ApiResult<void>>
  signOut: () => Promise<void>
  createHousehold: (input: CreateHouseholdInput) => Promise<ApiResult<HouseholdSummary>>
  joinHousehold: (input: JoinHouseholdInput) => Promise<ApiResult<HouseholdSummary>>
  /** Re-read the session from the server (also slides the cookie's expiry). */
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthStore>()

export function AuthProvider(props: ParentProps) {
  const [status, setStatus] = createSignal<AuthStatus>("checking")
  const [session, setSession] = createSignal<SessionContext>()

  const applySession = (next: SessionContext) => {
    setSession(next)
    setStatus("signedIn")
  }

  const clearSession = () => {
    setSession(undefined)
    setStatus("signedOut")
  }

  const refresh = async () => {
    const result = await authApi.me()
    if (result.ok) {
      applySession(result.value)
    } else {
      clearSession()
    }
  }

  // One session restore per app boot; guards show a splash until it settles.
  onSettled(() => {
    void refresh()
  })

  const signIn = async (input: LoginInput): Promise<ApiResult<void>> => {
    const result = await authApi.login(input)
    if (!result.ok) return result
    // Login only returns the profile; ask for the household-bearing context.
    const me = await authApi.me()
    if (me.ok) {
      applySession(me.value)
      return { ok: true, value: undefined }
    }
    // The cookie was minted but could not be resolved — treat as a failure
    // rather than stranding the user on a signed-out screen.
    clearSession()
    return { ok: false, error: me.error }
  }

  const signUp = async (input: RegisterInput): Promise<ApiResult<void>> => {
    const result = await authApi.register(input)
    if (!result.ok) return result
    const me = await authApi.me()
    if (me.ok) {
      applySession(me.value)
      return { ok: true, value: undefined }
    }
    clearSession()
    return { ok: false, error: me.error }
  }

  const signOut = async () => {
    // Clear locally even if the network is down: the cookie is unusable on the
    // next guarded navigation either way.
    await authApi.logout()
    clearSession()
  }

  const createHousehold = async (
    input: CreateHouseholdInput
  ): Promise<ApiResult<HouseholdSummary>> => {
    const result = await authApi.createHousehold(input)
    if (!result.ok) return result
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
    if (!result.ok) return result
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
    signIn,
    signUp,
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
