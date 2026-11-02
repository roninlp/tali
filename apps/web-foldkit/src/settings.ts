import { Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { Email, type LoginKey } from '@tali/domain'

import { AuthFailure, authApi } from './lib/auth-api'
import { authErrorMessage } from './lib/auth-copy'
import { deriveLoginKey, passwordProblem } from './lib/login-key'
import { buttonView } from './ui/button'
import { fieldView, formErrorView, textInputView } from './ui/field'

/**
 * The Settings password form Submodel, ported from
 * `apps/web/src/routes/settings.tsx`.
 *
 * Both passwords are stretched to login keys in the browser with the same
 * `deriveLoginKey` recipe as login and registration, so the API verifies the
 * current key and stores a fresh verifier without ever seeing a password.
 * Validation runs before any derivation: the current field must be filled, the
 * new one must satisfy the policy, and the confirmation must match.
 *
 * The signed-in email arrives as an update input, so the root never has to
 * duplicate the session inside this Model and a stale email cannot outlive a
 * sign-in.
 */

// MODEL

export const Model = Schema.Struct({
  currentPassword: Schema.String,
  newPassword: Schema.String,
  confirmPassword: Schema.String,
  maybeError: Schema.Option(Schema.String),
  hasSucceeded: Schema.Boolean,
  isSubmitting: Schema.Boolean,
})
export type Model = typeof Model.Type

export const initialModel = (): Model =>
  Model.make({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
    maybeError: Option.none(),
    hasSucceeded: false,
    isSubmitting: false,
  })

/** The session values the form needs on each dispatch. */
export type Inputs = Readonly<{
  maybeEmail: Option.Option<string>
}>

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedCurrentPassword: { value: Schema.String },
  UpdatedNewPassword: { value: Schema.String },
  UpdatedConfirmPassword: { value: Schema.String },
  SubmittedPassword: {},
  SucceededChangePassword: {},
  FailedChangePassword: { failure: AuthFailure },
})
export type Message = typeof Message.Type

// COMMAND

const requestLoginKey = (
  password: string,
  email: Email,
): Effect.Effect<Option.Option<LoginKey>> =>
  Effect.option(
    Effect.tryPromise({
      try: () => deriveLoginKey(password, email),
      catch: () => undefined,
    }),
  )

const internalFailure = AuthFailure.make({
  code: 'InternalError',
  retryable: false,
})

