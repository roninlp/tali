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

import type { AuthFailure } from '../lib/auth-api'
import { Message, SubmitLogin, initialModel, update, view } from './login'

const invalidCredentials: AuthFailure = {
  code: 'InvalidCredentials',
  retryable: false,
}

const emailField = label('ایمیل')
const passwordField = label('گذرواژه')
const submitButton = role('button', { name: 'ورود' })

describe('login screen', () => {
  test('renders the heading, both fields, and the submit button', () => {
    scene(
      { update, view },
      given(initialModel()),
      expect(role('heading', { name: 'ورود به تالی' })).toExist(),
      expect(emailField).toExist(),
      expect(passwordField).toExist(),
      expect(submitButton).toExist(),
      expect(role('link', { name: 'ثبت‌نام کنید' })).toExist(),
    )
  })

  test('submitting an empty form shows the validation message', () => {
    scene(
      { update, view },
      given(initialModel()),
      submit(role('form')),
      expect(text('ایمیل و گذرواژه را وارد کنید.')).toExist(),
      Command.expectNone(),
    )
  })

  test('a failed login shows the server message', () => {
    scene(
      { update, view },
      given(initialModel()),
      type(emailField, 'owner@example.com'),
      type(passwordField, 'correct horse battery'),
      submit(role('form')),
      Command.expectExact(SubmitLogin),
      Command.resolve(
        SubmitLogin,
        Message.FailedLogin({ failure: invalidCredentials }),
      ),
      expect(text('ایمیل یا گذرواژه درست نیست.')).toExist(),
      expect(submitButton).toBeEnabled(),
    )
  })
})
