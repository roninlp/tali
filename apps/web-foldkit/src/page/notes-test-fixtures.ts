import { Option } from 'effect'

import type { MirrorSnapshot } from '../mirror'
import { NoteRow, TagRow } from '../mirror'
import { mirrorNote, mirrorSnapshot } from '../mirror-fixtures'
import { DISPLAY } from '../test-fixtures'
import * as Notes from './notes'
import type { Inputs, Model } from './notes'
/**
 * Deterministic Notes fixtures shared by the Story and Scene tests. Ids are
 * plain UUID v7 values; the editor's model uses the same string ids the route
 * parser hands it.
 */

export const NOTE_ID = '0192f0a0-0000-7000-8000-000000000060'
export const SECOND_NOTE_ID = '0192f0a0-0000-7000-8000-000000000061'
export const ARCHIVED_NOTE_ID = '0192f0a0-0000-7000-8000-000000000062'
export const TRASHED_NOTE_ID = '0192f0a0-0000-7000-8000-000000000063'
export const TAG_ID = '0192f0a0-0000-7000-8000-000000000070'
export const SECOND_TAG_ID = '0192f0a0-0000-7000-8000-000000000071'

export const tagRow = (overrides: Partial<TagRow> = {}): TagRow =>
  TagRow.make({
    id: TAG_ID,
    name: 'دارو',
    color: null,
    ...overrides,
  })

export const noteRow = (overrides: Partial<NoteRow> = {}): NoteRow =>
  mirrorNote({ id: NOTE_ID, ...overrides })

export const pinnedNoteRow = (overrides: Partial<NoteRow> = {}): NoteRow =>
  noteRow({
    id: SECOND_NOTE_ID,
    title: 'ایده‌های هفته',
    text: 'نان سنگک و پنیر',
    excerpt: 'نان سنگک و پنیر',
    isPinned: true,
    updatedAt: '2026-10-21T09:30:00.000Z',
    ...overrides,
  })

export const archivedNoteRow = (overrides: Partial<NoteRow> = {}): NoteRow =>
  noteRow({
    id: ARCHIVED_NOTE_ID,
    title: 'یادداشت آرشیوی',
    text: 'متن آرشیو',
    excerpt: 'متن آرشیو',
    isArchived: true,
    updatedAt: '2026-10-19T09:30:00.000Z',
    ...overrides,
  })

export const trashedNoteRow = (overrides: Partial<NoteRow> = {}): NoteRow =>
  noteRow({
    id: TRASHED_NOTE_ID,
    title: 'یادداشت حذف‌شده',
    text: 'متن حذف‌شده',
    excerpt: 'متن حذف‌شده',
    deletedAt: '2026-10-22T09:30:00.000Z',
    updatedAt: '2026-10-22T09:30:00.000Z',
    ...overrides,
  })

export const mirrorWithNotes = (
  overrides: {
    readonly notes?: ReadonlyArray<NoteRow>
    readonly trashedNotes?: ReadonlyArray<NoteRow>
    readonly tags?: ReadonlyArray<TagRow>
  } = {},
): MirrorSnapshot =>
  mirrorSnapshot({
    notes: overrides.notes ?? [noteRow(), pinnedNoteRow(), archivedNoteRow()],
    trashedNotes: overrides.trashedNotes ?? [trashedNoteRow()],
    tags: overrides.tags ?? [tagRow()],
  })

export const notesInputs = (overrides: Partial<Inputs> = {}): Inputs => ({
  display: DISPLAY,
  isStoreReady: true,
  isOnline: true,
  pending: 0,
  mirror: mirrorWithNotes(),
  pendingKeys: [],
  ...overrides,
})

export const indexModel = (): Model =>
  Notes.enteredIndex(Notes.initialModel()).model

export const trashModel = (): Model =>
  Notes.enteredTrash(Notes.initialModel()).model

const loadedBase = (): Model =>
  Notes.Model.make({
    ...Notes.enteredNote(Notes.initialModel(), {
      noteId: NOTE_ID,
      isStoreReady: false,
    }).model,
    isEditorActive: true,
    loadState: 'ready',
    isLoadPending: false,
    title: 'خرید دارو',
    text: 'قرص می‌روم و دارو می‌خورم',
    savedTitle: 'خرید دارو',
    savedText: 'قرص می‌روم و دارو می‌خورم',
    visibility: 'private',
    isOwner: true,
    baseVersion: 1,
  })

export const editorModel = (overrides: Partial<Model> = {}): Model =>
  Notes.Model.make({ ...loadedBase(), ...overrides })

export const trashedEditorModel = (): Model =>
  editorModel({
    isTrashed: true,
    maybeActionError: Option.none(),
  })
