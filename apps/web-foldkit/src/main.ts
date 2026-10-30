import { Effect, Option, Schema } from 'effect'
import {
  Command,
  ManagedResource,
  Runtime,
  Subscription,
  Update,
} from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { UrlRequest, load, pushUrl, replaceUrl } from 'foldkit/navigation'
import { Transition } from 'foldkit/route'
import { modifyFields } from 'foldkit/struct'
import { Url, toString as urlToString } from 'foldkit/url'

import * as Auth from './auth'
import { GuardDecision, guardRoute, landingPath, landingRoute } from './guard'
import { PushEnvironment } from './lib/push/service-worker'
import * as Household from './page/household'
import * as Login from './page/login'
import * as Register from './page/register'
import * as Today from './page/today'
import * as Preferences from './preferences'
import { Preferences as PreferencesRow } from './preferences-model'
import * as Push from './push'
import { AppRoute, homeRouter, todayRouter, urlToAppRoute } from './route'
import { Session } from './session'
import * as Shell from './shell'
import * as Sync from './sync'
import * as Theme from './theme'
import { searchIcon } from './ui/icons'

// MODEL

export const Model = Schema.Struct({
  route: AppRoute,
  theme: Theme.Model,
  auth: Auth.Model,
  login: Login.Model,
  register: Register.Model,
  household: Household.Model,
  preferences: Preferences.Model,
  push: Push.Model,
  sync: Sync.Model,
  today: Today.Model,
})
export type Model = typeof Model.Type

export const Flags = Schema.Struct({
  maybeCachedSession: Schema.Option(Session),
  maybeCachedPreferences: Schema.Option(PreferencesRow),
  maybeSavedTheme: Schema.Option(Schema.String),
  maybeSavedMode: Schema.Option(Schema.String),
  isSystemDark: Schema.Boolean,
  pushEnvironment: PushEnvironment,
  isOnline: Schema.Boolean,
  isVisible: Schema.Boolean,
  now: Schema.Number,
})
export type Flags = typeof Flags.Type

// MESSAGE

export const Message = defineMessageUnion({
  ChangedUrl: { url: Url },
  ClickedLink: { request: UrlRequest },
  CompletedNavigateInternal: {},
  CompletedReplaceUrl: {},
  CompletedLoadExternal: {},
  GotThemeMessage: { message: Theme.Message },
  GotAuthMessage: { message: Auth.Message },
  GotLoginMessage: { message: Login.Message },
  GotRegisterMessage: { message: Register.Message },
  GotHouseholdMessage: { message: Household.Message },
  GotPreferencesMessage: { message: Preferences.Message },
  GotPushMessage: { message: Push.Message },
  GotSyncMessage: { message: Sync.Message },
  GotTodayMessage: { message: Today.Message },
})
export type Message = typeof Message.Type

// INIT

export const init: Runtime.RoutingApplicationInit<
  Model,
  Message,
  Flags,
  never,
  Sync.LocalStoreService
> = (flags: Flags, url: Url) => {
  const route = urlToAppRoute(url)
  const themeInit = Theme.init({
    maybeSavedTheme: flags.maybeSavedTheme,
    maybeSavedMode: flags.maybeSavedMode,
    isSystemDark: flags.isSystemDark,
  })
  const authInit = Auth.init(flags.maybeCachedSession)
  const maybeSession = Auth.maybeSession(authInit.model)
  const preferencesInit = Preferences.init({
    maybeUserId: Option.map(maybeSession, session => session.user.id),
    maybeProfileDefaults: Option.map(
      maybeSession,
      session => Preferences.sessionProfile(session).defaults,
    ),
    maybeCachedPreferences: flags.maybeCachedPreferences,
  })
  const pushInit = Push.init({
    maybeUserId: Option.map(maybeSession, session => session.user.id),
    environment: flags.pushEnvironment,
  })
  const syncInit = Sync.init({
    maybeUserId: Option.map(maybeSession, session => session.user.id),
    hasHousehold: Option.exists(
      maybeSession,
      session => session.householdId !== null,
    ),
    isOnline: flags.isOnline,
    isVisible: flags.isVisible,
  })
  const todayInit = Today.init({ now: flags.now })
  const model = Model.make({
    route,
    theme: themeInit.model,
    auth: authInit.model,
    login: Login.initialModel(),
    register: Register.initialModel(),
    household: Household.initialModel(),
    preferences: preferencesInit.model,
    push: pushInit.model,
    sync: syncInit.model,
    today: todayInit.model,
  })
  const guarded = enforceGuard(model, route)
  const todayEntry =
    guarded.model.route._tag === 'Today' && guardAllows(guarded.model, route)
      ? Today.entered(guarded.model.today, todayInputs(guarded.model))
      : { model: guarded.model.today }

  return {
    model: modifyFields(guarded.model, {
      today: () => todayEntry.model,
    }),
    commands: [
      ...Command.mapMessages(themeInit.commands, toThemeMessage),
      ...Command.mapMessages(authInit.commands, toAuthMessage),
      ...Command.mapMessages(preferencesInit.commands, toPreferencesMessage),
      ...Command.mapMessages(pushInit.commands, toPushMessage),
      ...(guarded.commands ?? []),
      ...Command.mapMessages(todayEntry.commands, toTodayMessage),
    ],
  }
}

