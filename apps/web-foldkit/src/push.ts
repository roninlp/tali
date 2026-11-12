import { Array, Effect, Option, Schema, Stream } from 'effect'
import { Command, Submodel, Subscription, Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { type AuthFailure } from './lib/auth-api'
import { authErrorMessage } from './lib/auth-copy'
import { API_URL, isDevServer } from './lib/config'
import { loadVapidPublicKey } from './lib/push/config'
import {
  QueuedReminderAction,
  ReminderActionMessage,
  flushQueuedReminderActions,
  readQueuedReminderActions,
  respondToDispatch,
} from './lib/push/notification-actions'
import { registerPushSubscription } from './lib/push/push-api'
import {
  PushEnvironment,
  PushPermission,
  detectPushEnvironment,
  findSubscription,
  registerServiceWorker,
  requestNotificationPermission,
  shareConfigWithWorker,
  subscribeThisDevice,
  unsubscribeThisDevice,
} from './lib/push/service-worker'
import {
  PushSubscriptionJson,
  toRegistrationInput,
} from './lib/push/subscription'
import { buttonView } from './ui/button'
import { eventStream, visibilityEvents } from './ui/dom-stream'
import { formErrorView } from './ui/field'

/**
 * The client half of the Web Push shell (ticket #20), ported from
 * `apps/web/src/lib/push/context.tsx`.
 *
 * Owns: service-worker registration, the VAPID-restricted `PushSubscription`
 * (with the key read from `GET /push/vapid`), its registration with
 * `POST /push/register`, the permission/health state `/settings` and
 * `/push-health` render, and the page drain for queued Done/Snooze taps.
 *
 * What it deliberately does **not** own: scheduling or dispatch. The server's
 * per-minute sweep sends; this Submodel makes sure the device is subscribed and
 * the worker knows the API origin.
 */

// MODEL

/** The service worker's subscription-change broadcast. */
const PushSubscriptionChangeMessage = Schema.Struct({
  type: Schema.Literal('tali:push-subscription-change'),
})

export const Model = Schema.Struct({
  maybeUserId: Schema.Option(Schema.String),
  environment: PushEnvironment,
  /** The server's VAPID public key (empty while unknown / unconfigured). */
  publicKey: Schema.String,
  maybeSubscription: Schema.Option(PushSubscriptionJson),
  isBusy: Schema.Boolean,
  maybeError: Schema.Option(Schema.String),
  /** Last Done/Snooze tap the service worker queued (stub consumer). */
  maybeLastAction: Schema.Option(QueuedReminderAction),
  isCopied: Schema.Boolean,
})

export type Model = typeof Model.Type

export const initialModel = (
  environment: PushEnvironment = detectPushEnvironment(),
): Model =>
  Model.make({
    maybeUserId: Option.none(),
    environment,
    publicKey: '',
    maybeSubscription: Option.none(),
    isBusy: false,
    maybeError: Option.none(),
    maybeLastAction: Option.none(),
    isCopied: false,
  })

// MESSAGE

export const Message = defineMessageUnion({
  CompletedRegisterPushWorker: {},
  SucceededRefreshPush: {
    maybeUserId: Schema.Option(Schema.String),
    environment: PushEnvironment,
    publicKey: Schema.String,
    maybeSubscription: Schema.Option(PushSubscriptionJson),
    maybeError: Schema.Option(Schema.String),
  },
  ClickedEnablePush: {},
  SucceededEnablePush: {
    maybeUserId: Schema.Option(Schema.String),
    environment: PushEnvironment,
    subscription: PushSubscriptionJson,
    maybeError: Schema.Option(Schema.String),
  },
  FailedEnablePush: {
    maybeUserId: Schema.Option(Schema.String),
    environment: PushEnvironment,
    message: Schema.String,
  },
  ClickedDisablePush: {},
  SucceededDisablePush: { maybeUserId: Schema.Option(Schema.String) },
  FailedDisablePush: {
    maybeUserId: Schema.Option(Schema.String),
    message: Schema.String,
  },
  ClickedRefreshPush: {},
  ClickedCopySubscription: {},
  CompletedCopySubscription: { isCopied: Schema.Boolean },
  ChangedVisibility: { isVisible: Schema.Boolean },
  CompletedReadPushEnvironment: { environment: PushEnvironment },
  ReceivedReminderAction: {
    dispatchId: Schema.String,
    action: Schema.Literals(['done', 'snooze']),
    snoozeMinutes: Schema.Option(Schema.Int),
    at: Schema.String,
  },
  ReceivedPushSubscriptionChange: {},
  CompletedReadReminderActions: {
    maybeLastAction: Schema.Option(QueuedReminderAction),
  },
  CompletedDrainReminderActions: {
    drained: Schema.Int,
    maybeLastAction: Schema.Option(QueuedReminderAction),
  },
})

export type Message = typeof Message.Type

// COMMAND

const pushFailureMessage = (code: AuthFailure['code']): string => {
  if (code === 'Unauthorized') {
    return 'برای ثبت اشتراک اعلان باید وارد شوید.'
  }

  if (code === 'BadRequest') {
    return 'مرورگر اطلاعات اشتراک را به شکل نامعتبر فرستاد.'
  }

  if (code === 'Network') {
    return 'ارتباط با سرور برقرار نشد؛ ثبت اشتراک در اجرای بعدی دوباره تلاش می‌شود.'
  }

  if (code === 'InternalError') {
    return 'ثبت اشتراک روی سرور ناموفق بود؛ بعداً دوباره تلاش می‌شود.'
  }

  return authErrorMessage(code)
}

export const RegisterPushWorker = Command.define('RegisterPushWorker', {
  messages: [Message.CompletedRegisterPushWorker],
  execute: Effect.promise(async () => {
    await registerServiceWorker()

    return Message.CompletedRegisterPushWorker()
  }),
})

export const RefreshPush = Command.define('RefreshPush', {
  args: { maybeUserId: Schema.Option(Schema.String) },
  messages: [Message.SucceededRefreshPush],
  execute: ({ maybeUserId }) =>
    Effect.gen(function* () {
      const environment = detectPushEnvironment()
      const isSignedIn = Option.isSome(maybeUserId)
      const publicKey = isSignedIn ? yield* loadVapidPublicKey : ''

      const maybeSubscription = yield* Effect.tryPromise({
        try: async () => {
          if (!isSignedIn) {
            return undefined
          }

          await registerServiceWorker()
          await shareConfigWithWorker(publicKey, API_URL)

          return await findSubscription()
        },
        catch: () => undefined,
      }).pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.map(subscription => Option.fromNullishOr(subscription)),
      )

      const maybeError = yield* Effect.gen(function* () {
        if (Option.isNone(maybeSubscription) || !isSignedIn) {
          return Option.none<string>()
        }

        const result = yield* registerPushSubscription(
          toRegistrationInput(maybeSubscription.value),
        )

        return result.ok
          ? Option.none<string>()
          : Option.some(pushFailureMessage(result.error.code))
      })

      return Message.SucceededRefreshPush({
        maybeUserId,
        environment,
        publicKey,
        maybeSubscription,
        maybeError,
      })
    }),
})

