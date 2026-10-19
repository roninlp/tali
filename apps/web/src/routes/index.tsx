import { createEffect } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Splash } from "../components/form"
import { landingPath } from "../components/guard"
import { useAuth } from "../lib/auth"

/**
 * `/` has no screen of its own: it resolves to the right place for the current
 * session — the app when signed in and in a household, the household step when
 * signed in without one, and login when signed out.
 */
export default function IndexRoute() {
  const auth = useAuth()
  const navigate = useNavigate()

  createEffect(
    () => ({ status: auth.status(), householdId: auth.householdId() }),
    ({ status, householdId }) => {
      if (status === "checking") return
      navigate(status === "signedIn" ? landingPath(householdId) : "/login", { replace: true })
    }
  )

  return <Splash />
}