// MANAGED RESOURCE

/**
 * One IndexedDB mirror per signed-in user, opened as soon as the session is
 * known and closed on sign-out. The child resource declares the requirement;
 * the lift maps its facts into the root Model.
 */
export const managedResources = ManagedResource.lift(Sync.managedResources)<
  Model,
  Message
>({
  read: model => Option.some(model.sync),
  toParentMessage: message => Message.GotSyncMessage({ message }),
})

// COMMAND

export const NavigateInternal = Command.define('NavigateInternal', {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) =>
    pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
})

export const ReplaceUrl = Command.define('ReplaceUrl', {
  args: { url: Schema.String },
  messages: [Message.CompletedReplaceUrl],
  execute: ({ url }) =>
    replaceUrl(url).pipe(Effect.as(Message.CompletedReplaceUrl())),
})

export const LoadExternal = Command.define('LoadExternal', {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) =>
    load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Sync.LocalStoreService>

const toAuthMessage = (message: Auth.Message): Message =>
  Message.GotAuthMessage({ message })

const toThemeMessage = (message: Theme.Message): Message =>
  Message.GotThemeMessage({ message })

const toPreferencesMessage = (message: Preferences.Message): Message =>
  Message.GotPreferencesMessage({ message })

const toPushMessage = (message: Push.Message): Message =>
  Message.GotPushMessage({ message })

const toTodayMessage = (message: Today.Message): Message =>
  Message.GotTodayMessage({ message })

/** The page's sibling inputs: display settings and the live mirror snapshot. */
const todayInputs = (model: Model): Today.Inputs => ({
  display: Preferences.currentDisplayFields(model.preferences),
  sectionOrder: Preferences.currentSectionOrder(model.preferences),
  isStoreReady: Sync.isStoreReady(model.sync),
  isOnline: model.sync.isOnline,
  pending: model.sync.pending,
  mirror: model.sync.mirror,
  pendingKeys: model.sync.pendingKeys,
})

const authCommand = <E = never, R = never>(
  command: Command.Command<Auth.Message, E, R>,
): Command.Command<Message, E, R> => Command.mapMessage(command, toAuthMessage)

const cacheSessionCommands = (
  auth: Auth.Model,
): ReadonlyArray<Command.Command<Message>> =>
  Option.match(Auth.maybeSession(auth), {
    onNone: () => [],
    onSome: session => [authCommand(Auth.CacheSession({ session }))],
  })

const guardContext = (model: Model) => ({
  isHouseholdInviteVisible: Option.isSome(model.household.maybeCreated),
})

const guardAllows = (model: Model, route: AppRoute): boolean =>
  GuardDecision.isAnyOf(['Allow'])(
    guardRoute(route, model.auth, guardContext(model)),
  )

const syncSession = (model: Model): Sync.Model => {
  const maybeSession = Auth.maybeSession(model.auth)

  return Sync.applySession(
    model.sync,
    Option.map(maybeSession, session => session.user.id),
    Option.exists(maybeSession, session => session.householdId !== null),
  )
}

const applyPreferencesSession = Update.foldChild({
  update: Preferences.applySession,
  read: (model: Model) => Option.some(model.preferences),
  write: (model: Model, nextPreferences: Preferences.Model) =>
    modifyFields(model, { preferences: () => nextPreferences }),
  toParentMessage: toPreferencesMessage,
})

const applyPushSession = Update.foldChild({
  update: Push.applySession,
  read: (model: Model) => Option.some(model.push),
  write: (model: Model, nextPush: Push.Model) =>
    modifyFields(model, { push: () => nextPush }),
  toParentMessage: toPushMessage,
})

/**
 * Push the current session into the child Submodels that key work by identity.
 * Preferences and push both start one read per sign-in; sync only swaps the
 * managed store resource. Each fold lifts the child's Commands to the root.
 */
const applySessionState: Update.Step<Model, Message> = Update.combine<
  Model,
  Message
>([
  (model: Model) =>
    applyPreferencesSession(
      model,
      Option.map(Auth.maybeSession(model.auth), session =>
        Preferences.sessionProfile(session),
      ),
    ),
  (model: Model) =>
    applyPushSession(
      model,
      Option.map(Auth.maybeSession(model.auth), session => session.user.id),
    ),
])

const enforceGuardWithSessionUser = (
  model: Model,
  route: AppRoute,
): UpdateReturn => {
  const guarded = enforceGuard(model, route)
  const sessionState = applySessionState(guarded.model)

  return {
    model: modifyFields(sessionState.model, {
      sync: () => syncSession(sessionState.model),
    }),
    commands: [...(guarded.commands ?? []), ...(sessionState.commands ?? [])],
  }
}

const enforceGuard = (model: Model, route: AppRoute): UpdateReturn =>
  GuardDecision.match<UpdateReturn>(
    guardRoute(route, model.auth, guardContext(model)),
    {
      Allow: () => ({ model: modifyFields(model, { route: () => route }) }),
      Wait: () => ({ model: modifyFields(model, { route: () => route }) }),
      Redirect: ({ route: target, path }) => ({
        model: modifyFields(model, { route: () => target }),
        commands: [ReplaceUrl({ url: path })],
      }),
    },
  )

const resetForms = (model: Model): Model =>
  modifyFields(model, {
    login: () => Login.initialModel(),
    register: () => Register.initialModel(),
    household: () => Household.initialModel(),
  })

const foldTheme: Update.Fold<Model, Message, Theme.Message> = Update.foldChild({
  update: Theme.update,
  read: model => Option.some(model.theme),
  write: (model, nextTheme) => modifyFields(model, { theme: () => nextTheme }),
  toParentMessage: message => Message.GotThemeMessage({ message }),
})

const foldAuthOutMessage = Auth.OutMessage.match<
  Update.Step<Model, Message, Sync.LocalStoreService>
>({
  RestoredSession: () => stepModel => {
    const guarded = enforceGuardWithSessionUser(stepModel, stepModel.route)

    return withStepCommands(guarded, enterToday(guarded.model))
  },
  SignedOut: () => stepModel =>
    enforceGuardWithSessionUser(resetForms(stepModel), stepModel.route),
})

const foldAuth = Update.foldChild({
  update: Auth.update,
  read: (model: Model) => Option.some(model.auth),
  write: (model: Model, nextAuth: Auth.Model) =>
    modifyFields(model, { auth: () => nextAuth }),
  toParentMessage: (message: Auth.Message) =>
    Message.GotAuthMessage({ message }),
  foldOutMessage: foldAuthOutMessage,
})

const refreshAuth = Update.foldChildStep({
  update: Auth.refresh,
  read: (model: Model) => Option.some(model.auth),
  write: (model: Model, nextAuth: Auth.Model) =>
    modifyFields(model, { auth: () => nextAuth }),
  toParentMessage: (message: Auth.Message) =>
    Message.GotAuthMessage({ message }),
})

const foldLoginOutMessage = Login.OutMessage.match<
  Update.Step<Model, Message, Sync.LocalStoreService>
>({
  SucceededLogin:
    ({ session }) =>
    stepModel => {
      const next = modifyFields(stepModel, {
        auth: () => Auth.applySession(stepModel.auth, session),
        sync: () =>
          Sync.applySession(
            stepModel.sync,
            Option.some(session.user.id),
            session.householdId !== null,
          ),
        login: () => Login.initialModel(),
        route: () => landingRoute(session),
      })
      const sessionState = applySessionState(next)
      const entered = enterToday(sessionState.model)

      return {
        model: entered.model,
        commands: [
          authCommand(Auth.CacheSession({ session })),
          ReplaceUrl({ url: landingPath(session) }),
          ...(sessionState.commands ?? []),
          ...(entered.commands ?? []),
        ],
      }
    },
})

const foldLogin = Update.foldChild({
  update: Login.update,
  read: (model: Model) => Option.some(model.login),
  write: (model: Model, nextLogin: Login.Model) =>
    modifyFields(model, { login: () => nextLogin }),
  toParentMessage: (message: Login.Message) =>
    Message.GotLoginMessage({ message }),
  foldOutMessage: foldLoginOutMessage,
})

const foldRegisterOutMessage = Register.OutMessage.match<
  Update.Step<Model, Message, Sync.LocalStoreService>
>({
  SucceededRegister:
    ({ session }) =>
    stepModel => {
      const next = modifyFields(stepModel, {
        auth: () => Auth.applySession(stepModel.auth, session),
        sync: () =>
          Sync.applySession(
            stepModel.sync,
            Option.some(session.user.id),
            session.householdId !== null,
          ),
        register: () => Register.initialModel(),
        route: () => landingRoute(session),
      })
      const sessionState = applySessionState(next)
      const entered = enterToday(sessionState.model)

      return {
        model: entered.model,
        commands: [
          authCommand(Auth.CacheSession({ session })),
          ReplaceUrl({ url: landingPath(session) }),
          ...(sessionState.commands ?? []),
          ...(entered.commands ?? []),
        ],
      }
    },
})

const foldRegister = Update.foldChild({
  update: Register.update,
  read: (model: Model) => Option.some(model.register),
  write: (model: Model, nextRegister: Register.Model) =>
    modifyFields(model, { register: () => nextRegister }),
  toParentMessage: (message: Register.Message) =>
    Message.GotRegisterMessage({ message }),
  foldOutMessage: foldRegisterOutMessage,
})

const foldHouseholdOutMessage = Household.OutMessage.match<
  Update.Step<Model, Message, Sync.LocalStoreService>
>({
  CreatedHousehold:
    ({ householdId }) =>
    stepModel => {
      const nextAuth = Auth.applyHouseholdId(stepModel.auth, householdId)

      return {
        model: modifyFields(stepModel, {
          auth: () => nextAuth,
          sync: () =>
            Sync.applySession(
              stepModel.sync,
              Option.map(
                Auth.maybeSession(nextAuth),
                session => session.user.id,
              ),
              true,
            ),
        }),
        commands: cacheSessionCommands(nextAuth),
      }
    },

  JoinedHousehold:
    ({ householdId }) =>
    stepModel => {
      const nextAuth = Auth.applyHouseholdId(stepModel.auth, householdId)

      const next = modifyFields(stepModel, {
        auth: () => nextAuth,
        sync: () =>
          Sync.applySession(
            stepModel.sync,
            Option.map(Auth.maybeSession(nextAuth), session => session.user.id),
            true,
          ),
        route: () => AppRoute.Today(),
      })
      const entered = enterToday(next)

      return {
        model: entered.model,
        commands: [
          ...cacheSessionCommands(nextAuth),
          ReplaceUrl({ url: todayRouter() }),
          ...(entered.commands ?? []),
        ],
      }
    },

  AlreadyInHousehold: () => stepModel => {
    const refreshed = refreshAuth(stepModel)
    const entered = enterToday(
      modifyFields(refreshed.model, {
        route: () => AppRoute.Today(),
      }),
    )

    return {
      model: entered.model,
      commands: [
        ...(refreshed.commands ?? []),
        ReplaceUrl({ url: todayRouter() }),
        ...(entered.commands ?? []),
      ],
    }
  },

  RequestedToday: () => stepModel => {
    const entered = enterToday(
      modifyFields(stepModel, { route: () => AppRoute.Today() }),
    )

    return {
      model: entered.model,
      commands: [
        ReplaceUrl({ url: todayRouter() }),
        ...(entered.commands ?? []),
      ],
    }
  },
})

const foldHousehold = Update.foldChild({
  update: Household.update,
  read: (model: Model) => Option.some(model.household),
  write: (model: Model, nextHousehold: Household.Model) =>
    modifyFields(model, { household: () => nextHousehold }),
  toParentMessage: (message: Household.Message) =>
    Message.GotHouseholdMessage({ message }),
  foldOutMessage: foldHouseholdOutMessage,
})

const foldPreferences = Update.foldChild({
  update: Preferences.update,
  read: (model: Model) => Option.some(model.preferences),
  write: (model: Model, nextPreferences: Preferences.Model) =>
    modifyFields(model, { preferences: () => nextPreferences }),
  toParentMessage: (message: Preferences.Message) =>
    Message.GotPreferencesMessage({ message }),
})

const foldPush = Update.foldChild({
  update: Push.update,
  read: (model: Model) => Option.some(model.push),
  write: (model: Model, nextPush: Push.Model) =>
    modifyFields(model, { push: () => nextPush }),
  toParentMessage: (message: Push.Message) =>
    Message.GotPushMessage({ message }),
})

const foldSync = Update.foldChild({
  update: Sync.update,
  read: (model: Model) => Option.some(model.sync),
  write: (model: Model, nextSync: Sync.Model) =>
    modifyFields(model, { sync: () => nextSync }),
  toParentMessage: (message: Sync.Message) =>
    Message.GotSyncMessage({ message }),
})

type TodayFoldInput = Readonly<{
  message: Today.Message
  inputs: Today.Inputs
}>

const foldSyncRefresh = Update.foldChildStep({
  update: Sync.refreshMirror,
  read: (model: Model) => Option.some(model.sync),
  write: (model: Model, nextSync: Sync.Model) =>
    modifyFields(model, { sync: () => nextSync }),
  toParentMessage: (message: Sync.Message) =>
    Message.GotSyncMessage({ message }),
})

const foldPreferencesSaved = Update.foldChild({
  update: Preferences.applySaved,
  read: (model: Model) => Option.some(model.preferences),
  write: (model: Model, nextPreferences: Preferences.Model) =>
    modifyFields(model, { preferences: () => nextPreferences }),
  toParentMessage: toPreferencesMessage,
})

const foldTodayOutMessage = Today.OutMessage.match<
  Update.Step<Model, Message, Sync.LocalStoreService>
>({
  WroteLocalData: () => stepModel => foldSyncRefresh(stepModel),

  SavedSectionOrder:
    ({ preferences }) =>
    stepModel =>
      foldPreferencesSaved(stepModel, preferences),
})

const foldToday = Update.foldChild({
  update: (today: Today.Model, input: TodayFoldInput) =>
    Today.update(today, input.message, input.inputs),
  read: (model: Model) => Option.some(model.today),
  write: (model: Model, nextToday: Today.Model) =>
    modifyFields(model, { today: () => nextToday }),
  toParentMessage: toTodayMessage,
  foldOutMessage: foldTodayOutMessage,
})

const foldTodayEntered = Update.foldChild({
  update: Today.entered,
  read: (model: Model) => Option.some(model.today),
  write: (model: Model, nextToday: Today.Model) =>
    modifyFields(model, { today: () => nextToday }),
  toParentMessage: toTodayMessage,
})

const foldTodaySyncSettled = Update.foldChild({
  update: Today.syncSettled,
  read: (model: Model) => Option.some(model.today),
  write: (model: Model, nextToday: Today.Model) =>
    modifyFields(model, { today: () => nextToday }),
  toParentMessage: toTodayMessage,
})

const foldTodayMessage = (model: Model, message: Today.Message): UpdateReturn =>
  foldToday(model, { message, inputs: todayInputs(model) })

/** Land on a freshly opened Today screen: refresh the read model once. */
const enterToday = (model: Model): UpdateReturn =>
  model.route._tag === 'Today' && guardAllows(model, model.route)
    ? foldTodayEntered(model, todayInputs(model))
    : { model }

const withStepCommands = (
  base: UpdateReturn,
  step: UpdateReturn,
): UpdateReturn => ({
  model: step.model,
  commands: [...(base.commands ?? []), ...(step.commands ?? [])],
})

/**
 * A completed drain is the moment the server read model is worth revalidating:
 * while writes were queued, Today overlaid them instead of fetching.
 */
const foldSyncMessage = (model: Model, message: Sync.Message): UpdateReturn => {
  const wasPending = model.sync.pending
  const folded = foldSync(model, message)
  const settled = wasPending > 0 && folded.model.sync.pending === 0

  if (!settled || folded.model.route._tag !== 'Today') {
    return folded
  }

  const todayStep = foldTodaySyncSettled(
    folded.model,
    todayInputs(folded.model),
  )

  return {
    model: todayStep.model,
    commands: [...(folded.commands ?? []), ...(todayStep.commands ?? [])],
  }
}

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedUrl: ({ url }) => {
      const nextRoute = urlToAppRoute(url)
      const guarded = enforceGuard(model, nextRoute)
      const entered = Transition.entered(
        Transition.make(model.route, nextRoute),
        'Today',
      )

      if (
        Option.isNone(entered) ||
        guarded.model.route._tag !== 'Today' ||
        !guardAllows(guarded.model, nextRoute)
      ) {
        return guarded
      }

      const todayStep = foldTodayEntered(
        guarded.model,
        todayInputs(guarded.model),
      )

      return {
        model: todayStep.model,
        commands: [...(guarded.commands ?? []), ...(todayStep.commands ?? [])],
      }
    },

    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({
          model,
          commands: [NavigateInternal({ url: urlToString(url) })],
        }),
        External: ({ href }) => ({
          model,
          commands: [LoadExternal({ href })],
        }),
      }),

    CompletedNavigateInternal: () => ({ model }),
    CompletedReplaceUrl: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),

    GotThemeMessage: ({ message }) => foldTheme(model, message),
    GotAuthMessage: ({ message }) => foldAuth(model, message),
    GotLoginMessage: ({ message }) => foldLogin(model, message),
    GotRegisterMessage: ({ message }) => foldRegister(model, message),
    GotHouseholdMessage: ({ message }) => foldHousehold(model, message),
    GotPreferencesMessage: ({ message }) => foldPreferences(model, message),
    GotPushMessage: ({ message }) => foldPush(model, message),
    GotSyncMessage: ({ message }) => foldSyncMessage(model, message),
    GotTodayMessage: ({ message }) => foldTodayMessage(model, message),
  })

