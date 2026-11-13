import { Option } from 'effect'
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

import * as Notes from './notes'
import type { Inputs, Model, SearchHit } from './notes'
import {
  NOTE_ID,
  SECOND_NOTE_ID,
  TAG_ID,
  TRASHED_NOTE_ID,
  archivedNoteRow,
  editorModel,
  indexModel,
  mirrorWithNotes,
  noteRow,
  notesInputs,
  pinnedNoteRow,
  tagRow,
  trashModel,
  trashedEditorModel,
} from './notes-test-fixtures'

/**
 * Ticket #40/#41 update behavior: quick create, search with its mirror
 * fallback, the local-first pin/archive/trash/restore writes, and the editor's
 * draft/autosave state machine.
 */

const update = (inputs: Inputs) => (notes: Model, message: Notes.Message) =>
  Notes.update(notes, message, inputs)

const defaultUpdate = update(notesInputs())

const NOTE_LOAD = (overrides: Partial<Notes.NoteLoad> = {}): Notes.NoteLoad =>
  Notes.NoteLoad.make({
    title: 'خرید دارو',
    text: 'قرص می‌روم و دارو می‌خورم',
    tagIds: [],
    isPinned: false,
    isArchived: false,
    isTrashed: false,
    visibility: 'private',
    isOwner: true,
    version: 4,
    maybeSyncError: Option.none(),
    isDraftApplied: false,
    shouldClearDraft: false,
    ...overrides,
  })

const HIT: SearchHit = {
  id: NOTE_ID,
  title: 'خرید دارو',
  segments: [{ text: 'دارو', match: true }],
  updatedAt: '2026-10-20T09:30:00.000Z',
}

describe('notes index create', () => {
  test('quick create writes locally then opens the note', () => {
    story(
      defaultUpdate,
      given(indexModel()),
      message(Notes.Message.SubmittedCreateNote()),
      model(next => {
        expect(next.isCreatingNote).toBe(true)
      }),
      Command.expectExact(Notes.CreateNote()),
      Command.resolve(
        Notes.CreateNote,
        Notes.Message.CompletedCreateNote({ noteId: NOTE_ID }),
      ),
      model(next => {
        expect(next.isCreatingNote).toBe(false)
      }),
      expectOutMessage(Notes.OutMessage.CreatedNote({ noteId: NOTE_ID })),
    )
  })

  test('a closed store creates nothing', () => {
    story(
      update(notesInputs({ isStoreReady: false })),
      given(indexModel()),
      message(Notes.Message.SubmittedCreateNote()),
      Command.expectNone(),
      expectNoOutMessage(),
    )
  })

  test('a create failure keeps the button live and shows the error', () => {
    story(
      defaultUpdate,
      given(indexModel()),
      message(Notes.Message.SubmittedCreateNote()),
      Command.resolve(
        Notes.CreateNote,
        Notes.Message.FailedCreateNote({ message: 'حافظه پر است' }),
      ),
      model(next => {
        expect(next.isCreatingNote).toBe(false)
        expect(next.maybeIndexError).toStrictEqual(Option.some('حافظه پر است'))
      }),
      expectNoOutMessage(),
    )
  })
})

