import { Show } from "solid-js"
import { Button } from "@tali/ui"
import { useAuth } from "../lib/auth"
import { Splash } from "./form"

/**
 * What the app shows before it knows who the user is: a plain splash while the
 * session restores, and a retry when that restore failed for a transient
 * reason (the session is only discarded on an explicit `Unauthorized`).
 */
export function BootScreen() {
  const auth = useAuth()

  return (
    <Show when={auth.status() === "error"} fallback={<Splash />}>
      <Splash
        message={
          auth.bootFailure()?.retryable
            ? "ارتباط با سرور برقرار نشد. دوباره تلاش کنید."
            : "درخواست نامعتبر بود. دوباره تلاش کنید."
        }
        action={
          <Button type="button" onClick={() => void auth.refresh()}>
            تلاش دوباره
          </Button>
        }
      />
    </Show>
  )
}