// VIEW

type PageCopy = Readonly<{
  heading: string
  documentTitle: string
}>

const pageCopy = (route: AppRoute): PageCopy =>
  AppRoute.match(route, {
    Home: () => ({ heading: 'تالی', documentTitle: 'Tali' }),
    Login: () => ({ heading: 'ورود به تالی', documentTitle: 'ورود — تالی' }),
    Register: () => ({ heading: 'ساخت حساب', documentTitle: 'ثبت‌نام — تالی' }),
    Today: () => ({ heading: 'امروز', documentTitle: 'امروز — تالی' }),
    Tasks: () => ({ heading: 'کارها', documentTitle: 'کارها — تالی' }),
    Lists: () => ({ heading: 'فهرست‌ها', documentTitle: 'فهرست‌ها — تالی' }),
    List: () => ({ heading: 'فهرست', documentTitle: 'فهرست — تالی' }),
    Notes: () => ({ heading: 'یادداشت‌ها', documentTitle: 'یادداشت‌ها — تالی' }),
    Note: () => ({ heading: 'یادداشت', documentTitle: 'یادداشت — تالی' }),
    NotesTrash: () => ({
      heading: 'سطل زباله',
      documentTitle: 'سطل زباله — تالی',
    }),
    Habits: () => ({ heading: 'عادت‌ها', documentTitle: 'عادت‌ها — تالی' }),
    Calendar: () => ({ heading: 'تقویم', documentTitle: 'تقویم — تالی' }),
    Reminders: () => ({
      heading: 'یادآورها',
      documentTitle: 'یادآورها — تالی',
    }),
    Settings: () => ({ heading: 'تنظیمات', documentTitle: 'تنظیمات — تالی' }),
    Household: () => ({
      heading: 'خانه‌ی مشترک',
      documentTitle: 'خانه‌ی مشترک — تالی',
    }),
    PushHealth: () => ({
      heading: 'وضعیت اعلان‌ها',
      documentTitle: 'وضعیت اعلان‌ها — تالی',
    }),
    NotFound: () => ({
      heading: 'صفحه پیدا نشد',
      documentTitle: 'صفحه پیدا نشد — تالی',
    }),
  })