describe('notes index actions', () => {
  test('pinning queues the local write and reports it', () => {
    story(
      defaultUpdate,
      given(indexModel()),
      message(
        Notes.Message.ClickedTogglePinned({
          noteId: NOTE_ID,
          isPinned: true,
        }),
      ),
      Command.expectExact(
        Notes.SetNotePinned({ noteId: NOTE_ID, isPinned: true }),
      ),
      Command.resolve(
        Notes.SetNotePinned,
        Notes.Message.CompletedSetPinned({ noteId: NOTE_ID, isPinned: true }),
      ),
      expectOutMessage(Notes.OutMessage.WroteLocalData()),
    )
  })

  test('archiving from the index queues the archive patch', () => {
    story(
      defaultUpdate,
      given(indexModel()),
      message(
        Notes.Message.ClickedToggleArchived({
          noteId: NOTE_ID,
          isArchived: true,
        }),
      ),
      Command.expectExact(
        Notes.SetNoteArchived({ noteId: NOTE_ID, isArchived: true }),
      ),
      Command.resolve(
        Notes.SetNoteArchived,
        Notes.Message.CompletedSetArchived({
          noteId: NOTE_ID,
          isArchived: true,
        }),
      ),
      expectOutMessage(Notes.OutMessage.WroteLocalData()),
    )
  })

  test('trashing from the index queues the soft delete and does not navigate', () => {
    story(
      defaultUpdate,
      given(indexModel()),
      message(Notes.Message.ClickedTrashNote({ noteId: NOTE_ID })),
      Command.expectExact(Notes.DeleteNote({ noteId: NOTE_ID })),
      Command.resolve(
        Notes.DeleteNote,
        Notes.Message.CompletedTrashNote({ noteId: NOTE_ID }),
      ),
      expectOutMessage(Notes.OutMessage.TrashedNote({ noteId: NOTE_ID })),
    )
  })

  test('the tag filter toggles one tag at a time', () => {
    story(
      defaultUpdate,
      given(indexModel()),
      message(Notes.Message.ToggledTagFilter({ tagId: TAG_ID })),
      model(next => {
        expect(next.selectedTagIds).toEqual([TAG_ID])
      }),
      message(Notes.Message.ToggledTagFilter({ tagId: TAG_ID })),
      model(next => {
        expect(next.selectedTagIds).toEqual([])
      }),
    )
  })

  test('the archive section opens and closes', () => {
    story(
      defaultUpdate,
      given(indexModel()),
      message(Notes.Message.ToggledArchive()),
      model(next => {
        expect(next.showArchived).toBe(true)
      }),
      message(Notes.Message.ToggledArchive()),
      model(next => {
        expect(next.showArchived).toBe(false)
      }),
    )
  })
})

describe('notes search', () => {
  test('typing asks the server after the debounce and marks the hits', () => {
    story(
      defaultUpdate,
      given(indexModel()),
      message(Notes.Message.UpdatedSearchQuery({ value: ' دارو ' })),
      model(next => {
        expect(next.query).toBe(' دارو ')
        expect(next.isSearching).toBe(true)
      }),
      Command.expectExact(
        Notes.SearchNotes({ query: 'دارو', generation: 1, delayMs: 180 }),
      ),
      Command.resolve(
        Notes.SearchNotes,
        Notes.Message.SucceededSearchNotes({
          query: 'دارو',
          generation: 1,
          hits: [HIT],
        }),
      ),
      model(next => {
        expect(next.isSearching).toBe(false)
        expect(next.isOfflineSearch).toBe(false)
        expect(next.searchHits).toStrictEqual([HIT])
      }),
    )
  })

  test('a failed server search falls back to the local mirror', () => {
    story(
      update(notesInputs({ mirror: mirrorWithNotes() })),
      given(indexModel()),
      message(Notes.Message.UpdatedSearchQuery({ value: 'دارو' })),
      Command.resolve(
        Notes.SearchNotes,
        Notes.Message.FailedSearchNotes({ query: 'دارو', generation: 1 }),
      ),
      model(next => {
        expect(next.isSearching).toBe(false)
        expect(next.isOfflineSearch).toBe(true)
        expect(next.searchHits.map(hit => hit.id)).toContain(NOTE_ID)
        expect(
          next.searchHits.some(hit =>
            hit.segments.some(segment => segment.match),
          ),
        ).toBe(true)
      }),
    )
  })

  test('clearing the query drops the hits and ignores a late response', () => {
    story(
      defaultUpdate,
      given(
        Notes.Model.make({
          ...indexModel(),
          query: 'دارو',
          searchGeneration: 1,
          isSearching: true,
          searchHits: [HIT],
        }),
      ),
      message(Notes.Message.ClickedClearSearch()),
      model(next => {
        expect(next.query).toBe('')
        expect(next.searchHits).toEqual([])
        expect(next.isSearching).toBe(false)
      }),
      message(
        Notes.Message.SucceededSearchNotes({
          query: 'دارو',
          generation: 1,
          hits: [HIT],
        }),
      ),
      model(next => {
        expect(next.searchHits).toEqual([])
      }),
    )
  })

  test('Ctrl+K only focuses the search box on the index', () => {
    story(
      defaultUpdate,
      given(indexModel()),
      message(Notes.Message.PressedSearchShortcut()),
      Command.expectExact(Notes.FocusNoteSearch()),
      Command.resolve(
        Notes.FocusNoteSearch,
        Notes.Message.CompletedFocusSearch(),
      ),
    )
  })
})