export const ChangePassword = Command.define('ChangePassword', {
  args: {
    email: Schema.String,
    currentPassword: Schema.String,
    newPassword: Schema.String,
  },
  messages: [Message.SucceededChangePassword, Message.FailedChangePassword],
  execute: ({ email, currentPassword, newPassword }) =>
    Effect.gen(function* () {
      const maybeEmail = Schema.decodeOption(Email)(email)

      if (Option.isNone(maybeEmail)) {
        return Message.FailedChangePassword({
          failure: AuthFailure.make({ code: 'BadRequest', retryable: false }),
        })
      }

      const maybeCurrentLoginKey = yield* requestLoginKey(
        currentPassword,
        maybeEmail.value,
      )
      const maybeNewLoginKey = yield* requestLoginKey(
        newPassword,
        maybeEmail.value,
      )

      if (
        Option.isNone(maybeCurrentLoginKey) ||
        Option.isNone(maybeNewLoginKey)
      ) {
        return Message.FailedChangePassword({ failure: internalFailure })
      }

      const result = yield* authApi.changePassword({
        currentLoginKey: maybeCurrentLoginKey.value,
        newLoginKey: maybeNewLoginKey.value,
      })

      return result.ok
        ? Message.SucceededChangePassword()
        : Message.FailedChangePassword({ failure: result.error })
    }),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

/** The legacy component remounted on every visit, so leaving drops the form. */
export const reset = (_model: Model): UpdateReturn => ({
  model: initialModel(),
})

const validationProblem = (model: Model): Option.Option<string> => {
  if (model.currentPassword === '') {
    return Option.some('گذرواژه‌ی فعلی را وارد کنید.')
  }

  const problem = passwordProblem(model.newPassword)

  if (problem !== undefined) {
    return Option.some(problem)
  }

  if (model.newPassword !== model.confirmPassword) {
    return Option.some('گذرواژه‌ی تازه و تکرار آن یکسان نیست.')
  }

  return Option.none()
}

export const update = (
  model: Model,
  message: Message,
  inputs: Inputs,
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    UpdatedCurrentPassword: ({ value }) => ({
      model: modifyFields(model, { currentPassword: () => value }),
    }),

    UpdatedNewPassword: ({ value }) => ({
      model: modifyFields(model, { newPassword: () => value }),
    }),

    UpdatedConfirmPassword: ({ value }) => ({
      model: modifyFields(model, { confirmPassword: () => value }),
    }),

    SubmittedPassword: () => {
      if (model.isSubmitting) {
        return { model }
      }

      const maybeProblem = validationProblem(model)

      if (Option.isSome(maybeProblem)) {
        return {
          model: modifyFields(model, { maybeError: () => maybeProblem }),
        }
      }

      const maybeEmail = Option.flatMap(inputs.maybeEmail, email =>
        Schema.decodeOption(Email)(email),
      )

      if (Option.isNone(maybeEmail)) {
        return {
          model: modifyFields(model, {
            maybeError: () => Option.some(authErrorMessage('Unauthorized')),
          }),
        }
      }

      return {
        model: modifyFields(model, {
          isSubmitting: () => true,
          maybeError: () => Option.none(),
          hasSucceeded: () => false,
        }),
        commands: [
          ChangePassword({
            email: maybeEmail.value,
            currentPassword: model.currentPassword,
            newPassword: model.newPassword,
          }),
        ],
      }
    },

    SucceededChangePassword: () => ({
      model: modifyFields(model, {
        currentPassword: () => '',
        newPassword: () => '',
        confirmPassword: () => '',
        isSubmitting: () => false,
        maybeError: () => Option.none(),
        hasSucceeded: () => true,
      }),
    }),

    FailedChangePassword: ({ failure }) => ({
      model: modifyFields(model, {
        isSubmitting: () => false,
        hasSucceeded: () => false,
        maybeError: () => Option.some(authErrorMessage(failure.code)),
      }),
    }),
  })

// VIEW

const successView = (model: Model, h: HtmlBuilder<Message>): Html =>
  model.hasSucceeded
    ? h.div(
        [
          h.Role('status'),
          h.Class('alert alert-success py-2.5 text-sm leading-7'),
        ],
        [h.span([], ['گذرواژه تغییر کرد.'])],
      )
    : h.empty

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.form(
    [
      h.Class('panel grid gap-4 p-4 sm:p-5'),
      h.AriaLabelledBy('settings-password-title'),
      h.OnSubmit(Message.SubmittedPassword()),
    ],
    [
      h.header(
        [h.Class('grid gap-1')],
        [
          h.h2(
            [h.Id('settings-password-title'), h.Class('m-0 text-lg font-bold')],
            ['گذرواژه'],
          ),
          h.p(
            [h.Class('m-0 text-sm leading-7 text-base-content/55')],
            [
              'گذرواژه فقط در همین مرورگر به کلید ورود تبدیل می‌شود و به سرور نمی‌رسد.',
            ],
          ),
        ],
      ),
      fieldView(
        {
          id: 'settings-current',
          label: 'گذرواژه‌ی فعلی',
          children: [
            textInputView(
              {
                id: 'settings-current',
                type: 'password',
                name: 'currentPassword',
                autoComplete: 'current-password',
                value: model.currentPassword,
                isDisabled: model.isSubmitting,
                onInput: value => Message.UpdatedCurrentPassword({ value }),
              },
              h,
            ),
          ],
        },
        h,
      ),
      fieldView(
        {
          id: 'settings-new',
          label: 'گذرواژه‌ی تازه',
          hint: 'حداقل ۱۲ نویسه',
          children: [
            textInputView(
              {
                id: 'settings-new',
                type: 'password',
                name: 'newPassword',
                autoComplete: 'new-password',
                value: model.newPassword,
                isDisabled: model.isSubmitting,
                onInput: value => Message.UpdatedNewPassword({ value }),
              },
              h,
            ),
          ],
        },
        h,
      ),
      fieldView(
        {
          id: 'settings-confirm',
          label: 'تکرار گذرواژه‌ی تازه',
          children: [
            textInputView(
              {
                id: 'settings-confirm',
                type: 'password',
                name: 'confirmPassword',
                autoComplete: 'new-password',
                value: model.confirmPassword,
                isDisabled: model.isSubmitting,
                onInput: value => Message.UpdatedConfirmPassword({ value }),
              },
              h,
            ),
          ],
        },
        h,
      ),
      formErrorView(model.maybeError, h),
      successView(model, h),
      buttonView(
        {
          type: 'submit',
          class: 'w-full',
          isDisabled: model.isSubmitting,
          isLoading: model.isSubmitting,
          children: ['تغییر گذرواژه'],
        },
        h,
      ),
    ],
  ),
)
