import { Option } from 'effect'
import {
  Command,
  expect,
  given,
  label,
  role,
  scene,
  submit,
  text,
  type,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import type { AuthFailure } from './lib/auth-api'
import * as Settings from './settings'

const EMAIL = 'owner@example.com'

const inputs: Settings.Inputs = { maybeEmail: Option.some(EMAIL) }

const passwordScene = {
  update: (settings: Settings.Model, message: Settings.Message) =>
    Settings.update(settings, message, inputs),
  view: Settings.view,
}

const currentField = label('گذرواژه‌ی فعلی')
const newField = label('گذرواژه‌ی تازه')
const confirmField = label('تکرار گذرواژه‌ی تازه')
const submitButton = role('button', { name: 'تغییر گذرواژه' })

const fillForm = () => [
  type(currentField, 'old password value'),
  type(newField, 'new password value'),
  type(confirmField, 'new password value'),
]

const invalidCredentials: AuthFailure = {
  code: 'InvalidCredentials',
  retryable: false,
}

describe('settings password form', () => {
  test('renders the heading, copy, three fields, and the submit button', () => {
    scene(
      passwordScene,
      given(Settings.initialModel()),
      expect(role('heading', { name: 'گذرواژه' })).toExist(),
      expect(
        text(
          'گذرواژه فقط در همین مرورگر به کلید ورود تبدیل می‌شود و به سرور نمی‌رسد.',
        ),
      ).toExist(),
      expect(currentField).toExist(),
      expect(newField).toExist(),
      expect(confirmField).toExist(),
      expect(text('حداقل ۱۲ نویسه')).toExist(),
      expect(submitButton).toExist(),
      expect(submitButton).toBeEnabled(),
    )
  })

  test('submitting an empty form asks for the current password', () => {
    scene(
      passwordScene,
      given(Settings.initialModel()),
      submit(role('form', { name: 'گذرواژه' })),
      expect(role('alert', { name: 'گذرواژه‌ی فعلی را وارد کنید.' })).toExist(),
      Command.expectNone(),
    )
  })

  test('an invalid new password shows the policy message', () => {
    scene(
      passwordScene,
      given(Settings.initialModel()),
      type(currentField, 'old password value'),
      type(newField, 'short'),
      type(confirmField, 'short'),
      submit(role('form', { name: 'گذرواژه' })),
      expect(
        role('alert', { name: 'گذرواژه باید حداقل ۱۲ نویسه باشد.' }),
      ).toExist(),
      Command.expectNone(),
    )
  })

  test('a mismatched confirmation shows the mismatch message', () => {
    scene(
      passwordScene,
      given(Settings.initialModel()),
      type(currentField, 'old password value'),
      type(newField, 'new password value'),
      type(confirmField, 'another password value'),
      submit(role('form', { name: 'گذرواژه' })),
      expect(
        role('alert', { name: 'گذرواژه‌ی تازه و تکرار آن یکسان نیست.' }),
      ).toExist(),
      Command.expectNone(),
    )
  })

  test('a running submit disables the fields and the button', () => {
    scene(
      passwordScene,
      given(Settings.initialModel()),
      ...fillForm(),
      submit(role('form', { name: 'گذرواژه' })),
      Command.expectExact(Settings.ChangePassword),
      expect(currentField).toBeDisabled(),
      expect(newField).toBeDisabled(),
      expect(confirmField).toBeDisabled(),
      expect(submitButton).toBeDisabled(),
      Command.resolve(
        Settings.ChangePassword,
        Settings.Message.SucceededChangePassword(),
      ),
      expect(submitButton).toBeEnabled(),
    )
  })

  test('a failed change shows the server message and re-enables the form', () => {
    scene(
      passwordScene,
      given(Settings.initialModel()),
      ...fillForm(),
      submit(role('form', { name: 'گذرواژه' })),
      Command.resolve(
        Settings.ChangePassword,
        Settings.Message.FailedChangePassword({ failure: invalidCredentials }),
      ),
      expect(role('alert', { name: 'ایمیل یا گذرواژه درست نیست.' })).toExist(),
      expect(submitButton).toBeEnabled(),
      expect(currentField).toBeEnabled(),
    )
  })

  test('a successful change clears the fields and confirms', () => {
    scene(
      passwordScene,
      given(Settings.initialModel()),
      ...fillForm(),
      submit(role('form', { name: 'گذرواژه' })),
      Command.resolve(
        Settings.ChangePassword,
        Settings.Message.SucceededChangePassword(),
      ),
      expect(role('status', { name: 'گذرواژه تغییر کرد.' })).toExist(),
      expect(currentField).toHaveValue(''),
      expect(newField).toHaveValue(''),
      expect(confirmField).toHaveValue(''),
      expect(submitButton).toBeEnabled(),
    )
  })
})