describe('note editor load', () => {
  test('entering a note loads it from the mirror when the store is ready', () => {
    const entered = Notes.enteredNote(Notes.initialModel(), {
      noteId: NOTE_ID,
      isStoreReady: true,
    })

    expect(entered.model.loadState).toBe('loading')
    expect(entered.model.isLoadPending).toBe(true)
    expect(entered.commands).toHaveLength(1)
  })

  test('a missing note explains the offline case', () => {
    story(
      update(notesInputs({ isOnline: false })),
      given(
        Notes.Model.make({
          ...Notes.enteredNote(Notes.initialModel(), {
            noteId: NOTE_ID,
            isStoreReady: false,
          }).model,
          loadGeneration: 1,
        }),
      ),
      message(
        Notes.Message.SucceededLoadNote({
          generation: 1,
          maybeNote: Option.none(),
        }),
      ),
      model(next => {
        expect(next.loadState).toBe('missing')
        expect(next.maybeLoadHint).toStrictEqual(
          Option.some(
            'این یادداشت روی این دستگاه نیست و اتصال هم برقرار نیست.',
          ),
        )
      }),
    )
  })

  test('a loaded row becomes the editor baseline and retires a stale draft', () => {
    story(
      defaultUpdate,
      given(
        Notes.Model.make({
          ...Notes.enteredNote(Notes.initialModel(), {
            noteId: NOTE_ID,
            isStoreReady: false,
          }).model,
          loadGeneration: 1,
        }),
      ),
      message(
        Notes.Message.SucceededLoadNote({
          generation: 1,
          maybeNote: Option.some(NOTE_LOAD({ shouldClearDraft: true })),
        }),
      ),
      Command.expectHas(Notes.FocusNoteBody()),
      Command.resolve(
        Notes.FocusNoteBody,
        Notes.Message.CompletedFocusSearch(),
      ),
      Command.expectHas(Notes.ClearNoteDraft({ noteId: NOTE_ID })),
      Command.resolve(
        Notes.ClearNoteDraft,
        Notes.Message.CompletedClearNoteDraft({ noteId: NOTE_ID }),
      ),
      model(next => {
        expect(next.loadState).toBe('ready')
        expect(next.savedText).toBe('قرص می‌روم و دارو می‌خورم')
        expect(next.isLoadPending).toBe(false)
      }),
    )
  })

  test('an applied draft schedules both the draft and the autosave', () => {
    story(
      defaultUpdate,
      given(
        Notes.Model.make({
          ...Notes.enteredNote(Notes.initialModel(), {
            noteId: NOTE_ID,
            isStoreReady: false,
          }).model,
          loadGeneration: 1,
        }),
      ),
      message(
        Notes.Message.SucceededLoadNote({
          generation: 1,
          maybeNote: Option.some(
            NOTE_LOAD({ text: 'نیمه‌نوشته', isDraftApplied: true }),
          ),
        }),
      ),
      Command.resolve(
        Notes.FocusNoteBody,
        Notes.Message.CompletedFocusSearch(),
      ),
      model(next => {
        expect(next.text).toBe('نیمه‌نوشته')
        expect(next.draftRevision).toBe(1)
        expect(next.saveRevision).toBe(1)
      }),
    )
  })
})

