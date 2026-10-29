import { For, Show } from "solid-js"
import { THEMES, useTheme, type ThemeMode } from "../lib/theme"
import { Icon, type IconName } from "./icons"

/**
 * Theme gallery + light/dark/system switch.
 *
 * Mode picks the house pair (`tali` / `talidark`); a gallery theme is an
 * explicit choice that also records its own light/dark nature. The choice is
 * stored on this device only.
 */

const MODES: ReadonlyArray<{ value: ThemeMode; label: string; icon: IconName }> = [
  { value: "light", label: "روشن", icon: "sun" },
  { value: "dark", label: "تیره", icon: "moon" },
  { value: "system", label: "سیستم", icon: "monitor" }
]

export function ThemePicker() {
  const theme = useTheme()

  const isSelected = (id: string): boolean =>
    theme.theme() === id || (theme.theme() === "auto" && theme.resolved() === id)

  return (
    <section aria-labelledby="theme-picker-title" class="panel grid gap-4 p-4 sm:p-5">
      <header class="grid gap-1">
        <h2 id="theme-picker-title" class="m-0 text-lg font-bold">
          ظاهر و پوسته
        </h2>
        <p class="m-0 text-sm leading-7 text-base-content/55">
          حالت روشن/تیره و پوسته‌ی دلخواه را انتخاب کنید. این انتخاب فقط روی همین دستگاه ذخیره می‌شود.
        </p>
      </header>

      <div
        role="group"
        aria-label="حالت روشن یا تیره"
        class="join grid w-full max-w-md grid-cols-3"
      >
        <For each={MODES}>
          {(mode) => (
            <button
              type="button"
              class={
                theme.mode() === mode.value
                  ? "btn btn-primary join-item gap-1.5"
                  : "btn btn-outline join-item gap-1.5"
              }
              aria-pressed={theme.mode() === mode.value ? "true" : "false"}
              onClick={() => theme.setMode(mode.value)}
            >
              <Icon name={mode.icon} class="size-4" />
              {mode.label}
            </button>
          )}
        </For>
      </div>

      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <For each={THEMES}>
          {(entry) => (
            <button
              type="button"
              aria-pressed={isSelected(entry.id) ? "true" : "false"}
              aria-label={`پوسته ${entry.label}`}
              onClick={() => theme.setTheme(entry.id)}
              class={
                isSelected(entry.id)
                  ? "grid gap-2 rounded-box border-2 border-primary bg-base-100 p-2 text-start shadow-sm"
                  : "grid gap-2 rounded-box border border-base-300 bg-base-100 p-2 text-start hover:border-primary/50"
              }
            >
              <span class="flex h-12 overflow-hidden rounded-lg border border-base-300" aria-hidden="true">
                <span class="flex-1" style={{ background: entry.swatch[0] }} />
                <span class="flex-1" style={{ background: entry.swatch[1] }} />
                <span class="w-1/3" style={{ background: entry.swatch[2] }} />
              </span>
              <span class="flex items-center justify-between gap-1">
                <span class="truncate text-[0.82rem] font-medium">{entry.label}</span>
                <Show
                  when={isSelected(entry.id)}
                  fallback={
                    <span class="text-[0.62rem] text-base-content/40">
                      {entry.dark ? "تیره" : "روشن"}
                    </span>
                  }
                >
                  <span class="grid size-5 place-items-center rounded-full bg-primary text-primary-content">
                    <Icon name="check" class="size-3" />
                  </span>
                </Show>
              </span>
            </button>
          )}
        </For>
      </div>
    </section>
  )
}
