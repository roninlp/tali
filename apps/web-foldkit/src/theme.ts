import { Effect, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { buttonView } from './ui/button'
import { moonIcon, sunIcon } from './ui/icons'

// MODEL

export const Theme = Schema.Literals(['Tali', 'TaliDark'])
export type Theme = typeof Theme.Type

export const Model = Schema.Struct({ theme: Theme })
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedThemeToggle: {},
  CompletedApplyTheme: {},
})
export type Message = typeof Message.Type

// INIT

/**
 * The house light theme is the document default in `index.html`, so init needs
 * no Command: the palette is already applied before first paint. Restoring a
 * saved preference (and the light/dark/system mode) lands with P2.5.
 */
export const init = (): Update.Return<Model, Message> => ({
  model: Model.make({ theme: 'Tali' }),
})

// COMMAND

const dataTheme = (theme: Theme): string =>
  theme === 'TaliDark' ? 'talidark' : 'tali'

// Mirrors --color-base-200 in the two house themes.
const themeColor = (theme: Theme): string =>
  theme === 'TaliDark' ? '#10141d' : '#f6f7fb'

const applyDocumentTheme = (theme: Theme): void => {
  document.documentElement.setAttribute('data-theme', dataTheme(theme))

  // Keep the browser / PWA chrome in step with the page background.
  const themeColorMeta = document.querySelector('meta[name="theme-color"]')
  if (themeColorMeta !== null) {
    themeColorMeta.setAttribute('content', themeColor(theme))
  }
}

export const ApplyTheme = Command.define('ApplyTheme', {
  args: { theme: Theme },
  messages: [Message.CompletedApplyTheme],
  execute: ({ theme }) =>
    Effect.sync(() => {
      applyDocumentTheme(theme)
      return Message.CompletedApplyTheme()
    }),
})

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedThemeToggle: () => {
      const theme: Theme = model.theme === 'TaliDark' ? 'Tali' : 'TaliDark'

      return {
        model: modifyFields(model, { theme: () => theme }),
        commands: [ApplyTheme({ theme })],
      }
    },

    CompletedApplyTheme: () => ({ model }),
  })

// VIEW

const toggleLabel = (theme: Theme): string =>
  theme === 'TaliDark' ? 'حالت روشن' : 'حالت تیره'

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const label = toggleLabel(model.theme)

  return buttonView(
    {
      variant: 'ghost',
      size: 'sm',
      class: 'btn-circle',
      ariaLabel: label,
      title: label,
      onClick: Message.ClickedThemeToggle(),
      children: [
        model.theme === 'TaliDark' ? sunIcon('size-5') : moonIcon('size-5'),
      ],
    },
    h,
  )
})