describe('note editor autosave', () => {
  test('typing increments both debounce revision counters', () => {
    story(
      defaultUpdate,
      given(editorModel()),
      message(Notes.Message.UpdatedNoteText({ value: 'متن تازه' })),
      model(next => {
        expect(next.text).toBe('متن تازه')
        expect(next.draftRevision).toBe(1)
        expect(next.saveRevision).toBe(1)
      }),
    )
  })

  test('the draft debounce writes the crash draft', () => {
    story(
      defaultUpdate,
      given(editorModel({ draftRevision: 1, text: 'متن تازه' })),
      message(Notes.Message.TickedNoteDraft({ revision: 1 })),
      Command.expectExact(
        Notes.SaveNoteDraft({
          noteId: NOTE_ID,
          text: 'متن تازه',
          savedText: 'قرص می‌روم و دارو می‌خورم',
          version: 1,
          revision: 1,
        }),
      ),
      Command.resolve(
        Notes.SaveNoteDraft,
        Notes.Message.CompletedSaveNoteDraft({ noteId: NOTE_ID, revision: 1 }),
      ),
    )
  })

  test('the autosave debounce commits text and reports the local write', () => {
    story(
      defaultUpdate,
      given(editorModel({ saveRevision: 1, text: 'متن تازه' })),
      message(Notes.Message.TickedNoteSave({ revision: 1 })),
      Command.expectExact(
        Notes.SaveNoteContent({
          noteId: NOTE_ID,
          title: 'خرید دارو',
          text: 'متن تازه',
          generation: 1,
        }),
      ),
      Command.resolve(
        Notes.SaveNoteContent,
        Notes.Message.CompletedSaveNote({
          noteId: NOTE_ID,
          title: 'خرید دارو',
          text: 'متن تازه',
          generation: 1,
        }),
      ),
      model(next => {
        expect(next.saveState).toBe('saved')
        expect(next.savedText).toBe('متن تازه')
      }),
      expectOutMessage(Notes.OutMessage.WroteLocalData()),
    )
  })

  test('an unchanged debounce just settles the status', () => {
    story(
      defaultUpdate,
      given(editorModel({ saveRevision: 1 })),
      message(Notes.Message.TickedNoteSave({ revision: 1 })),
      Command.expectNone(),
      model(next => {
        expect(next.saveState).toBe('saved')
      }),
    )
  })

  test('a failed save shows the error and keeps the text', () => {
    story(
      defaultUpdate,
      given(editorModel({ saveRevision: 1, text: 'متن تازه' })),
      message(Notes.Message.TickedNoteSave({ revision: 1 })),
      Command.resolve(
        Notes.SaveNoteContent,
        Notes.Message.FailedSaveNote({
          noteId: NOTE_ID,
          generation: 1,
          message: 'حافظه پر است',
        }),
      ),
      model(next => {
        expect(next.saveState).toBe('error')
        expect(next.text).toBe('متن تازه')
      }),
      expectNoOutMessage(),
    )
  })

  test('a title edit only bumps the save debounce', () => {
    story(
      defaultUpdate,
      given(editorModel()),
      message(Notes.Message.UpdatedNoteTitle({ value: 'خرید هفتگی' })),
      Command.expectNone(),
      model(next => {
        expect(next.title).toBe('خرید هفتگی')
        expect(next.saveRevision).toBe(1)
        expect(next.saveState).toBe('saving')
      }),
    )
  })

  test('the autosave debounce commits the edited title', () => {
    story(
      defaultUpdate,
      given(editorModel({ saveRevision: 1, title: 'خرید هفتگی' })),
      message(Notes.Message.TickedNoteSave({ revision: 1 })),
      Command.expectExact(
        Notes.SaveNoteContent({
          noteId: NOTE_ID,
          title: 'خرید هفتگی',
          text: 'قرص می‌روم و دارو می‌خورم',
          generation: 1,
        }),
      ),
      Command.resolve(
        Notes.SaveNoteContent,
        Notes.Message.CompletedSaveNote({
          noteId: NOTE_ID,
          title: 'خرید هفتگی',
          text: 'قرص می‌روم و دارو می‌خورم',
          generation: 1,
        }),
      ),
      model(next => {
        expect(next.savedTitle).toBe('خرید هفتگی')
        expect(next.saveState).toBe('saved')
      }),
      expectOutMessage(Notes.OutMessage.WroteLocalData()),
    )
  })

  test('a hidden tab flushes both the draft and the save', () => {
    story(
      defaultUpdate,
      given(
        editorModel({ text: 'متن تازه', draftRevision: 2, saveRevision: 2 }),
      ),
      message(Notes.Message.FlushedNoteOnHide()),
      Command.expectHas(
        Notes.SaveNoteDraft({
          noteId: NOTE_ID,
          text: 'متن تازه',
          savedText: 'قرص می‌روم و دارو می‌خورم',
          version: 1,
          revision: 2,
        }),
      ),
      Command.expectHas(
        Notes.SaveNoteContent({
          noteId: NOTE_ID,
          title: 'خرید دارو',
          text: 'متن تازه',
          generation: 1,
        }),
      ),
      Command.resolve(
        Notes.SaveNoteDraft,
        Notes.Message.CompletedSaveNoteDraft({ noteId: NOTE_ID, revision: 2 }),
      ),
      Command.resolve(
        Notes.SaveNoteContent,
        Notes.Message.CompletedSaveNote({
          noteId: NOTE_ID,
          title: 'خرید دارو',
          text: 'متن تازه',
          generation: 1,
        }),
      ),
    )
  })
})

