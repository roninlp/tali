import { Effect, Option, Schema } from 'effect'
import { Command, Runtime, Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { UrlRequest, load, pushUrl, replaceUrl } from 'foldkit/navigation'
import { modifyFields } from 'foldkit/struct'
import { Url, toString as urlToString } from 'foldkit/url'

import * as Auth from './auth'
import { GuardDecision, guardRoute, landingPath, landingRoute } from './guard'
import * as Household from './page/household'
import * as Login from './page/login'
import * as Register from './page/register'
import { AppRoute, homeRouter, todayRouter, urlToAppRoute } from './route'
import { Session } from './session'
import * as Shell from './shell'
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
})
export type Model = typeof Model.Type

export const Flags = Schema.Struct({
  maybeCachedSession: Schema.Option(Session),
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
})
export type Message = typeof Message.Type

// INIT

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags> = (
  flags: Flags,
  url: Url,
) => {
  const route = urlToAppRoute(url)
  const themeInit = Theme.init()
  const authInit = Auth.init(flags.maybeCachedSession)
  const model = Model.make({
    route,
    theme: themeInit.model,
    auth: authInit.model,
    login: Login.initialModel(),
    register: Register.initialModel(),
    household: Household.initialModel(),
  })
  const guarded = enforceGuard(model, route)

  return {
    model: guarded.model,
    commands: [
      ...Command.mapMessages(authInit.commands, toAuthMessage),
      ...(guarded.commands ?? []),
    ],
  }
}

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

type UpdateReturn = Update.Return<Model, Message>

const toAuthMessage = (message: Auth.Message): Message =>
  Message.GotAuthMessage({ message })

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

const foldAuthOutMessage = Auth.OutMessage.match<Update.Step<Model, Message>>({
  RestoredSession: () => stepModel => enforceGuard(stepModel, stepModel.route),
  SignedOut: () => stepModel =>
    enforceGuard(resetForms(stepModel), stepModel.route),
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

const foldLoginOutMessage = Login.OutMessage.match<Update.Step<Model, Message>>(
  {
    SucceededLogin:
      ({ session }) =>
      stepModel => ({
        model: modifyFields(stepModel, {
          auth: () => Auth.applySession(stepModel.auth, session),
          login: () => Login.initialModel(),
          route: () => landingRoute(session),
        }),
        commands: [
          authCommand(Auth.CacheSession({ session })),
          ReplaceUrl({ url: landingPath(session) }),
        ],
      }),
  },
)

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
  Update.Step<Model, Message>
>({
  SucceededRegister:
    ({ session }) =>
    stepModel => ({
      model: modifyFields(stepModel, {
        auth: () => Auth.applySession(stepModel.auth, session),
        register: () => Register.initialModel(),
        route: () => landingRoute(session),
      }),
      commands: [
        authCommand(Auth.CacheSession({ session })),
        ReplaceUrl({ url: landingPath(session) }),
      ],
    }),
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
  Update.Step<Model, Message>
>({
  CreatedHousehold:
    ({ householdId }) =>
    stepModel => {
      const nextAuth = Auth.applyHouseholdId(stepModel.auth, householdId)

      return {
        model: modifyFields(stepModel, { auth: () => nextAuth }),
        commands: cacheSessionCommands(nextAuth),
      }
    },

  JoinedHousehold:
    ({ householdId }) =>
    stepModel => {
      const nextAuth = Auth.applyHouseholdId(stepModel.auth, householdId)

      return {
        model: modifyFields(stepModel, {
          auth: () => nextAuth,
          route: () => AppRoute.Today(),
        }),
        commands: [
          ...cacheSessionCommands(nextAuth),
          ReplaceUrl({ url: todayRouter() }),
        ],
      }
    },

  AlreadyInHousehold: () => stepModel => {
    const refreshed = refreshAuth(stepModel)

    return {
      model: modifyFields(refreshed.model, {
        route: () => AppRoute.Today(),
      }),
      commands: [
        ...(refreshed.commands ?? []),
        ReplaceUrl({ url: todayRouter() }),
      ],
    }
  },

  RequestedToday: () => stepModel => ({
    model: modifyFields(stepModel, { route: () => AppRoute.Today() }),
    commands: [ReplaceUrl({ url: todayRouter() })],
  }),
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

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedUrl: ({ url }) => enforceGuard(model, urlToAppRoute(url)),

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
    [themeToggle, accountMenu],
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