const usesAppShell = AppRoute.isAnyOf([
  'Today',
  'Tasks',
  'Lists',
  'List',
  'Notes',
  'Note',
  'NotesTrash',
  'Habits',
  'Calendar',
  'Reminders',
  'Settings',
  'PushHealth',
])

const routeDetail = (route: AppRoute): Option.Option<string> =>
  AppRoute.matchOrElse<Option.Option<string>>(
    route,
    {
      List: ({ listId }) => Option.some(`شناسه‌ی فهرست: ${listId}`),
      Note: ({ noteId }) => Option.some(`شناسه‌ی یادداشت: ${noteId}`),
    },
    () => Option.none(),
  )

const placeholderNoteView = (h: HtmlBuilder<Message>): Html =>
  h.p(
    [h.Class('m-0 text-sm leading-7 text-base-content/55')],
    ['این صفحه در گام بعدی ساخته می‌شود.'],
  )

const placeholderPageView = (
  heading: string,
  maybeDetail: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class('page-wrap grid max-w-5xl gap-3')],
    [
      h.h1([h.Class('m-0 text-3xl font-bold tracking-tight')], [heading]),
      placeholderNoteView(h),
      Option.match(maybeDetail, {
        onNone: () => h.empty,
        onSome: detail => h.p([h.Class('soft-note m-0 text-xs')], [detail]),
      }),
    ],
  )

