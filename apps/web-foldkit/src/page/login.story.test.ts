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
import { sessionWithHousehold } from '../test-fixtures'
import { Message, OutMessage, SubmitLogin, initialModel, update } from './login'

const invalidCredentials: AuthFailure = {
  code: 'InvalidCredentials',
  retryable: false,
}

const filledModel = modifyFields(initialModel(), {
  email: () => 'owner@example.com',
  password: () => 'correct horse battery',
})

describe('login form', () => {
  test('submitting an empty form asks for both fields', () => {
    story(
      update,
      given(initialModel()),
      message(Message.SubmittedForm()),
      model(model => {
        expect(model.maybeError).toStrictEqual(
          Option.some('ایمیل و گذرواژه را وارد کنید.'),
        )
        expect(model.isSubmitting).toBe(false)
      }),
      Command.expectNone(),
      expectNoOutMessage(),
    )
  })

  test('submitting a filled form derives the key and calls the API', () => {
    story(
      update,
      given(filledModel),
      message(Message.SubmittedForm()),
      model(model => {
        expect(model.isSubmitting).toBe(true)
        expect(model.maybeError).toStrictEqual(Option.none())
      }),
      Command.expectExact(
        SubmitLogin({
          email: 'owner@example.com',
          password: 'correct horse battery',
        }),
      ),
      Command.resolve(
        SubmitLogin,
        Message.FailedLogin({ failure: invalidCredentials }),
      ),
      model(model => {
        expect(model.isSubmitting).toBe(false)
        expect(model.maybeError).toStrictEqual(
          Option.some('ایمیل یا گذرواژه درست نیست.'),
        )
      }),
      expectNoOutMessage(),
    )
  })

  test('a successful login emits the session', () => {
    story(
      update,
      given(filledModel),
      message(Message.SubmittedForm()),
      Command.resolve(
        SubmitLogin,
        Message.SucceededLogin({ session: sessionWithHousehold }),
      ),
      model(model => {
        expect(model.isSubmitting).toBe(false)
      }),
      expectOutMessage(
        OutMessage.SucceededLogin({ session: sessionWithHousehold }),
      ),
    )
  })

  test('typing after a failure keeps the error until the next submit', () => {
    story(
      update,
      given(
        modifyFields(filledModel, {
          maybeError: () => Option.some('ایمیل یا گذرواژه درست نیست.'),
        }),
      ),
      message(Message.UpdatedEmail({ value: 'other@example.com' })),
      model(model => {
        expect(model.email).toBe('other@example.com')
        expect(model.maybeError).toStrictEqual(
          Option.some('ایمیل یا گذرواژه درست نیست.'),
        )
      }),
    )
  })
})
