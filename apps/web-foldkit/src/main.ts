import { Array, Effect, Match, Option, Schema } from 'effect'
import { Popover } from '@foldkit/ui'
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

import { type ListId, type NoteId } from '@tali/domain'

import * as Auth from './auth'
import { GuardDecision, guardRoute, landingPath, landingRoute } from './guard'
import { PushEnvironment } from './lib/push/service-worker'
import * as Calendar from './page/calendar'
import * as Habits from './page/habits'
import * as Household from './page/household'
import * as Lists from './page/lists'
import * as Login from './page/login'
import * as Notes from './page/notes'
import * as Register from './page/register'
import * as Reminders from './page/reminders'
import * as Tasks from './page/tasks'
import { TaskViewSettings } from './page/tasks-model'
import * as Today from './page/today'
import * as Preferences from './preferences'
import { Preferences as PreferencesRow } from './preferences-model'
import * as Push from './push'
import {
  AppRoute,
  homeRouter,
  listPath,
  listsRouter,
  notePath,
  notesRouter,
  settingsRouter,
  todayRouter,
  urlToAppRoute,
} from './route'
import { Session } from './session'
import * as Settings from './settings'
import * as Shell from './shell'
import * as Sync from './sync'
import * as Theme from './theme'
import { listsIcon, searchIcon } from './ui/icons'

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
  lists: Lists.Model,
  notes: Notes.Model,
  tasks: Tasks.Model,
  habits: Habits.Model,
  calendar: Calendar.Model,
  reminders: Reminders.Model,
  settings: Settings.Model,
  morePopover: Popover.Model,
})
export type Model = typeof Model.Type

