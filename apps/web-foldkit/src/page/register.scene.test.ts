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

import {
  Message,
  SubmitRegistration,
  initialModel,
  update,
  view,
} from './register'

const nameField = label('نام نمایشی')
const emailField = label('ایمیل')
const passwordField = label('گذرواژه')

describe('register screen', () => {
  test('renders the heading and all three fields', () => {
    scene(
      { update, view },
      given(initialModel()),
      expect(role('heading', { name: 'ساخت حساب' })).toExist(),
      expect(nameField).toExist(),
      expect(emailField).toExist(),
      expect(passwordField).toExist(),
      expect(role('link', { name: 'وارد شوید' })).toExist(),
    )
  })

  test('a short password shows the browser-side policy message', () => {
    scene(
      { update, view },
      given(initialModel()),
      type(nameField, 'مالک'),
      type(emailField, 'owner@example.com'),
      type(passwordField, 'short'),
      submit(role('form')),
      expect(text('گذرواژه باید حداقل ۱۲ نویسه باشد.')).toExist(),
      Command.expectNone(),
    )
  })

  test('a valid form requests registration', () => {
    scene(
      { update, view },
      given(initialModel()),
      type(nameField, 'مالک'),
      type(emailField, 'owner@example.com'),
      type(passwordField, 'correct horse battery'),
      submit(role('form')),
      Command.expectExact(SubmitRegistration),
      Command.resolve(
        SubmitRegistration,
        Message.FailedRegister({
          failure: { code: 'Network', retryable: true },
        }),
      ),
      expect(
        text('ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی کنید.'),
      ).toExist(),
    )
  })
})
