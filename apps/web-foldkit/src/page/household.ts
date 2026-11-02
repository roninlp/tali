import { Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { InviteCode } from '@tali/domain'

import { HouseholdSummary } from '../household-summary'
import { AuthFailure, authApi } from '../lib/auth-api'
import { authErrorMessage } from '../lib/auth-copy'
import { authCardView } from '../ui/auth-card'
import { buttonView } from '../ui/button'
import { formErrorView, textInputView } from '../ui/field'

// MODEL

const CreateForm = Schema.Struct({
  name: Schema.String,
  maybeError: Schema.Option(Schema.String),
  isSubmitting: Schema.Boolean,
})

const JoinForm = Schema.Struct({
  inviteCode: Schema.String,
  maybeError: Schema.Option(Schema.String),
  isSubmitting: Schema.Boolean,
})

export const Model = Schema.Struct({
  create: CreateForm,
  join: JoinForm,
  maybeCreated: Schema.Option(HouseholdSummary),
  isCopied: Schema.Boolean,
})
export type Model = typeof Model.Type

export const initialModel = (): Model =>
  Model.make({
    create: {
      name: 'خانه‌ی ما',
      maybeError: Option.none(),
      isSubmitting: false,
    },
    join: {
      inviteCode: '',
      maybeError: Option.none(),
      isSubmitting: false,
    },
    maybeCreated: Option.none(),
    isCopied: false,
  })

// MESSAGE

export const OutMessage = defineMessageUnion({
  CreatedHousehold: { householdId: Schema.String },
  JoinedHousehold: { householdId: Schema.String },
  AlreadyInHousehold: {},
  RequestedToday: {},
})
export type OutMessage = typeof OutMessage.Type

export const Message = defineMessageUnion({
  UpdatedHouseholdName: { value: Schema.String },
  UpdatedInviteCode: { value: Schema.String },
  SubmittedCreateHousehold: {},
  SubmittedJoinHousehold: {},
  SucceededCreateHousehold: { household: HouseholdSummary },
  FailedCreateHousehold: { failure: AuthFailure },
  SucceededJoinHousehold: { household: HouseholdSummary },
  FailedJoinHousehold: { failure: AuthFailure },
  ClickedCopyInviteCode: {},
  CompletedCopyInviteCode: { isCopied: Schema.Boolean },
  ClickedContinue: {},
})
export type Message = typeof Message.Type

// COMMAND

export const SubmitCreateHousehold = Command.define('SubmitCreateHousehold', {
  args: { name: Schema.String },
  messages: [Message.SucceededCreateHousehold, Message.FailedCreateHousehold],
  execute: ({ name }) =>
    authApi.createHousehold({ name }).pipe(
      Effect.map(result =>
        result.ok
          ? Message.SucceededCreateHousehold({
              household: result.value.household,
            })
          : Message.FailedCreateHousehold({ failure: result.error }),
      ),
    ),
})

export const SubmitJoinHousehold = Command.define('SubmitJoinHousehold', {
  args: { inviteCode: InviteCode },
  messages: [Message.SucceededJoinHousehold, Message.FailedJoinHousehold],
  execute: ({ inviteCode }) =>
    authApi.joinHousehold({ inviteCode }).pipe(
      Effect.map(result =>
        result.ok
          ? Message.SucceededJoinHousehold({
              household: result.value.household,
            })
          : Message.FailedJoinHousehold({ failure: result.error }),
      ),
    ),
})

export const CopyInviteCode = Command.define('CopyInviteCode', {
  args: { inviteCode: Schema.String },
  messages: [Message.CompletedCopyInviteCode],
  execute: ({ inviteCode }) =>
    Effect.tryPromise({
      try: () => navigator.clipboard.writeText(inviteCode).then(() => true),
      catch: () => false,
    }).pipe(
      Effect.catch(() => Effect.succeed(false)),
      Effect.map(isCopied => Message.CompletedCopyInviteCode({ isCopied })),
    ),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    UpdatedHouseholdName: ({ value }) => ({
      model: modifyFields(model, {
        create: () => modifyFields(model.create, { name: () => value }),
      }),
    }),

    UpdatedInviteCode: ({ value }) => ({
      model: modifyFields(model, {
        join: () => modifyFields(model.join, { inviteCode: () => value }),
      }),
    }),

    SubmittedCreateHousehold: () => {
      if (model.create.isSubmitting) {
        return { model }
      }

      if (model.create.name.trim() === '') {
        return {
          model: modifyFields(model, {
            create: () =>
              modifyFields(model.create, {
                maybeError: () => Option.some('نام خانه را وارد کنید.'),
              }),
          }),
        }
      }

      return {
        model: modifyFields(model, {
          create: () =>
            modifyFields(model.create, {
              isSubmitting: () => true,
              maybeError: () => Option.none(),
            }),
        }),
        commands: [SubmitCreateHousehold({ name: model.create.name.trim() })],
      }
    },

    SubmittedJoinHousehold: () => {
      if (model.join.isSubmitting) {
        return { model }
      }

      if (model.join.inviteCode.trim() === '') {
        return {
          model: modifyFields(model, {
            join: () =>
              modifyFields(model.join, {
                maybeError: () => Option.some('کد دعوت را وارد کنید.'),
              }),
          }),
        }
      }

      return {
        model: modifyFields(model, {
          join: () =>
            modifyFields(model.join, {
              isSubmitting: () => true,
              maybeError: () => Option.none(),
            }),
        }),
        commands: [
          SubmitJoinHousehold({
            inviteCode: InviteCode.make(model.join.inviteCode.trim()),
          }),
        ],
      }
    },

    SucceededCreateHousehold: ({ household }) => ({
      model: modifyFields(model, {
        create: () =>
          modifyFields(model.create, {
            isSubmitting: () => false,
            maybeError: () => Option.none(),
          }),
        maybeCreated: () => Option.some(household),
        isCopied: () => false,
      }),
      outMessage: OutMessage.CreatedHousehold({
        householdId: household.id,
      }),
    }),

    FailedCreateHousehold: ({ failure }) =>
      failure.code === 'AlreadyInHousehold'
        ? {
            model: modifyFields(model, {
              create: () =>
                modifyFields(model.create, {
                  isSubmitting: () => false,
                  maybeError: () => Option.none(),
                }),
            }),
            outMessage: OutMessage.AlreadyInHousehold(),
          }
        : {
            model: modifyFields(model, {
              create: () =>
                modifyFields(model.create, {
                  isSubmitting: () => false,
                  maybeError: () => Option.some(authErrorMessage(failure.code)),
                }),
            }),
          },

    SucceededJoinHousehold: ({ household }) => ({
      model: modifyFields(model, {
        join: () =>
          modifyFields(model.join, {
            isSubmitting: () => false,
            maybeError: () => Option.none(),
          }),
      }),
      outMessage: OutMessage.JoinedHousehold({
        householdId: household.id,
      }),
    }),

    FailedJoinHousehold: ({ failure }) =>
      failure.code === 'AlreadyInHousehold'
        ? {
            model: modifyFields(model, {
              join: () =>
                modifyFields(model.join, {
                  isSubmitting: () => false,
                  maybeError: () => Option.none(),
                }),
            }),
            outMessage: OutMessage.AlreadyInHousehold(),
          }
        : {
            model: modifyFields(model, {
              join: () =>
                modifyFields(model.join, {
                  isSubmitting: () => false,
                  maybeError: () => Option.some(authErrorMessage(failure.code)),
                }),
            }),
          },

    ClickedCopyInviteCode: () =>
      Option.match(model.maybeCreated, {
        onNone: () => ({ model }),
        onSome: summary => ({
          model,
          commands: [CopyInviteCode({ inviteCode: summary.inviteCode })],
        }),
      }),

    CompletedCopyInviteCode: ({ isCopied }) => ({
      model: modifyFields(model, { isCopied: () => isCopied }),
    }),

    ClickedContinue: () => ({
      model,
      outMessage: OutMessage.RequestedToday(),
    }),
  })

// VIEW

export type ViewInputs = Readonly<{
  maybeDisplayName: Option.Option<string>
}>

const dividerView = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Role('separator'),
      h.Class('flex items-center gap-2.5 text-base-content/50'),
    ],
    [
      h.span([h.Class('h-px flex-1 bg-base-300')]),
      h.span([h.Class('text-[0.8rem] opacity-80')], ['یا']),
      h.span([h.Class('h-px flex-1 bg-base-300')]),
    ],
  )

