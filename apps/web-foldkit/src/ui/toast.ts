import { Schema } from 'effect'
import { Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Toast as UiToast } from '@foldkit/ui'
import type { EntryHandlers } from '@foldkit/ui/toast'

import { type ChildField, foldFieldChild, foldFieldChildStep } from './fold'

/**
 * The shared toast stack, built on the Foldkit UI `Toast` submodel.
 *
 * Each screen that shows transient feedback owns a `Toast.Model` field and
 * folds the child `Message`s through `Update.foldChild`; this module owns the
 * payload shape, the entry markup, and the stack view so screens stay small.
 *
 * An entry may carry an undo action in `maybeUndo`; the screen maps it to a
 * parent `Message` through `toUndoMessage` and the entry renders the button.
 */

export const ToastUndo = Schema.Struct({
  kind: Schema.Literals(['uncheckItem', 'restoreHabit']),
  id: Schema.String,
  title: Schema.String,
})

export type ToastUndo = typeof ToastUndo.Type

const ToastPayload = Schema.Struct({
  text: Schema.String,
  maybeUndo: Schema.optionalKey(ToastUndo),
})

export type ToastPayload = typeof ToastPayload.Type

export const Toast = UiToast.make(ToastPayload)

export type ToastVariant = 'Info' | 'Success' | 'Warning' | 'Error'

const VARIANT_ICON: Readonly<Record<ToastVariant, string>> = {
  Info: '۱',
  Success: '✓',
  Warning: '!',
  Error: '✕',
}

type ToastEntry = typeof Toast.Entry.Type

// UPDATE

type ToastModel = typeof Toast.Model.Type

type ToastMessage = typeof Toast.Message.Type

type ToastUpdateReturn = Update.ReturnWithOutMessage<
  ToastModel,
  ToastMessage,
  typeof Toast.OutMessage.Type
>

export type ToastFolds<ParentModel, ParentMessage> = Readonly<{
  fold: Update.Fold<ParentModel, ParentMessage, ToastMessage>
  shownStep: (
    payload: ToastPayload,
    variant: ToastVariant,
  ) => Update.Step<ParentModel, ParentMessage>
  dismissedStep: (entryId: string) => Update.Step<ParentModel, ParentMessage>
}>

/** The update half of a screen's toast stack: the `Toast.update` fold plus the
 *  two Model-only entry points screens use to show and dismiss an entry. The
 *  toast OutMessage stops at the screen, so every fold here ignores it. */
export const toastFolds = <ParentModel, ParentMessage>(
  config: Readonly<
    ChildField<ParentModel, ToastModel> & {
      toParentMessage: (message: ToastMessage) => ParentMessage
    }
  >,
): ToastFolds<ParentModel, ParentMessage> => {
  const foldOutMessage = () => (stepModel: ParentModel) => ({
    model: stepModel,
  })

  const step = (
    update: (toast: ToastModel) => ToastUpdateReturn,
  ): Update.Step<ParentModel, ParentMessage> =>
    foldFieldChildStep({
      update,
      field: config.field,
      setField: config.setField,
      toParentMessage: config.toParentMessage,
      foldOutMessage,
    })

  return {
    fold: foldFieldChild({
      update: Toast.update,
      field: config.field,
      setField: config.setField,
      toParentMessage: config.toParentMessage,
      foldOutMessage,
    }),
    shownStep: (payload, variant) =>
      step(toast => Toast.show(toast, { payload, variant })),
    dismissedStep: entryId => step(toast => Toast.dismiss(toast, entryId)),
  }
}

// VIEW

const toastEntryView = <Message>(
  entry: ToastEntry,
  handlers: EntryHandlers,
  maybeToUndoMessage:
    | ((entryId: string, undo: ToastUndo) => Message)
    | undefined,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeUndo = entry.payload.maybeUndo

  return h.div(
    [h.Class('toast-entry'), h.DataAttribute('variant', entry.variant)],
    [
      h.span(
        [
          h.AriaHidden(true),
          h.Class('text-sm leading-7'),
          h.DataAttribute('toast-swipe-ignore', ''),
        ],
        [VARIANT_ICON[entry.variant]],
      ),
      h.p(
        [h.DataAttribute('toast-swipe-ignore', ''), h.Class('m-0 flex-1')],
        [entry.payload.text],
      ),
      ...(maybeUndo !== undefined && maybeToUndoMessage !== undefined
        ? [
            h.button(
              [
                h.Type('button'),
                h.DataAttribute('toast-swipe-ignore', ''),
                h.Class('toast-undo'),
                h.OnClick(maybeToUndoMessage(entry.id, maybeUndo)),
              ],
              ['بازگردانی'],
            ),
          ]
        : []),
      h.button(
        [...handlers.dismiss, h.AriaLabel('بستن'), h.Class('toast-dismiss')],
        ['✕'],
      ),
    ],
  )
}

export const toastStackView = <Message>(
  config: Readonly<{
    model: typeof Toast.Model.Type
    toParentMessage: (message: typeof Toast.Message.Type) => Message
    toUndoMessage?: (entryId: string, undo: ToastUndo) => Message
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.submodel({
    slotId: config.model.id,
    model: config.model,
    view: Toast.view,
    viewInputs: {
      position: 'BottomLeft',
      entryToView: (entry, handlers) =>
        toastEntryView(entry, handlers, config.toUndoMessage, h),
      entryClassName: 'flex items-start gap-2',
      containerClassName: 'z-50 flex flex-col gap-2',
    },
    toParentMessage: config.toParentMessage,
  })