const PERMISSION_DENIED =
  'اجازه‌ی اعلان داده نشد. از تنظیمات مرورگر می‌توانید آن را فعال کنید.'

export const EnablePush = Command.define('EnablePush', {
  args: {
    maybeUserId: Schema.Option(Schema.String),
    publicKey: Schema.String,
  },
  messages: [Message.SucceededEnablePush, Message.FailedEnablePush],
  execute: ({ maybeUserId, publicKey }) =>
    Effect.gen(function* () {
      const environment = detectPushEnvironment()

      if (!environment.isSupported) {
        return Message.FailedEnablePush({
          maybeUserId,
          environment,
          message: 'این مرورگر از اعلان‌های Web Push پشتیبانی نمی‌کند.',
        })
      }

      const key = publicKey !== '' ? publicKey : yield* loadVapidPublicKey

      if (key === '') {
        return Message.FailedEnablePush({
          maybeUserId,
          environment,
          message:
            'کلید عمومی VAPID روی سرور تنظیم نشده است؛ ابتدا راهنمای آزمون محلی را ببینید.',
        })
      }

      if (!environment.isSecure) {
        return Message.FailedEnablePush({
          maybeUserId,
          environment,
          message: 'Web Push فقط در بستر امن (HTTPS یا localhost) کار می‌کند.',
        })
      }

      const permission = yield* Effect.promise(requestNotificationPermission)

      const nextEnvironment = modifyFields(environment, {
        permission: () => permission,
      })

      if (permission !== 'granted') {
        return Message.FailedEnablePush({
          maybeUserId,
          environment: nextEnvironment,
          message: PERMISSION_DENIED,
        })
      }

      const maybeSubscription = yield* Effect.tryPromise({
        try: () => subscribeThisDevice(key, API_URL),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))

      if (maybeSubscription === undefined) {
        return Message.FailedEnablePush({
          maybeUserId,
          environment: nextEnvironment,
          message: 'ثبت service worker ناموفق بود.',
        })
      }

      const result = yield* registerPushSubscription(
        toRegistrationInput(maybeSubscription),
      )

      return Message.SucceededEnablePush({
        maybeUserId,
        environment: nextEnvironment,
        subscription: maybeSubscription,
        maybeError: result.ok
          ? Option.none()
          : Option.some(pushFailureMessage(result.error.code)),
      })
    }),
})