const createFormView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Class('grid gap-3'), h.OnSubmit(Message.SubmittedCreateHousehold())],
    [
      h.h2([h.Class('m-0 text-lg font-bold')], ['ساختن خانه']),
      textInputView(
        {
          id: 'household-name',
          label: 'نام خانه',
          name: 'householdName',
          value: model.create.name,
          isDisabled: model.create.isSubmitting,
          onInput: value => Message.UpdatedHouseholdName({ value }),
        },
        h,
      ),
      formErrorView(model.create.maybeError, h),
      buttonView(
        {
          type: 'submit',
          class: 'w-full',
          isDisabled: model.create.isSubmitting,
          isLoading: model.create.isSubmitting,
          children: ['ساختن خانه'],
        },
        h,
      ),
    ],
  )

const joinFormView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Class('grid gap-3'), h.OnSubmit(Message.SubmittedJoinHousehold())],
    [
      h.h2([h.Class('m-0 text-lg font-bold')], ['پیوستن به خانه']),
      textInputView(
        {
          id: 'household-invite',
          label: 'کد دعوت',
          name: 'inviteCode',
          dir: 'ltr',
          autoComplete: 'off',
          value: model.join.inviteCode,
          isDisabled: model.join.isSubmitting,
          onInput: value => Message.UpdatedInviteCode({ value }),
        },
        h,
      ),
      formErrorView(model.join.maybeError, h),
      buttonView(
        {
          type: 'submit',
          variant: 'ghost',
          class: 'w-full',
          isDisabled: model.join.isSubmitting,
          isLoading: model.join.isSubmitting,
          children: ['پیوستن'],
        },
        h,
      ),
    ],
  )

