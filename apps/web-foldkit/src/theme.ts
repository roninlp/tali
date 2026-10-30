import { Array, Effect, Option, Schema } from 'effect'
import { Command, Dom, Submodel, Subscription, Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { classNames } from './ui/class-names'
import { checkIcon, monitorIcon, moonIcon, sunIcon } from './ui/icons'

/**
 * Theme + colour-mode store, ported from `apps/web/src/lib/theme.tsx`.
 *
 * Two independent pieces of state:
 * - `theme`: a concrete daisyUI theme id, or `"auto"` for the house light/dark
 *   pair. Picking a theme from the gallery is a device choice.
 * - `mode`: light / dark / system, used when `theme` is `"auto"` — and
 *   mirrored back into the theme when the user toggles the sun/moon button.
 *
 * The resolved theme is written to `data-theme` on <html>; daisyUI themes then
 * drive every colour in the app. The choice is device-local (localStorage):
 * a phone in the kitchen and a laptop on the desk can run different themes
 * without fighting over a server preference.
 *
 * `public/theme-boot.js` applies the saved theme before first paint. The Model
 * starts from the same storage values, so the first render agrees with what
 * the document already shows instead of flashing the house light palette.
 */

// MODEL

export const HOUSE_LIGHT = 'tali'
export const HOUSE_DARK = 'talidark'

export const ThemeId = Schema.Literals([
  'tali',
  'talidark',
  'cupcake',
  'emerald',
  'corporate',
  'nord',
  'lofi',
  'pastel',
  'caramellatte',
  'winter',
  'sunset',
  'dracula',
  'night',
  'dim',
])
export type ThemeId = typeof ThemeId.Type

export const ThemeMode = Schema.Literals(['light', 'dark', 'system'])
export type ThemeMode = typeof ThemeMode.Type

export const ThemeChoice = Schema.Literals([
  'auto',
  'tali',
  'talidark',
  'cupcake',
  'emerald',
  'corporate',
  'nord',
  'lofi',
  'pastel',
  'caramellatte',
  'winter',
  'sunset',
  'dracula',
  'night',
  'dim',
])
export type ThemeChoice = typeof ThemeChoice.Type

export const Model = Schema.Struct({
  theme: ThemeChoice,
  mode: ThemeMode,
  isSystemDark: Schema.Boolean,
})
export type Model = typeof Model.Type

export interface ThemeInfo {
  readonly id: ThemeId
  readonly label: string
  readonly dark: boolean
  /** Representative colours for the picker swatch: primary, accent, surface. */
  readonly swatch: Readonly<[string, string, string]>
}

/** Curated gallery: the house themes first, then a spread of daisyUI themes. */
const HOUSE_LIGHT_INFO: ThemeInfo = {
  id: HOUSE_LIGHT,
  label: 'تالی روشن',
  dark: false,
  swatch: ['#3558b5', '#258777', '#ffffff'],
}

const HOUSE_DARK_INFO: ThemeInfo = {
  id: HOUSE_DARK,
  label: 'تالی تیره',
  dark: true,
  swatch: ['#8ba5ff', '#4fd0b4', '#171c27'],
}

export const THEMES: ReadonlyArray<ThemeInfo> = [
  HOUSE_LIGHT_INFO,
  HOUSE_DARK_INFO,
  {
    id: 'cupcake',
    label: 'کاپ‌کیک',
    dark: false,
    swatch: ['#65c3c8', '#ef9fbc', '#faf7f5'],
  },
  {
    id: 'emerald',
    label: 'زمرد',
    dark: false,
    swatch: ['#66cc8a', '#377cfb', '#ffffff'],
  },
  {
    id: 'corporate',
    label: 'اداری',
    dark: false,
    swatch: ['#4b6bfb', '#7b92b2', '#ffffff'],
  },
  {
    id: 'nord',
    label: 'نورد',
    dark: false,
    swatch: ['#5e81ac', '#88c0d0', '#eceff4'],
  },
  {
    id: 'lofi',
    label: 'لوفای',
    dark: false,
    swatch: ['#0d0d0d', '#1d4ed8', '#ffffff'],
  },
  {
    id: 'pastel',
    label: 'پاستل',
    dark: false,
    swatch: ['#d1c1d7', '#f6cbd1', '#ffffff'],
  },
  {
    id: 'caramellatte',
    label: 'کارامل',
    dark: false,
    swatch: ['#c8a27a', '#7c5a3c', '#fdf8f2'],
  },
  {
    id: 'winter',
    label: 'زمستان',
    dark: false,
    swatch: ['#0069ff', '#6b7a90', '#ffffff'],
  },
  {
    id: 'sunset',
    label: 'غروب',
    dark: true,
    swatch: ['#ff865b', '#fd6f9c', '#121c22'],
  },
  {
    id: 'dracula',
    label: 'دراکولا',
    dark: true,
    swatch: ['#ff79c6', '#bd93f9', '#282a36'],
  },
  {
    id: 'night',
    label: 'شب',
    dark: true,
    swatch: ['#38bdf8', '#818cf8', '#0f172a'],
  },
  {
    id: 'dim',
    label: 'تاریک',
    dark: true,
    swatch: ['#9be9d5', '#a3b8ff', '#242933'],
  },
]

const THEME_KEY = 'tali.theme'
const MODE_KEY = 'tali.mode'

export const isThemeId = (value: string): value is ThemeId =>
  Array.some(THEMES, theme => theme.id === value)

const parseThemeChoice = (value: string | undefined): ThemeChoice => {
  if (value === 'auto') {
    return 'auto'
  }

  return value !== undefined && isThemeId(value) ? value : 'auto'
}

const parseThemeMode = (value: string | undefined): ThemeMode =>
  value === 'light' || value === 'dark' || value === 'system' ? value : 'system'

const themeInfoOf = (id: ThemeId): ThemeInfo =>
  Option.match(
    Array.findFirst(THEMES, theme => theme.id === id),
    {
      onNone: () => HOUSE_LIGHT_INFO,
      onSome: info => info,
    },
  )

const isDarkTheme = (id: ThemeId): boolean => themeInfoOf(id).dark

/** The daisyUI theme the document should carry for the current choice. */
export const resolvedTheme = (model: Model): ThemeId =>
  model.theme === 'auto'
    ? model.mode === 'system'
      ? model.isSystemDark
        ? HOUSE_DARK
        : HOUSE_LIGHT
      : model.mode === 'dark'
        ? HOUSE_DARK
        : HOUSE_LIGHT
    : model.theme

const readStorage = (key: string): Option.Option<string> => {
  if (typeof localStorage === 'undefined') {
    return Option.none()
  }

  try {
    return Option.fromNullishOr(localStorage.getItem(key))
  } catch {
    return Option.none()
  }
}

export const readStoredTheme = (): Option.Option<string> =>
  readStorage(THEME_KEY)

export const readStoredMode = (): Option.Option<string> => readStorage(MODE_KEY)

const writeStorage = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private mode / storage full: the theme still applies for this session.
  }
}