export const DisablePush = Command.define('DisablePush', {
  args: { maybeUserId: Schema.Option(Schema.String) },
  messages: [Message.SucceededDisablePush, Message.FailedDisablePush],
  execute: ({ maybeUserId }) =>
    Effect.tryPromise({
      try: unsubscribeThisDevice,
      catch: () => false,
    }).pipe(
      Effect.orElseSucceed(() => false),
      Effect.map(succeeded =>
        succeeded
          ? Message.SucceededDisablePush({ maybeUserId })
          : Message.FailedDisablePush({
              maybeUserId,
              message: 'لغو اشتراک ناموفق بود.',
            }),
      ),
    ),
})

export const CopySubscription = Command.define('CopySubscription', {
  args: { subscription: PushSubscriptionJson },
  messages: [Message.CompletedCopySubscription],
  execute: ({ subscription }) =>
    Effect.tryPromise({
      try: () =>
        navigator.clipboard
          .writeText(JSON.stringify(subscription, null, 2))
          .then(() => true),
      catch: () => false,
    }).pipe(
      Effect.orElseSucceed(() => false),
      Effect.map(isCopied => Message.CompletedCopySubscription({ isCopied })),
    ),
})

export const ReadReminderActions = Command.define('ReadReminderActions', {
  messages: [Message.CompletedReadReminderActions],
  execute: readQueuedReminderActions.pipe(
    Effect.map(actions =>
      Message.CompletedReadReminderActions({
        maybeLastAction: Array.last(actions),
      }),
    ),
  ),
})

export const DrainReminderActions = Command.define('DrainReminderActions', {
  messages: [Message.CompletedDrainReminderActions],
  execute: Effect.gen(function* () {
    const result = yield* flushQueuedReminderActions(respondToDispatch)
    const remaining = yield* readQueuedReminderActions

    return Message.CompletedDrainReminderActions({
      drained: result.drained,
      maybeLastAction: Array.last(remaining),
    })
  }),
})

// INIT

export type InitOptions = Readonly<{
  maybeUserId: Option.Option<string>
  environment: PushEnvironment
}>

