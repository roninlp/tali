import { Option } from 'effect'
import type { HtmlBuilder } from 'foldkit/html'
import { expect, given, role, scene, text } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { fieldView, formErrorView, textInputView } from './field'

type Model = Readonly<{ maybeError: Option.Option<string> }>

type Message = Readonly<{ _tag: 'UpdatedEmail'; value: string }>

const update = (model: Model, _message: Message) => ({ model })

const updatedEmail = (value: string): Message => ({
  _tag: 'UpdatedEmail',
  value,
})

const view = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [],
    [
      fieldView(
        {
          id: 'email',
          label: 'ایمیل',
          hint: 'نشانی ورود شما',
          children: [
            textInputView(
              {
                id: 'email',
                type: 'email',
                value: '',
                onInput: updatedEmail,
              },
              h,
            ),
          ],
        },
        h,
      ),
      formErrorView(model.maybeError, h),
    ],
  )

describe('field primitives', () => {
  test('associates the label with the input and renders the hint', () => {
    scene(
      { update, view },
      given({ maybeError: Option.none<string>() }),
      expect(role('textbox', { name: 'ایمیل' })).toExist(),
      expect(text('نشانی ورود شما')).toExist(),
    )
  })

  test('renders the form error as an alert', () => {
    scene(
      { update, view },
      given({ maybeError: Option.some('ایمیل نامعتبر است.') }),
      expect(role('alert')).toExist(),
      expect(text('ایمیل نامعتبر است.')).toExist(),
    )
  })

  test('renders no alert without an error', () => {
    scene(
      { update, view },
      given({ maybeError: Option.none<string>() }),
      expect(role('alert')).toBeAbsent(),
    )
  })
})
