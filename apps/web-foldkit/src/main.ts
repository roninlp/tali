import { Effect, Option, Schema } from 'effect'
import { Command, Runtime, Update } from 'foldkit'
import { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { UrlRequest, load, pushUrl } from 'foldkit/navigation'
import { modifyFields } from 'foldkit/struct'
import { Url, toString as urlToString } from 'foldkit/url'

import { AppRoute, homeRouter, urlToAppRoute } from './route'
import * as Shell from './shell'
import * as Theme from './theme'
import { authCardView } from './ui/auth-card'
import { searchIcon } from './ui/icons'

// MODEL

export const Model = Schema.Struct({
  route: AppRoute,
  theme: Theme.Model,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ChangedUrl: { url: Url },
  ClickedLink: { request: UrlRequest },
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  GotThemeMessage: { message: Theme.Message },
})
export type Message = typeof Message.Type

// INIT

export const init: Runtime.RoutingApplicationInit<Model, Message> = (
  url: Url,
) => {
  const route = urlToAppRoute(url)
  const themeInit = Theme.init()

  return Update.foldChildInit(themeInit, {
    toParentModel: theme => ({ route, theme }),
    toParentMessage: message => Message.GotThemeMessage({ message }),
  })
}

// COMMAND

export const NavigateInternal = Command.define('NavigateInternal', {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) =>
    pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
})

export const LoadExternal = Command.define('LoadExternal', {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) =>
    load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const foldTheme: Update.Fold<Model, Message, Theme.Message> = Update.foldChild({
  update: Theme.update,
  read: model => Option.some(model.theme),
  write: (model, nextTheme) => modifyFields(model, { theme: () => nextTheme }),
  toParentMessage: message => Message.GotThemeMessage({ message }),
})

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedUrl: ({ url }) => ({
      model: modifyFields(model, { route: () => urlToAppRoute(url) }),
    }),

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
    CompletedLoadExternal: () => ({ model }),

    GotThemeMessage: ({ message }) => foldTheme(model, message),
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
        ['این صفحه در گام بعدی به ورود یا امروز هدایت می‌شود.'],
      ),
    ],
  )

const loginView = (h: HtmlBuilder<Message>): Html =>
  authCardView(
    {
      title: 'ورود به تالی',
      subtitle: 'برنامه‌ریز مشترک خانه‌ی شما.',
      children: [placeholderNoteView(h)],
    },
    h,
  )

const registerView = (h: HtmlBuilder<Message>): Html =>
  authCardView(
    {
      title: 'ساخت حساب',
      subtitle:
        'برای شروع، یک حساب بسازید؛ بعد خانه‌ی مشترک را می‌سازید یا به آن می‌پیوندید.',
      children: [placeholderNoteView(h)],
    },
    h,
  )

const householdView = (h: HtmlBuilder<Message>): Html =>
  authCardView(
    {
      title: 'خانه‌ی مشترک',
      subtitle:
        'تالی برای دو نفر ساخته شده: یک خانه، دو حساب. یکی خانه را می‌سازد و دیگری با کد دعوت به آن می‌پیوندد.',
      children: [placeholderNoteView(h)],
    },
    h,
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

const pageView = (
  route: AppRoute,
  heading: string,
  h: HtmlBuilder<Message>,
): Html =>
  AppRoute.matchOrElse<Html>(
    route,
    {
      Home: () => homeView(h),
      Login: () => loginView(h),
      Register: () => registerView(h),
      Household: () => householdView(h),
      NotFound: () => notFoundView(h),
    },
    () => placeholderPageView(heading, routeDetail(route), h),
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const copy = pageCopy(model.route)
  const themeToggle = h.submodel({
    slotId: 'theme-toggle',
    model: model.theme,
    view: Theme.view,
    toParentMessage: message => Message.GotThemeMessage({ message }),
  })

  const content = pageView(model.route, copy.heading, h)

  const body = usesAppShell(model.route)
    ? Shell.view(
        {
          actions: themeToggle,
          content,
          maybeActiveSection: Shell.sectionForRoute(model.route),
        },
        h,
      )
    : Shell.standaloneView({ actions: themeToggle, content }, h)

  return {
    title: copy.documentTitle,
    lang: 'fa',
    dir: 'Rtl',
    body,
  }
}