export const Flags = Schema.Struct({
  maybeCachedSession: Schema.Option(Session),
  maybeCachedPreferences: Schema.Option(PreferencesRow),
  maybeCachedTaskView: Schema.Option(TaskViewSettings),
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
  GotListsMessage: { message: Lists.Message },
  GotNotesMessage: { message: Notes.Message },
  GotTasksMessage: { message: Tasks.Message },
  GotHabitsMessage: { message: Habits.Message },
  GotCalendarMessage: { message: Calendar.Message },
  GotRemindersMessage: { message: Reminders.Message },
  GotSettingsMessage: { message: Settings.Message },
  GotMorePopoverMessage: { message: Popover.Message },
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
  const maybeUserId = Option.map(maybeSession, session => session.user.id)
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
  const listsInit = Lists.init()
  const tasksInit = Tasks.init({
    now: flags.now,
    maybeUserId,
    maybeSettings: flags.maybeCachedTaskView,
  })
  const habitsInit = Habits.init({ now: flags.now })
  const calendarInit = Calendar.init({ now: flags.now })
  const remindersInit = Reminders.init()
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
    lists: listsInit.model,
    notes: Notes.initialModel(),
    tasks: tasksInit.model,
    habits: habitsInit.model,
    calendar: calendarInit.model,
    reminders: remindersInit.model,
    settings: Settings.initialModel(),
    morePopover: Popover.init({ id: 'mobile-more-menu' }),
  })
  const guarded = enforceGuard(model, route)
  const entered = enterRoute(
    guarded.model,
    Transition.coldLoad(guarded.model.route),
  )

  return {
    model: entered.model,
    commands: [
      ...Command.mapMessages(themeInit.commands, toThemeMessage),
      ...Command.mapMessages(authInit.commands, toAuthMessage),
      ...Command.mapMessages(preferencesInit.commands, toPreferencesMessage),
      ...Command.mapMessages(pushInit.commands, toPushMessage),
      ...(guarded.commands ?? []),
      ...(entered.commands ?? []),
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

const toListsMessage = (message: Lists.Message): Message =>
  Message.GotListsMessage({ message })

const toNotesMessage = (message: Notes.Message): Message =>
  Message.GotNotesMessage({ message })

const toTasksMessage = (message: Tasks.Message): Message =>
  Message.GotTasksMessage({ message })

const toHabitsMessage = (message: Habits.Message): Message =>
  Message.GotHabitsMessage({ message })

const toCalendarMessage = (message: Calendar.Message): Message =>
  Message.GotCalendarMessage({ message })

const toRemindersMessage = (message: Reminders.Message): Message =>
  Message.GotRemindersMessage({ message })

const toSettingsMessage = (message: Settings.Message): Message =>
  Message.GotSettingsMessage({ message })

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

/** The Lists screens read the same mirror plus the signed-in writer identity. */
const listsInputs = (model: Model): Lists.Inputs => ({
  display: Preferences.currentDisplayFields(model.preferences),
  checkedItemPlacement: Preferences.currentCheckedItemPlacement(
    model.preferences,
  ),
  isStoreReady: Sync.isStoreReady(model.sync),
  isOnline: model.sync.isOnline,
  pending: model.sync.pending,
  mirror: model.sync.mirror,
  pendingKeys: model.sync.pendingKeys,
  maybeUserId: Option.map(
    Auth.maybeSession(model.auth),
    session => session.user.id,
  ),
})

const tasksInputs = (model: Model): Tasks.Inputs => ({
  display: Preferences.currentDisplayFields(model.preferences),
  isStoreReady: Sync.isStoreReady(model.sync),
  isOnline: model.sync.isOnline,
  pending: model.sync.pending,
  mirror: model.sync.mirror,
  pendingKeys: model.sync.pendingKeys,
})

/** The Notes screens read the same mirror and connectivity state. */
const notesInputs = (model: Model): Notes.Inputs => ({
  display: Preferences.currentDisplayFields(model.preferences),
  isStoreReady: Sync.isStoreReady(model.sync),
  isOnline: model.sync.isOnline,
  pending: model.sync.pending,
  mirror: model.sync.mirror,
  pendingKeys: model.sync.pendingKeys,
})

/** The Habits screen reads the same mirror plus the sync error banner. */
const habitsInputs = (model: Model): Habits.Inputs => ({
  display: Preferences.currentDisplayFields(model.preferences),
  isStoreReady: Sync.isStoreReady(model.sync),
  isOnline: model.sync.isOnline,
  pending: model.sync.pending,
  mirror: model.sync.mirror,
  pendingKeys: model.sync.pendingKeys,
  maybeSyncError: model.sync.maybeError,
  maybeUserId: Option.map(
    Auth.maybeSession(model.auth),
    session => session.user.id,
  ),
})

/** The Settings password form needs only the signed-in email to derive keys. */
const settingsInputs = (model: Model): Settings.Inputs => ({
  maybeEmail: Option.map(
    Auth.maybeSession(model.auth),
    session => session.user.email,
  ),
})

/** The Calendar screen reads the mirror plus the signed-in writer identity. */
const calendarInputs = (model: Model): Calendar.Inputs => ({
  display: Preferences.currentDisplayFields(model.preferences),
  isStoreReady: Sync.isStoreReady(model.sync),
  isOnline: model.sync.isOnline,
  pending: model.sync.pending,
  mirror: model.sync.mirror,
  pendingKeys: model.sync.pendingKeys,
  maybeUserId: Option.map(
    Auth.maybeSession(model.auth),
    session => session.user.id,
  ),
  maybeHouseholdId: Option.flatMap(Auth.maybeSession(model.auth), session =>
    Option.fromNullishOr(session.householdId),
  ),
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

const applyTasksSession = Update.foldChild({
  update: Tasks.applySession,
  read: (model: Model) => Option.some(model.tasks),
  write: (model: Model, nextTasks: Tasks.Model) =>
    modifyFields(model, { tasks: () => nextTasks }),
  toParentMessage: toTasksMessage,
})

/**
 * Push the current session into the child Submodels that key work by identity.
 * Preferences, push, and the tasks view each start one read per sign-in; sync
 * only swaps the managed store resource. Each fold lifts the child's Commands
 * to the root.
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
  (model: Model) =>
    applyTasksSession(
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
    settings: () => Settings.initialModel(),
  })

const foldTheme: Update.Fold<Model, Message, Theme.Message> = Update.foldChild({
  update: Theme.update,
  read: (model: Model) => Option.some(model.theme),
  write: (model: Model, nextTheme: Theme.Model) =>
    modifyFields(model, { theme: () => nextTheme }),
  toParentMessage: (message: Theme.Message) =>
    Message.GotThemeMessage({ message }),
})

const foldMorePopoverOutMessage =
  Popover.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => stepModel => ({ model: stepModel }),
    Closed: () => stepModel => ({ model: stepModel }),
  })

const foldMorePopover = Update.foldChild({
  update: Popover.update,
  read: (model: Model) => Option.some(model.morePopover),
  write: (model: Model, nextPopover: Popover.Model) =>
    modifyFields(model, { morePopover: () => nextPopover }),
  toParentMessage: message => Message.GotMorePopoverMessage({ message }),
  foldOutMessage: foldMorePopoverOutMessage,
})

const closeMorePopover = (model: Model): UpdateReturn => {
  const closed = Popover.close(model.morePopover)

  return {
    model: modifyFields(model, { morePopover: () => closed.model }),
    commands: Command.mapMessages(
      closed.commands,
      message => Message.GotMorePopoverMessage({ message }),
    ),
  }
}

const foldAuthOutMessage = Auth.OutMessage.match<
  Update.Step<Model, Message, Sync.LocalStoreService>
>({
  RestoredSession: () => stepModel => {
    const guarded = enforceGuardWithSessionUser(stepModel, stepModel.route)

    return withStepCommands(guarded, enterCurrentRoute(guarded.model))
  },
  SignedOut: () => stepModel =>
    enforceGuardWithSessionUser(resetForms(stepModel), stepModel.route),
  SelectedSettings: () => stepModel => ({
    model: stepModel,
    commands: [NavigateInternal({ url: settingsRouter() })],
  }),
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
      const entered = enterCurrentRoute(sessionState.model)

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
      const entered = enterCurrentRoute(sessionState.model)

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
      const entered = enterCurrentRoute(next)

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
    const entered = enterCurrentRoute(
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
    const entered = enterCurrentRoute(
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

type ListsFoldInput = Readonly<{
  message: Lists.Message
  inputs: Lists.Inputs
}>

const foldLists = Update.foldChild({
  update: (lists: Lists.Model, input: ListsFoldInput) =>
    Lists.update(lists, input.message, input.inputs),
  read: (model: Model) => Option.some(model.lists),
  write: (model: Model, nextLists: Lists.Model) =>
    modifyFields(model, { lists: () => nextLists }),
  toParentMessage: toListsMessage,
  foldOutMessage: Lists.OutMessage.match<
    Update.Step<Model, Message, Sync.LocalStoreService>
  >({
    WroteLocalData: () => stepModel => foldSyncRefresh(stepModel),

    CreatedList:
      ({ listId }) =>
      stepModel => {
        const refreshed = foldSyncRefresh(stepModel)

        return {
          model: refreshed.model,
          commands: [
            ...(refreshed.commands ?? []),
            NavigateInternal({ url: listPath(listId) }),
          ],
        }
      },

    DeletedList:
      ({ listId }) =>
      stepModel => {
        const refreshed = foldSyncRefresh(stepModel)
        const wasCurrent =
          stepModel.route._tag === 'List' && stepModel.route.listId === listId

        return wasCurrent
          ? {
              model: refreshed.model,
              commands: [
                ...(refreshed.commands ?? []),
                NavigateInternal({ url: listsRouter() }),
              ],
            }
          : refreshed
      },
  }),
})

const foldListsEnteredIndex = Update.foldChild({
  update: Lists.enteredIndex,
  read: (model: Model) => Option.some(model.lists),
  write: (model: Model, nextLists: Lists.Model) =>
    modifyFields(model, { lists: () => nextLists }),
  toParentMessage: toListsMessage,
})

const foldListsEnteredDetail = Update.foldChild({
  update: (lists: Lists.Model, input: Readonly<{ listId: ListId }>) =>
    Lists.enteredDetail(lists, { listId: input.listId }),
  read: (model: Model) => Option.some(model.lists),
  write: (model: Model, nextLists: Lists.Model) =>
    modifyFields(model, { lists: () => nextLists }),
  toParentMessage: toListsMessage,
})

const foldListsMirrorSettled = Update.foldChild({
  update: (lists: Lists.Model, inputs: Lists.Inputs) =>
    Lists.mirrorSettled(lists, inputs),
  read: (model: Model) => Option.some(model.lists),
  write: (model: Model, nextLists: Lists.Model) =>
    modifyFields(model, { lists: () => nextLists }),
  toParentMessage: toListsMessage,
})

/** Enter a Lists screen and re-read the mirror that screen renders from. */
const enterListsPage = (
  model: Model,
  maybeListId: Option.Option<ListId>,
): UpdateReturn => {
  const entered = Option.match(maybeListId, {
    onNone: () => foldListsEnteredIndex(model, undefined),
    onSome: listId => foldListsEnteredDetail(model, { listId }),
  })

  if (!Sync.isStoreReady(entered.model.sync)) {
    return entered
  }

  const refreshed = foldSyncRefresh(entered.model)

  return {
    model: refreshed.model,
    commands: [...(entered.commands ?? []), ...(refreshed.commands ?? [])],
  }
}

const foldListsMessage = (model: Model, message: Lists.Message): UpdateReturn =>
  foldLists(model, { message, inputs: listsInputs(model) })

type NotesFoldInput = Readonly<{
  message: Notes.Message
  inputs: Notes.Inputs
}>

const foldNotesOutMessage = Notes.OutMessage.match<
  Update.Step<Model, Message, Sync.LocalStoreService>
>({
  WroteLocalData: () => stepModel => foldSyncRefresh(stepModel),

  CreatedNote:
    ({ noteId }) =>
    stepModel => {
      const refreshed = foldSyncRefresh(stepModel)

      return {
        model: refreshed.model,
        commands: [
          ...(refreshed.commands ?? []),
          NavigateInternal({ url: notePath(noteId) }),
        ],
      }
    },

  ArchivedNote:
    ({ noteId }) =>
    stepModel => {
      const refreshed = foldSyncRefresh(stepModel)
      const wasCurrent =
        stepModel.route._tag === 'Note' && stepModel.route.noteId === noteId

      return wasCurrent
        ? {
            model: refreshed.model,
            commands: [
              ...(refreshed.commands ?? []),
              NavigateInternal({ url: notesRouter() }),
            ],
          }
        : refreshed
    },

  TrashedNote:
    ({ noteId }) =>
    stepModel => {
      const refreshed = foldSyncRefresh(stepModel)
      const wasCurrent =
        stepModel.route._tag === 'Note' && stepModel.route.noteId === noteId

      return wasCurrent
        ? {
            model: refreshed.model,
            commands: [
              ...(refreshed.commands ?? []),
              NavigateInternal({ url: notesRouter() }),
            ],
          }
        : refreshed
    },
})

const foldNotes = Update.foldChild({
  update: (notes: Notes.Model, input: NotesFoldInput) =>
    Notes.update(notes, input.message, input.inputs),
  read: (model: Model) => Option.some(model.notes),
  write: (model: Model, nextNotes: Notes.Model) =>
    modifyFields(model, { notes: () => nextNotes }),
  toParentMessage: toNotesMessage,
  foldOutMessage: foldNotesOutMessage,
})

const foldNotesEnteredIndex = Update.foldChildStep({
  update: Notes.enteredIndex,
  read: (model: Model) => Option.some(model.notes),
  write: (model: Model, nextNotes: Notes.Model) =>
    modifyFields(model, { notes: () => nextNotes }),
  toParentMessage: toNotesMessage,
})

const foldNotesEnteredTrash = Update.foldChildStep({
  update: Notes.enteredTrash,
  read: (model: Model) => Option.some(model.notes),
  write: (model: Model, nextNotes: Notes.Model) =>
    modifyFields(model, { notes: () => nextNotes }),
  toParentMessage: toNotesMessage,
})

const foldNotesEnteredNote = Update.foldChild({
  update: (
    notes: Notes.Model,
    input: Readonly<{ noteId: NoteId; isStoreReady: boolean }>,
  ) =>
    Notes.enteredNote(notes, {
      noteId: input.noteId,
      isStoreReady: input.isStoreReady,
    }),
  read: (model: Model) => Option.some(model.notes),
  write: (model: Model, nextNotes: Notes.Model) =>
    modifyFields(model, { notes: () => nextNotes }),
  toParentMessage: toNotesMessage,
})

const foldNotesLeftNote = Update.foldChildStep({
  update: Notes.leftNote,
  read: (model: Model) => Option.some(model.notes),
  write: (model: Model, nextNotes: Notes.Model) =>
    modifyFields(model, { notes: () => nextNotes }),
  toParentMessage: toNotesMessage,
})

const foldNotesMirrorSettled = Update.foldChild({
  update: (notes: Notes.Model, inputs: Notes.Inputs) =>
    Notes.mirrorSettled(notes, inputs),
  read: (model: Model) => Option.some(model.notes),
  write: (model: Model, nextNotes: Notes.Model) =>
    modifyFields(model, { notes: () => nextNotes }),
  toParentMessage: toNotesMessage,
})

const foldNotesMessage = (model: Model, message: Notes.Message): UpdateReturn =>
  foldNotes(model, { message, inputs: notesInputs(model) })

/** Enter `/notes` and re-read the mirror the screen renders from. */
const enterNotesIndex = (model: Model): UpdateReturn => {
  const entered = foldNotesEnteredIndex(model)

  if (!Sync.isStoreReady(entered.model.sync)) {
    return entered
  }

  const refreshed = foldSyncRefresh(entered.model)

  return {
    model: refreshed.model,
    commands: [...(entered.commands ?? []), ...(refreshed.commands ?? [])],
  }
}

/** Enter `/notes/trash` and re-read the mirror it renders from. */
const enterNotesTrash = (model: Model): UpdateReturn => {
  const entered = foldNotesEnteredTrash(model)

  if (!Sync.isStoreReady(entered.model.sync)) {
    return entered
  }

  const refreshed = foldSyncRefresh(entered.model)

  return {
    model: refreshed.model,
    commands: [...(entered.commands ?? []), ...(refreshed.commands ?? [])],
  }
}

/** Enter one note editor, loading it from the mirror and its crash draft. */
const enterNotesNote = (model: Model, noteId: NoteId): UpdateReturn => {
  const entered = foldNotesEnteredNote(model, {
    noteId,
    isStoreReady: Sync.isStoreReady(model.sync),
  })

  if (!Sync.isStoreReady(entered.model.sync)) {
    return entered
  }

  const refreshed = foldSyncRefresh(entered.model)

  return {
    model: refreshed.model,
    commands: [...(entered.commands ?? []), ...(refreshed.commands ?? [])],
  }
}

type TasksFoldInput = Readonly<{
  message: Tasks.Message
  inputs: Tasks.Inputs
}>

const foldTasksOutMessage = Tasks.OutMessage.match<
  Update.Step<Model, Message, Sync.LocalStoreService>
>({
  WroteLocalData: () => stepModel => foldSyncRefresh(stepModel),
})

const foldTasks = Update.foldChild({
  update: (tasks: Tasks.Model, input: TasksFoldInput) =>
    Tasks.update(tasks, input.message, input.inputs),
  read: (model: Model) => Option.some(model.tasks),
  write: (model: Model, nextTasks: Tasks.Model) =>
    modifyFields(model, { tasks: () => nextTasks }),
  toParentMessage: toTasksMessage,
  foldOutMessage: foldTasksOutMessage,
})

const foldTasksEntered = Update.foldChildStep({
  update: Tasks.entered,
  read: (model: Model) => Option.some(model.tasks),
  write: (model: Model, nextTasks: Tasks.Model) =>
    modifyFields(model, { tasks: () => nextTasks }),
  toParentMessage: toTasksMessage,
})

const foldTasksMessage = (model: Model, message: Tasks.Message): UpdateReturn =>
  foldTasks(model, { message, inputs: tasksInputs(model) })

type HabitsFoldInput = Readonly<{
  message: Habits.Message
  inputs: Habits.Inputs
}>

const foldHabits = Update.foldChild({
  update: (habits: Habits.Model, input: HabitsFoldInput) =>
    Habits.update(habits, input.message, input.inputs),
  read: (model: Model) => Option.some(model.habits),
  write: (model: Model, nextHabits: Habits.Model) =>
    modifyFields(model, { habits: () => nextHabits }),
  toParentMessage: toHabitsMessage,
  foldOutMessage: Habits.OutMessage.match<
    Update.Step<Model, Message, Sync.LocalStoreService>
  >({
    WroteLocalData: () => stepModel => foldSyncRefresh(stepModel),
  }),
})

const foldHabitsEntered = Update.foldChild({
  update: Habits.entered,
  read: (model: Model) => Option.some(model.habits),
  write: (model: Model, nextHabits: Habits.Model) =>
    modifyFields(model, { habits: () => nextHabits }),
  toParentMessage: toHabitsMessage,
})

const foldHabitsMessage = (
  model: Model,
  message: Habits.Message,
): UpdateReturn => foldHabits(model, { message, inputs: habitsInputs(model) })

type CalendarFoldInput = Readonly<{
  message: Calendar.Message
  inputs: Calendar.Inputs
}>

const foldCalendar = Update.foldChild({
  update: (calendar: Calendar.Model, input: CalendarFoldInput) =>
    Calendar.update(calendar, input.message, input.inputs),
  read: (model: Model) => Option.some(model.calendar),
  write: (model: Model, nextCalendar: Calendar.Model) =>
    modifyFields(model, { calendar: () => nextCalendar }),
  toParentMessage: toCalendarMessage,
  foldOutMessage: Calendar.OutMessage.match<
    Update.Step<Model, Message, Sync.LocalStoreService>
  >({
    WroteLocalData: () => stepModel => foldSyncRefresh(stepModel),
  }),
})

const foldCalendarEntered = Update.foldChild({
  update: Calendar.entered,
  read: (model: Model) => Option.some(model.calendar),
  write: (model: Model, nextCalendar: Calendar.Model) =>
    modifyFields(model, { calendar: () => nextCalendar }),
  toParentMessage: toCalendarMessage,
})

const foldCalendarSyncSettled = Update.foldChild({
  update: Calendar.syncSettled,
  read: (model: Model) => Option.some(model.calendar),
  write: (model: Model, nextCalendar: Calendar.Model) =>
    modifyFields(model, { calendar: () => nextCalendar }),
  toParentMessage: toCalendarMessage,
})

const foldCalendarMessage = (
  model: Model,
  message: Calendar.Message,
): UpdateReturn =>
  foldCalendar(model, { message, inputs: calendarInputs(model) })

const foldRemindersOutMessage = Reminders.OutMessage.match<
  Update.Step<Model, Message, Sync.LocalStoreService>
>({
  WroteLocalData: () => stepModel => foldSyncRefresh(stepModel),
})

const foldReminders = Update.foldChild({
  update: Reminders.update,
  read: (model: Model) => Option.some(model.reminders),
  write: (model: Model, nextReminders: Reminders.Model) =>
    modifyFields(model, { reminders: () => nextReminders }),
  toParentMessage: toRemindersMessage,
  foldOutMessage: foldRemindersOutMessage,
})

const foldRemindersEntered = Update.foldChildStep({
  update: Reminders.entered,
  read: (model: Model) => Option.some(model.reminders),
  write: (model: Model, nextReminders: Reminders.Model) =>
    modifyFields(model, { reminders: () => nextReminders }),
  toParentMessage: toRemindersMessage,
  foldOutMessage: foldRemindersOutMessage,
})

type SettingsFoldInput = Readonly<{
  message: Settings.Message
  inputs: Settings.Inputs
}>

const foldSettings = Update.foldChild({
  update: (settings: Settings.Model, input: SettingsFoldInput) =>
    Settings.update(settings, input.message, input.inputs),
  read: (model: Model) => Option.some(model.settings),
  write: (model: Model, nextSettings: Settings.Model) =>
    modifyFields(model, { settings: () => nextSettings }),
  toParentMessage: toSettingsMessage,
})

const foldSettingsMessage = (
  model: Model,
  message: Settings.Message,
): UpdateReturn =>
  foldSettings(model, { message, inputs: settingsInputs(model) })

const foldSettingsReset = Update.foldChildStep({
  update: Settings.reset,
  read: (model: Model) => Option.some(model.settings),
  write: (model: Model, nextSettings: Settings.Model) =>
    modifyFields(model, { settings: () => nextSettings }),
  toParentMessage: toSettingsMessage,
})

/** Enter `/habits` and re-read the mirror it renders from. */
const enterHabitsPage = (model: Model): UpdateReturn => {
  const entered = foldHabitsEntered(model, undefined)

  if (!Sync.isStoreReady(entered.model.sync)) {
    return entered
  }

  const refreshed = foldSyncRefresh(entered.model)

  return {
    model: refreshed.model,
    commands: [...(entered.commands ?? []), ...(refreshed.commands ?? [])],
  }
}

/** Enter `/calendar` and re-read the mirror it renders from. */
const enterCalendarPage = (model: Model): UpdateReturn => {
  const entered = foldCalendarEntered(model, calendarInputs(model))

  if (!Sync.isStoreReady(entered.model.sync)) {
    return entered
  }

  const refreshed = foldSyncRefresh(entered.model)

  return {
    model: refreshed.model,
    commands: [...(entered.commands ?? []), ...(refreshed.commands ?? [])],
  }
}

/** Run the entry capability of whichever page the transition landed on. */
const enterRoute = (
  model: Model,
  transition: Transition.Transition<AppRoute>,
): UpdateReturn => {
  const nextRoute = transition.nextRoute

  if (!guardAllows(model, nextRoute)) {
    return { model }
  }

  if (
    model.route._tag === 'Today' &&
    Option.isSome(Transition.entered(transition, 'Today'))
  ) {
    return foldTodayEntered(model, todayInputs(model))
  }

  if (
    model.route._tag === 'Tasks' &&
    Option.isSome(Transition.entered(transition, 'Tasks'))
  ) {
    return foldTasksEntered(model)
  }

  if (
    model.route._tag === 'Habits' &&
    Option.isSome(Transition.entered(transition, 'Habits'))
  ) {
    return enterHabitsPage(model)
  }

  if (
    model.route._tag === 'Lists' &&
    Option.isSome(Transition.entered(transition, 'Lists'))
  ) {
    return enterListsPage(model, Option.none())
  }

  if (
    model.route._tag === 'Calendar' &&
    Option.isSome(Transition.entered(transition, 'Calendar'))
  ) {
    return enterCalendarPage(model)
  }

  if (
    model.route._tag === 'Reminders' &&
    Option.isSome(Transition.entered(transition, 'Reminders'))
  ) {
    return foldRemindersEntered(model)
  }

  if (model.route._tag === 'List') {
    const listId = model.route.listId
    const isNewList =
      Option.isNone(transition.maybePreviousRoute) ||
      Option.exists(
        transition.maybePreviousRoute,
        previous => previous._tag !== 'List' || previous.listId !== listId,
      )

    if (isNewList) {
      return enterListsPage(model, Option.some(listId))
    }
  }

  if (
    model.route._tag === 'Notes' &&
    Option.isSome(Transition.entered(transition, 'Notes'))
  ) {
    return enterNotesIndex(model)
  }

  if (
    model.route._tag === 'NotesTrash' &&
    Option.isSome(Transition.entered(transition, 'NotesTrash'))
  ) {
    return enterNotesTrash(model)
  }

  if (model.route._tag === 'Note') {
    const noteId = model.route.noteId
    const isNewNote =
      Option.isNone(transition.maybePreviousRoute) ||
      Option.exists(
        transition.maybePreviousRoute,
        previous => previous._tag !== 'Note' || previous.noteId !== noteId,
      )

    if (isNewNote) {
      return enterNotesNote(model, noteId)
    }
  }

  return { model }
}

/** Enter the current route after a session change or a fresh landing. */
const enterCurrentRoute = (model: Model): UpdateReturn =>
  enterRoute(model, Transition.coldLoad(model.route))

const withStepCommands = (
  base: UpdateReturn,
  step: UpdateReturn,
): UpdateReturn => ({
  model: step.model,
  commands: [...(base.commands ?? []), ...(step.commands ?? [])],
})

/** Whether this sync message settled a mirror read. */
const isMirrorReadResult = (message: Sync.Message): boolean =>
  Match.value(message).pipe(
    Match.tag('SucceededReadMirror', () => true),
    Match.tag('FailedReadMirror', () => true),
    Match.orElse(() => false),
  )

/** Messages that carry a fresh mirror snapshot the Notes editor adopts. */
const isMirrorSettledMessage = (message: Sync.Message): boolean =>
  Match.value(message).pipe(
    Match.tag('SucceededReadMirror', () => true),
    Match.tag('FailedReadMirror', () => true),
    Match.tag('SucceededSyncPass', () => true),
    Match.tag('FailedSyncPass', () => true),
    Match.orElse(() => false),
  )

/**
 * A completed drain is the moment the server read model is worth revalidating:
 * while writes were queued, Today overlaid them instead of fetching.
 */
const foldSyncMessage = (model: Model, message: Sync.Message): UpdateReturn => {
  const wasPending = model.sync.pending
  const folded = foldSync(model, message)
  const listsStep =
    folded.model.route._tag === 'List' && isMirrorReadResult(message)
      ? foldListsMirrorSettled(folded.model, listsInputs(folded.model))
      : { model: folded.model }
  const notesStep =
    AppRoute.isAnyOf(['Notes', 'Note', 'NotesTrash'])(folded.model.route) &&
    isMirrorSettledMessage(message)
      ? foldNotesMirrorSettled(folded.model, notesInputs(folded.model))
      : { model: listsStep.model }
  const settled = wasPending > 0 && folded.model.sync.pending === 0
  const todayStep =
    settled && notesStep.model.route._tag === 'Today'
      ? foldTodaySyncSettled(notesStep.model, todayInputs(notesStep.model))
      : { model: notesStep.model }
  const calendarStep =
    settled && todayStep.model.route._tag === 'Calendar'
      ? foldCalendarSyncSettled(
          todayStep.model,
          calendarInputs(todayStep.model),
        )
      : { model: todayStep.model }

  return {
    model: calendarStep.model,
    commands: [
      ...(folded.commands ?? []),
      ...(listsStep.commands ?? []),
      ...(notesStep.commands ?? []),
      ...(todayStep.commands ?? []),
      ...(calendarStep.commands ?? []),
    ],
  }
}

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedUrl: ({ url }) => {
      const nextRoute = urlToAppRoute(url)
      const guarded = enforceGuard(model, nextRoute)
      const leavingNote =
        model.route._tag === 'Note' &&
        (guarded.model.route._tag !== 'Note' ||
          guarded.model.route.noteId !== model.route.noteId)
      const leavingSettings =
        model.route._tag === 'Settings' &&
        guarded.model.route._tag !== 'Settings'
      const left = leavingNote
        ? foldNotesLeftNote(guarded.model)
        : leavingSettings
          ? foldSettingsReset(guarded.model)
          : { model: guarded.model }

      const entered = enterRoute(
        left.model,
        Transition.make(model.route, guarded.model.route),
      )

      return {
        model: entered.model,
        commands: [
          ...(guarded.commands ?? []),
          ...(left.commands ?? []),
          ...(entered.commands ?? []),
        ],
      }
    },

    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => {
          const closed = closeMorePopover(model)

          return {
            model: closed.model,
            commands: [
              ...(closed.commands ?? []),
              NavigateInternal({ url: urlToString(url) }),
            ],
          }
        },
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
    GotListsMessage: ({ message }) => foldListsMessage(model, message),
    GotNotesMessage: ({ message }) => foldNotesMessage(model, message),
    GotTasksMessage: ({ message }) => foldTasksMessage(model, message),
    GotHabitsMessage: ({ message }) => foldHabitsMessage(model, message),
    GotCalendarMessage: ({ message }) => foldCalendarMessage(model, message),
    GotRemindersMessage: ({ message }) => foldReminders(model, message),
    GotSettingsMessage: ({ message }) => foldSettingsMessage(model, message),
    GotMorePopoverMessage: ({ message }) => foldMorePopover(model, message),
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

const placeholderNoteView = (h: HtmlBuilder<Message>): Html =>
  h.p(
    [h.Class('m-0 text-sm leading-7 text-base-content/55')],
    ['این صفحه در گام بعدی ساخته می‌شود.'],
  )

const placeholderPageView = (heading: string, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('page-wrap grid max-w-5xl gap-3')],
    [
      h.h1([h.Class('m-0 text-3xl font-bold tracking-tight')], [heading]),
      placeholderNoteView(h),
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

const tasksPageView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: 'tasks-page',
    model: model.tasks,
    view: Tasks.view,
    viewInputs: tasksInputs(model),
    toParentMessage: toTasksMessage,
  })

const remindersPageView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('page-wrap grid max-w-3xl gap-4')],
    [
      h.header(
        [h.Class('grid gap-1')],
        [
          h.h1(
            [h.Class('m-0 text-2xl font-bold tracking-tight sm:text-3xl')],
            ['یادآورها'],
          ),
          h.p(
            [h.Class('m-0 text-sm text-base-content/55')],
            ['اعلان‌های این دستگاه و یادآورهایی که مرورگر آن‌ها را ندیده است.'],
          ),
        ],
      ),
      h.submodel({
        slotId: 'reminders-push-health',
        model: model.push,
        view: Push.healthView,
        toParentMessage: toPushMessage,
      }),
      h.submodel({
        slotId: 'reminders-inbox',
        model: model.reminders,
        view: Reminders.view,
        toParentMessage: toRemindersMessage,
      }),
    ],
  )

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
            ['ظاهر برنامه، تقویم و منطقه‌ی زمانی، و امنیت حساب.'],
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
        slotId: 'settings-password',
        model: model.settings,
        view: Settings.view,
        toParentMessage: toSettingsMessage,
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
      Lists: () =>
        h.submodel({
          slotId: 'lists-index',
          model: model.lists,
          view: Lists.indexView,
          viewInputs: listsInputs(model),
          toParentMessage: toListsMessage,
        }),
      List: () =>
        h.submodel({
          slotId: 'list-detail',
          model: model.lists,
          view: Lists.detailView,
          viewInputs: listsInputs(model),
          toParentMessage: toListsMessage,
        }),
      Notes: () =>
        h.submodel({
          slotId: 'notes-index',
          model: model.notes,
          view: Notes.indexView,
          viewInputs: notesInputs(model),
          toParentMessage: toNotesMessage,
        }),
      Note: () =>
        h.submodel({
          slotId: 'note-editor',
          model: model.notes,
          view: Notes.noteView,
          viewInputs: notesInputs(model),
          toParentMessage: toNotesMessage,
        }),
      NotesTrash: () =>
        h.submodel({
          slotId: 'notes-trash',
          model: model.notes,
          view: Notes.trashView,
          viewInputs: notesInputs(model),
          toParentMessage: toNotesMessage,
        }),
      Tasks: () => tasksPageView(model, h),
      Habits: () =>
        h.submodel({
          slotId: 'habits-page',
          model: model.habits,
          view: Habits.view,
          viewInputs: habitsInputs(model),
          toParentMessage: toHabitsMessage,
        }),
      Calendar: () =>
        h.submodel({
          slotId: 'calendar-page',
          model: model.calendar,
          view: Calendar.view,
          viewInputs: calendarInputs(model),
          toParentMessage: toCalendarMessage,
        }),
      Reminders: () => remindersPageView(model, h),
      Settings: () => settingsPageView(model, h),
      PushHealth: () => pushHealthPageView(model, h),
      NotFound: () => notFoundView(h),
    },
    () => placeholderPageView(pageCopy(model.route).heading, h),
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const copy = pageCopy(model.route)
  const maybeActiveSection = Shell.sectionForRoute(model.route)
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
    toParentMessage: toAuthMessage,
  })
  const authBoot = () =>
    h.submodel({
      slotId: 'auth-boot',
      model: model.auth,
      view: Auth.bootView,
      toParentMessage: toAuthMessage,
    })
  const moreMenu = h.submodel({
    slotId: model.morePopover.id,
    model: model.morePopover,
    view: Popover.view,
    viewInputs: {
      anchor: { placement: 'top-end', gap: 8, padding: 8 },
      ariaLabel: 'بخش‌های بیشتر',
      toView: render =>
        moreMenuView(
          {
            render,
            maybeActiveSection,
          },
          h,
        ),
    },
    toParentMessage: message => Message.GotMorePopoverMessage({ message }),
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
            maybeActiveSection,
            maybeDisplayName,
            moreMenu,
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

const moreMenuView = (
  config: Readonly<{
    render: Popover.RenderInfo
    maybeActiveSection: Option.Option<Shell.AppSection>
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('relative w-full')],
    [
      h.button(
        [
          ...config.render.button,
          h.Class(
            'flex w-full cursor-pointer flex-col items-center gap-0.5 py-2 text-[0.68rem] font-medium text-base-content/55',
          ),
        ],
        [
          h.span(
            [h.Class('grid size-8 place-items-center rounded-xl')],
            [listsIcon('size-5')],
          ),
          'بیشتر',
        ],
      ),
      config.render.isVisible
        ? h.div(
            [...config.render.panel],
            [
              h.nav(
                [
                  h.AriaLabel('بخش‌های بیشتر'),
                  h.Class('float-card w-44 p-1.5'),
                ],
                Array.map(MORE_SECTIONS, section =>
                  Shell.morePanelLinkView(section, config.maybeActiveSection, h),
                ),
              ),
            ],
          )
        : h.empty,
    ],
  )

const MORE_SECTIONS: ReadonlyArray<Shell.AppSection> = [
  'Habits',
  'Lists',
  'Reminders',
  'Settings',
]

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

const tasksSubscriptions = Subscription.lift(Tasks.subscriptions)<
  Model,
  Message
>({
  read: model =>
    model.route._tag === 'Tasks' ? Option.some(model.tasks) : Option.none(),
  toParentMessage: toTasksMessage,
})

const notesSubscriptions = Subscription.lift(Notes.subscriptions)<
  Model,
  Message
>({
  read: model => Option.some(model.notes),
  toParentMessage: toNotesMessage,
})

const habitsSubscriptions = Subscription.lift(Habits.subscriptions)<
  Model,
  Message
>({
  read: model =>
    model.route._tag === 'Habits' ? Option.some(model.habits) : Option.none(),
  toParentMessage: toHabitsMessage,
})

const calendarSubscriptions = Subscription.lift(Calendar.subscriptions)<
  Model,
  Message
>({
  read: model =>
    model.route._tag === 'Calendar'
      ? Option.some(model.calendar)
      : Option.none(),
  toParentMessage: toCalendarMessage,
})

const remindersSubscriptions = Subscription.lift(Reminders.subscriptions)<
  Model,
  Message
>({
  read: model =>
    model.route._tag === 'Reminders'
      ? Option.some(model.reminders)
      : Option.none(),
  toParentMessage: toRemindersMessage,
})

export const subscriptions = Subscription.aggregate(
  syncSubscriptions,
  themeSubscriptions,
  pushSubscriptions,
  todaySubscriptions,
  tasksSubscriptions,
  notesSubscriptions,
  habitsSubscriptions,
  calendarSubscriptions,
  remindersSubscriptions,
)
