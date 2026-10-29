import { createEffect, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@tali/ui"
import { useAuth } from "../lib/auth"
import { authErrorMessage } from "../lib/auth-copy"
import { useLocalStore } from "../lib/local-store"
import { useTheme } from "../lib/theme"
import { createNoteInMirror } from "../lib/notes/mirror"
import { Icon, type IconName } from "./icons"
import { SyncStatus } from "./sync-status"
import { FormError } from "./form"

/**
 * The signed-in app chrome shared by every household screen.
 *
 * Desktop: a sticky navbar with the full section menu and a user menu.
 * Mobile: a compact top bar plus a fixed bottom tab bar (five primary
 * destinations and a "more" menu), which is the pattern that feels native on
 * a phone. The "new note" action lives here because FR-NOTE-01 requires quick
 * create from anywhere: one local-store transaction mints the note, then the
 * editor opens immediately — no network round trip.
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

interface NavItem {
  readonly section: AppSection
  readonly href: string
  readonly label: string
  readonly icon: IconName
}

const NAV: ReadonlyArray<NavItem> = [
  { section: "today", href: "/today", label: "امروز", icon: "today" },
  { section: "calendar", href: "/calendar", label: "تقویم", icon: "calendar" },
  { section: "tasks", href: "/tasks", label: "کارها", icon: "tasks" },
  { section: "habits", href: "/habits", label: "عادت‌ها", icon: "habits" },
  { section: "lists", href: "/lists", label: "فهرست‌ها", icon: "lists" },
  { section: "notes", href: "/notes", label: "یادداشت‌ها", icon: "notes" },
  { section: "reminders", href: "/reminders", label: "یادآورها", icon: "reminders" },
  { section: "settings", href: "/settings", label: "تنظیمات", icon: "settings" }
]

/** The four destinations that sit in the phone tab bar; the rest are "more". */
const MOBILE_PRIMARY: ReadonlyArray<AppSection> = ["today", "tasks", "calendar", "notes"]
const MOBILE_MORE: ReadonlyArray<AppSection> = ["habits", "lists", "reminders", "settings"]

const item = (section: AppSection): NavItem =>
  NAV.find((entry) => entry.section === section) ?? NAV[0]!

function ThemeToggle() {
  const theme = useTheme()
  return (
    <button
      type="button"
      class="btn btn-ghost btn-circle btn-sm"
      aria-label={theme.dark() ? "حالت روشن" : "حالت تیره"}
      title={theme.dark() ? "حالت روشن" : "حالت تیره"}
      onClick={() => theme.toggle()}
    >
      <Icon name={theme.dark() ? "sun" : "moon"} class="size-5" />
    </button>
  )
}

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

  // Alt+N from any screen, the keyboard twin of the quick action.
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

  const isActive = (section: AppSection): boolean => section === props.active

  return (
    <>
      <header class="sticky inset-x-0 top-0 z-40 border-b border-base-300 bg-base-100/90 backdrop-blur-md">
        <div class="mx-auto flex h-14 w-full max-w-7xl items-center gap-2 px-3 sm:h-16 sm:px-6">
          <a
            href="/today"
            class="flex shrink-0 items-center gap-2 rounded-lg px-1 py-1"
            onClick={(event) => go(event, "/today")}
            aria-label="تالی — امروز"
          >
            <span class="grid size-8 place-items-center rounded-xl bg-primary text-sm font-black text-primary-content shadow-sm">
              ت
            </span>
            <span class="hidden text-base font-bold tracking-tight sm:inline">تالی</span>
          </a>

          <Show when={auth.session()?.user.displayName}>
            {(displayName) => (
              <span class="me-1 hidden max-w-32 truncate text-xs text-base-content/50 lg:inline">
                {displayName()}
              </span>
            )}
          </Show>

          <nav class="mx-auto hidden md:block" aria-label="بخش‌های تالی">
            <ul class="menu menu-horizontal gap-0.5 px-0">
              <For each={NAV}>
                {(entry) => (
                  <li>
                    <a
                      href={entry.href}
                      aria-current={isActive(entry.section) ? "page" : undefined}
                      class={
                        isActive(entry.section)
                          ? "gap-1.5 rounded-lg bg-primary/10 px-2.5 text-[0.82rem] font-medium text-primary"
                          : "gap-1.5 rounded-lg px-2.5 text-[0.82rem] font-medium"
                      }
                      onClick={(event) => go(event, entry.href)}
                    >
                      <Icon name={entry.icon} class="size-4" />
                      {entry.label}
                    </a>
                  </li>
                )}
              </For>
            </ul>
          </nav>

          <div class="ms-auto flex items-center gap-1 md:ms-0">
            <div class="hidden sm:block">
              <SyncStatus />
            </div>
            <ThemeToggle />
            <Button
              type="button"
              size="sm"
              class="hidden gap-1.5 sm:inline-flex"
              disabled={noteBusy()}
              onClick={() => void newNote()}
              aria-keyshortcuts="Alt+N"
              title="یادداشت تازه (Alt+N)"
            >
              <Icon name="plus" class="size-4" />
              یادداشت تازه
            </Button>
            <button
              type="button"
              class="btn btn-ghost btn-circle btn-sm sm:hidden"
              aria-label="یادداشت تازه"
              title="یادداشت تازه (Alt+N)"
              disabled={noteBusy()}
              onClick={() => void newNote()}
            >
              <Icon name="plus" class="size-5" />
            </button>

            <details class="dropdown dropdown-end">
              <summary
                class="btn btn-ghost btn-circle btn-sm"
                aria-label="حساب کاربری"
                title="حساب کاربری"
              >
                <Icon name="user" class="size-5" />
              </summary>
              <ul class="menu dropdown-content z-50 mt-2 w-56 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
                <li class="menu-title">
                  <span class="truncate">{auth.session()?.user.displayName ?? "حساب من"}</span>
                </li>
                <li>
                  <button type="button" onClick={() => navigate("/settings")}>
                    <Icon name="settings" class="size-4" />
                    تنظیمات
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    disabled={signOutBusy()}
                    onClick={() => void signOut()}
                  >
                    <Icon name="logout" class="size-4" />
                    {signOutBusy() ? "در حال خروج…" : "خروج"}
                  </button>
                </li>
                <Show when={signOutError()}>
                  <li class="p-1">
                    <FormError message={signOutError()} />
                  </li>
                </Show>
              </ul>
            </details>
          </div>
        </div>
      </header>

      {/* Phone tab bar. Sits above the home indicator and leaves room for the
          page's own bottom padding. */}
      <nav
        class="fixed inset-x-0 bottom-0 z-40 border-t border-base-300 bg-base-100/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
        aria-label="نوار پایین تالی"
      >
        <ul class="mx-auto grid max-w-lg grid-cols-5">
          <For each={MOBILE_PRIMARY}>
            {(section) => {
              const entry = item(section)
              return (
                <li>
                  <a
                    href={entry.href}
                    aria-current={isActive(section) ? "page" : undefined}
                    class={
                      isActive(section)
                        ? "flex flex-col items-center gap-0.5 py-2 text-[0.68rem] font-medium text-primary"
                        : "flex flex-col items-center gap-0.5 py-2 text-[0.68rem] font-medium text-base-content/55"
                    }
                    onClick={(event) => go(event, entry.href)}
                  >
                    <span
                      class={
                        isActive(section)
                          ? "grid size-8 place-items-center rounded-xl bg-primary/10"
                          : "grid size-8 place-items-center rounded-xl"
                      }
                    >
                      <Icon name={entry.icon} class="size-5" />
                    </span>
                    {entry.label}
                  </a>
                </li>
              )
            }}
          </For>
          <li>
            <details class="dropdown dropdown-top dropdown-end w-full">
              <summary
                class="flex cursor-pointer list-none flex-col items-center gap-0.5 py-2 text-[0.68rem] font-medium text-base-content/55 [&::-webkit-details-marker]:hidden"
                aria-label="بخش‌های بیشتر"
              >
                <span class="grid size-8 place-items-center rounded-xl">
                  <Icon name="lists" class="size-5" />
                </span>
                بیشتر
              </summary>
              <ul class="menu dropdown-content z-50 mb-2 w-44 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
                <For each={MOBILE_MORE}>
                  {(section) => {
                    const entry = item(section)
                    return (
                      <li>
                        <a
                          href={entry.href}
                          aria-current={isActive(section) ? "page" : undefined}
                          class={
                            isActive(section)
                              ? "bg-primary/10 text-primary"
                              : undefined
                          }
                          onClick={(event) => go(event, entry.href)}
                        >
                          <Icon name={entry.icon} class="size-4" />
                          {entry.label}
                        </a>
                      </li>
                    )
                  }}
                </For>
              </ul>
            </details>
          </li>
        </ul>
      </nav>
    </>
  )
}
