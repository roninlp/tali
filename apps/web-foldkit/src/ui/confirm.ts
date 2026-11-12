import { Option } from 'effect'
import { Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Dialog } from '@foldkit/ui'

import { classNames } from './class-names'
import { type ChildField, foldFieldChild, foldFieldChildStep } from './fold'

/**
 * The shared confirm dialog, built on the Foldkit UI `Dialog` submodel.
 *
 * A screen that needs a destructive-action confirmation owns a
 * `Dialog.Model` field plus its own pending-item state, opens the dialog with
 * `Dialog.open`, and folds the child `Message`s through `Update.foldChild`.
 * `confirmDialogView` renders the panel; the screen passes the copy resolved
 * from its pending state and the `Message` the accept button dispatches.
 */

export type ConfirmSpec = Readonly<{
  title: string
  body: string
  confirmLabel: string
  cancelLabel: string
  /** Colour of the accept button. Defaults to the primary tones. */
  isDanger?: boolean
}>

const DEFAULT_SPEC: ConfirmSpec = {
  title: '',
  body: '',
  confirmLabel: 'تایید',
  cancelLabel: 'انصراف',
}

// UPDATE

export type ConfirmDialogFolds<ParentModel, ParentMessage> = Readonly<{
  fold: Update.Fold<ParentModel, ParentMessage, Dialog.Message>
  openStep: Update.Step<ParentModel, ParentMessage>
  closeStep: Update.Step<ParentModel, ParentMessage>
}>

/** The update half of a screen's confirm dialog: the `Dialog.update` fold
 *  plus its `open` and `close` entry points. `whenClosed` clears whatever the
 *  screen staged for the pending action, since the dialog reports `Closed` for
 *  a cancel and for an accepted confirm alike. */
export const confirmDialogFolds = <ParentModel, ParentMessage>(
  config: Readonly<
    ChildField<ParentModel, Dialog.Model> & {
      toParentMessage: (message: Dialog.Message) => ParentMessage
      whenClosed: (model: ParentModel) => ParentModel
    }
  >,
): ConfirmDialogFolds<ParentModel, ParentMessage> => {
  const foldOutMessage = Dialog.OutMessage.match<
    Update.Step<ParentModel, ParentMessage>
  >({
    Opened: () => stepModel => ({ model: stepModel }),
    Closed: () => stepModel => ({ model: config.whenClosed(stepModel) }),
  })

  return {
    fold: foldFieldChild({
      update: Dialog.update,
      field: config.field,
      setField: config.setField,
      toParentMessage: config.toParentMessage,
      foldOutMessage,
    }),
    openStep: foldFieldChildStep({
      update: Dialog.open,
      field: config.field,
      setField: config.setField,
      toParentMessage: config.toParentMessage,
      foldOutMessage,
    }),
    closeStep: foldFieldChildStep({
      update: Dialog.close,
      field: config.field,
      setField: config.setField,
      toParentMessage: config.toParentMessage,
      foldOutMessage,
    }),
  }
}

// VIEW

const confirmPanelView = <Message>(
  render: Dialog.RenderInfo,
  spec: ConfirmSpec,
  onConfirm: Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.dialog(
    [...render.dialog, h.Class('app-modal')],
    render.isVisible
      ? [
          h.div([...render.backdrop, h.Class('app-modal-backdrop')]),
          h.div(
            [...render.panel, h.Class('float-card app-confirm')],
            [
              h.h2(
                [...render.title, h.Class('app-confirm-title m-0')],
                [spec.title],
              ),
              h.p(
                [...render.description, h.Class('app-confirm-body')],
                [spec.body],
              ),
              h.div(
                [h.Class('app-confirm-actions')],
                [
                  h.button(
                    [
                      ...render.closeButton,
                      h.Type('button'),
                      h.Class('btn btn-outline btn-sm'),
                    ],
                    [spec.cancelLabel],
                  ),
                  h.button(
                    [
                      h.Class(
                        classNames(
                          'btn btn-sm',
                          spec.isDanger === true ? 'btn-error' : 'btn-primary',
                        ),
                      ),
                      h.OnClick(onConfirm),
                    ],
                    [spec.confirmLabel],
                  ),
                ],
              ),
            ],
          ),
        ]
      : [],
  )

export const confirmDialogView = <Message>(
  config: Readonly<{
    model: Dialog.Model
    toParentMessage: (message: Dialog.Message) => Message
    onConfirm: Message
    spec: Option.Option<ConfirmSpec>
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.submodel({
    slotId: config.model.id,
    model: config.model,
    view: Dialog.view,
    viewInputs: {
      hasDescription: true,
      toView: render =>
        confirmPanelView(
          render,
          Option.getOrElse(config.spec, () => DEFAULT_SPEC),
          config.onConfirm,
          h,
        ),
    },
    toParentMessage: config.toParentMessage,
  })