const homeView = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('grid justify-items-center gap-3 text-center')],
    [
      h.span(
        [
          h.Class(
            'grid size-14 place-items-center rounded-2xl bg-primary text-2xl font-black text-primary-content shadow-sm',
          ),
        ],
        ['ت'],
      ),
      h.h1([h.Class('m-0 text-3xl font-bold tracking-tight')], ['تالی']),
      h.p(
        [h.Class('m-0 text-sm leading-7 text-base-content/60')],
        ['برنامه‌ریز مشترک خانه‌ی شما.'],
      ),
      h.p(
        [h.Class('m-0 text-xs text-base-content/45')],
        ['در حال هدایت به جای درست…'],
      ),
    ],
  )

const notFoundView = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.Class(
        'card w-full max-w-sm border border-base-300 bg-base-100 shadow-xl',
      ),
    ],
    [
      h.div(
        [h.Class('card-body items-center gap-3 text-center')],
        [
          h.span(
            [
              h.Class(
                'grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary',
              ),
            ],
            [searchIcon('size-6')],
          ),
          h.h1([h.Class('m-0 text-2xl font-bold')], ['صفحه پیدا نشد']),
          h.p(
            [h.Class('m-0 text-sm text-base-content/55')],
            ['نشانی‌ای که باز کردید وجود ندارد.'],
          ),
          h.a(
            [h.Href(homeRouter()), h.Class('btn btn-primary btn-sm mt-1')],
            ['بازگشت به تالی'],
          ),
        ],
      ),
    ],
  )