// MESSAGE

export const Message = defineMessageUnion({
  SelectedTheme: { id: ThemeId },
  SelectedMode: { mode: ThemeMode },
  ChangedSystemDark: { isDark: Schema.Boolean },
  ClickedThemeToggle: {},
  CompletedApplyTheme: {},
  CompletedPersistTheme: {},
})
export type Message = typeof Message.Type

// INIT

export type InitOptions = Readonly<{
  maybeSavedTheme: Option.Option<string>
  maybeSavedMode: Option.Option<string>
  isSystemDark: boolean
}>

export const init = (options: InitOptions): Update.Return<Model, Message> => {
  const model = Model.make({
    theme: parseThemeChoice(Option.getOrUndefined(options.maybeSavedTheme)),
    mode: parseThemeMode(Option.getOrUndefined(options.maybeSavedMode)),
    isSystemDark: options.isSystemDark,
  })

  return {
    model,
    commands: [ApplyTheme({ resolved: resolvedTheme(model) })],
  }
}

// COMMAND

const themeColorFallback = (theme: ThemeId): string =>
  isDarkTheme(theme) ? '#10141d' : '#f6f7fb'

const applyDocumentTheme = (theme: ThemeId): void => {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)

  const themeColorMeta = document.querySelector('meta[name="theme-color"]')
  if (themeColorMeta === null) {
    return
  }

  themeColorMeta.setAttribute('content', themeColorFallback(theme))

  // Keep the browser / PWA chrome in step with the theme's page background.
  requestAnimationFrame(() => {
    const background = getComputedStyle(root).backgroundColor
    if (background !== '' && background !== 'rgba(0, 0, 0, 0)') {
      themeColorMeta.setAttribute('content', background)
    }
  })
}

