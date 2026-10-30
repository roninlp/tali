import { expect, given, role, scene, text } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { Model, update, view } from './main'
import * as Theme from './theme'

const modelWithTheme = (theme: Theme.Theme): Model =>
  Model.make({ theme: Theme.Model.make({ theme }) })

describe('shell', () => {
  test('renders the Persian shell with the brand and landing copy', () => {
    scene(
      { update, view },
      given(modelWithTheme('Tali')),
      expect(role('banner')).toExist(),
      expect(role('heading', { name: 'تالی' })).toExist(),
      expect(text('برنامه‌ریز مشترک خانه‌ی شما.')).toExist(),
    )
  })

  test('the header offers the switch to the dark theme', () => {
    scene(
      { update, view },
      given(modelWithTheme('Tali')),
      expect(role('button', { name: 'حالت تیره' })).toExist(),
    )
  })

  test('the dark theme offers the switch back to light', () => {
    scene(
      { update, view },
      given(modelWithTheme('TaliDark')),
      expect(role('button', { name: 'حالت روشن' })).toExist(),
    )
  })
})
