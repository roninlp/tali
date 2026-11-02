import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { expect, test } from 'vitest'

import { Message, update } from './main'
import { AppRoute } from './route'
import { modelAt } from './test-fixtures'
import * as Theme from './theme'

const givenTheme = (
  theme: Theme.ThemeChoice,
  mode: Theme.ThemeMode = 'light',
) => given(modelAt(AppRoute.Today(), undefined, theme, mode))

const clickedThemeToggle = Message.GotThemeMessage({
  message: Theme.Message.ClickedThemeToggle(),
})

const selectedMode = (mode: Theme.ThemeMode) =>
  Message.GotThemeMessage({
    message: Theme.Message.SelectedMode({ mode }),
  })

const changedSystemDark = (isDark: boolean) =>
  Message.GotThemeMessage({
    message: Theme.Message.ChangedSystemDark({ isDark }),
  })

test('the toggle switches the house light theme to dark and saves it', () => {
  story(
    update,
    givenTheme('tali'),
    message(clickedThemeToggle),
    model(next => {
      expect(next.theme.theme).toBe('talidark')
      expect(next.theme.mode).toBe('dark')
    }),
    Command.expectHas(Theme.PersistTheme({ theme: 'talidark', mode: 'dark' })),
    Command.resolve(Theme.PersistTheme, Theme.Message.CompletedPersistTheme()),
    Command.expectHas(Theme.ApplyTheme({ resolved: 'talidark' })),
    Command.resolve(Theme.ApplyTheme, Theme.Message.CompletedApplyTheme()),
  )
})

test('the toggle switches the house dark theme back to light', () => {
  story(
    update,
    givenTheme('talidark', 'dark'),
    message(clickedThemeToggle),
    model(next => {
      expect(next.theme.theme).toBe('tali')
      expect(next.theme.mode).toBe('light')
    }),
    Command.expectHas(Theme.PersistTheme({ theme: 'tali', mode: 'light' })),
    Command.resolve(Theme.PersistTheme, Theme.Message.CompletedPersistTheme()),
    Command.expectHas(Theme.ApplyTheme({ resolved: 'tali' })),
    Command.resolve(Theme.ApplyTheme, Theme.Message.CompletedApplyTheme()),
  )
})

test('a mode choice returns to the house pair and persists the mode', () => {
  story(
    update,
    given(modelAt(AppRoute.Today(), undefined, 'dracula')),
    message(selectedMode('system')),
    model(next => {
      expect(next.theme.theme).toBe('auto')
      expect(next.theme.mode).toBe('system')
    }),
    Command.expectHas(Theme.PersistTheme({ theme: 'auto', mode: 'system' })),
    Command.resolve(Theme.PersistTheme, Theme.Message.CompletedPersistTheme()),
    Command.expectHas(Theme.ApplyTheme({ resolved: 'tali' })),
    Command.resolve(Theme.ApplyTheme, Theme.Message.CompletedApplyTheme()),
  )
})

test('a gallery pick records its own light/dark nature', () => {
  story(
    update,
    givenTheme('tali'),
    message(
      Message.GotThemeMessage({
        message: Theme.Message.SelectedTheme({ id: 'night' }),
      }),
    ),
    model(next => {
      expect(next.theme.theme).toBe('night')
      expect(next.theme.mode).toBe('dark')
    }),
    Command.expectHas(Theme.PersistTheme({ theme: 'night', mode: 'dark' })),
    Command.resolve(Theme.PersistTheme, Theme.Message.CompletedPersistTheme()),
    Command.expectHas(Theme.ApplyTheme({ resolved: 'night' })),
    Command.resolve(Theme.ApplyTheme, Theme.Message.CompletedApplyTheme()),
  )
})

test('an operating-system switch repaints only the automatic theme', () => {
  story(
    update,
    givenTheme('auto', 'system'),
    message(changedSystemDark(true)),
    model(next => {
      expect(next.theme.isSystemDark).toBe(true)
    }),
    Command.expectHas(Theme.ApplyTheme({ resolved: 'talidark' })),
    Command.resolve(Theme.ApplyTheme, Theme.Message.CompletedApplyTheme()),
  )

  story(
    update,
    givenTheme('night', 'dark'),
    message(changedSystemDark(false)),
    model(next => {
      expect(next.theme.isSystemDark).toBe(false)
    }),
    Command.expectNone(),
  )
})

test('init restores a saved theme and applies it after the boot script', () => {
  const init = Theme.init({
    maybeSavedTheme: Option.some('dim'),
    maybeSavedMode: Option.some('dark'),
    isSystemDark: false,
  })

  expect(init.model.theme).toBe('dim')
  expect(init.model.mode).toBe('dark')
  expect(init.commands).toBeDefined()
})

test('resolvedTheme follows the saved choice and the light/dark pair', () => {
  const automatic: Theme.Model = Theme.Model.make({
    theme: 'auto',
    mode: 'system',
    isSystemDark: true,
  })

  expect(Theme.resolvedTheme(automatic)).toBe('talidark')
  expect(
    Theme.resolvedTheme(
      Theme.Model.make({ theme: 'auto', mode: 'light', isSystemDark: true }),
    ),
  ).toBe('tali')
  expect(
    Theme.resolvedTheme(
      Theme.Model.make({ theme: 'cupcake', mode: 'dark', isSystemDark: true }),
    ),
  ).toBe('cupcake')
})