export const ApplyTheme = Command.define('ApplyTheme', {
  args: { resolved: ThemeId },
  messages: [Message.CompletedApplyTheme],
  execute: ({ resolved }) =>
    Effect.sync(() => {
      applyDocumentTheme(resolved)
      return Message.CompletedApplyTheme()
    }),
})

export const PersistTheme = Command.define('PersistTheme', {
  args: { theme: ThemeChoice, mode: ThemeMode },
  messages: [Message.CompletedPersistTheme],
  execute: ({ theme, mode }) =>
    Effect.sync(() => {
      writeStorage(THEME_KEY, theme)
      writeStorage(MODE_KEY, mode)
      return Message.CompletedPersistTheme()
    }),
})

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SelectedTheme: ({ id }) => {
      const mode: ThemeMode = isDarkTheme(id) ? 'dark' : 'light'

      return {
        model: modifyFields(model, {
          theme: () => id,
          mode: () => mode,
        }),
        commands: [
          PersistTheme({ theme: id, mode }),
          ApplyTheme({ resolved: id }),
        ],
      }
    },

    SelectedMode: ({ mode }) => {
      const next = modifyFields(model, {
        theme: () => 'auto',
        mode: () => mode,
      })

      return {
        model: next,
        commands: [
          PersistTheme({ theme: 'auto', mode }),
          ApplyTheme({ resolved: resolvedTheme(next) }),
        ],
      }
    },

    ChangedSystemDark: ({ isDark }) => {
      const next = modifyFields(model, { isSystemDark: () => isDark })

      return model.theme === 'auto'
        ? {
            model: next,
            commands: [ApplyTheme({ resolved: resolvedTheme(next) })],
          }
        : { model: next }
    },

    ClickedThemeToggle: () => {
      const current =
        model.theme === 'auto' ? resolvedTheme(model) : model.theme
      const id: ThemeId = isDarkTheme(current) ? HOUSE_LIGHT : HOUSE_DARK
      const mode: ThemeMode = isDarkTheme(id) ? 'dark' : 'light'

      return {
        model: modifyFields(model, {
          theme: () => id,
          mode: () => mode,
        }),
        commands: [
          PersistTheme({ theme: id, mode }),
          ApplyTheme({ resolved: id }),
        ],
      }
    },

    CompletedApplyTheme: () => ({ model }),
    CompletedPersistTheme: () => ({ model }),
  })

// SUBSCRIPTION

const systemDarkEvents = Dom.streamFromMediaQuery({
  query: '(prefers-color-scheme: dark)',
  mapMatches: isDark => Message.ChangedSystemDark({ isDark }),
})

export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  systemDark: Subscription.persistentEntry(systemDarkEvents),
}))

// VIEW

const MODES: ReadonlyArray<{
  value: ThemeMode
  label: string
  icon: (className: string) => Html
}> = [
  { value: 'light', label: 'روشن', icon: sunIcon },
  { value: 'dark', label: 'تیره', icon: moonIcon },
  { value: 'system', label: 'سیستم', icon: monitorIcon },
]

