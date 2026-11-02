import { Command, click, expect, given, role, scene } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { RadioGroup } from '@foldkit/ui'
import * as Theme from './theme'

const model = (
  theme: Theme.ThemeChoice,
  mode: Theme.ThemeMode = 'light',
): Theme.Model =>
  Theme.Model.make({
    theme,
    mode,
    isSystemDark: false,
    modePicker: RadioGroup.init({ id: 'theme-mode-picker' }),
  })

describe('theme picker', () => {
  test('marks the active mode inside the segmented control', () => {
    scene(
      { update: Theme.update, view: Theme.pickerView },
      given(model('talidark', 'dark')),
      expect(role('heading', { name: 'ظاهر' })).toExist(),
      expect(role('radio', { name: 'تیره' })).toHaveAttr('aria-checked', 'true'),
      expect(role('radio', { name: 'روشن' })).toHaveAttr(
        'aria-checked',
        'false',
      ),
    )
  })

  test('choosing a mode returns to the house pair and persists it', () => {
    scene(
      { update: Theme.update, view: Theme.pickerView },
      given(model('talidark', 'dark')),
      click(role('radio', { name: 'سیستم' })),
      Command.resolve(
        RadioGroup.FocusOption,
        RadioGroup.Message.CompletedFocusOption(),
      ),
      Command.expectHas(Theme.PersistTheme({ theme: 'auto', mode: 'system' })),
      Command.resolve(
        Theme.PersistTheme,
        Theme.Message.CompletedPersistTheme(),
      ),
      Command.expectHas(Theme.ApplyTheme({ resolved: 'tali' })),
      Command.resolve(Theme.ApplyTheme, Theme.Message.CompletedApplyTheme()),
      expect(role('radio', { name: 'سیستم' })).toHaveAttr(
        'aria-checked',
        'true',
      ),
    )
  })

  test('the picker is a labelled radio group', () => {
    scene(
      { update: Theme.update, view: Theme.pickerView },
      given(model('tali')),
      expect(role('radiogroup', { name: 'حالت روشن یا تیره' })).toExist(),
      expect(role('radio', { name: 'روشن' })).toHaveAttr('aria-checked', 'true'),
    )
  })
})
