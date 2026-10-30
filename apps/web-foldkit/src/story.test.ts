import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import { Message, update } from './main'
import { AppRoute } from './route'
import { modelAt } from './test-fixtures'
import * as Theme from './theme'

const givenTheme = (theme: Theme.Theme) =>
  given(modelAt(AppRoute.Today(), undefined, theme))

const clickedThemeToggle = Message.GotThemeMessage({
  message: Theme.Message.ClickedThemeToggle(),
})

describe('theme', () => {
  test('the toggle switches the house light theme to dark', () => {
    story(
      update,
      givenTheme('Tali'),
      message(clickedThemeToggle),
      model(model => {
        expect(model.theme.theme).toBe('TaliDark')
      }),
      Command.expectHas(Theme.ApplyTheme({ theme: 'TaliDark' })),
      Command.resolve(Theme.ApplyTheme, Theme.Message.CompletedApplyTheme()),
    )
  })

  test('the toggle switches the house dark theme back to light', () => {
    story(
      update,
      givenTheme('TaliDark'),
      message(clickedThemeToggle),
      model(model => {
        expect(model.theme.theme).toBe('Tali')
      }),
      Command.expectHas(Theme.ApplyTheme({ theme: 'Tali' })),
      Command.resolve(Theme.ApplyTheme, Theme.Message.CompletedApplyTheme()),
    )
  })

  test('CompletedApplyTheme leaves the Model untouched and emits nothing', () => {
    story(
      update,
      givenTheme('TaliDark'),
      message(
        Message.GotThemeMessage({
          message: Theme.Message.CompletedApplyTheme(),
        }),
      ),
      model(model => {
        expect(model.theme.theme).toBe('TaliDark')
      }),
      Command.expectNone(),
    )
  })
})