const toggleLabel = (model: Model): string =>
  isDarkTheme(resolvedTheme(model)) ? 'حالت روشن' : 'حالت تیره'

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const label = toggleLabel(model)

  return h.button(
    [
      h.Type('button'),
      h.AriaLabel(label),
      h.Title(label),
      h.Class('btn btn-ghost btn-sm btn-circle'),
      h.OnClick(Message.ClickedThemeToggle()),
    ],
    [
      isDarkTheme(resolvedTheme(model))
        ? sunIcon('size-5')
        : moonIcon('size-5'),
    ],
  )
})

const modeButtonView = (
  model: Model,
  entry: (typeof MODES)[number],
  h: HtmlBuilder<Message>,
): Html => {
  const isSelected = model.mode === entry.value

  return h.button(
    [
      h.Type('button'),
      h.AriaPressed(isSelected ? 'true' : 'false'),
      h.Class(
        classNames(
          'btn join-item gap-1.5',
          isSelected ? 'btn-primary' : 'btn-outline',
        ),
      ),
      h.OnClick(Message.SelectedMode({ mode: entry.value })),
    ],
    [entry.icon('size-4'), entry.label],
  )
}

const galleryButtonView = (
  model: Model,
  info: ThemeInfo,
  h: HtmlBuilder<Message>,
): Html => {
  const isSelected =
    model.theme === info.id ||
    (model.theme === 'auto' && resolvedTheme(model) === info.id)

  return h.button(
    [
      h.Type('button'),
      h.AriaPressed(isSelected ? 'true' : 'false'),
      h.AriaLabel(`پوسته ${info.label}`),
      h.Class(
        classNames(
          'grid gap-2 rounded-box border bg-base-100 p-2 text-start',
          isSelected
            ? 'border-2 border-primary shadow-sm'
            : 'border-base-300 hover:border-primary/50',
        ),
      ),
      h.OnClick(Message.SelectedTheme({ id: info.id })),
    ],
    [
      h.span(
        [
          h.AriaHidden(true),
          h.Class(
            'flex h-12 overflow-hidden rounded-lg border border-base-300',
          ),
        ],
        [
          h.span([h.Class('flex-1'), h.Style({ background: info.swatch[0] })]),
          h.span([h.Class('flex-1'), h.Style({ background: info.swatch[1] })]),
          h.span([h.Class('w-1/3'), h.Style({ background: info.swatch[2] })]),
        ],
      ),
      h.span(
        [h.Class('flex items-center justify-between gap-1')],
        [
          h.span(
            [h.Class('truncate text-[0.82rem] font-medium')],
            [info.label],
          ),
          isSelected
            ? h.span(
                [
                  h.Class(
                    'grid size-5 place-items-center rounded-full bg-primary text-primary-content',
                  ),
                ],
                [checkIcon('size-3')],
              )
            : h.span(
                [h.Class('text-[0.62rem] text-base-content/40')],
                [info.dark ? 'تیره' : 'روشن'],
              ),
        ],
      ),
    ],
  )
}

export const pickerView = Submodel.defineView<Model, Message>((model, h) =>
  h.section(
    [
      h.AriaLabelledBy('theme-picker-title'),
      h.Class('panel grid gap-4 p-4 sm:p-5'),
    ],
    [
      h.header(
        [h.Class('grid gap-1')],
        [
          h.h2(
            [h.Id('theme-picker-title'), h.Class('m-0 text-lg font-bold')],
            ['ظاهر و پوسته'],
          ),
          h.p(
            [h.Class('m-0 text-sm leading-7 text-base-content/55')],
            [
              'حالت روشن/تیره و پوسته‌ی دلخواه را انتخاب کنید. این انتخاب فقط روی همین دستگاه ذخیره می‌شود.',
            ],
          ),
        ],
      ),
      h.div(
        [
          h.Role('group'),
          h.AriaLabel('حالت روشن یا تیره'),
          h.Class('join grid w-full max-w-md grid-cols-3'),
        ],
        Array.map(MODES, entry => modeButtonView(model, entry, h)),
      ),
      h.div(
        [h.Class('grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4')],
        Array.map(THEMES, info => galleryButtonView(model, info, h)),
      ),
    ],
  ),
)