export const init = (options: InitOptions): Update.Return<Model, Message> => ({
  model: Model.make({
    ...initialModel(options.environment),
    maybeUserId: options.maybeUserId,
  }),
  commands: [
    RegisterPushWorker(),
    ReadReminderActions(),
    ...(Option.isSome(options.maybeUserId)
      ? [RefreshPush({ maybeUserId: options.maybeUserId })]
      : []),
  ],
})

/** Re-read permission/install state after the browser settings changed. */
export const ReadPushEnvironment = Command.define('ReadPushEnvironment', {
  messages: [Message.CompletedReadPushEnvironment],
  execute: Effect.sync(() =>
    Message.CompletedReadPushEnvironment({
      environment: detectPushEnvironment(),
    }),
  ),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const sameUser = (model: Model, maybeUserId: Option.Option<string>): boolean =>
  Option.match(model.maybeUserId, {
    onNone: () => Option.isNone(maybeUserId),
    onSome: userId => Option.contains(maybeUserId, userId),
  })

/** Refresh on sign-in and drain anything a notification tap queued. */
export const applySession = (
  model: Model,
  maybeUserId: Option.Option<string>,
): Update.Return<Model, Message> => {
  if (sameUser(model, maybeUserId)) {
    return { model }
  }

  if (Option.isNone(maybeUserId)) {
    return {
      model: modifyFields(model, {
        maybeUserId: () => Option.none(),
        isBusy: () => false,
        maybeError: () => Option.none(),
      }),
    }
  }

  return {
    model: modifyFields(model, {
      maybeUserId: () => maybeUserId,
      isBusy: () => false,
      maybeError: () => Option.none(),
    }),
    commands: [RefreshPush({ maybeUserId }), DrainReminderActions()],
  }
}

const queuedActionOf = (message: {
  readonly dispatchId: string
  readonly action: 'done' | 'snooze'
  readonly snoozeMinutes: Option.Option<number>
  readonly at: string
}): QueuedReminderAction =>
  QueuedReminderAction.make({
    dispatchId: message.dispatchId,
    action: message.action,
    at: message.at,
    ...Option.match(message.snoozeMinutes, {
      onNone: () => ({}),
      onSome: snoozeMinutes => ({ snoozeMinutes }),
    }),
  })

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    CompletedRegisterPushWorker: () => ({ model }),

    SucceededRefreshPush: ({
      maybeUserId,
      environment,
      publicKey,
      maybeSubscription,
      maybeError,
    }) => {
      if (!sameUser(model, maybeUserId)) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          environment: () => environment,
          publicKey: () => publicKey,
          maybeSubscription: () => maybeSubscription,
          isBusy: () => false,
          maybeError: () => maybeError,
          isCopied: () => false,
        }),
      }
    },

    ClickedEnablePush: () => {
      if (model.isBusy) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          isBusy: () => true,
          maybeError: () => Option.none(),
        }),
        commands: [
          EnablePush({
            maybeUserId: model.maybeUserId,
            publicKey: model.publicKey,
          }),
        ],
      }
    },

    SucceededEnablePush: ({
      maybeUserId,
      environment,
      subscription,
      maybeError,
    }) => {
      if (!sameUser(model, maybeUserId)) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          environment: () => environment,
          maybeSubscription: () => Option.some(subscription),
          isBusy: () => false,
          maybeError: () => maybeError,
          isCopied: () => false,
        }),
        commands: [ReadReminderActions()],
      }
    },

    FailedEnablePush: ({ maybeUserId, environment, message }) => {
      if (!sameUser(model, maybeUserId)) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          environment: () => environment,
          isBusy: () => false,
          maybeError: () => Option.some(message),
        }),
      }
    },

    ClickedDisablePush: () => {
      if (model.isBusy || Option.isNone(model.maybeSubscription)) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          isBusy: () => true,
          maybeError: () => Option.none(),
        }),
        commands: [DisablePush({ maybeUserId: model.maybeUserId })],
      }
    },

    SucceededDisablePush: ({ maybeUserId }) => {
      if (!sameUser(model, maybeUserId)) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeSubscription: () => Option.none(),
          isBusy: () => false,
          maybeError: () => Option.none(),
          isCopied: () => false,
        }),
      }
    },

    FailedDisablePush: ({ maybeUserId, message }) => {
      if (!sameUser(model, maybeUserId)) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          isBusy: () => false,
          maybeError: () => Option.some(message),
        }),
      }
    },

    ClickedRefreshPush: () => {
      if (model.isBusy) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          isBusy: () => true,
          maybeError: () => Option.none(),
        }),
        commands: [RefreshPush({ maybeUserId: model.maybeUserId })],
      }
    },

    ClickedCopySubscription: () =>
      Option.match(model.maybeSubscription, {
        onNone: () => ({ model }),
        onSome: subscription => ({
          model,
          commands: [CopySubscription({ subscription })],
        }),
      }),

    CompletedCopySubscription: ({ isCopied }) => ({
      model: modifyFields(model, { isCopied: () => isCopied }),
    }),

    ChangedVisibility: ({ isVisible }) =>
      isVisible
        ? {
            model,
            commands: [
              ReadPushEnvironment(),
              ReadReminderActions(),
              DrainReminderActions(),
            ],
          }
        : { model },

    CompletedReadPushEnvironment: ({ environment }) => ({
      model: modifyFields(model, { environment: () => environment }),
    }),

    ReceivedReminderAction: ({ dispatchId, action, snoozeMinutes, at }) => ({
      model: modifyFields(model, {
        maybeLastAction: () =>
          Option.some(
            queuedActionOf({ dispatchId, action, snoozeMinutes, at }),
          ),
      }),
      commands: [DrainReminderActions()],
    }),

    ReceivedPushSubscriptionChange: () => ({
      model,
      commands: [RefreshPush({ maybeUserId: model.maybeUserId })],
    }),

    CompletedReadReminderActions: ({ maybeLastAction }) => ({
      model: modifyFields(model, {
        maybeLastAction: () => maybeLastAction,
      }),
    }),

    CompletedDrainReminderActions: ({ maybeLastAction }) => ({
      model: modifyFields(model, {
        maybeLastAction: () =>
          Option.match(maybeLastAction, {
            onNone: () => model.maybeLastAction,
            onSome: action => Option.some(action),
          }),
      }),
    }),
  })

