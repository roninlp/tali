import { Clock, Effect, Option, Schema } from 'effect'
import { Command, Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { uuidV7 } from '@tali/domain'

import { createNoteInMirror, saveNoteContentInMirror } from '../lib/note-writes'
import { storeFailureMessage } from '../page/local-write'
import { LocalStoreResource } from '../sync/local-store'
import type { LocalStoreService } from '../sync/local-store'
import { formErrorView, textAreaFieldView, textInputView } from '../ui/field'

/**
 * The standalone "new note" form.
 *
 * The Notes screen creates a blank row and opens its editor in one click; this
 * form is the dialog-friendly path, collecting a title and a body before the
 * mirror write. It owns its Model, Messages and Command, so any dialog can
 * mount it without pulling in the notes page.
 */

// MODEL

export const Model = Schema.Struct({
  title: Schema.String,
  text: Schema.String,
  isSaving: Schema.Boolean,
  maybeError: Schema.Option(Schema.String),
})

export type Model = typeof Model.Type

export const initialModel = (): Model =>
  Model.make({
    title: '',
    text: '',
    isSaving: false,
    maybeError: Option.none(),
  })

export type Inputs = Readonly<{ isStoreReady: boolean }>

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedTitle: { value: Schema.String },
  UpdatedText: { value: Schema.String },
  Submitted: {},
  CompletedCreateNote: { noteId: Schema.String },
  FailedCreateNote: { message: Schema.String },
})

export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  CreatedNote: { noteId: Schema.String },
  WroteLocalData: {},
})

export type OutMessage = typeof OutMessage.Type

// COMMAND

export const CreateNote = Command.define('CreateNote', {
  args: { title: Schema.String, text: Schema.String },
  messages: [Message.CompletedCreateNote, Message.FailedCreateNote],
  execute: ({ title, text }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* Clock.currentTimeMillis
      const instant = new Date(now).toISOString()
      const noteId = uuidV7(now)
      const trimmedTitle = title.trim()

      yield* Effect.tryPromise({
        try: () => createNoteInMirror(store, noteId, instant),
        catch: storeFailureMessage,
      })

      if (trimmedTitle !== '' || text !== '') {
        yield* Effect.tryPromise({
          try: () =>
            saveNoteContentInMirror(
              store,
              noteId,
              { title: trimmedTitle, text },
              instant,
            ),
          catch: storeFailureMessage,
        })
      }

      return Message.CompletedCreateNote({ noteId })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCreateNote({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

// UPDATE

export const update = (
  model: Model,
  message: Message,
): Update.ReturnWithOutMessage<Model, Message, OutMessage, LocalStoreService> =>
  Message.match(message, {
    UpdatedTitle: ({ value }) => ({
      model: modifyFields(model, {
        title: () => value,
        maybeError: () => Option.none(),
      }),
    }),

    UpdatedText: ({ value }) => ({
      model: modifyFields(model, {
        text: () => value,
        maybeError: () => Option.none(),
      }),
    }),

    Submitted: () => {
      if (model.isSaving) {
        return { model }
      }

      if (model.title.trim() === '' && model.text.trim() === '') {
        return { model }
      }

      return {
        model: modifyFields(model, {
          isSaving: () => true,
          maybeError: () => Option.none(),
        }),
        commands: [CreateNote({ title: model.title, text: model.text })],
      }
    },

    CompletedCreateNote: ({ noteId }) => ({
      model: initialModel(),
      outMessage: OutMessage.CreatedNote({ noteId }),
    }),

    FailedCreateNote: ({ message }) => ({
      model: modifyFields(model, {
        isSaving: () => false,
        maybeError: () => Option.some(message),
      }),
    }),
  })

// VIEW

export const view = (
  model: Model,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.form(
    [
      h.Class('grid min-w-0 gap-3'),
      h.AriaLabel('یادداشت تازه'),
      h.OnSubmit(Message.Submitted()),
    ],
    [
      textInputView(
        {
          id: 'create-note-title',
          label: 'عنوان یادداشت',
          value: model.title,
          placeholder: 'عنوان…',
          autoComplete: 'off',
          isDisabled: !inputs.isStoreReady || model.isSaving,
          onInput: value => Message.UpdatedTitle({ value }),
          class: 'min-w-0',
        },
        h,
      ),
      textAreaFieldView(
        {
          id: 'create-note-body',
          label: 'متن یادداشت',
          value: model.text,
          rows: 6,
          placeholder: 'چیزی بنویسید…',
          isDisabled: !inputs.isStoreReady || model.isSaving,
          onInput: value => Message.UpdatedText({ value }),
          class: 'min-w-0',
        },
        h,
      ),
      formErrorView(model.maybeError, h),
      h.div(
        [h.Class('flex justify-end')],
        [
          h.button(
            [
              h.Type('submit'),
              h.Class('btn btn-primary min-h-10'),
              h.Disabled(
                !inputs.isStoreReady ||
                  model.isSaving ||
                  (model.title.trim() === '' && model.text.trim() === ''),
              ),
            ],
            [model.isSaving ? 'در حال ساختن…' : 'ساختن یادداشت'],
          ),
        ],
      ),
    ],
  )
