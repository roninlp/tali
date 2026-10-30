import { Command, click, expect, given, role, scene } from 'foldkit/scene'
import { describe, test } from 'vitest'

import * as Theme from './theme'

const model = (
  theme: Theme.ThemeChoice,
  mode: Theme.ThemeMode = 'light',
): Theme.Model => Theme.Model.make({ theme, mode, isSystemDark: false })

describe('theme picker', () => {
  test('marks the active mode and the active gallery theme', () => {
    scene(
      { update: Theme.update, view: Theme.pickerView },
      given(model('night', 'dark')),
      expect(role('heading', { name: 'ظاهر و پوسته' })).toExist(),
      expect(role('button', { name: 'سیستم' })).toHaveAttr(
        'aria-pressed',
        'false',
      ),
      expect(role('button', { name: 'پوسته شب' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
    )
  })

  test('choosing a mode returns to the house pair and persists it', () => {
    scene(
      { update: Theme.update, view: Theme.pickerView },
      given(model('dracula', 'dark')),
      click(role('button', { name: 'سیستم' })),
      Command.expectHas(Theme.PersistTheme({ theme: 'auto', mode: 'system' })),
      Command.resolve(
        Theme.PersistTheme,
        Theme.Message.CompletedPersistTheme(),
      ),
      Command.expectHas(Theme.ApplyTheme({ resolved: 'tali' })),
      Command.resolve(Theme.ApplyTheme, Theme.Message.CompletedApplyTheme()),
      expect(role('button', { name: 'سیستم' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
    )
  })

  test('choosing a gallery theme persists its light/dark nature', () => {
    scene(
      { update: Theme.update, view: Theme.pickerView },
      given(model('tali')),
      click(role('button', { name: 'پوسته دراکولا' })),
      Command.expectHas(Theme.PersistTheme({ theme: 'dracula', mode: 'dark' })),
      Command.resolve(
        Theme.PersistTheme,
        Theme.Message.CompletedPersistTheme(),
      ),
      Command.expectHas(Theme.ApplyTheme({ resolved: 'dracula' })),
      Command.resolve(Theme.ApplyTheme, Theme.Message.CompletedApplyTheme()),
    )
  })
})
