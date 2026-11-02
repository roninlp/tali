import type { HtmlBuilder } from 'foldkit/html'
import { expect, given, role, scene } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { buttonView } from './button'

type Model = Readonly<{ unused: true }>

const model: Model = { unused: true }

const update = (current: Model) => ({ model: current })

const view = (_model: Model, h: HtmlBuilder<never>) =>
  h.div(
    [],
    [
      buttonView({ children: ['ذخیره'], type: 'submit' }, h),
      buttonView({ children: ['در حال ذخیره'], isLoading: true }, h),
      buttonView({ children: [], ariaLabel: 'بستن', isSquare: true }, h),
    ],
  )

describe('buttonView', () => {
  test('renders a labelled submit button', () => {
    scene(
      { update, view },
      given(model),
      expect(role('button', { name: 'ذخیره' })).toExist(),
    )
  })

  test('renders a loading button as disabled', () => {
    scene(
      { update, view },
      given(model),
      expect(role('button', { name: 'در حال ذخیره' })).toBeDisabled(),
    )
  })

  test('a square icon button takes its accessible name from ariaLabel', () => {
    scene(
      { update, view },
      given(model),
      expect(role('button', { name: 'بستن' })).toExist(),
    )
  })
})
