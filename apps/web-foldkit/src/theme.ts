import { Array, Effect, Option, Schema } from 'effect'
import { Command, Dom, Submodel, Subscription, Update } from 'foldkit'
import type { Html } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { RadioGroup } from '@foldkit/ui'

import { buttonView } from './ui/button'
import { monitorIcon, moonIcon, sunIcon } from './ui/icons'

/**
 * Theme + colour-mode store, built on the Foldkit UI `RadioGroup`.
 *
 * Two independent pieces of state:
 * - `theme`: the house light or dark id, or `"auto"` to follow `mode`.
 * - `mode`: light / dark / system, used when `theme` is `"auto"` — and
 *   mirrored back into the theme when the user toggles the sun/moon button.
 *
 * The resolved theme is written to `data-theme` on <html>; the owned token
 * block in `styles.css` then drives every colour in the app. The choice is
 * device-local (localStorage): a phone in the kitchen and a laptop on the
 * desk can run different themes without fighting over a server preference.
 *
 * `public/theme-boot.js` applies the saved theme before first paint. The
 * Model starts from the same values, so the first render agrees with what
 * the document already shows instead of flashing the house light palette.
 */

// MODEL

export const HOUSE_LIGHT = 'tali'
export const HOUSE_DARK = 'talidark'

export const ThemeId = Schema.Literals([HOUSE_LIGHT, HOUSE_DARK])

export type ThemeId = typeof ThemeId.Type

export const ThemeMode = Schema.Literals(['light', 'dark', 'system'])

export type ThemeMode = typeof ThemeMode.Type

export const ThemeChoice = Schema.Literals(['auto', HOUSE_LIGHT, HOUSE_DARK])

export type ThemeChoice = typeof ThemeChoice.Type

export const ModePicker = RadioGroup.create<ThemeMode>()

export const Model = Schema.Struct({
  theme: ThemeChoice,
  mode: ThemeMode,
  isSystemDark: Schema.Boolean,
  modePicker: RadioGroup.Model,
})

export type Model = typeof Model.Type

export interface ThemeInfo {
  readonly id: ThemeId
  readonly label: string
  readonly dark: boolean
  /** Representative colours for the picker swatch: primary, accent, surface. */
  readonly swatch: Readonly<[string, string, string]>
}

/** The house pair: the only two paint jobs the app ships. */
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
]

const THEME_KEY = 'tali.theme'
const MODE_KEY = 'tali.mode'

const parseThemeChoice = (value: string | undefined): ThemeChoice => {
  if (value === HOUSE_LIGHT) {
    return HOUSE_LIGHT
  }

  if (value === HOUSE_DARK) {
    return HOUSE_DARK
  }

  return 'auto'
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

/** The id the document should carry for the current choice. */
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
  GotModePickerMessage: { message: RadioGroup.Message },
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
    modePicker: RadioGroup.init({ id: 'theme-mode-picker' }),
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

type ThemeUpdate = (
  model: Model,
  message: Message,
) => Update.Return<Model, Message>

const foldModePickerOutMessage = (handleUpdate: ThemeUpdate) =>
  RadioGroup.OutMessage.match<
    Update.Step<Model, Message>,
    RadioGroup.OutMessage<ThemeMode>
  >({
    Selected:
      ({ value }) =>
      stepModel =>
        handleUpdate(stepModel, Message.SelectedMode({ mode: value })),
  })

const foldModePicker = (handleUpdate: ThemeUpdate) =>
  Update.foldChild({
    update: ModePicker.update,
    read: (model: Model) => Option.some(model.modePicker),
    write: (model: Model, nextModePicker: RadioGroup.Model) =>
      modifyFields(model, { modePicker: () => nextModePicker }),
    toParentMessage: message => Message.GotModePickerMessage({ message }),
    foldOutMessage: foldModePickerOutMessage(handleUpdate),
  })

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
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

    GotModePickerMessage: ({ message }) =>
      foldModePicker(update)(model, message),

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

const MODE_LABEL: Readonly<Record<ThemeMode, string>> = {
  light: 'روشن',
  dark: 'تیره',
  system: 'سیستم',
}

const toggleLabel = (model: Model): string =>
  isDarkTheme(resolvedTheme(model)) ? 'حالت روشن' : 'حالت تیره'

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const isDark = isDarkTheme(resolvedTheme(model))

  return buttonView(
    {
      variant: 'ghost',
      size: 'sm',
      isCircle: true,
      children: [isDark ? sunIcon('size-5') : moonIcon('size-5')],
      ariaLabel: toggleLabel(model),
      title: toggleLabel(model),
      onClick: Message.ClickedThemeToggle(),
    },
    h,
  )
})

export const pickerView = Submodel.defineView<Model, Message>((model, h) => {
  const options: ReadonlyArray<ThemeMode> = ['light', 'dark', 'system']

  const segmentedView = (render: RadioGroup.RenderInfo<ThemeMode>): Html =>
    h.div(
      [...render.group, h.Class('segmented grid w-full max-w-md')],
      Array.map(render.options, option =>
        h.button(
          [...option.option, h.Class('segmented-option')],
          Option.match(
            Array.findFirst(MODES, mode => mode.value === option.value),
            {
              onNone: () => [MODE_LABEL[option.value]],
              onSome: mode => [mode.icon('size-4'), mode.label],
            },
          ),
        ),
      ),
    )

  return h.section(
    [
      h.AriaLabelledBy('theme-picker-title'),
      h.Class('panel grid grid-cols-1 gap-4 p-4 sm:p-5'),
    ],
    [
      h.header(
        [h.Class('grid gap-1.5')],
        [
          h.h2(
            [
              h.Id('theme-picker-title'),
              h.Class('m-0 text-[0.95rem] font-semibold'),
            ],
            ['ظاهر'],
          ),
          h.p(
            [h.Class('m-0 text-sm leading-7 text-base-content/55')],
            [
              'حالت روشن، تیره یا سیستم را انتخاب کنید. این انتخاب فقط روی همین دستگاه ذخیره می‌شود.',
            ],
          ),
        ],
      ),
      h.submodel({
        slotId: model.modePicker.id,
        model: model.modePicker,
        view: ModePicker.view,
        viewInputs: {
          options,
          selectedValue: Option.some(model.mode),
          ariaLabel: 'حالت روشن یا تیره',
          toView: segmentedView,
        },
        toParentMessage: message => Message.GotModePickerMessage({ message }),
      }),
    ],
  )
})