const todayPageView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: 'today-page',
    model: model.today,
    view: Today.view,
    viewInputs: todayInputs(model),
    toParentMessage: toTodayMessage,
  })

const settingsPageView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('page-wrap grid max-w-2xl gap-4')],
    [
      h.header(
        [h.Class('grid gap-1')],
        [
          h.h1(
            [h.Class('m-0 text-2xl font-bold tracking-tight sm:text-3xl')],
            ['تنظیمات'],
          ),
          h.p(
            [h.Class('m-0 text-sm leading-7 text-base-content/55')],
            ['ظاهر برنامه، تقویم و منطقه‌ی زمانی، و وضعیت اعلان‌های این دستگاه.'],
          ),
        ],
      ),
      h.submodel({
        slotId: 'settings-theme-picker',
        model: model.theme,
        view: Theme.pickerView,
        toParentMessage: toThemeMessage,
      }),
      h.submodel({
        slotId: 'settings-preferences',
        model: model.preferences,
        view: Preferences.settingsView,
        toParentMessage: toPreferencesMessage,
      }),
      h.submodel({
        slotId: 'settings-push-health',
        model: model.push,
        view: Push.healthView,
        toParentMessage: toPushMessage,
      }),
    ],
  )

const pushHealthPageView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('page-wrap grid max-w-2xl gap-4')],
    [
      h.h1(
        [h.Class('m-0 text-2xl font-bold tracking-tight sm:text-3xl')],
        ['وضعیت اعلان‌ها'],
      ),
      h.submodel({
        slotId: 'push-health',
        model: model.push,
        view: Push.healthView,
        toParentMessage: toPushMessage,
      }),
    ],
  )