// SUBSCRIPTION

const serviceWorkerEvents: Stream.Stream<Message> = eventStream(emit => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return () => {}
  }

  const onMessage = (event: MessageEvent) => {
    const decoded = Schema.decodeUnknownOption(ReminderActionMessage)(
      event.data,
    )

    if (Option.isSome(decoded)) {
      emit(
        Message.ReceivedReminderAction({
          dispatchId: decoded.value.dispatchId,
          action: decoded.value.action,
          snoozeMinutes: Option.fromNullishOr(decoded.value.snoozeMinutes),
          at: decoded.value.at,
        }),
      )

      return
    }

    if (
      Option.isSome(
        Schema.decodeUnknownOption(PushSubscriptionChangeMessage)(event.data),
      )
    ) {
      emit(Message.ReceivedPushSubscriptionChange())
    }
  }

  navigator.serviceWorker.addEventListener('message', onMessage)

  return () => {
    navigator.serviceWorker.removeEventListener('message', onMessage)
  }
})

export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  serviceWorker: Subscription.persistentEntry(serviceWorkerEvents),
  pushVisibility: Subscription.persistentEntry(
    visibilityEvents(isVisible => Message.ChangedVisibility({ isVisible })),
  ),
}))

// VIEW

type Tone = 'ok' | 'warn' | 'bad' | 'muted'

const TONE_CLASS: Readonly<
  Record<Tone, Readonly<{ text: string; dot: string }>>
> = {
  ok: { text: 'text-success', dot: 'bg-success' },
  warn: { text: 'text-warning', dot: 'bg-warning' },
  bad: { text: 'text-error', dot: 'bg-error' },
  muted: { text: 'text-base-content/70', dot: 'bg-base-content/35' },
}

