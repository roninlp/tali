import { Effect, Option, Schema } from 'effect'
import { Menu } from '@foldkit/ui'
import { Command, Submodel, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { AuthFailure, authApi } from './lib/auth-api'
import { authErrorMessage } from './lib/auth-copy'
import { cacheSession, clearCachedSession } from './lib/session-cache'
import { Session } from './session'
import {
  ACCOUNT_MENU_ID,
  type AccountItem,
  AccountMenu,
  accountMenuView,
} from './ui/account-menu'
import { Toast, toastStackView } from './ui/toast'
import { bootView as bootSplashView } from './ui/boot'

// MODEL

export const SessionStatus = defineTaggedUnion({
  Restoring: {},
  SignedOut: {},
  SignedIn: {
    session: Session,
    maybeBootFailure: Schema.Option(AuthFailure),
  },
  Failed: { failure: AuthFailure },
})
export type SessionStatus = typeof SessionStatus.Type

export const Model = Schema.Struct({
  status: SessionStatus,
  /** Invalidates a restore response that lands after a newer session fact. */
  restoreAttempt: Schema.Int,
  isSigningOut: Schema.Boolean,
  maybeSignOutFailure: Schema.Option(AuthFailure),
  menu: Menu.Model,
  toast: Toast.Model,
})
export type Model = typeof Model.Type

// MESSAGE

export const OutMessage = defineMessageUnion({
  RestoredSession: { session: Session },
  SignedOut: {},
  SelectedSettings: {},
})
export type OutMessage = typeof OutMessage.Type

export const Message = defineMessageUnion({
  ClickedRetryRestore: {},
  ClickedSignOut: {},
  GotAccountMenuMessage: { message: Menu.Message },
  GotToastMessage: { message: Toast.Message },
  SucceededRestoreSession: { attempt: Schema.Int, session: Session },
  FailedRestoreSession: { attempt: Schema.Int, failure: AuthFailure },
  SucceededSignOut: {},
  FailedSignOut: { failure: AuthFailure },
  CompletedCacheSession: {},
  CompletedClearCachedSession: {},
})
export type Message = typeof Message.Type

// COMMAND

export const RestoreSession = Command.define('RestoreSession', {
  args: { attempt: Schema.Int },
  messages: [Message.SucceededRestoreSession, Message.FailedRestoreSession],
  execute: ({ attempt }) =>
    authApi.me().pipe(
      Effect.map(result =>
        result.ok
          ? Message.SucceededRestoreSession({
              attempt,
              session: result.value,
            })
          : Message.FailedRestoreSession({ attempt, failure: result.error }),
      ),
    ),
})

export const SignOut = Command.define('SignOut', {
  messages: [Message.SucceededSignOut, Message.FailedSignOut],
  execute: authApi
    .logout()
    .pipe(
      Effect.map(result =>
        result.ok
          ? Message.SucceededSignOut()
          : Message.FailedSignOut({ failure: result.error }),
      ),
    ),
})

export const CacheSession = Command.define('CacheSession', {
  args: { session: Session },
  messages: [Message.CompletedCacheSession],
  execute: ({ session }) =>
    Effect.sync(() => {
      cacheSession(session)
      return Message.CompletedCacheSession()
    }),
})

export const ClearCachedSession = Command.define('ClearCachedSession', {
  messages: [Message.CompletedClearCachedSession],
  execute: Effect.sync(() => {
    clearCachedSession()
    return Message.CompletedClearCachedSession()
  }),
})

// INIT

export const init = (
  maybeCachedSession: Option.Option<Session>,
): Update.Return<Model, Message> => {
  const status = Option.match(maybeCachedSession, {
    onNone: () => SessionStatus.Restoring(),
    onSome: session =>
      SessionStatus.SignedIn({
        session,
        maybeBootFailure: Option.none(),
      }),
  })
  const model = Model.make({
    status,
    restoreAttempt: 1,
    isSigningOut: false,
    maybeSignOutFailure: Option.none(),
    menu: Menu.init({ id: ACCOUNT_MENU_ID }),
    toast: Toast.init({ id: 'auth-toast' }),
  })

  return {
    model,
    commands: [RestoreSession({ attempt: model.restoreAttempt })],
  }
}

/** Re-read the session without dropping a cached sign-in while it runs. */
export const refresh = (model: Model): Update.Return<Model, Message> => {
  const restoreAttempt = model.restoreAttempt + 1

  return {
    model: modifyFields(model, {
      restoreAttempt: () => restoreAttempt,
      maybeSignOutFailure: () => Option.none(),
    }),
    commands: [RestoreSession({ attempt: restoreAttempt })],
  }
}

export const applySession = (model: Model, session: Session): Model =>
  modifyFields(model, {
    status: () =>
      SessionStatus.SignedIn({
        session,
        maybeBootFailure: Option.none(),
      }),
    restoreAttempt: () => model.restoreAttempt + 1,
    isSigningOut: () => false,
    maybeSignOutFailure: () => Option.none(),
  })

export const applyHouseholdId = (model: Model, householdId: string): Model =>
  SessionStatus.match(model.status, {
    Restoring: () => model,
    SignedOut: () => model,
    Failed: () => model,
    SignedIn: ({ session, maybeBootFailure }) =>
      modifyFields(model, {
        status: () =>
          SessionStatus.SignedIn({
            session: Session.make({
              user: session.user,
              householdId,
            }),
            maybeBootFailure,
          }),
      }),
  })

export const maybeSession = (model: Model): Option.Option<Session> =>
  SessionStatus.match(model.status, {
    Restoring: () => Option.none(),
    SignedOut: () => Option.none(),
    Failed: () => Option.none(),
    SignedIn: ({ session }) => Option.some(session),
  })

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const startSignOut = (model: Model): UpdateReturn => {
  if (model.isSigningOut) {
    return { model }
  }

  return {
    model: modifyFields(model, {
      isSigningOut: () => true,
      maybeSignOutFailure: () => Option.none(),
    }),
    commands: [SignOut()],
  }
}

const foldAccountMenuOutMessage = Menu.OutMessage.match<
  Update.StepWithOutMessage<Model, Message, OutMessage>,
  Menu.OutMessage<AccountItem>
>({
  Selected:
    ({ value }) =>
    stepModel =>
      value === 'signout'
        ? startSignOut(stepModel)
        : { model: stepModel, outMessage: OutMessage.SelectedSettings() },
})

const foldAccountMenu = Update.foldChild({
  update: AccountMenu.update,
  read: (model: Model) => Option.some(model.menu),
  write: (model, nextMenu) => modifyFields(model, { menu: () => nextMenu }),
  toParentMessage: message => Message.GotAccountMenuMessage({ message }),
  foldOutMessage: foldAccountMenuOutMessage,
})

const foldToastOutMessage = Toast.OutMessage.match<Update.Step<Model, Message>>({
  DismissedToast: () => model => ({ model }),
})

const foldToast = Update.foldChild({
  update: Toast.update,
  read: (model: Model) => Option.some(model.toast),
  write: (model, nextToast) =>
    modifyFields(model, { toast: () => nextToast }),
  toParentMessage: message => Message.GotToastMessage({ message }),
  foldOutMessage: foldToastOutMessage,
})

const shownToastStep = (body: string): Update.Step<Model, Message> =>
  Update.foldChildStep({
    update: toast =>
      Toast.show(toast, { payload: { text: body }, variant: 'Error' }),
    read: (model: Model) => Option.some(model.toast),
    write: (model, nextToast) =>
      modifyFields(model, { toast: () => nextToast }),
    toParentMessage: message => Message.GotToastMessage({ message }),
    foldOutMessage: () => stepModel => ({ model: stepModel }),
  })

const clearSession = (model: Model): UpdateReturn => ({
  model: modifyFields(model, {
    status: () => SessionStatus.SignedOut(),
    restoreAttempt: () => model.restoreAttempt + 1,
    isSigningOut: () => false,
    maybeSignOutFailure: () => Option.none(),
  }),
  commands: [ClearCachedSession()],
  outMessage: OutMessage.SignedOut(),
})

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedRetryRestore: () =>
      refresh(
        modifyFields(model, {
          status: () => SessionStatus.Restoring(),
        }),
      ),

    ClickedSignOut: () => startSignOut(model),

    SucceededRestoreSession: ({ attempt, session }) => {
      if (attempt !== model.restoreAttempt) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          status: () =>
            SessionStatus.SignedIn({
              session,
              maybeBootFailure: Option.none(),
            }),
          isSigningOut: () => false,
          maybeSignOutFailure: () => Option.none(),
        }),
        commands: [CacheSession({ session })],
        outMessage: OutMessage.RestoredSession({ session }),
      }
    },

    FailedRestoreSession: ({ attempt, failure }) => {
      if (attempt !== model.restoreAttempt) {
        return { model }
      }

      if (failure.code === 'Unauthorized') {
        return clearSession(model)
      }

      return {
        model: modifyFields(model, {
          status: () =>
            SessionStatus.match(model.status, {
              Restoring: () => SessionStatus.Failed({ failure }),
              SignedOut: () => SessionStatus.SignedOut(),
              SignedIn: ({ session }) =>
                SessionStatus.SignedIn({
                  session,
                  maybeBootFailure: Option.some(failure),
                }),
              Failed: () => SessionStatus.Failed({ failure }),
            }),
        }),
      }
    },

    SucceededSignOut: () => clearSession(model),

    FailedSignOut: ({ failure }) => {
      if (failure.code === 'Unauthorized') {
        return clearSession(model)
      }

      const failingSignOut: Update.Step<Model, Message> = stepModel => ({
        model: modifyFields(stepModel, {
          isSigningOut: () => false,
          maybeSignOutFailure: () => Option.some(failure),
        }),
      })

      return Update.combine(model, [shownToastStep(authErrorMessage(failure.code)), failingSignOut])
    },

    GotAccountMenuMessage: ({ message }) =>
      foldAccountMenu(model, message),

    GotToastMessage: ({ message }) => foldToast(model, message),

    CompletedCacheSession: () => ({ model }),
    CompletedClearCachedSession: () => ({ model }),
  })