describe('note editor actions', () => {
  test('pinning and tag toggles queue their local writes', () => {
    story(
      defaultUpdate,
      given(editorModel()),
      message(Notes.Message.ClickedToggleEditorPinned()),
      Command.expectExact(
        Notes.SetNotePinned({ noteId: NOTE_ID, isPinned: true }),
      ),
      Command.resolve(
        Notes.SetNotePinned,
        Notes.Message.CompletedSetPinned({ noteId: NOTE_ID, isPinned: true }),
      ),
      expectOutMessage(Notes.OutMessage.WroteLocalData()),
    )

    story(
      defaultUpdate,
      given(editorModel()),
      message(Notes.Message.ClickedToggleNoteVisibility()),
      Command.expectExact(
        Notes.SetNoteVisibility({ noteId: NOTE_ID, visibility: 'shared' }),
      ),
      Command.resolve(
        Notes.SetNoteVisibility,
        Notes.Message.CompletedSetNoteVisibility({
          noteId: NOTE_ID,
          visibility: 'shared',
        }),
      ),
      expectOutMessage(Notes.OutMessage.WroteLocalData()),
      model(next => {
        expect(next.visibility).toBe('shared')
      }),
    )

    story(
      defaultUpdate,
      given(editorModel({ isOwner: false })),
      message(Notes.Message.ClickedToggleNoteVisibility()),
      Command.expectNone(),
      model(next => {
        expect(next.visibility).toBe('private')
      }),
    )

    story(
      defaultUpdate,
      given(editorModel({ tagIds: [] })),
      message(Notes.Message.ClickedToggleEditorTag({ tagId: TAG_ID })),
      Command.expectExact(
        Notes.SetNoteTags({ noteId: NOTE_ID, tagIds: [TAG_ID] }),
      ),
      Command.resolve(
        Notes.SetNoteTags,
        Notes.Message.CompletedSetTags({
          noteId: NOTE_ID,
          tagIds: [TAG_ID],
        }),
      ),
      model(next => {
        expect(next.tagIds).toEqual([TAG_ID])
      }),
      expectOutMessage(Notes.OutMessage.WroteLocalData()),
    )
  })

  test('archiving from the editor flushes then archives and leaves', () => {
    story(
      defaultUpdate,
      given(editorModel({ text: 'متن تازه' })),
      message(Notes.Message.ClickedArchiveNote()),
      Command.expectExact(
        Notes.ArchiveEditedNote({
          noteId: NOTE_ID,
          title: 'خرید دارو',
          text: 'متن تازه',
        }),
      ),
      Command.resolve(
        Notes.ArchiveEditedNote,
        Notes.Message.CompletedArchiveNote({
          noteId: NOTE_ID,
          title: 'خرید دارو',
          text: 'متن تازه',
        }),
      ),
      model(next => {
        expect(next.isArchived).toBe(true)
        expect(next.savedText).toBe('متن تازه')
      }),
      expectOutMessage(Notes.OutMessage.ArchivedNote({ noteId: NOTE_ID })),
    )
  })

  test('unarchiving stays in place', () => {
    story(
      defaultUpdate,
      given(editorModel({ isArchived: true })),
      message(Notes.Message.ClickedArchiveNote()),
      Command.expectExact(
        Notes.SetNoteArchived({ noteId: NOTE_ID, isArchived: false }),
      ),
      Command.resolve(
        Notes.SetNoteArchived,
        Notes.Message.CompletedSetArchived({
          noteId: NOTE_ID,
          isArchived: false,
        }),
      ),
      model(next => {
        expect(next.isArchived).toBe(false)
      }),
      expectOutMessage(Notes.OutMessage.WroteLocalData()),
    )
  })

  test('trashing from the editor flushes then soft-deletes', () => {
    story(
      defaultUpdate,
      given(editorModel({ text: 'متن تازه' })),
      message(Notes.Message.ClickedTrashEditedNote()),
      Command.expectExact(
        Notes.TrashEditedNote({
          noteId: NOTE_ID,
          title: 'خرید دارو',
          text: 'متن تازه',
        }),
      ),
      Command.resolve(
        Notes.TrashEditedNote,
        Notes.Message.CompletedTrashNote({ noteId: NOTE_ID }),
      ),
      model(next => {
        expect(next.isTrashed).toBe(true)
      }),
      expectOutMessage(Notes.OutMessage.TrashedNote({ noteId: NOTE_ID })),
    )
  })

  test('restoring a trashed editor clears the tombstone locally', () => {
    story(
      defaultUpdate,
      given(trashedEditorModel()),
      message(Notes.Message.ClickedRestoreNote()),
      Command.expectExact(
        Notes.RestoreNote({ noteId: NOTE_ID, source: 'editor' }),
      ),
      Command.resolve(
        Notes.RestoreNote,
        Notes.Message.CompletedRestoreNote({
          noteId: NOTE_ID,
          source: 'editor',
        }),
      ),
      model(next => {
        expect(next.isTrashed).toBe(false)
        expect(next.isRestoring).toBe(false)
      }),
      expectOutMessage(Notes.OutMessage.WroteLocalData()),
    )
  })

  test('restoring while offline asks for a connection instead of queueing', () => {
    story(
      update(notesInputs({ isOnline: false })),
      given(trashedEditorModel()),
      message(Notes.Message.ClickedRestoreNote()),
      model(next => {
        expect(next.isRestoring).toBe(false)
        expect(next.maybeActionError).toStrictEqual(
          Option.some(
            'برای بازگرداندن یادداشت به اینترنت وصل شوید؛ متن روی دستگاه محفوظ است.',
          ),
        )
      }),
      expectNoOutMessage(),
    )
  })

  test('retrying a rejected note adopts the mirror version', () => {
    story(
      defaultUpdate,
      given(editorModel({ maybeSyncError: Option.some('InvalidPatch') })),
      message(Notes.Message.ClickedRetrySync()),
      Command.expectExact(Notes.RetryNoteSync({ noteId: NOTE_ID })),
      Command.resolve(
        Notes.RetryNoteSync,
        Notes.Message.CompletedRetryNote({ noteId: NOTE_ID, version: 5 }),
      ),
      model(next => {
        expect(next.baseVersion).toBe(5)
        expect(next.maybeSyncError).toStrictEqual(Option.none())
        expect(next.isRetrying).toBe(false)
      }),
      expectOutMessage(Notes.OutMessage.WroteLocalData()),
    )
  })
})

