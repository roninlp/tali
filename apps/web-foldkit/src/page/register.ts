import { Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { Email } from '@tali/domain'

import { AuthFailure, authApi } from '../lib/auth-api'
import { authErrorMessage } from '../lib/auth-copy'
import { deriveLoginKey, passwordProblem } from '../lib/login-key'
import { loginRouter } from '../route'
import { Session } from '../session'
import { authCardView, authFooterLinkView } from '../ui/auth-card'
import { buttonView } from '../ui/button'
import { formErrorView, textInputView } from '../ui/field'

// MODEL

export const Model = Schema.Struct({
  displayName: Schema.String,
  email: Schema.String,
  password: Schema.String,
  maybeError: Schema.Option(Schema.String),
  isSubmitting: Schema.Boolean,
})
export type Model = typeof Model.Type

export const initialModel = (): Model =>
  Model.make({
    displayName: '',
    email: '',
    password: '',
    maybeError: Option.none(),
    isSubmitting: false,
  })

// MESSAGE

export const OutMessage = defineMessageUnion({
  SucceededRegister: { session: Session },
})
export type OutMessage = typeof OutMessage.Type

export const Message = defineMessageUnion({
  UpdatedDisplayName: { value: Schema.String },
  UpdatedEmail: { value: Schema.String },
  UpdatedPassword: { value: Schema.String },
  SubmittedForm: {},
  SucceededRegister: { session: Session },
  FailedRegister: { failure: AuthFailure },
})
export type Message = typeof Message.Type

// COMMAND

/**
 * Detect the browser's IANA zone so a new account gets sensible date and
 * reminder defaults without asking. The settings screen can change it later.
 */
const detectedTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tehran'
  } catch {
    return 'Asia/Tehran'
  }
}

export const SubmitRegistration = Command.define('SubmitRegistration', {
  args: {
    displayName: Schema.String,
    email: Schema.String,
    password: Schema.String,
  },
  messages: [Message.SucceededRegister, Message.FailedRegister],
  execute: ({ displayName, email, password }) =>
    Effect.gen(function* () {
      const maybeEmail = Schema.decodeOption(Email)(email)

      if (Option.isNone(maybeEmail)) {
        return Message.FailedRegister({
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
        return Message.FailedRegister({
          failure: AuthFailure.make({
            code: 'InternalError',
            retryable: false,
          }),
        })
      }

      const result = yield* authApi.register({
        email: maybeEmail.value,
        loginKey: maybeLoginKey.value,
        displayName,
        timeZone: detectedTimeZone(),
      })

      return result.ok
        ? Message.SucceededRegister({ session: result.value })
        : Message.FailedRegister({ failure: result.error })
    }),
})

// UPDATE

const isEmail = (value: string): boolean =>
  /^\s*[^\s@]+@[^\s@]+\.[^\s@]+\s*$/.test(value)

const validationProblem = (model: Model): Option.Option<string> => {
  if (model.displayName.trim() === '') {
    return Option.some('نام نمایشی را وارد کنید.')
  }

  if (!isEmail(model.email)) {
    return Option.some('ایمیل معتبر وارد کنید.')
  }

  return Option.fromNullishOr(passwordProblem(model.password))
}

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    UpdatedDisplayName: ({ value }) => ({
      model: modifyFields(model, { displayName: () => value }),
    }),

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

      const maybeProblem = validationProblem(model)

      if (Option.isSome(maybeProblem)) {
        return {
          model: modifyFields(model, {
            maybeError: () => maybeProblem,
          }),
        }
      }

      return {
        model: modifyFields(model, {
          isSubmitting: () => true,
          maybeError: () => Option.none(),
        }),
        commands: [
          SubmitRegistration({
            displayName: model.displayName.trim(),
            email: model.email.trim(),
            password: model.password,
          }),
        ],
      }
    },

    SucceededRegister: ({ session }) => ({
      model: modifyFields(model, {
        isSubmitting: () => false,
        maybeError: () => Option.none(),
      }),
      outMessage: OutMessage.SucceededRegister({ session }),
    }),

    FailedRegister: ({ failure }) => ({
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
      title: 'ساخت حساب',
      subtitle:
        'برای شروع، یک حساب بسازید؛ بعد خانه‌ی مشترک را می‌سازید یا به آن می‌پیوندید.',
      children: [
        h.form(
          [h.Class('grid gap-3.5'), h.OnSubmit(Message.SubmittedForm())],
          [
            textInputView(
              {
                id: 'register-name',
                label: 'نام نمایشی',
                name: 'displayName',
                autoComplete: 'name',
                value: model.displayName,
                isDisabled: model.isSubmitting,
                onInput: value => Message.UpdatedDisplayName({ value }),
              },
              h,
            ),
            textInputView(
              {
                id: 'register-email',
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
                id: 'register-password',
                label: 'گذرواژه',
                hint: 'حداقل ۱۲ نویسه',
                type: 'password',
                name: 'password',
                autoComplete: 'new-password',
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
                children: ['ساخت حساب'],
              },
              h,
            ),
          ],
        ),
        authFooterLinkView(
          {
            href: loginRouter(),
            text: 'حساب دارید؟',
            linkText: 'وارد شوید',
          },
          h,
        ),
      ],
    },
    h,
  ),
)
