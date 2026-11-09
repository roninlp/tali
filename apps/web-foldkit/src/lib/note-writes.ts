import { defaultVisibilityFor } from '@tali/domain'
import type { Note } from '@tali/domain'
import type { LocalStore, ServerRow } from '@tali/sync-client'

import {
  noteTextFromData,
  noteTitleFromData,
  textToNoteBody,
} from './note-body'
import {
  type NoteDraft,
  noteDraftKey,
  parseNoteDraft,
  serializeNoteDraft,
} from './note-draft'

/**
 * Note mirror writes, ported from `apps/web/src/lib/notes/mirror.ts` and
 * `saver.ts` (ticket #40; FR-NOTE-01/03).
 *
 * Every helper commits the mirror row and its outbox entry in one
 * `writeLocal` transaction before resolving, so the editor and list are
 * correct offline and the sync engine carries the mutation on reconnect. No
 * note write uses RPC.
 *
 * Content saves are serialized per note and dedupe identical text, like the
 * legacy `createNoteSaver`: one editing session mints one server version per
 * real change, and a slow IndexedDB transaction cannot overtake the next one.
 * The crash draft lives in the store's separate `drafts` object store; a save
 * clears it only when it still describes the text that was just committed, so
 * a keystroke typed while the save was in flight survives.
 */

export interface NoteContent {
  readonly title: string
  readonly text: string
}

export const createNoteInMirror = async (
  store: LocalStore,
  id: string,
  now: string,
): Promise<string> => {
  await store.writeLocal({
    entityType: 'note',
    entityId: id,
    op: 'upsert',
    patch: {
      id,
      type: 'note',
      ownerId: store.userId,
      title: '',
      body: textToNoteBody(''),
      plainText: '',
      isPinned: false,
      isArchived: false,
      tagIds: [],
      visibility: defaultVisibilityFor('note'),
      createdAt: now,
    },
    now,
  })

  return id
}

const contentQueues = new Map<string, Promise<unknown>>()

const queueKey = (store: LocalStore, noteId: string): string =>
  `${store.userId}\u0000${noteId}`

const enqueue = <A>(key: string, run: () => Promise<A>): Promise<A> => {
  const previous = contentQueues.get(key) ?? Promise.resolve()
  const next = previous.then(run, run)
  contentQueues.set(
    key,
    next.catch(() => undefined),
  )

  return next
}

export type NoteSaveOutcome = 'saved' | 'unchanged'

/**
 * Commit the editor's title and body. Identical input is a no-op, and the
 * error is thrown so the screen can show its save-failed state.
 */
export const saveNoteContentInMirror = (
  store: LocalStore,
  noteId: string,
  content: NoteContent,
  now: string,
): Promise<NoteSaveOutcome> =>
  enqueue(queueKey(store, noteId), async () => {
    const current = await store.get('note', noteId)

    if (current === undefined) {
      throw new Error('این یادداشت دیگر روی این دستگاه نیست.')
    }

    const title = noteTitleFromData(current.data)
    const text = noteTextFromData(current.data)

    if (title === content.title && text === content.text) {
      return 'unchanged'
    }

    await store.writeLocal({
      entityType: 'note',
      entityId: noteId,
      op: 'upsert',
      patch: {
        title: content.title,
        body: textToNoteBody(content.text),
        plainText: content.text,
      },
      now,
    })

    try {
      const draft = await readNoteDraft(store, noteId)

      if (draft === undefined || draft.text === content.text) {
        await clearNoteDraft(store, noteId)
      }
    } catch {
      // The mirror write already committed; a draft-read failure must not
      // turn a successful save into a failure (or delete a newer draft).
    }

    return 'saved'
  })

export const setNotePinnedInMirror = (
  store: LocalStore,
  noteId: string,
  isPinned: boolean,
  now: string,
): Promise<void> =>
  store
    .writeLocal({
      entityType: 'note',
      entityId: noteId,
      op: 'upsert',
      patch: { isPinned },
      now,
    })
    .then(() => undefined)

export const setNoteArchivedInMirror = (
  store: LocalStore,
  noteId: string,
  isArchived: boolean,
  now: string,
): Promise<void> =>
  store
    .writeLocal({
      entityType: 'note',
      entityId: noteId,
      op: 'upsert',
      patch: { isArchived },
      now,
    })
    .then(() => undefined)

export const setNoteTagsInMirror = (
  store: LocalStore,
  noteId: string,
  tagIds: ReadonlyArray<string>,
  now: string,
): Promise<void> =>
  store
    .writeLocal({
      entityType: 'note',
      entityId: noteId,
      op: 'upsert',
      patch: { tagIds },
      now,
    })
    .then(() => undefined)

/** Soft delete: the row stays restorable for the shared 30-day trash window. */
export const trashNoteInMirror = (
  store: LocalStore,
  noteId: string,
  now: string,
): Promise<void> =>
  store
    .writeLocal({
      entityType: 'note',
      entityId: noteId,
      op: 'delete',
      patch: {},
      now,
    })
    .then(() => undefined)

/**
 * Clear a local tombstone in place. The sync store's `deletedAt` override is
 * what the trash view uses for an optimistic restore; the mirror stays
 * authoritative for what the screen renders.
 */
/**
 * An RPC-returned note in the mirror's server-row shape, so a successful
 * restore is adopted without waiting for the next pull. Ported from
 * `apps/web/src/lib/notes/mirror.ts`.
 */
export const noteToServerRow = (note: Note): ServerRow => {
  const { version, updatedAt, deletedAt, ...data } = note

  return {
    entityType: 'note',
    entityId: note.id,
    version,
    updatedAt,
    deletedAt,
    data: { ...data },
  }
}

export const retryNoteInMirror = (
  store: LocalStore,
  noteId: string,
): Promise<number | undefined> =>
  store.retryFailed('note', noteId).then(record => record?.version)

export const saveNoteDraft = async (
  store: LocalStore,
  noteId: string,
  draft: NoteDraft,
): Promise<void> =>
  enqueue(queueKey(store, noteId), () =>
    store.saveDraft(noteDraftKey(noteId), serializeNoteDraft(draft)),
  )

export const readNoteDraft = async (
  store: LocalStore,
  noteId: string,
): Promise<NoteDraft | undefined> =>
  parseNoteDraft(await store.readDraft(noteDraftKey(noteId)))

export const clearNoteDraft = async (
  store: LocalStore,
  noteId: string,
): Promise<void> => store.clearDraft(noteDraftKey(noteId))