describe('notes trash', () => {
  test('restoring a trashed row uses the RPC restore path', () => {
    story(
      defaultUpdate,
      given(trashModel()),
      message(
        Notes.Message.ClickedRestoreTrashedNote({ noteId: TRASHED_NOTE_ID }),
      ),
      Command.expectExact(
        Notes.RestoreNote({ noteId: TRASHED_NOTE_ID, source: 'trash' }),
      ),
      Command.resolve(
        Notes.RestoreNote,
        Notes.Message.CompletedRestoreNote({
          noteId: TRASHED_NOTE_ID,
          source: 'trash',
        }),
      ),
      model(next => {
        expect(next.maybeRestoringId).toStrictEqual(Option.none())
      }),
      expectOutMessage(Notes.OutMessage.WroteLocalData()),
    )
  })

  test('restoring while offline explains why it cannot queue', () => {
    story(
      update(notesInputs({ isOnline: false })),
      given(trashModel()),
      message(
        Notes.Message.ClickedRestoreTrashedNote({ noteId: TRASHED_NOTE_ID }),
      ),
      model(next => {
        expect(next.maybeRestoringId).toStrictEqual(Option.none())
        expect(next.maybeTrashError).toStrictEqual(
          Option.some(
            'برای بازگرداندن یادداشت به اینترنت وصل شوید؛ متن روی دستگاه محفوظ است.',
          ),
        )
      }),
      expectNoOutMessage(),
    )
  })
})

