import { Option, Schema } from 'effect'
import { Command, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { Dialog, Popover } from '@foldkit/ui'

import * as NoteForm from './form/note-form'
import type { LocalStoreService } from './sync/local-store'

/**
 * The application-level create flow: the floating `+` on Today, the action
 * menu it opens, and the dialog that hosts one standalone create form.
 *
 * The submodel owns only the chrome — which kind is open, the popover, and the
 * dialog. Each form keeps its own state and write Command; the root mounts the
 * matching form inside the dialog and closes it when that form reports a
 * completed create.
 */

// MODEL

export const Kind = Schema.Literals([
  'task',
  'habit',
  'event',
  'occasion',
  'note',
])

export type Kind = typeof Kind.Type

export const Model = Schema.Struct({
  menu: Popover.Model,
  dialog: Dialog.Model,
  maybeKind: Schema.Option(Kind),
  noteForm: NoteForm.Model,
})

export type Model = typeof Model.Type

export const init = (): Model =>
  Model.make({
    menu: Popover.init({ id: 'create-menu', contentFocus: true }),
    dialog: Dialog.init({ id: 'create-dialog' }),
    maybeKind: Option.none(),
    noteForm: NoteForm.initialModel(),
  })

// MESSAGE

export const Message = defineMessageUnion({
  GotMenuMessage: { message: Popover.Message },
  GotDialogMessage: { message: Dialog.Message },
  SelectedKind: { kind: Kind },
  GotNoteFormMessage: { message: NoteForm.Message },
})

export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  OpenedForm: { kind: Kind },
  Closed: {},
  CreatedNote: { noteId: Schema.String },
  WroteLocalData: {},
})

export type OutMessage = typeof OutMessage.Type

/** The Message a menu action dispatches for one create kind. */
export const selectKind = (kind: Kind): Message =>
  Message.SelectedKind({ kind })

/** Lift a Popover result into this submodel's Message union. */
export const gotMenuMessage = (message: Popover.Message): Message =>
  Message.GotMenuMessage({ message })

/** Lift a Dialog result into this submodel's Message union. */
export const gotDialogMessage = (message: Dialog.Message): Message =>
  Message.GotDialogMessage({ message })

/** Lift a NoteForm result into this submodel's Message union. */
export const gotNoteFormMessage = (message: NoteForm.Message): Message =>
  Message.GotNoteFormMessage({ message })

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  LocalStoreService
>

const foldMenu = Update.foldChild({
  update: Popover.update,
  read: (model: Model) => Option.some(model.menu),
  write: (model: Model, nextMenu: Popover.Model) =>
    modifyFields(model, { menu: () => nextMenu }),
  toParentMessage: message => Message.GotMenuMessage({ message }),
  foldOutMessage: Popover.OutMessage.match<
    Update.Step<Model, Message, LocalStoreService>
  >({
    Opened: () => stepModel => ({ model: stepModel }),
    Closed: () => stepModel => ({ model: stepModel }),
  }),
})

const foldDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.dialog),
  write: (model: Model, nextDialog: Dialog.Model) =>
    modifyFields(model, { dialog: () => nextDialog }),
  toParentMessage: message => Message.GotDialogMessage({ message }),
  foldOutMessage: Dialog.OutMessage.match<
    Update.Step<Model, Message, LocalStoreService>
  >({
    Opened: () => stepModel => ({ model: stepModel }),
    Closed: () => stepModel => ({
      model: modifyFields(stepModel, { maybeKind: () => Option.none() }),
    }),
  }),
  toParentOutMessage: Dialog.OutMessage.match<OutMessage | undefined>({
    Opened: () => undefined,
    Closed: () => OutMessage.Closed(),
  }),
})

const foldNoteForm = Update.foldChild({
  update: NoteForm.update,
  read: (model: Model) => Option.some(model.noteForm),
  write: (model: Model, nextNoteForm: NoteForm.Model) =>
    modifyFields(model, { noteForm: () => nextNoteForm }),
  toParentMessage: message => Message.GotNoteFormMessage({ message }),
  foldOutMessage: NoteForm.OutMessage.match<
    Update.Step<Model, Message, LocalStoreService>
  >({
    CreatedNote: () => stepModel => ({ model: stepModel }),
    WroteLocalData: () => stepModel => ({ model: stepModel }),
  }),
  toParentOutMessage: NoteForm.OutMessage.match<OutMessage | undefined>({
    CreatedNote: ({ noteId }) => OutMessage.CreatedNote({ noteId }),
    WroteLocalData: () => OutMessage.WroteLocalData(),
  }),
})

/** Close the create dialog and forget the selected kind. */
export const close = (model: Model): UpdateReturn => {
  const closed = Dialog.close(model.dialog)

  return {
    model: modifyFields(model, {
      dialog: () => closed.model,
      maybeKind: () => Option.none(),
    }),
    commands: Command.mapMessages(closed.commands, message =>
      Message.GotDialogMessage({ message }),
    ),
  }
}

/** Whether a create dialog is currently showing. */
export const isOpen = (model: Model): boolean => Option.isSome(model.maybeKind)

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match(message, {
    GotMenuMessage: ({ message: menuMessage }) => foldMenu(model, menuMessage),
    GotDialogMessage: ({ message: dialogMessage }) =>
      foldDialog(model, dialogMessage),
    GotNoteFormMessage: ({ message: noteMessage }) =>
      foldNoteForm(model, noteMessage),

    SelectedKind: ({ kind }) => {
      const closedMenu = Popover.close(model.menu)
      const opened = Dialog.open(model.dialog)

      return {
        model: modifyFields(model, {
          menu: () => closedMenu.model,
          dialog: () => opened.model,
          maybeKind: () => Option.some(kind),
          noteForm: () => NoteForm.initialModel(),
        }),
        commands: [
          ...Command.mapMessages(closedMenu.commands, message =>
            Message.GotMenuMessage({ message }),
          ),
          ...Command.mapMessages(opened.commands, message =>
            Message.GotDialogMessage({ message }),
          ),
        ],
        outMessage: OutMessage.OpenedForm({ kind }),
      }
    },
  })