// VIEW

export const view = Submodel.defineView<Model, Message>((model, h) =>
  Option.match(maybeSession(model), {
    onNone: () => h.empty,
    onSome: session =>
      h.div(
        [h.Class('flex flex-col items-start gap-2')],
        [
          accountMenuView(
            {
              menu: model.menu,
              displayName: session.user.displayName,
              isSigningOut: model.isSigningOut,
              toParentMessage: message =>
                Message.GotAccountMenuMessage({ message }),
            },
            h,
          ),
          toastStackView(
            {
              model: model.toast,
              toParentMessage: message =>
                Message.GotToastMessage({ message }),
            },
            h,
          ),
        ],
      ),
  }),
)

export const bootView = Submodel.defineView<Model, Message>((model, h) =>
  SessionStatus.match(model.status, {
    Restoring: () =>
      bootSplashView(
        {
          message: 'در حال بارگذاری…',
          maybeRetry: Option.none(),
        },
        h,
      ),
    Failed: ({ failure }) =>
      bootSplashView(
        {
          message: failure.retryable
            ? 'ارتباط با سرور برقرار نشد. دوباره تلاش کنید.'
            : 'درخواست نامعتبر بود. دوباره تلاش کنید.',
          maybeRetry: Option.some(Message.ClickedRetryRestore()),
        },
        h,
      ),
    SignedOut: () =>
      bootSplashView(
        {
          message: 'در حال بارگذاری…',
          maybeRetry: Option.none(),
        },
        h,
      ),
    SignedIn: () =>
      bootSplashView(
        {
          message: 'در حال بارگذاری…',
          maybeRetry: Option.none(),
        },
        h,
      ),
  }),
)
