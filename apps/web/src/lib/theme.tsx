import { createContext, createEffect, createSignal, onCleanup, useContext, type ParentProps } from "solid-js"
import { isServer } from "@solidjs/web"

/**
 * Theme + colour-mode store.
 *
 * Two independent pieces of state:
 * - `theme`: a concrete daisyUI theme id, or `"auto"` for the house light/dark
 *   pair. Picking a theme from the gallery is a device choice.
 * - `mode`: light / dark / system, used when `theme` is `"auto"` — and mirrored
 *   back into the theme when the user toggles the sun/moon button.
 *
 * The resolved theme is written to `data-theme` on <html>; daisyUI themes then
 * drive every colour in the app. The choice is device-local (localStorage):
 * a phone in the kitchen and a laptop on the desk can run different themes
 * without fighting over a server preference.
 */

export type ThemeMode = "light" | "dark" | "system"

export interface ThemeInfo {
  readonly id: string
  readonly label: string
  readonly dark: boolean
  /** Representative colours for the picker swatch: primary, accent, surface. */
  readonly swatch: readonly [string, string, string]
}

export const HOUSE_LIGHT = "tali"
export const HOUSE_DARK = "talidark"

/** Curated gallery: the house themes first, then a spread of daisyUI themes. */
export const THEMES: ReadonlyArray<ThemeInfo> = [
  { id: HOUSE_LIGHT, label: "تالی روشن", dark: false, swatch: ["#3558b5", "#258777", "#ffffff"] },
  { id: HOUSE_DARK, label: "تالی تیره", dark: true, swatch: ["#8ba5ff", "#4fd0b4", "#171c27"] },
  { id: "cupcake", label: "کاپ‌کیک", dark: false, swatch: ["#65c3c8", "#ef9fbc", "#faf7f5"] },
  { id: "emerald", label: "زمرد", dark: false, swatch: ["#66cc8a", "#377cfb", "#ffffff"] },
  { id: "corporate", label: "اداری", dark: false, swatch: ["#4b6bfb", "#7b92b2", "#ffffff"] },
  { id: "nord", label: "نورد", dark: false, swatch: ["#5e81ac", "#88c0d0", "#eceff4"] },
  { id: "lofi", label: "لوفای", dark: false, swatch: ["#0d0d0d", "#1d4ed8", "#ffffff"] },
  { id: "pastel", label: "پاستل", dark: false, swatch: ["#d1c1d7", "#f6cbd1", "#ffffff"] },
  { id: "caramellatte", label: "کارامل", dark: false, swatch: ["#c8a27a", "#7c5a3c", "#fdf8f2"] },
  { id: "winter", label: "زمستان", dark: false, swatch: ["#0069ff", "#6b7a90", "#ffffff"] },
  { id: "sunset", label: "غروب", dark: true, swatch: ["#ff865b", "#fd6f9c", "#121c22"] },
  { id: "dracula", label: "دراکولا", dark: true, swatch: ["#ff79c6", "#bd93f9", "#282a36"] },
  { id: "night", label: "شب", dark: true, swatch: ["#38bdf8", "#818cf8", "#0f172a"] },
  { id: "dim", label: "تاریک", dark: true, swatch: ["#9be9d5", "#a3b8ff", "#242933"] }
] as const

export const isThemeId = (value: string): boolean => THEMES.some((theme) => theme.id === value)

const THEME_KEY = "tali.theme"
const MODE_KEY = "tali.mode"

const readStorage = (key: string): string | undefined => {
  if (isServer || typeof localStorage === "undefined") return undefined
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

const writeStorage = (key: string, value: string): void => {
  if (isServer) return
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private mode / storage full: the theme still applies for this session.
  }
}

