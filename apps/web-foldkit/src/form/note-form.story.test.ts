import {
  Command,
  expectNoOutMessage,
  expectOutMessage,
  given,
  message,
  model,
  story,
} from 'foldkit/story'
import { describe, expect, test } from 'vite-plus/test'

import * as NoteForm from './note-form'

describe('note create form', () => {
  test('submits the title and body, then reports the created note', () => {
    story(
      NoteForm.update,
      given(NoteForm.initialModel()),
      message(NoteForm.Message.UpdatedTitle({ value: '  خرید  ' })),
      message(NoteForm.Message.UpdatedText({ value: 'نان و شیر' })),
      message(NoteForm.Message.Submitted()),
      Command.expectExact(
        NoteForm.CreateNote({ title: '  خرید  ', text: 'نان و شیر' }),
      ),
      Command.resolve(
        NoteForm.CreateNote,
        NoteForm.Message.CompletedCreateNote({ noteId: 'note-1' }),
      ),
      model(next => {
        expect(next.title).toBe('')
        expect(next.text).toBe('')
        expect(next.isSaving).toBe(false)
      }),
      expectOutMessage(NoteForm.OutMessage.CreatedNote({ noteId: 'note-1' })),
    )
  })

  test('an empty form creates nothing', () => {
    story(
      NoteForm.update,
      given(NoteForm.initialModel()),
      message(NoteForm.Message.Submitted()),
      Command.expectNone(),
    )
  })

  test('a failed write keeps the draft for a retry', () => {
    story(
      NoteForm.update,
      given(NoteForm.initialModel()),
      message(NoteForm.Message.UpdatedTitle({ value: 'یادداشت' })),
      message(NoteForm.Message.Submitted()),
      Command.resolve(
        NoteForm.CreateNote,
        NoteForm.Message.FailedCreateNote({ message: 'حافظه پر است' }),
      ),
      model(next => {
        expect(next.title).toBe('یادداشت')
        expect(next.isSaving).toBe(false)
      }),
      expectNoOutMessage(),
    )
  })
})