const PERMISSION_COPY: Readonly<
  Record<PushPermission, Readonly<{ label: string; tone: Tone }>>
> = {
  granted: { label: 'فعال', tone: 'ok' },
  denied: { label: 'مسدود شده', tone: 'bad' },
  default: { label: 'داده نشده', tone: 'warn' },
  unsupported: { label: 'پشتیبانی نمی‌شود', tone: 'muted' },
}

const permissionCopy = (
  permission: PushPermission,
): Readonly<{ label: string; tone: Tone }> => PERMISSION_COPY[permission]

const actionCopy = (action: string): string =>
  action === 'done' ? 'انجام شد' : 'بعداً'

const formatTime = (iso: string): string => {
  const time = Date.parse(iso)

  if (Number.isNaN(time)) {
    return ''
  }

  return new Intl.DateTimeFormat('fa-IR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(time)
}

type StatusRowConfig = Readonly<{
  label: string
  value: string
  tone: Tone
  maybeHint?: Option.Option<string>
}>

const statusRowView = <Message>(
  config: StatusRowConfig,
  h: HtmlBuilder<Message>,
): Html => {
  const tone = TONE_CLASS[config.tone]

  return h.div(
    [h.Class('grid gap-1 border-b border-base-300 py-2.5 last:border-b-0')],
    [
      h.div(
        [h.Class('flex items-center justify-between gap-2')],
        [
          h.span([h.Class('text-sm leading-7')], [config.label]),
          h.span(
            [
              h.Class(
                `inline-flex items-center gap-1.5 whitespace-nowrap text-[0.82rem] ${tone.text}`,
              ),
            ],
            [
              h.span([
                h.AriaHidden(true),
                h.Class(`size-1.5 rounded-full ${tone.dot}`),
              ]),
              config.value,
            ],
          ),
        ],
      ),
      Option.match(config.maybeHint ?? Option.none(), {
        onNone: () => h.empty,
        onSome: hint =>
          h.span(
            [h.Class('text-[0.72rem] leading-6 text-base-content/70')],
            [hint],
          ),
      }),
    ],
  )
}

export const healthView = Submodel.defineView<Model, Message>((model, h) => {
  const permission = permissionCopy(model.environment.permission)
  const isConfigured = model.publicKey !== ''
  const isSubscribed = Option.isSome(model.maybeSubscription)

  return h.section(
    [
      h.AriaLabelledBy('push-health-title'),
      h.Class('panel grid grid-cols-1 gap-4 p-4 sm:p-5'),
    ],
    [
      h.header(
        [h.Class('grid gap-1.5')],
        [
          h.h2(
            [
              h.Id('push-health-title'),
              h.Class('m-0 text-[0.95rem] font-semibold'),
            ],
            ['وضعیت اعلان‌ها'],
          ),
          h.p(
            [h.Class('m-0 text-sm leading-7 text-base-content/70')],
            [
              'یادآورها از طریق Web Push به همین دستگاه می‌رسند. این بخش آمادگی دستگاه را نشان می‌دهد.',
            ],
          ),
        ],
      ),
      h.div(
        [],
        [
          statusRowView(
            {
              label: 'پشتیبانی مرورگر',
              value: model.environment.isSupported
                ? 'پشتیبانی می‌شود'
                : 'پشتیبانی نمی‌شود',
              tone: model.environment.isSupported ? 'ok' : 'bad',
            },
            h,
          ),
          statusRowView(
            {
              label: 'بستر امن (HTTPS یا localhost)',
              value: model.environment.isSecure ? 'بله' : 'خیر',
              tone: model.environment.isSecure ? 'ok' : 'bad',
            },
            h,
          ),
          statusRowView(
            {
              label: 'نصب‌شده به‌عنوان برنامه',
              value: model.environment.isInstalled ? 'بله' : 'نه',
              tone: model.environment.isInstalled ? 'ok' : 'warn',
              maybeHint: model.environment.isInstalled
                ? Option.none()
                : Option.some(
                    'برای اعلان در iOS، تالی را از «افزودن به صفحه‌ی خانه» نصب کنید. در اندروید نصب توصیه می‌شود.',
                  ),
            },
            h,
          ),
          statusRowView(
            {
              label: 'مجوز اعلان',
              value: permission.label,
              tone: permission.tone,
              maybeHint:
                model.environment.permission === 'denied'
                  ? Option.some(
                      'مجوز را از تنظیمات سایت در مرورگر باز کنید؛ دوباره درخواست دادن از این صفحه ممکن نیست.',
                    )
                  : Option.none(),
            },
            h,
          ),
          statusRowView(
            {
              label: 'اشتراک این دستگاه',
              value: isSubscribed ? 'ثبت شده' : 'ثبت نشده',
              tone: isSubscribed ? 'ok' : 'muted',
            },
            h,
          ),
          statusRowView(
            {
              label: 'کلید عمومی VAPID',
              value: isConfigured ? 'تنظیم شده' : 'تنظیم نشده',
              tone: isConfigured ? 'ok' : 'bad',
              maybeHint: isConfigured
                ? Option.none()
                : Option.some(
                    'کلید عمومی از سرور خوانده می‌شود (GET /push/vapid). اگر تنظیم نشده باشد، VAPID_* را در محیط API بگذارید (docs/web-push-local.md).',
                  ),
            },
            h,
          ),
          Option.match(model.maybeLastAction, {
            onNone: () => h.empty,
            onSome: action =>
              statusRowView(
                {
                  label: 'آخرین پاسخ اعلان (آزمایشی)',
                  value: `${actionCopy(action.action)} · ${formatTime(action.at)}`,
                  tone: 'ok',
                  maybeHint: Option.some(
                    'دکمه‌های انجام شد/بعداً نخست در صف محلی دستگاه ذخیره و سپس به دفتر ارسال فرستاده می‌شوند؛ پس از ثبت، از صف پاک می‌شوند.',
                  ),
                },
                h,
              ),
          }),
        ],
      ),
      formErrorView(model.maybeError, h),
      h.div(
        [h.Class('flex flex-wrap gap-2')],
        [
          buttonView(
            {
              type: 'button',
              isDisabled:
                model.isBusy ||
                !model.environment.isSupported ||
                !isConfigured ||
                !model.environment.isSecure,
              isLoading: model.isBusy,
              children: [
                isSubscribed ? 'بررسی و ثبت دوباره' : 'فعال‌سازی اعلان‌ها',
              ],
              onClick: Message.ClickedEnablePush(),
            },
            h,
          ),
          buttonView(
            {
              type: 'button',
              variant: 'ghost',
              isDisabled: model.isBusy,
              children: ['تازه‌سازی وضعیت'],
              onClick: Message.ClickedRefreshPush(),
            },
            h,
          ),
          ...(isSubscribed
            ? [
                buttonView(
                  {
                    type: 'button',
                    variant: 'ghost',
                    isDisabled: model.isBusy,
                    children: ['لغو اشتراک این دستگاه'],
                    onClick: Message.ClickedDisablePush(),
                  },
                  h,
                ),
              ]
            : []),
          ...(isDevServer && isSubscribed
            ? [
                buttonView(
                  {
                    type: 'button',
                    variant: 'ghost',
                    children: [
                      model.isCopied ? 'رونوشت شد' : 'رونوشت اشتراک برای آزمون',
                    ],
                    onClick: Message.ClickedCopySubscription(),
                  },
                  h,
                ),
              ]
            : []),
        ],
      ),
      h.p(
        [h.Class('m-0 text-[0.72rem] leading-6 text-base-content/70')],
        [
          'راهنمای ارسال یک اعلان آزمایشی روی همین دستگاه: ',
          h.code([h.Dir('ltr')], ['docs/web-push-local.md']),
        ],
      ),
    ],
  )
})
