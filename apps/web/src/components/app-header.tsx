import { createSignal, For, Show } from "solid-js"
import type { JSX } from "@solidjs/web"
import { useNavigate } from "@solidjs/router"
import { Button, tokens } from "@tali/ui"
import { useAuth } from "../lib/auth"
import { authErrorMessage } from "../lib/auth-copy"
import { SyncStatus } from "./sync-status"
import { FormError } from "./form"

/**
 * The signed-in app chrome shared by `/today`, `/reminders`, and `/settings`
 * (ticket #20). Keeping the header in one place means the new routes do not
 * clone today's session/offline/logout logic.
 */

export type AppSection = "today" | "reminders" | "settings"

const NAV: ReadonlyArray<{ section: AppSection; href: string; label: string }> = [
  { section: "today", href: "/today", label: "امروز" },
  { section: "reminders", href: "/reminders", label: "یادآورها" },
  { section: "settings", href: "/settings", label: "تنظیمات" }
]

export function AppHeader(props: { active: AppSection }) {
  const auth = useAuth()
  const navigate = useNavigate()
  const [signOutBusy, setSignOutBusy] = createSignal(false)
  const [signOutError, setSignOutError] = createSignal<string>()

  const signOut = async () => {
    if (signOutBusy()) return
    setSignOutBusy(true)
    setSignOutError(undefined)
    const result = await auth.signOut()
    setSignOutBusy(false)
    if (result.ok) {
      navigate("/login", { replace: true })
    } else {
      // The server still holds the session; say so instead of pretending.
      setSignOutError(authErrorMessage(result.error.code))
    }
  }

  const go = (event: MouseEvent, href: string) => {
    event.preventDefault()
    navigate(href)
  }

  return (
    <header
      style={{
        display: "grid",
        gap: tokens.space.sm,
        padding: `${tokens.space.md} ${tokens.space.lg}`,
        background: tokens.color.surface,
        "border-bottom": `1px solid ${tokens.color.line}`
      }}
    >
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          gap: tokens.space.md,
          "flex-wrap": "wrap"
        }}
      >
        <div style={{ display: "grid", gap: "2px" }}>
          <strong style={{ "font-size": "1.1rem", color: tokens.color.brand }}>تالی</strong>
          <Show when={auth.session()?.user.displayName}>
            {(displayName) => (
              <span style={{ "font-size": "0.85rem", color: tokens.color.inkSoft }}>{displayName()}</span>
            )}
          </Show>
        </div>
        <div style={{ display: "flex", "align-items": "center", gap: tokens.space.sm }}>
          <SyncStatus />
          <Button variant="ghost" type="button" disabled={signOutBusy()} onClick={() => void signOut()}>
            {signOutBusy() ? "در حال خروج…" : "خروج"}
          </Button>
        </div>
      </div>

      <nav aria-label="بخش‌های تالی" style={{ display: "flex", gap: "4px", "flex-wrap": "wrap" }}>
        <For each={NAV}>
          {(item) => {
            const active = () => item.section === props.active
            const style = (): JSX.CSSProperties => ({
              padding: "4px 10px",
              "border-radius": "999px",
              "font-family": tokens.font.sans,
              "font-size": "0.85rem",
              "text-decoration": "none",
              color: active() ? "#fff" : tokens.color.inkSoft,
              background: active() ? tokens.color.brand : "transparent",
              border: `1px solid ${active() ? tokens.color.brand : tokens.color.line}`
            })
            return (
              <a
                href={item.href}
                aria-current={active() ? "page" : undefined}
                style={style()}
                onClick={(event) => go(event, item.href)}
              >
                {item.label}
              </a>
            )
          }}
        </For>
      </nav>

      <FormError message={signOutError()} />
    </header>
  )
}
