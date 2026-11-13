import { Effect, Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import type { AuthFailure } from './lib/auth-api'
import * as Settings from './settings'
import { jsonResponse, stubFetch } from './test-http'

const EMAIL = 'owner@example.com'

const signedInInputs: Settings.Inputs = { maybeEmail: Option.some(EMAIL) }
const signedOutInputs: Settings.Inputs = { maybeEmail: Option.none() }

const update =
  (inputs: Settings.Inputs) =>
  (settings: Settings.Model, message: Settings.Message) =>
    Settings.update(settings, message, inputs)

const signedInUpdate = update(signedInInputs)

const filledModel = (): Settings.Model =>
  modifyFields(Settings.initialModel(), {
    currentPassword: () => 'old password value',
    newPassword: () => 'new password value',
    confirmPassword: () => 'new password value',
  })

const invalidCredentials: AuthFailure = {
  code: 'InvalidCredentials',
  retryable: false,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('password validation', () => {
  test('an empty current password is rejected first', () => {
    story(
      signedInUpdate,
      given(
        modifyFields(filledModel(), {
          currentPassword: () => '',
          newPassword: () => 'short',
        }),
      ),
      message(Settings.Message.SubmittedPassword()),
      model(settings => {
        expect(settings.maybeError).toStrictEqual(
          Option.some('گذرواژه‌ی فعلی را وارد کنید.'),
        )
        expect(settings.isSubmitting).toBe(false)
      }),
      Command.expectNone(),
    )
  })

  test('the new password must meet the browser policy', () => {
    story(
      signedInUpdate,
      given(
        modifyFields(filledModel(), {
          newPassword: () => '12345678901',
          confirmPassword: () => '12345678901',
        }),
      ),
      message(Settings.Message.SubmittedPassword()),
      model(settings => {
        expect(settings.maybeError).toStrictEqual(
          Option.some('گذرواژه باید حداقل ۱۲ نویسه باشد.'),
        )
        expect(settings.isSubmitting).toBe(false)
      }),
      Command.expectNone(),
    )
  })

  test('the confirmation must match the new password', () => {
    story(
      signedInUpdate,
      given(
        modifyFields(filledModel(), {
          confirmPassword: () => 'another password value',
        }),
      ),
      message(Settings.Message.SubmittedPassword()),
      model(settings => {
        expect(settings.maybeError).toStrictEqual(
          Option.some('گذرواژه‌ی تازه و تکرار آن یکسان نیست.'),
        )
        expect(settings.isSubmitting).toBe(false)
      }),
      Command.expectNone(),
    )
  })

  test('a signed-out form reports the ended session instead of calling the API', () => {
    story(
      update(signedOutInputs),
      given(filledModel()),
      message(Settings.Message.SubmittedPassword()),
      model(settings => {
        expect(settings.maybeError).toStrictEqual(
          Option.some('نشست شما پایان یافته است. دوباره وارد شوید.'),
        )
        expect(settings.isSubmitting).toBe(false)
      }),
      Command.expectNone(),
    )
  })
})

describe('password submission', () => {
  test('a valid form asks the command to derive both keys for the signed-in email', () => {
    story(
      signedInUpdate,
      given(filledModel()),
      message(Settings.Message.SubmittedPassword()),
      model(settings => {
        expect(settings.isSubmitting).toBe(true)
        expect(settings.maybeError).toStrictEqual(Option.none())
        expect(settings.hasSucceeded).toBe(false)
      }),
      Command.expectExact(
        Settings.ChangePassword({
          email: EMAIL,
          currentPassword: 'old password value',
          newPassword: 'new password value',
        }),
      ),
      Command.resolve(
        Settings.ChangePassword,
        Settings.Message.FailedChangePassword({ failure: invalidCredentials }),
      ),
      model(settings => {
        expect(settings.isSubmitting).toBe(false)
        expect(settings.hasSucceeded).toBe(false)
        expect(settings.currentPassword).toBe('old password value')
        expect(settings.maybeError).toStrictEqual(
          Option.some('ایمیل یا گذرواژه درست نیست.'),
        )
      }),
    )
  })

  test('a successful change clears the fields and confirms', () => {
    story(
      signedInUpdate,
      given(filledModel()),
      message(Settings.Message.SubmittedPassword()),
      Command.resolve(
        Settings.ChangePassword,
        Settings.Message.SucceededChangePassword(),
      ),
      model(settings => {
        expect(settings.isSubmitting).toBe(false)
        expect(settings.currentPassword).toBe('')
        expect(settings.newPassword).toBe('')
        expect(settings.confirmPassword).toBe('')
        expect(settings.maybeError).toStrictEqual(Option.none())
        expect(settings.hasSucceeded).toBe(true)
      }),
      Command.expectNone(),
    )
  })

  test('a failed change keeps the typed values so the user can retry', () => {
    story(
      signedInUpdate,
      given(filledModel()),
      message(Settings.Message.SubmittedPassword()),
      Command.resolve(
        Settings.ChangePassword,
        Settings.Message.FailedChangePassword({
          failure: { code: 'Network', retryable: true },
        }),
      ),
      model(settings => {
        expect(settings.currentPassword).toBe('old password value')
        expect(settings.newPassword).toBe('new password value')
        expect(settings.confirmPassword).toBe('new password value')
        expect(settings.maybeError).toStrictEqual(
          Option.some(
            'ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی کنید.',
          ),
        )
      }),
      Command.expectNone(),
    )
  })

  test('a second submit while the first is running sends nothing', () => {
    story(
      signedInUpdate,
      given(
        modifyFields(filledModel(), {
          isSubmitting: () => true,
        }),
      ),
      message(Settings.Message.SubmittedPassword()),
      Command.expectNone(),
      model(settings => {
        expect(settings.isSubmitting).toBe(true)
      }),
    )
  })
})

describe('password command', () => {
  test('derives both login keys in the browser and posts no password', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { ok: true }))

    const result = await Effect.runPromise(
      Settings.ChangePassword({
        email: EMAIL,
        currentPassword: 'old password value',
        newPassword: 'new password value',
      }).effect,
    )

    expect(result).toStrictEqual(Settings.Message.SucceededChangePassword())

    const init = fetchMock.mock.calls[0]?.[1]
    const body: unknown = JSON.parse(String(init?.body))

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/auth/change-password',
    )
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
    })
    expect(body).toStrictEqual({
      currentLoginKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      newLoginKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
    expect(body).not.toHaveProperty('currentPassword')
    expect(body).not.toHaveProperty('newPassword')
  })
})