export interface ThemeStore {
  /** The chosen gallery theme, or "auto" for the house light/dark pair. */
  theme: () => string
  mode: () => ThemeMode
  /** The daisyUI theme currently applied to <html>. */
  resolved: () => string
  /** Whether the resolved theme is a dark palette. */
  dark: () => boolean
  setTheme: (id: string) => void
  setMode: (mode: ThemeMode) => void
  /** Sun/moon button: switch to the house light or dark theme. */
  toggle: () => void
}

/**
 * Fallback used outside a provider (unit tests render small components alone).
 * It reports the house light theme and ignores writes; the real provider owns
 * persistence and the `data-theme` attribute.
 */
const FALLBACK_THEME: ThemeStore = {
  theme: () => "auto",
  mode: () => "system",
  resolved: () => HOUSE_LIGHT,
  dark: () => false,
  setTheme: () => undefined,
  setMode: () => undefined,
  toggle: () => undefined
}

const ThemeContext = createContext<ThemeStore>(FALLBACK_THEME)

const systemPrefersDark = (): boolean =>
  !isServer && typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches

export function ThemeProvider(props: ParentProps) {
  const [theme, setThemeSignal] = createSignal<string>(
    (() => {
      const saved = readStorage(THEME_KEY)
      return saved !== undefined && (saved === "auto" || isThemeId(saved)) ? saved : "auto"
    })()
  )
  const [mode, setModeSignal] = createSignal<ThemeMode>(
    (() => {
      const saved = readStorage(MODE_KEY)
      return saved === "light" || saved === "dark" || saved === "system" ? saved : "system"
    })()
  )
  const [systemDark, setSystemDark] = createSignal(systemPrefersDark())

  if (!isServer && typeof matchMedia !== "undefined") {
    const query = matchMedia("(prefers-color-scheme: dark)")
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener("change", onChange)
    onCleanup(() => query.removeEventListener("change", onChange))
  }

  /** Light/dark pair resolution, used when no gallery theme is chosen. */
  const pair = (): string => {
    const dark = mode() === "system" ? systemDark() : mode() === "dark"
    return dark ? HOUSE_DARK : HOUSE_LIGHT
  }

  const resolved = (): string => (theme() === "auto" ? pair() : theme())

  const dark = (): boolean => {
    if (theme() === "auto") return pair() === HOUSE_DARK
    return THEMES.find((entry) => entry.id === theme())?.dark ?? false
  }

  createEffect(
    () => resolved(),
    (current) => {
      if (isServer) return
      const root = document.documentElement
      root.dataset.theme = current
      // Keep the browser/PWA chrome in step with the theme's page background.
      requestAnimationFrame(() => {
        const meta = document.querySelector('meta[name="theme-color"]')
        if (meta === null) return
        const background = getComputedStyle(root).backgroundColor
        if (background !== "" && background !== "rgba(0, 0, 0, 0)") {
          meta.setAttribute("content", background)
        }
      })
    }
  )

  const setTheme = (id: string) => {
    const next = id === "auto" || isThemeId(id) ? id : HOUSE_LIGHT
    setThemeSignal(next)
    writeStorage(THEME_KEY, next)
    const info = THEMES.find((entry) => entry.id === next)
    if (info !== undefined) {
      setModeSignal(info.dark ? "dark" : "light")
      writeStorage(MODE_KEY, info.dark ? "dark" : "light")
    }
  }

  const setMode = (next: ThemeMode) => {
    setModeSignal(next)
    writeStorage(MODE_KEY, next)
    // A mode choice returns to the house pair so "light/dark" always means the
    // same two themes, regardless of a gallery pick made earlier.
    setThemeSignal("auto")
    writeStorage(THEME_KEY, "auto")
  }

  const toggle = () => {
    setTheme(dark() ? HOUSE_LIGHT : HOUSE_DARK)
  }

  const store: ThemeStore = {
    theme,
    mode,
    resolved,
    dark,
    setTheme,
    setMode,
    toggle
  }

  return <ThemeContext value={store}>{props.children}</ThemeContext>
}

export function useTheme(): ThemeStore {
  return useContext(ThemeContext) ?? FALLBACK_THEME
}
