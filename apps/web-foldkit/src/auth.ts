import { Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { AuthFailure, authApi } from './lib/auth-api'
import { authErrorMessage } from './lib/auth-copy'
import { cacheSession, clearCachedSession } from './lib/session-cache'
import { settingsRouter } from './route'
import { Session } from './session'
import { accountMenuView } from './ui/account-menu'
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
})
export type Model = typeof Model.Type

// MESSAGE

export const OutMessage = defineMessageUnion({
  RestoredSession: { session: Session },
  SignedOut: {},
})
export type OutMessage = typeof OutMessage.Type

export const Message = defineMessageUnion({
  ClickedRetryRestore: {},
  ClickedSignOut: {},
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

    ClickedSignOut: () =>
      model.isSigningOut
        ? { model }
        : {
            model: modifyFields(model, {
              isSigningOut: () => true,
              maybeSignOutFailure: () => Option.none(),
            }),
            commands: [SignOut()],
          },

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

      return {
        model: modifyFields(model, {
          isSigningOut: () => false,
          maybeSignOutFailure: () => Option.some(failure),
        }),
      }
    },

    CompletedCacheSession: () => ({ model }),
    CompletedClearCachedSession: () => ({ model }),
  })

// VIEW

export const view = Submodel.defineView<Model, Message>((model, h) =>
  Option.match(maybeSession(model), {
    onNone: () => h.empty,
    onSome: session =>
      accountMenuView(
        {
          displayName: session.user.displayName,
          isSigningOut: model.isSigningOut,
          maybeError: Option.map(model.maybeSignOutFailure, failure =>
            authErrorMessage(failure.code),
          ),
          onSignOut: Message.ClickedSignOut(),
          settingsHref: settingsRouter(),
        },
        h,
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
