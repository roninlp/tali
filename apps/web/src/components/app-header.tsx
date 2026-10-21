import { createEffect, createSignal, For, Show } from "solid-js"
import type { JSX } from "@solidjs/web"
import { useNavigate } from "@solidjs/router"
import { Button, tokens } from "@tali/ui"
import { useAuth } from "../lib/auth"
import { authErrorMessage } from "../lib/auth-copy"
import { useLocalStore } from "../lib/local-store"
import { createNoteInMirror } from "../lib/notes/mirror"
import { SyncStatus } from "./sync-status"
import { FormError } from "./form"

/**
 * The signed-in app chrome shared by `/today`, `/tasks`, `/notes`,
 * `/reminders`, and `/settings` (ticket #20; notes #40; tasks #37).
 *
 * The "new note" action lives here rather than on one screen because FR-NOTE-01
 * requires quick create from anywhere: one local-store transaction mints the
 * note, then the editor opens immediately — no network round trip.
 */

export type AppSection =
  | "today"
  | "calendar"
  | "tasks"
  | "habits"
  | "lists"
  | "notes"
  | "reminders"
  | "settings"

const NAV: ReadonlyArray<{ section: AppSection; href: string; label: string }> = [
  { section: "today", href: "/today", label: "امروز" },
  { section: "calendar", href: "/calendar", label: "تقویم" },
  { section: "tasks", href: "/tasks", label: "کارها" },
  { section: "habits", href: "/habits", label: "عادت‌ها" },
  { section: "lists", href: "/lists", label: "فهرست‌ها" },
  { section: "notes", href: "/notes", label: "یادداشت‌ها" },
  { section: "reminders", href: "/reminders", label: "یادآورها" },
  { section: "settings", href: "/settings", label: "تنظیمات" }
]

export function AppHeader(props: { active: AppSection }) {
  const auth = useAuth()
  const local = useLocalStore()
  const navigate = useNavigate()
  const [signOutBusy, setSignOutBusy] = createSignal(false)
  const [signOutError, setSignOutError] = createSignal<string>()
  const [noteBusy, setNoteBusy] = createSignal(false)
  const newNote = async () => {
    if (noteBusy()) return
    setNoteBusy(true)
    try {
      // The mirror opens once per session on first paint; a click in that
      // window waits a beat instead of dropping the quick-create intent.
      let store = local.store()
      for (let attempt = 0; attempt < 30 && store === undefined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        store = local.store()
      }
      if (store === undefined) {
        navigate("/notes")
        return
      }
      const id = await createNoteInMirror(store)
      navigate(`/notes/${id}`)
    } finally {
      setNoteBusy(false)
    }
  }

  // Alt+N from any screen, the keyboard twin of the floating/quick action.
  createEffect(
    () => null,
    () => {
      if (typeof window === "undefined") return
      const onKey = (event: KeyboardEvent) => {
        if (event.altKey && event.key.toLowerCase() === "n") {
          event.preventDefault()
          void newNote()
        }
      }
      window.addEventListener("keydown", onKey)
      return () => window.removeEventListener("keydown", onKey)
    }
  )

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
      class="tali-app-header"
      style={{
        display: "grid",
        padding: "10px clamp(14px, 3vw, 24px)"
      }}
    >
      <div class="tali-app-header-inner">
        <div class="tali-app-header-top">
          <div class="tali-app-brand">
            <strong style={{ "font-size": "1.08rem", color: tokens.color.brand }}>
              تالی
            </strong>
            <Show when={auth.session()?.user.displayName}>
              {(displayName) => <span class="tali-app-user">{displayName()}</span>}
            </Show>
          </div>
          <div class="tali-app-header-actions">
            <SyncStatus />
            <Button
              type="button"
              disabled={noteBusy()}
              onClick={() => void newNote()}
              aria-keyshortcuts="Alt+N"
              title="یادداشت تازه (Alt+N)"
            >
              {noteBusy() ? "…" : "یادداشت تازه"}
            </Button>
            <Button
              variant="ghost"
              type="button"
              disabled={signOutBusy()}
              onClick={() => void signOut()}
            >
              {signOutBusy() ? "در حال خروج…" : "خروج"}
            </Button>
          </div>
        </div>

        <nav class="tali-app-nav" aria-label="بخش‌های تالی">
          <For each={NAV}>
            {(item) => {
              const active = () => item.section === props.active
              const style = (): JSX.CSSProperties => ({
                padding: "5px 12px",
                "border-radius": "999px",
                "font-family": tokens.font.sans,
                "font-size": "0.82rem",
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
      </div>
    </header>
  )
}