describe('notes mirror settling', () => {
  test('a loaded editor adopts the row version and sync error', () => {
    const settled = Notes.mirrorSettled(
      editorModel({ baseVersion: 1 }),
      notesInputs({
        mirror: mirrorWithNotes({
          notes: [
            noteRow({
              id: NOTE_ID,
              version: 2,
              text: 'قرص می‌روم و دارو می‌خورم',
              syncErrorCode: Option.some('InvalidPatch'),
            }),
          ],
        }),
      }),
    )

    expect(settled.model.baseVersion).toBe(2)
    expect(settled.model.maybeSyncError).toStrictEqual(
      Option.some('InvalidPatch'),
    )
  })

  test('a waiting editor starts its load when the store becomes ready', () => {
    const waiting = Notes.enteredNote(Notes.initialModel(), {
      noteId: NOTE_ID,
      isStoreReady: false,
    })

    const settled = Notes.mirrorSettled(
      Notes.Model.make({ ...waiting.model, loadGeneration: 2 }),
      notesInputs(),
    )

    expect(settled.commands).toHaveLength(1)
    expect(settled.model.isLoadPending).toBe(true)
  })

  test('leaving a dirty editor flushes before going inactive', () => {
    const left = Notes.leftNote(editorModel({ text: 'متن تازه' }))

    expect(left.commands).toHaveLength(2)
    expect(left.model.isEditorActive).toBe(false)
    expect(left.model.saveState).toBe('saving')
  })
})

describe('notes index sections', () => {
  test('the default fixture has pinned, active and archived rows', () => {
    const inputs = notesInputs({
      mirror: mirrorWithNotes({
        notes: [noteRow(), pinnedNoteRow(), archivedNoteRow()],
      }),
    })

    expect(inputs.mirror.notes).toHaveLength(3)
    expect(inputs.mirror.trashedNotes.map(note => note.id)).toEqual([
      TRASHED_NOTE_ID,
    ])
    expect(inputs.mirror.tags.map(tag => tag.id)).toEqual([TAG_ID])
    expect(indexModel().isIndexActive).toBe(true)
    expect(SECOND_NOTE_ID).not.toBe(NOTE_ID)
    expect(tagRow().name).toBe('دارو')
  })
})