const invitePanelView = (
  summary: HouseholdSummary,
  isCopied: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('grid gap-3')],
    [
      h.h2([h.Class('m-0 text-lg font-bold')], ['خانه ساخته شد']),
      h.p(
        [h.Class('m-0 text-sm leading-8 text-base-content/55')],
        [
          `کد دعوت «${summary.name}» را برای نفر دوم بفرستید. او با این کد به خانه می‌پیوندد.`,
        ],
      ),
      h.code(
        [
          h.DataAttribute('testid', 'household-invite-code'),
          h.Dir('ltr'),
          h.Class(
            'block rounded-field border border-dashed border-base-300 bg-base-200 p-3 text-center text-base tracking-[0.08em] break-all',
          ),
        ],
        [summary.inviteCode],
      ),
      h.div(
        [h.Class('flex gap-2')],
        [
          buttonView(
            {
              variant: 'ghost',
              children: [isCopied ? 'کپی شد' : 'کپی کد'],
              onClick: Message.ClickedCopyInviteCode(),
            },
            h,
          ),
          buttonView(
            {
              class: 'flex-1',
              children: ['ادامه به امروز'],
              onClick: Message.ClickedContinue(),
            },
            h,
          ),
        ],
      ),
    ],
  )

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, viewInputs, h) =>
    authCardView(
      {
        title: 'خانه‌ی مشترک',
        subtitle:
          'تالی برای دو نفر ساخته شده: یک خانه، دو حساب. یکی خانه را می‌سازد و دیگری با کد دعوت به آن می‌پیوندد.',
        children: [
          Option.match(model.maybeCreated, {
            onNone: () =>
              h.div(
                [h.Class('grid gap-4')],
                [
                  Option.match(viewInputs.maybeDisplayName, {
                    onNone: () => h.empty,
                    onSome: name =>
                      h.p(
                        [h.Class('m-0 text-sm text-base-content/55')],
                        [`خوش آمدید، ${name}.`],
                      ),
                  }),
                  createFormView(model, h),
                  dividerView(h),
                  joinFormView(model, h),
                ],
              ),
            onSome: summary => invitePanelView(summary, model.isCopied, h),
          }),
        ],
      },
      h,
    ),
)
