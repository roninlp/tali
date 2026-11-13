import { Option } from 'effect'
import {
  Command,
  expectNoOutMessage,
  expectOutMessage,
  given,
  message,
  model,
  story,
} from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vite-plus/test'

import type { AuthFailure } from '../lib/auth-api'
import { sessionWithoutHousehold } from '../test-fixtures'
import {
  Message,
  OutMessage,
  SubmitRegistration,
  initialModel,
  update,
} from './register'

const emailAlreadyRegistered: AuthFailure = {
  code: 'EmailAlreadyRegistered',
  retryable: false,
}

const filledModel = modifyFields(initialModel(), {
  displayName: () => 'مالک',
  email: () => 'owner@example.com',
  password: () => 'correct horse battery',
})

describe('register form', () => {
  test('requires a display name', () => {
    story(
      update,
      given(
        modifyFields(initialModel(), {
          email: () => 'owner@example.com',
          password: () => 'correct horse battery',
        }),
      ),
      message(Message.SubmittedForm()),
      model(model => {
        expect(model.maybeError).toStrictEqual(
          Option.some('نام نمایشی را وارد کنید.'),
        )
      }),
      Command.expectNone(),
    )
  })

  test('requires a valid email', () => {
    story(
      update,
      given(
        modifyFields(initialModel(), {
          displayName: () => 'مالک',
          email: () => 'not-an-email',
          password: () => 'correct horse battery',
        }),
      ),
      message(Message.SubmittedForm()),
      model(model => {
        expect(model.maybeError).toStrictEqual(
          Option.some('ایمیل معتبر وارد کنید.'),
        )
      }),
      Command.expectNone(),
    )
  })

  test('enforces the twelve-character password minimum', () => {
    story(
      update,
      given(
        modifyFields(initialModel(), {
          displayName: () => 'مالک',
          email: () => 'owner@example.com',
          password: () => 'short',
        }),
      ),
      message(Message.SubmittedForm()),
      model(model => {
        expect(model.maybeError).toStrictEqual(
          Option.some('گذرواژه باید حداقل ۱۲ نویسه باشد.'),
        )
      }),
      Command.expectNone(),
    )
  })

  test('a valid form derives the key and calls the API', () => {
    story(
      update,
      given(filledModel),
      message(Message.SubmittedForm()),
      model(model => {
        expect(model.isSubmitting).toBe(true)
      }),
      Command.expectExact(
        SubmitRegistration({
          displayName: 'مالک',
          email: 'owner@example.com',
          password: 'correct horse battery',
        }),
      ),
      Command.resolve(
        SubmitRegistration,
        Message.FailedRegister({ failure: emailAlreadyRegistered }),
      ),
      model(model => {
        expect(model.isSubmitting).toBe(false)
        expect(model.maybeError).toStrictEqual(
          Option.some('این ایمیل قبلاً ثبت شده است. وارد شوید.'),
        )
      }),
      expectNoOutMessage(),
    )
  })

  test('a successful registration emits the session', () => {
    story(
      update,
      given(filledModel),
      message(Message.SubmittedForm()),
      Command.resolve(
        SubmitRegistration,
        Message.SucceededRegister({ session: sessionWithoutHousehold }),
      ),
      expectOutMessage(
        OutMessage.SucceededRegister({ session: sessionWithoutHousehold }),
      ),
    )
  })
})