const pageView = (model: Model, h: HtmlBuilder<Message>): Html =>
  AppRoute.matchOrElse<Html>(
    model.route,
    {
      Home: () => homeView(h),
      Login: () =>
        h.submodel({
          slotId: 'login-page',
          model: model.login,
          view: Login.view,
          toParentMessage: message => Message.GotLoginMessage({ message }),
        }),
      Register: () =>
        h.submodel({
          slotId: 'register-page',
          model: model.register,
          view: Register.view,
          toParentMessage: message => Message.GotRegisterMessage({ message }),
        }),
      Household: () =>
        h.submodel({
          slotId: 'household-page',
          model: model.household,
          view: Household.view,
          viewInputs: {
            maybeDisplayName: Option.map(
              Auth.maybeSession(model.auth),
              session => session.user.displayName,
            ),
          },
          toParentMessage: message => Message.GotHouseholdMessage({ message }),
        }),
      Today: () => todayPageView(model, h),
      Settings: () => settingsPageView(model, h),
      PushHealth: () => pushHealthPageView(model, h),
      NotFound: () => notFoundView(h),
    },
    () =>
      placeholderPageView(
        pageCopy(model.route).heading,
        routeDetail(model.route),
        h,
      ),
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const copy = pageCopy(model.route)
  const themeToggle = h.submodel({
    slotId: 'theme-toggle',
    model: model.theme,
    view: Theme.view,
    toParentMessage: message => Message.GotThemeMessage({ message }),
  })
  const maybeSession = Auth.maybeSession(model.auth)
  const maybeDisplayName = Option.map(
    maybeSession,
    session => session.user.displayName,
  )
  const syncStatus = Option.match(maybeSession, {
    onNone: () => h.empty,
    onSome: () =>
      h.submodel({
        slotId: 'sync-status',
        model: model.sync,
        view: Sync.view,
        toParentMessage: message => Message.GotSyncMessage({ message }),
      }),
  })
  const accountMenu = h.submodel({
    slotId: 'account-menu',
    model: model.auth,
    view: Auth.view,
    toParentMessage: message => Message.GotAuthMessage({ message }),
  })
  const authBoot = () =>
    h.submodel({
      slotId: 'auth-boot',
      model: model.auth,
      view: Auth.bootView,
      toParentMessage: message => Message.GotAuthMessage({ message }),
    })
  const actions = h.div(
    [h.Class('flex items-center gap-1')],
    [syncStatus, themeToggle, accountMenu],
  )
  const guard = GuardDecision.match<
    Readonly<{
      isAllowed: boolean
      content: Html
    }>
  >(guardRoute(model.route, model.auth, guardContext(model)), {
    Allow: () => ({ isAllowed: true, content: pageView(model, h) }),
    Wait: () => ({
      isAllowed: false,
      content: authBoot(),
    }),
    Redirect: () => ({
      isAllowed: false,
      content: authBoot(),
    }),
  })

  const body =
    guard.isAllowed && usesAppShell(model.route)
      ? Shell.view(
          {
            actions,
            content: guard.content,
            maybeActiveSection: Shell.sectionForRoute(model.route),
            maybeDisplayName,
          },
          h,
        )
      : Shell.standaloneView({ actions, content: guard.content }, h)

  return {
    title: copy.documentTitle,
    lang: 'fa',
    dir: 'Rtl',
    body,
  }
}

// SUBSCRIPTION

const syncSubscriptions = Subscription.lift(Sync.subscriptions)<Model, Message>(
  {
    read: model => Option.some(model.sync),
    toParentMessage: message => Message.GotSyncMessage({ message }),
  },
)

const themeSubscriptions = Subscription.lift(Theme.subscriptions)<
  Model,
  Message
>({
  read: model => Option.some(model.theme),
  toParentMessage: toThemeMessage,
})

const pushSubscriptions = Subscription.lift(Push.subscriptions)<Model, Message>(
  {
    read: model => Option.some(model.push),
    toParentMessage: toPushMessage,
  },
)

const todaySubscriptions = Subscription.lift(Today.subscriptions)<
  Model,
  Message
>({
  read: model =>
    model.route._tag === 'Today' ? Option.some(model.today) : Option.none(),
  toParentMessage: toTodayMessage,
})

export const subscriptions = Subscription.aggregate(
  syncSubscriptions,
  themeSubscriptions,
  pushSubscriptions,
  todaySubscriptions,
)
