import { createEffect, createMemo, Show, type ParentProps } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useAuth } from "../lib/auth"
import { BootScreen } from "./boot"

/**
 * Route guard. Each page declares what it needs, and the guard renders it only
 * once the session state satisfies that need; otherwise it redirects.
 *
 * - `guest`     — signed-out only (login/register)
 * - `session`   — any signed-in account (household setup)
 * - `household` — signed in *and* in a household (the app proper)
 */
export type Access = "guest" | "session" | "household"

/** Where a signed-in account belongs, by household state. */
export const landingPath = (householdId: string | undefined): string =>
  householdId === undefined ? "/household" : "/today"

export function Guard(props: ParentProps<{ access: Access }>) {
  const auth = useAuth()
  const navigate = useNavigate()

  const allowed = createMemo(() => {
    const status = auth.status()
    // `checking` and `error` are not a session state: render nothing yet.
    if (status === "checking" || status === "error") return false
    if (props.access === "guest") return status === "signedOut"
    if (status === "signedOut") return false
    if (props.access === "session") return true
    return auth.householdId() !== undefined
  })

  createEffect(
    () => ({ allowed: allowed(), status: auth.status(), householdId: auth.householdId() }),
    ({ allowed: isAllowed, status, householdId }) => {
      if (isAllowed || status === "checking" || status === "error") return
      navigate(status === "signedOut" ? "/login" : landingPath(householdId), { replace: true })
    }
  )

  return (
    <Show when={allowed()} fallback={<BootScreen />}>
      {props.children}
    </Show>
  )
}
