import { Option, Schema } from 'effect'
import { Runtime, Update } from 'foldkit'
import { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import * as Shell from './shell'
import * as Theme from './theme'

// MODEL

export const Model = Schema.Struct({
  theme: Theme.Model,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  GotThemeMessage: { message: Theme.Message },
})
export type Message = typeof Message.Type

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => {
  const themeInit = Theme.init()

  return Update.foldChildInit(themeInit, {
    toParentModel: theme => ({ theme }),
    toParentMessage: message => Message.GotThemeMessage({ message }),
  })
}

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
    GotThemeMessage: ({ message }) => foldTheme(model, message),
  })

// VIEW

/**
 * The shell's landing content until the route union lands in P2.2. Each route
 * then renders its own placeholder with the right title and nav state.
 */
const welcomeView = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('page-wrap grid max-w-3xl gap-3')],
    [
      h.h1([h.Class('m-0 text-3xl font-bold tracking-tight')], ['تالی']),
      h.p(
        [h.Class('m-0 text-base leading-7 text-base-content/60')],
        ['برنامه‌ریز مشترک خانه‌ی شما.'],
      ),
    ],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const themeToggle = h.submodel({
    slotId: 'theme-toggle',
    model: model.theme,
    view: Theme.view,
    toParentMessage: message => Message.GotThemeMessage({ message }),
  })

  return {
    title: 'Tali',
    lang: 'fa',
    dir: 'Rtl',
    body: Shell.view(
      {
        actions: themeToggle,
        content: welcomeView(h),
      },
      h,
    ),
  }
}
