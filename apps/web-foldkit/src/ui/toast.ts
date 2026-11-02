import { Schema } from 'effect'
import { Toast as UiToast } from '@foldkit/ui'
import type { EntryHandlers } from '@foldkit/ui/toast'
import type { Html, HtmlBuilder } from 'foldkit/html'

/**
 * The shared toast stack, built on the Foldkit UI `Toast` submodel.
 *
 * Each screen that shows transient feedback owns a `Toast.Model` field and
 * folds the child `Message`s through `Update.foldChild`; this module owns the
 * payload shape, the entry markup, and the stack view so screens stay small.
 */

const ToastPayload = Schema.Struct({ text: Schema.String })
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

const toastEntryView = <Message>(
  entry: ToastEntry,
  handlers: EntryHandlers,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
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
        [
          h.DataAttribute('toast-swipe-ignore', ''),
          h.Class('m-0 flex-1'),
        ],
        [entry.payload.text],
      ),
      h.button(
        [...handlers.dismiss, h.AriaLabel('بستن'), h.Class('toast-dismiss')],
        ['✕'],
      ),
    ],
  )

export const toastStackView = <Message>(
  config: Readonly<{
    model: typeof Toast.Model.Type
    toParentMessage: (message: typeof Toast.Message.Type) => Message
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
        toastEntryView<Message>(entry, handlers, h),
      entryClassName: 'flex items-start gap-2',
      containerClassName: 'z-50 flex flex-col gap-2',
    },
    toParentMessage: config.toParentMessage,
  })
