import { Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { Email } from '@tali/domain'

import { AuthFailure, authApi } from '../lib/auth-api'
import { authErrorMessage } from '../lib/auth-copy'
import { deriveLoginKey } from '../lib/login-key'
import { registerRouter } from '../route'
import { Session } from '../session'
import { authCardView, authFooterLinkView } from '../ui/auth-card'
import { buttonView } from '../ui/button'
import { formErrorView, textInputView } from '../ui/field'

// MODEL

export const Model = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
  maybeError: Schema.Option(Schema.String),
  isSubmitting: Schema.Boolean,
})
export type Model = typeof Model.Type

export const initialModel = (): Model =>
  Model.make({
    email: '',
    password: '',
    maybeError: Option.none(),
    isSubmitting: false,
  })

// MESSAGE

export const OutMessage = defineMessageUnion({
  SucceededLogin: { session: Session },
})
export type OutMessage = typeof OutMessage.Type

export const Message = defineMessageUnion({
  UpdatedEmail: { value: Schema.String },
  UpdatedPassword: { value: Schema.String },
  SubmittedForm: {},
  SucceededLogin: { session: Session },
  FailedLogin: { failure: AuthFailure },
})
export type Message = typeof Message.Type

// COMMAND

export const SubmitLogin = Command.define('SubmitLogin', {
  args: { email: Schema.String, password: Schema.String },
  messages: [Message.SucceededLogin, Message.FailedLogin],
  execute: ({ email, password }) =>
    Effect.gen(function* () {
      const maybeEmail = Schema.decodeOption(Email)(email)

      if (Option.isNone(maybeEmail)) {
        return Message.FailedLogin({
          failure: AuthFailure.make({ code: 'BadRequest', retryable: false }),
        })
      }

      const maybeLoginKey = yield* Effect.option(
        Effect.tryPromise({
          try: () => deriveLoginKey(password, maybeEmail.value),
          catch: () => undefined,
        }),
      )

      if (Option.isNone(maybeLoginKey)) {
        return Message.FailedLogin({
          failure: AuthFailure.make({
            code: 'InternalError',
            retryable: false,
          }),
        })
      }

      const result = yield* authApi.login({
        email: maybeEmail.value,
        loginKey: maybeLoginKey.value,
      })

      return result.ok
        ? Message.SucceededLogin({ session: result.value })
        : Message.FailedLogin({ failure: result.error })
    }),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    UpdatedEmail: ({ value }) => ({
      model: modifyFields(model, { email: () => value }),
    }),

    UpdatedPassword: ({ value }) => ({
      model: modifyFields(model, { password: () => value }),
    }),

    SubmittedForm: () => {
      if (model.isSubmitting) {
        return { model }
      }

      if (model.email.trim() === '' || model.password === '') {
        return {
          model: modifyFields(model, {
            maybeError: () => Option.some('ایمیل و گذرواژه را وارد کنید.'),
          }),
        }
      }

      return {
        model: modifyFields(model, {
          isSubmitting: () => true,
          maybeError: () => Option.none(),
        }),
        commands: [
          SubmitLogin({
            email: model.email.trim(),
            password: model.password,
          }),
        ],
      }
    },

    SucceededLogin: ({ session }) => ({
      model: modifyFields(model, {
        isSubmitting: () => false,
        maybeError: () => Option.none(),
      }),
      outMessage: OutMessage.SucceededLogin({ session }),
    }),

    FailedLogin: ({ failure }) => ({
      model: modifyFields(model, {
        isSubmitting: () => false,
        maybeError: () => Option.some(authErrorMessage(failure.code)),
      }),
    }),
  })

// VIEW

export const view = Submodel.defineView<Model, Message>((model, h) =>
  authCardView(
    {
      title: 'ورود به تالی',
      subtitle: 'برنامه‌ریز مشترک خانه‌ی شما.',
      children: [
        h.form(
          [h.Class('grid gap-3.5'), h.OnSubmit(Message.SubmittedForm())],
          [
            textInputView(
              {
                id: 'login-email',
                label: 'ایمیل',
                type: 'email',
                name: 'email',
                autoComplete: 'email',
                dir: 'ltr',
                value: model.email,
                isDisabled: model.isSubmitting,
                onInput: value => Message.UpdatedEmail({ value }),
              },
              h,
            ),
            textInputView(
              {
                id: 'login-password',
                label: 'گذرواژه',
                type: 'password',
                name: 'password',
                autoComplete: 'current-password',
                value: model.password,
                isDisabled: model.isSubmitting,
                onInput: value => Message.UpdatedPassword({ value }),
              },
              h,
            ),
            formErrorView(model.maybeError, h),
            buttonView(
              {
                type: 'submit',
                class: 'w-full',
                isDisabled: model.isSubmitting,
                isLoading: model.isSubmitting,
                children: ['ورود'],
              },
              h,
            ),
          ],
        ),
        authFooterLinkView(
          {
            href: registerRouter(),
            text: 'حساب ندارید؟',
            linkText: 'ثبت‌نام کنید',
          },
          h,
        ),
      ],
    },
    h,
  ),
)
