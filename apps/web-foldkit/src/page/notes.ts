import {
  Array,
  Clock,
  Duration,
  Effect,
  Option,
  Queue,
  Schema,
  Stream,
} from 'effect'
import { Command, Dom, Submodel, Subscription, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { NoteId, uuidV7 } from '@tali/domain'

import { noteTextFromData, noteTitleFromData, tagIdsOf } from '../lib/note-body'
import { type NoteDraft, reconcileDraft } from '../lib/note-draft'
import { searchNotesLocally } from '../lib/note-search'
import { searchNotes } from '../lib/note-search-api'
import {
  clearNoteDraft,
  createNoteInMirror,
  noteToServerRow,
  readNoteDraft,
  retryNoteInMirror,
  saveNoteContentInMirror,
  saveNoteDraft,
  setNoteArchivedInMirror,
  setNotePinnedInMirror,
  setNoteTagsInMirror,
  trashNoteInMirror,
} from '../lib/note-writes'
import { setVisibilityInMirror } from '../lib/visibility-writes'
import { withRpcClient } from '../lib/rpc'
import type { MirrorSnapshot } from '../mirror'
import type { DisplayFields } from '../preferences-model'
import { LocalStoreResource } from '../sync/local-store'
import type { LocalStoreService } from '../sync/local-store'
import { noteEditorView } from './note-view'
import { notesTrashView } from './notes-trash-view'
import { notesIndexView } from './notes-view'

/**
 * The `/notes`, `/notes/[id]` and `/notes/trash` Submodel, ported from
 * `apps/web/src/components/notes/notes-screen.tsx`,
 * `apps/web/src/routes/notes/[id].tsx` and `.../trash.tsx`
 * (ticket #40/#41; FR-NOTE-01/03/04).
 *
 * The list, editor and trash read the same mirror snapshot. Note writes stay
 * local-first: every create, edit, pin, archive, tag, trash and restore
 * commits the IndexedDB row and the outbox in one transaction, then the root
 * asks sync to re-read the mirror. No note write uses RPC.
 *
 * The editor keeps a crash-safe draft in the store's `drafts` object store.
 * Autosave and draft persistence are debounced through Subscriptions keyed by
 * a revision counter, so a title or body keystroke restarts the timer instead
 * of queueing a save per character, and a draft is written 120 ms after typing
 * stops. The save debounce commits the title and the body together.
 */

// MODEL

export const LoadState = Schema.Literals(['loading', 'ready', 'missing'])
export type LoadState = typeof LoadState.Type

export const SaveState = Schema.Literals(['idle', 'saving', 'saved', 'error'])
export type SaveState = typeof SaveState.Type

export const SearchSegment = Schema.Struct({
  text: Schema.String,
  match: Schema.Boolean,
})
export type SearchSegment = typeof SearchSegment.Type

export const SearchHit = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  segments: Schema.Array(SearchSegment),
  updatedAt: Schema.String,
})
export type SearchHit = typeof SearchHit.Type

export const RestoreSource = Schema.Literals(['editor', 'trash'])
export type RestoreSource = typeof RestoreSource.Type

export const NoteLoad = Schema.Struct({
  title: Schema.String,
  text: Schema.String,
  tagIds: Schema.Array(Schema.String),
  isPinned: Schema.Boolean,
  isArchived: Schema.Boolean,
  isTrashed: Schema.Boolean,
  /** Resolved visibility and ownership, for the Share / Unshare action. */
  visibility: Schema.Literals(['private', 'shared']),
  isOwner: Schema.Boolean,
  version: Schema.Int,
  maybeSyncError: Schema.Option(Schema.String),
  isDraftApplied: Schema.Boolean,
  shouldClearDraft: Schema.Boolean,
})
export type NoteLoad = typeof NoteLoad.Type

export const Model = Schema.Struct({
  maybeNoteId: Schema.Option(Schema.String),
  isEditorActive: Schema.Boolean,
  isIndexActive: Schema.Boolean,
  loadState: LoadState,
  loadGeneration: Schema.Int,
  isLoadPending: Schema.Boolean,
  maybeLoadHint: Schema.Option(Schema.String),
  saveState: SaveState,
  saveGeneration: Schema.Int,
  draftRevision: Schema.Int,
  saveRevision: Schema.Int,
  title: Schema.String,
  text: Schema.String,
  savedTitle: Schema.String,
  savedText: Schema.String,
  baseVersion: Schema.Int,
  tagIds: Schema.Array(Schema.String),
  isPinned: Schema.Boolean,
  isArchived: Schema.Boolean,
  isTrashed: Schema.Boolean,
  visibility: Schema.Literals(['private', 'shared']),
  isOwner: Schema.Boolean,
  maybeActionError: Schema.Option(Schema.String),
  maybeSyncError: Schema.Option(Schema.String),
  isRetrying: Schema.Boolean,
  isRestoring: Schema.Boolean,
  query: Schema.String,
  searchGeneration: Schema.Int,
  searchHits: Schema.Array(SearchHit),
  isSearching: Schema.Boolean,
  isOfflineSearch: Schema.Boolean,
  selectedTagIds: Schema.Array(Schema.String),
  showArchived: Schema.Boolean,
  isCreatingNote: Schema.Boolean,
  maybeIndexError: Schema.Option(Schema.String),
  maybeTrashError: Schema.Option(Schema.String),
  maybeRestoringId: Schema.Option(Schema.String),
  announcement: Schema.String,
})
export type Model = typeof Model.Type

export const initialModel = (): Model =>
  Model.make({
    maybeNoteId: Option.none(),
    isEditorActive: false,
    isIndexActive: false,
    loadState: 'loading',
    loadGeneration: 0,
    isLoadPending: false,
    maybeLoadHint: Option.none(),
    saveState: 'idle',
    saveGeneration: 0,
    draftRevision: 0,
    saveRevision: 0,
    title: '',
    text: '',
    savedTitle: '',
    savedText: '',
    baseVersion: 0,
    tagIds: [],
    isPinned: false,
    isArchived: false,
    isTrashed: false,
    visibility: 'private',
    isOwner: false,
    maybeActionError: Option.none(),
    maybeSyncError: Option.none(),
    isRetrying: false,
    isRestoring: false,
    query: '',
    searchGeneration: 0,
    searchHits: [],
    isSearching: false,
    isOfflineSearch: false,
    selectedTagIds: [],
    showArchived: false,
    isCreatingNote: false,
    maybeIndexError: Option.none(),
    maybeTrashError: Option.none(),
    maybeRestoringId: Option.none(),
    announcement: '',
  })

/** Everything the screens read from their siblings on each dispatch. */
export type Inputs = Readonly<{
  display: DisplayFields
  isStoreReady: boolean
  isOnline: boolean
  pending: number
  mirror: MirrorSnapshot
  pendingKeys: ReadonlyArray<string>
}>

export type ViewInputs = Inputs

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedSearchQuery: { value: Schema.String },
  SucceededSearchNotes: {
    query: Schema.String,
    generation: Schema.Int,
    hits: Schema.Array(SearchHit),
  },
  FailedSearchNotes: { query: Schema.String, generation: Schema.Int },
  ClickedClearSearch: {},
  PressedSearchShortcut: {},
  CompletedFocusSearch: {},
  ToggledTagFilter: { tagId: Schema.String },
  ToggledArchive: {},
  SubmittedCreateNote: {},
  CompletedCreateNote: { noteId: Schema.String },
  FailedCreateNote: { message: Schema.String },

  ClickedTogglePinned: { noteId: Schema.String, isPinned: Schema.Boolean },
  CompletedSetPinned: { noteId: Schema.String, isPinned: Schema.Boolean },
  FailedSetPinned: { noteId: Schema.String, message: Schema.String },
  ClickedToggleArchived: { noteId: Schema.String, isArchived: Schema.Boolean },
  CompletedSetArchived: { noteId: Schema.String, isArchived: Schema.Boolean },
  FailedSetArchived: { noteId: Schema.String, message: Schema.String },
  ClickedTrashNote: { noteId: Schema.String },
  CompletedTrashNote: { noteId: Schema.String },
  FailedTrashNote: { noteId: Schema.String, message: Schema.String },

  SucceededLoadNote: {
    generation: Schema.Int,
    maybeNote: Schema.Option(NoteLoad),
  },
  FailedLoadNote: { generation: Schema.Int, message: Schema.String },
  UpdatedNoteTitle: { value: Schema.String },
  UpdatedNoteText: { value: Schema.String },
  TickedNoteDraft: { revision: Schema.Int },
  TickedNoteSave: { revision: Schema.Int },
  CompletedSaveNoteDraft: { noteId: Schema.String, revision: Schema.Int },
  FailedSaveNoteDraft: { message: Schema.String },
  CompletedClearNoteDraft: { noteId: Schema.String },
  FailedClearNoteDraft: { message: Schema.String },
  CompletedSaveNote: {
    noteId: Schema.String,
    title: Schema.String,
    text: Schema.String,
    generation: Schema.Int,
  },
  FailedSaveNote: {
    noteId: Schema.String,
    generation: Schema.Int,
    message: Schema.String,
  },
  ClickedToggleEditorPinned: {},
  ClickedToggleNoteVisibility: {},
  CompletedSetNoteVisibility: {
    noteId: Schema.String,
    visibility: Schema.Literals(['private', 'shared']),
  },
  FailedSetNoteVisibility: { message: Schema.String },
  ClickedToggleEditorTag: { tagId: Schema.String },
  CompletedSetTags: {
    noteId: Schema.String,
    tagIds: Schema.Array(Schema.String),
  },
  FailedSetTags: { noteId: Schema.String, message: Schema.String },
  ClickedArchiveNote: {},
  CompletedArchiveNote: {
    noteId: Schema.String,
    title: Schema.String,
    text: Schema.String,
  },
  FailedArchiveNote: { message: Schema.String },
  ClickedTrashEditedNote: {},
  ClickedRestoreNote: {},
  ClickedRestoreTrashedNote: { noteId: Schema.String },
  CompletedRestoreNote: { noteId: Schema.String, source: RestoreSource },
  FailedRestoreNote: { source: RestoreSource, message: Schema.String },
  ClickedRetrySync: {},
  CompletedRetryNote: { noteId: Schema.String, version: Schema.Int },
  FailedRetryNote: { message: Schema.String },
  FlushedNoteOnHide: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  WroteLocalData: {},
  CreatedNote: { noteId: Schema.String },
  ArchivedNote: { noteId: Schema.String },
  TrashedNote: { noteId: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

const storeFailureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'ذخیره در حافظه‌ی محلی ناموفق بود'

/**
 * Restore is the one note write that cannot be queued: the sync protocol's
 * tombstone-wins rule means an offline upsert can never resurrect a row, so
 * the trash and editor restore paths call `RestoreNote` over RPC after the
 * outbox has drained (legacy `routes/notes/trash.tsx` and `[id].tsx`).
 */
const RESTORE_OFFLINE_MESSAGE =
  'برای بازگرداندن یادداشت به اینترنت وصل شوید؛ متن روی دستگاه محفوظ است.'

const RESTORE_QUEUED_MESSAGE =
  'همگام‌سازی در جریان است؛ چند لحظه بعد دوباره تلاش کنید.'

const restoreFailureMessage = (source: RestoreSource): string =>
  source === 'trash'
    ? 'بازگردانی انجام نشد. اتصال را بررسی کنید و دوباره تلاش کنید.'
    : 'بازگردانی انجام نشد. اتصال را بررسی کنید.'

const currentIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

/** Read the mirror row and crash draft, then reconcile them. */
export const LoadNoteEditor = Command.define('LoadNoteEditor', {
  args: { noteId: Schema.String, generation: Schema.Int },
  messages: [Message.SucceededLoadNote, Message.FailedLoadNote],
  execute: ({ noteId, generation }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const record = yield* Effect.tryPromise({
        try: () => store.get('note', noteId),
        catch: storeFailureMessage,
      })

      if (record === undefined) {
        return Message.SucceededLoadNote({
          generation,
          maybeNote: Option.none(),
        })
      }

      const draft = yield* Effect.tryPromise({
        try: () => readNoteDraft(store, noteId),
        catch: storeFailureMessage,
      })
      const hasPending = yield* Effect.tryPromise({
        try: () => store.hasPending('note', noteId),
        catch: storeFailureMessage,
      })
      const serverText = noteTextFromData(record.data)
      const decision = reconcileDraft({
        draft,
        serverVersion: record.version,
        serverText,
        hasPending,
      })

      return Message.SucceededLoadNote({
        generation,
        maybeNote: Option.some(
          NoteLoad.make({
            title: noteTitleFromData(record.data),
            text: decision.apply ? decision.text : serverText,
            tagIds: tagIdsOf(record.data.tagIds),
            isPinned: record.data.isPinned === true,
            isArchived: record.data.isArchived === true,
            isTrashed: record.deletedAt !== null,
            visibility: record.data.visibility === 'shared' ? 'shared' : 'private',
            isOwner:
              record.data.ownerId === undefined ||
              record.data.ownerId === store.userId,
            version: record.version,
            maybeSyncError: Option.fromNullishOr(record.syncError?.code),
            isDraftApplied: decision.apply,
            shouldClearDraft:
              !decision.apply &&
              (decision.reason === 'server-newer' ||
                decision.reason === 'empty' ||
                decision.reason === 'unchanged'),
          }),
        ),
      })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadNote({
            generation,
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const SearchNotes = Command.define('SearchNotes', {
  args: {
    query: Schema.String,
    generation: Schema.Int,
    delayMs: Schema.Int,
  },
  messages: [Message.SucceededSearchNotes, Message.FailedSearchNotes],
  execute: ({ query, generation, delayMs }) =>
    Effect.gen(function* () {
      if (delayMs > 0) {
        yield* Effect.sleep(Duration.millis(delayMs))
      }

      return yield* searchNotes(query)
    }).pipe(
      Effect.map(result =>
        result.ok
          ? Message.SucceededSearchNotes({
              query,
              generation,
              hits: result.hits,
            })
          : Message.FailedSearchNotes({ query, generation }),
      ),
    ),
})

export const CreateNote = Command.define('CreateNote', {
  messages: [Message.CompletedCreateNote, Message.FailedCreateNote],
  execute: Effect.gen(function* () {
    const store = yield* LocalStoreResource.get
    const now = yield* Clock.currentTimeMillis
    const noteId = uuidV7(now)
    const instant = new Date(now).toISOString()

    yield* Effect.tryPromise({
      try: () => createNoteInMirror(store, noteId, instant),
      catch: storeFailureMessage,
    })

    return Message.CompletedCreateNote({ noteId })
  }).pipe(
    Effect.catch(error =>
      Effect.succeed(
        Message.FailedCreateNote({ message: storeFailureMessage(error) }),
      ),
    ),
  ),
})

export const SetNotePinned = Command.define('SetNotePinned', {
  args: { noteId: Schema.String, isPinned: Schema.Boolean },
  messages: [Message.CompletedSetPinned, Message.FailedSetPinned],
  execute: ({ noteId, isPinned }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () => setNotePinnedInMirror(store, noteId, isPinned, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedSetPinned({ noteId, isPinned })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSetPinned({
            noteId,
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const SetNoteArchived = Command.define('SetNoteArchived', {
  args: { noteId: Schema.String, isArchived: Schema.Boolean },
  messages: [Message.CompletedSetArchived, Message.FailedSetArchived],
  execute: ({ noteId, isArchived }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () => setNoteArchivedInMirror(store, noteId, isArchived, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedSetArchived({ noteId, isArchived })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSetArchived({
            noteId,
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const SetNoteVisibility = Command.define('SetNoteVisibility', {
  args: {
    noteId: Schema.String,
    visibility: Schema.Literals(['private', 'shared']),
  },
  messages: [
    Message.CompletedSetNoteVisibility,
    Message.FailedSetNoteVisibility,
  ],
  execute: ({ noteId, visibility }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () =>
          setVisibilityInMirror(store, 'note', noteId, visibility, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedSetNoteVisibility({ noteId, visibility })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSetNoteVisibility({
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const SetNoteTags = Command.define('SetNoteTags', {
  args: { noteId: Schema.String, tagIds: Schema.Array(Schema.String) },
  messages: [Message.CompletedSetTags, Message.FailedSetTags],
  execute: ({ noteId, tagIds }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () => setNoteTagsInMirror(store, noteId, tagIds, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedSetTags({ noteId, tagIds })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSetTags({
            noteId,
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const DeleteNote = Command.define('DeleteNote', {
  args: { noteId: Schema.String },
  messages: [Message.CompletedTrashNote, Message.FailedTrashNote],
  execute: ({ noteId }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () => trashNoteInMirror(store, noteId, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedTrashNote({ noteId })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedTrashNote({
            noteId,
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const SaveNoteContent = Command.define('SaveNoteContent', {
  args: {
    noteId: Schema.String,
    title: Schema.String,
    text: Schema.String,
    generation: Schema.Int,
  },
  messages: [Message.CompletedSaveNote, Message.FailedSaveNote],
  execute: ({ noteId, title, text, generation }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () => saveNoteContentInMirror(store, noteId, { title, text }, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedSaveNote({ noteId, title, text, generation })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSaveNote({
            noteId,
            generation,
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const SaveNoteDraft = Command.define('SaveNoteDraft', {
  args: {
    noteId: Schema.String,
    text: Schema.String,
    savedText: Schema.String,
    version: Schema.Int,
    revision: Schema.Int,
  },
  messages: [Message.CompletedSaveNoteDraft, Message.FailedSaveNoteDraft],
  execute: ({ noteId, text, savedText, version, revision }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* Clock.currentTimeMillis

      if (text === savedText) {
        yield* Effect.tryPromise({
          try: () => clearNoteDraft(store, noteId),
          catch: storeFailureMessage,
        })
      } else {
        const draft: NoteDraft = {
          version,
          text,
          baseText: savedText,
          savedAt: new Date(now).toISOString(),
        }

        yield* Effect.tryPromise({
          try: () => saveNoteDraft(store, noteId, draft),
          catch: storeFailureMessage,
        })
      }

      return Message.CompletedSaveNoteDraft({ noteId, revision })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSaveNoteDraft({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

export const ClearNoteDraft = Command.define('ClearNoteDraft', {
  args: { noteId: Schema.String },
  messages: [Message.CompletedClearNoteDraft, Message.FailedClearNoteDraft],
  execute: ({ noteId }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get

      yield* Effect.tryPromise({
        try: () => clearNoteDraft(store, noteId),
        catch: storeFailureMessage,
      })

      return Message.CompletedClearNoteDraft({ noteId })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedClearNoteDraft({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

/** Save the buffered text, then archive. Ordered in one Command. */
export const ArchiveEditedNote = Command.define('ArchiveEditedNote', {
  args: {
    noteId: Schema.String,
    title: Schema.String,
    text: Schema.String,
  },
  messages: [Message.CompletedArchiveNote, Message.FailedArchiveNote],
  execute: ({ noteId, title, text }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () => saveNoteContentInMirror(store, noteId, { title, text }, now),
        catch: storeFailureMessage,
      })
      yield* Effect.tryPromise({
        try: () => setNoteArchivedInMirror(store, noteId, true, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedArchiveNote({ noteId, title, text })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedArchiveNote({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

/** Save the buffered text, then soft-delete. Ordered in one Command. */
export const TrashEditedNote = Command.define('TrashEditedNote', {
  args: {
    noteId: Schema.String,
    title: Schema.String,
    text: Schema.String,
  },
  messages: [Message.CompletedTrashNote, Message.FailedTrashNote],
  execute: ({ noteId, title, text }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () => saveNoteContentInMirror(store, noteId, { title, text }, now),
        catch: storeFailureMessage,
      })
      yield* Effect.tryPromise({
        try: () => trashNoteInMirror(store, noteId, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedTrashNote({ noteId })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedTrashNote({
            noteId,
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const RestoreNote = Command.define('RestoreNote', {
  args: { noteId: Schema.String, source: RestoreSource },
  messages: [Message.CompletedRestoreNote, Message.FailedRestoreNote],
  execute: ({ noteId, source }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get

      // A still-queued delete would be pushed after the restore and tombstone
      // the row again, so ask for one more sync instead of racing it.
      const hasPending = yield* Effect.tryPromise({
        try: () => store.hasPending('note', noteId),
        catch: storeFailureMessage,
      })

      if (hasPending) {
        return Message.FailedRestoreNote({
          source,
          message: RESTORE_QUEUED_MESSAGE,
        })
      }

      const note = yield* withRpcClient(client =>
        client.RestoreNote({
          id: NoteId.make(noteId),
          clientMutationId: uuidV7(),
        }),
      )

      yield* Effect.tryPromise({
        try: () => store.mergeServer([noteToServerRow(note)]),
        catch: storeFailureMessage,
      })

      return Message.CompletedRestoreNote({ noteId, source })
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          Message.FailedRestoreNote({
            source,
            message: restoreFailureMessage(source),
          }),
        ),
      ),
    ),
})

export const RetryNoteSync = Command.define('RetryNoteSync', {
  args: { noteId: Schema.String },
  messages: [Message.CompletedRetryNote, Message.FailedRetryNote],
  execute: ({ noteId }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get

      const version = yield* Effect.tryPromise({
        try: () => retryNoteInMirror(store, noteId),
        catch: storeFailureMessage,
      })

      return version === undefined
        ? Message.FailedRetryNote({
            message: 'این یادداشت دیگر روی این دستگاه نیست.',
          })
        : Message.CompletedRetryNote({ noteId, version })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedRetryNote({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

export const FocusNoteSearch = Command.define('FocusNoteSearch', {
  messages: [Message.CompletedFocusSearch],
  execute: Dom.focus('#note-search', { preventScroll: true }).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusSearch()),
  ),
})

export const FocusNoteBody = Command.define('FocusNoteBody', {
  messages: [Message.CompletedFocusSearch],
  execute: Dom.focus('#note-body', { preventScroll: true }).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusSearch()),
  ),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  LocalStoreService
>

type CommandReturn = Update.Return<Model, Message, LocalStoreService>

const isCurrentNote = (model: Model, noteId: string): boolean =>
  Option.exists(model.maybeNoteId, current => current === noteId)

const clearIndexError = (model: Model): Model =>
  modifyFields(model, { maybeIndexError: () => Option.none() })

const clearActionError = (model: Model): Model =>
  modifyFields(model, {
    maybeActionError: () => Option.none(),
    maybeTrashError: () => Option.none(),
  })

/**
 * Save the editor's buffered text before leaving. Returns the next Model with
 * the save generation advanced so the completion is accepted.
 */
const flushEditor = (model: Model): CommandReturn => {
  if (!model.isEditorActive || model.loadState !== 'ready' || model.isTrashed) {
    return { model }
  }

  const maybeNoteId = model.maybeNoteId

  return Option.match(maybeNoteId, {
    onNone: () => ({ model }),
    onSome: noteId => {
      const needsDraft = model.text !== model.savedText
      const needsSave = needsDraft || model.title !== model.savedTitle

      if (!needsSave) {
        return { model }
      }

      const generation = model.saveGeneration + 1
      const next = modifyFields(model, {
        saveGeneration: () => generation,
        saveState: () => 'saving' as const,
      })

      return {
        model: next,
        commands: [
          ...(needsDraft
            ? [
                SaveNoteDraft({
                  noteId,
                  text: model.text,
                  savedText: model.savedText,
                  version: model.baseVersion,
                  revision: model.draftRevision,
                }),
              ]
            : []),
          SaveNoteContent({
            noteId,
            title: model.title,
            text: model.text,
            generation,
          }),
        ],
      }
    },
  })
}

export const update = (
  model: Model,
  message: Message,
  inputs: Inputs,
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    UpdatedSearchQuery: ({ value }) => {
      const query = value.trim()
      const generation = model.searchGeneration + 1

      if (query === '') {
        return {
          model: modifyFields(model, {
            query: () => value,
            searchGeneration: () => generation,
            searchHits: () => [],
            isSearching: () => false,
            isOfflineSearch: () => false,
          }),
        }
      }

      return {
        model: modifyFields(model, {
          query: () => value,
          searchGeneration: () => generation,
          isSearching: () => true,
        }),
        commands: [SearchNotes({ query, generation, delayMs: 180 })],
      }
    },

    SucceededSearchNotes: ({ query, generation, hits }) => {
      if (
        !model.isIndexActive ||
        generation !== model.searchGeneration ||
        model.query.trim() !== query
      ) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          searchHits: () => hits,
          isSearching: () => false,
          isOfflineSearch: () => false,
        }),
      }
    },

    FailedSearchNotes: ({ query, generation }) => {
      if (
        !model.isIndexActive ||
        generation !== model.searchGeneration ||
        model.query.trim() !== query
      ) {
        return { model }
      }

      const hits = searchNotesLocally(inputs.mirror.notes, query)

      return {
        model: modifyFields(model, {
          searchHits: () =>
            hits.map(hit => ({
              id: hit.id,
              title: hit.title,
              segments: hit.segments,
              updatedAt: hit.updatedAt,
            })),
          isSearching: () => false,
          isOfflineSearch: () => true,
        }),
      }
    },

    ClickedClearSearch: () => ({
      model: modifyFields(model, {
        query: () => '',
        searchGeneration: () => model.searchGeneration + 1,
        searchHits: () => [],
        isSearching: () => false,
        isOfflineSearch: () => false,
      }),
    }),

    PressedSearchShortcut: () =>
      model.isIndexActive
        ? { model, commands: [FocusNoteSearch()] }
        : { model },

    CompletedFocusSearch: () => ({ model }),

    ToggledTagFilter: ({ tagId }) => ({
      model: modifyFields(model, {
        selectedTagIds: () =>
          model.selectedTagIds.includes(tagId)
            ? model.selectedTagIds.filter(current => current !== tagId)
            : [...model.selectedTagIds, tagId],
      }),
    }),

    ToggledArchive: () => ({
      model: modifyFields(model, {
        showArchived: () => !model.showArchived,
      }),
    }),

    SubmittedCreateNote: () => {
      if (!inputs.isStoreReady || model.isCreatingNote) {
        return { model }
      }

      return {
        model: modifyFields(clearIndexError(model), {
          isCreatingNote: () => true,
        }),
        commands: [CreateNote()],
      }
    },

    CompletedCreateNote: ({ noteId }) => ({
      model: modifyFields(model, {
        isCreatingNote: () => false,
        announcement: () => 'یادداشت تازه ساخته شد',
      }),
      outMessage: OutMessage.CreatedNote({ noteId }),
    }),

    FailedCreateNote: ({ message }) => ({
      model: modifyFields(model, {
        isCreatingNote: () => false,
        maybeIndexError: () => Option.some(message),
      }),
    }),

    ClickedTogglePinned: ({ noteId, isPinned }) =>
      inputs.isStoreReady
        ? {
            model: clearIndexError(model),
            commands: [SetNotePinned({ noteId, isPinned })],
          }
        : { model },

    CompletedSetPinned: ({ noteId, isPinned }) => ({
      model: modifyFields(model, {
        maybeIndexError: () => Option.none(),
        ...(isCurrentNote(model, noteId) ? { isPinned: () => isPinned } : {}),
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedSetPinned: ({ noteId, message }) => ({
      model: modifyFields(model, {
        maybeIndexError: () => Option.some(message),
        ...(isCurrentNote(model, noteId)
          ? { maybeActionError: () => Option.some(message) }
          : {}),
      }),
    }),

    ClickedToggleArchived: ({ noteId, isArchived }) =>
      inputs.isStoreReady
        ? {
            model: clearIndexError(model),
            commands: [SetNoteArchived({ noteId, isArchived })],
          }
        : { model },

    CompletedSetArchived: ({ noteId, isArchived }) => ({
      model: modifyFields(model, {
        maybeIndexError: () => Option.none(),
        ...(isCurrentNote(model, noteId)
          ? { isArchived: () => isArchived }
          : {}),
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedSetArchived: ({ noteId, message }) => ({
      model: modifyFields(model, {
        maybeIndexError: () => Option.some(message),
        ...(isCurrentNote(model, noteId)
          ? { maybeActionError: () => Option.some(message) }
          : {}),
      }),
    }),

    ClickedTrashNote: ({ noteId }) =>
      inputs.isStoreReady
        ? {
            model: clearIndexError(model),
            commands: [DeleteNote({ noteId })],
          }
        : { model },

    CompletedTrashNote: ({ noteId }) => ({
      model: modifyFields(model, {
        maybeIndexError: () => Option.none(),
        maybeActionError: () => Option.none(),
        ...(isCurrentNote(model, noteId) ? { isTrashed: () => true } : {}),
        announcement: () => 'یادداشت به سطل زباله رفت',
      }),
      outMessage: OutMessage.TrashedNote({ noteId }),
    }),

    FailedTrashNote: ({ noteId, message }) => ({
      model: modifyFields(model, {
        maybeIndexError: () => Option.some(message),
        ...(isCurrentNote(model, noteId)
          ? {
              maybeActionError: () => Option.some(message),
              saveState: () => 'error' as const,
            }
          : {}),
      }),
    }),

    SucceededLoadNote: ({ generation, maybeNote }) => {
      if (
        generation !== model.loadGeneration ||
        !model.isEditorActive ||
        Option.isNone(model.maybeNoteId)
      ) {
        return { model }
      }

      return Option.match(maybeNote, {
        onNone: () => ({
          model: modifyFields(model, {
            loadState: () => 'missing' as const,
            isLoadPending: () => false,
            maybeLoadHint: () =>
              Option.some(
                inputs.isOnline
                  ? 'این یادداشت پیدا نشد؛ شاید حذف شده باشد.'
                  : 'این یادداشت روی این دستگاه نیست و اتصال هم برقرار نیست.',
              ),
          }),
        }),
        onSome: note => {
          const next = modifyFields(model, {
            loadState: () => 'ready' as const,
            isLoadPending: () => false,
            maybeLoadHint: () => Option.none(),
            maybeActionError: () => Option.none(),
            maybeSyncError: () => note.maybeSyncError,
            title: () => note.title,
            text: () => note.text,
            savedTitle: () => note.title,
            savedText: () => note.text,
            baseVersion: () => note.version,
            tagIds: () => note.tagIds,
            isPinned: () => note.isPinned,
            isArchived: () => note.isArchived,
            isTrashed: () => note.isTrashed,
            saveState: () => 'idle' as const,
            saveGeneration: () => 0,
            draftRevision: () =>
              note.isDraftApplied ? model.draftRevision + 1 : 0,
            saveRevision: () =>
              note.isDraftApplied ? model.saveRevision + 1 : 0,
          })

          return {
            model: next,
            commands: [
              FocusNoteBody(),
              ...(note.shouldClearDraft
                ? [
                    ClearNoteDraft({
                      noteId: Option.getOrThrow(model.maybeNoteId),
                    }),
                  ]
                : []),
            ],
          }
        },
      })
    },

    FailedLoadNote: ({ generation, message }) => {
      if (
        generation !== model.loadGeneration ||
        !model.isEditorActive ||
        Option.isNone(model.maybeNoteId)
      ) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          loadState: () => 'missing' as const,
          isLoadPending: () => false,
          maybeLoadHint: () =>
            Option.some(message || 'خواندن یادداشت ممکن نشد.'),
        }),
      }
    },

    UpdatedNoteTitle: ({ value }) => {
      if (
        model.loadState !== 'ready' ||
        model.isTrashed ||
        Option.isNone(model.maybeNoteId)
      ) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          title: () => value,
          saveRevision: () => model.saveRevision + 1,
          saveState: () => 'saving' as const,
        }),
      }
    },

    UpdatedNoteText: ({ value }) =>
      model.loadState === 'ready' && !model.isTrashed
        ? {
            model: modifyFields(model, {
              text: () => value,
              draftRevision: () => model.draftRevision + 1,
              saveRevision: () => model.saveRevision + 1,
            }),
          }
        : { model },

    TickedNoteDraft: ({ revision }) => {
      if (
        revision !== model.draftRevision ||
        !model.isEditorActive ||
        model.loadState !== 'ready' ||
        model.isTrashed
      ) {
        return { model }
      }

      return Option.match(model.maybeNoteId, {
        onNone: () => ({ model }),
        onSome: noteId => ({
          model,
          commands: [
            SaveNoteDraft({
              noteId,
              text: model.text,
              savedText: model.savedText,
              version: model.baseVersion,
              revision,
            }),
          ],
        }),
      })
    },

    TickedNoteSave: ({ revision }) => {
      if (
        revision !== model.saveRevision ||
        !model.isEditorActive ||
        model.loadState !== 'ready' ||
        model.isTrashed
      ) {
        return { model }
      }

      return Option.match(model.maybeNoteId, {
        onNone: () => ({ model }),
        onSome: noteId => {
          if (
            model.title === model.savedTitle &&
            model.text === model.savedText
          ) {
            return {
              model: modifyFields(model, { saveState: () => 'saved' as const }),
            }
          }

          const generation = model.saveGeneration + 1

          return {
            model: modifyFields(model, {
              saveGeneration: () => generation,
              saveState: () => 'saving' as const,
            }),
            commands: [
              SaveNoteContent({
                noteId,
                title: model.title,
                text: model.text,
                generation,
              }),
            ],
          }
        },
      })
    },

    CompletedSaveNoteDraft: () => ({ model }),
    FailedSaveNoteDraft: () => ({ model }),
    CompletedClearNoteDraft: () => ({ model }),
    FailedClearNoteDraft: () => ({ model }),

    CompletedSaveNote: ({ noteId, title, text, generation }) => {
      if (
        generation !== model.saveGeneration ||
        !isCurrentNote(model, noteId)
      ) {
        return { model }
      }

      const hasNewer = model.title !== title || model.text !== text

      return {
        model: modifyFields(model, {
          savedTitle: () => title,
          savedText: () => text,
          saveState: () => (hasNewer ? 'saving' : 'saved'),
        }),
        outMessage: OutMessage.WroteLocalData(),
      }
    },

    FailedSaveNote: ({ noteId, generation }) =>
      generation === model.saveGeneration && isCurrentNote(model, noteId)
        ? {
            model: modifyFields(model, { saveState: () => 'error' as const }),
          }
        : { model },

    ClickedToggleEditorPinned: () => {
      if (
        model.loadState !== 'ready' ||
        model.isTrashed ||
        Option.isNone(model.maybeNoteId)
      ) {
        return { model }
      }

      return {
        model: clearActionError(model),
        commands: [
          SetNotePinned({
            noteId: model.maybeNoteId.value,
            isPinned: !model.isPinned,
          }),
        ],
      }
    },

    ClickedToggleNoteVisibility: () => {
      if (
        model.loadState !== 'ready' ||
        model.isTrashed ||
        !model.isOwner ||
        Option.isNone(model.maybeNoteId)
      ) {
        return { model }
      }

      return {
        model: clearActionError(model),
        commands: [
          SetNoteVisibility({
            noteId: model.maybeNoteId.value,
            visibility: model.visibility === 'shared' ? 'private' : 'shared',
          }),
        ],
      }
    },

    CompletedSetNoteVisibility: ({ noteId, visibility }) => ({
      model: modifyFields(model, {
        maybeActionError: () => Option.none(),
        ...(isCurrentNote(model, noteId)
          ? { visibility: () => visibility }
          : {}),
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedSetNoteVisibility: ({ message }) => ({
      model: modifyFields(model, {
        maybeActionError: () => Option.some(message),
      }),
    }),

    ClickedToggleEditorTag: ({ tagId }) => {
      if (
        model.loadState !== 'ready' ||
        model.isTrashed ||
        Option.isNone(model.maybeNoteId)
      ) {
        return { model }
      }

      const tagIds = model.tagIds.includes(tagId)
        ? model.tagIds.filter(current => current !== tagId)
        : [...model.tagIds, tagId]

      return {
        model: modifyFields(clearActionError(model), {
          tagIds: () => tagIds,
        }),
        commands: [SetNoteTags({ noteId: model.maybeNoteId.value, tagIds })],
      }
    },

    CompletedSetTags: ({ noteId, tagIds }) => ({
      model: modifyFields(model, {
        maybeActionError: () => Option.none(),
        ...(isCurrentNote(model, noteId) ? { tagIds: () => tagIds } : {}),
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedSetTags: ({ noteId, message }) => ({
      model: modifyFields(model, {
        ...(isCurrentNote(model, noteId)
          ? { maybeActionError: () => Option.some(message) }
          : {}),
      }),
    }),

    ClickedArchiveNote: () => {
      if (
        model.loadState !== 'ready' ||
        model.isTrashed ||
        Option.isNone(model.maybeNoteId)
      ) {
        return { model }
      }

      if (model.isArchived) {
        return {
          model: clearActionError(model),
          commands: [
            SetNoteArchived({
              noteId: model.maybeNoteId.value,
              isArchived: false,
            }),
          ],
        }
      }

      return {
        model: modifyFields(clearActionError(model), {
          saveState: () => 'saving' as const,
        }),
        commands: [
          ArchiveEditedNote({
            noteId: model.maybeNoteId.value,
            title: model.title,
            text: model.text,
          }),
        ],
      }
    },

    CompletedArchiveNote: ({ noteId, title, text }) =>
      isCurrentNote(model, noteId)
        ? {
            model: modifyFields(model, {
              isArchived: () => true,
              savedTitle: () => title,
              savedText: () => text,
              saveState: () => 'saved' as const,
              announcement: () => 'یادداشت آرشیو شد',
            }),
            outMessage: OutMessage.ArchivedNote({ noteId }),
          }
        : {
            model: modifyFields(model, {
              savedTitle: () => title,
              savedText: () => text,
            }),
            outMessage: OutMessage.ArchivedNote({ noteId }),
          },

    FailedArchiveNote: () => ({
      model: modifyFields(model, {
        saveState: () => 'error' as const,
        maybeActionError: () =>
          Option.some('ذخیره‌ی متن انجام نشد؛ دوباره تلاش کنید.'),
      }),
    }),

    ClickedTrashEditedNote: () => {
      if (
        model.loadState !== 'ready' ||
        model.isTrashed ||
        Option.isNone(model.maybeNoteId)
      ) {
        return { model }
      }

      return {
        model: modifyFields(clearActionError(model), {
          saveState: () => 'saving' as const,
        }),
        commands: [
          TrashEditedNote({
            noteId: model.maybeNoteId.value,
            title: model.title,
            text: model.text,
          }),
        ],
      }
    },

    ClickedRestoreNote: () =>
      Option.match(model.maybeNoteId, {
        onNone: () => ({ model }),
        onSome: noteId =>
          inputs.isOnline
            ? {
                model: modifyFields(clearActionError(model), {
                  isRestoring: () => true,
                }),
                commands: [RestoreNote({ noteId, source: 'editor' })],
              }
            : {
                model: modifyFields(clearActionError(model), {
                  maybeActionError: () => Option.some(RESTORE_OFFLINE_MESSAGE),
                }),
              },
      }),

    ClickedRestoreTrashedNote: ({ noteId }) => {
      if (!inputs.isStoreReady) {
        return { model }
      }

      if (!inputs.isOnline) {
        return {
          model: modifyFields(clearActionError(model), {
            maybeTrashError: () => Option.some(RESTORE_OFFLINE_MESSAGE),
          }),
        }
      }

      return {
        model: modifyFields(clearActionError(model), {
          maybeRestoringId: () => Option.some(noteId),
        }),
        commands: [RestoreNote({ noteId, source: 'trash' })],
      }
    },

    CompletedRestoreNote: ({ noteId, source }) => ({
      model: modifyFields(model, {
        maybeTrashError: () => Option.none(),
        maybeActionError: () => Option.none(),
        isRestoring: () =>
          source === 'editor' && isCurrentNote(model, noteId)
            ? false
            : model.isRestoring,
        isTrashed: () =>
          source === 'editor' && isCurrentNote(model, noteId)
            ? false
            : model.isTrashed,
        maybeRestoringId: () =>
          Option.contains(model.maybeRestoringId, noteId)
            ? Option.none()
            : model.maybeRestoringId,
        announcement: () => 'یادداشت بازگردانی شد',
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedRestoreNote: ({ source, message }) => ({
      model: modifyFields(model, {
        isRestoring: () => (source === 'editor' ? false : model.isRestoring),
        maybeRestoringId: () =>
          source === 'trash' ? Option.none() : model.maybeRestoringId,
        ...(source === 'editor'
          ? { maybeActionError: () => Option.some(message) }
          : { maybeTrashError: () => Option.some(message) }),
      }),
    }),

    ClickedRetrySync: () => {
      if (model.isRetrying || Option.isNone(model.maybeNoteId)) {
        return { model }
      }

      return {
        model: modifyFields(clearActionError(model), {
          isRetrying: () => true,
        }),
        commands: [RetryNoteSync({ noteId: model.maybeNoteId.value })],
      }
    },

    CompletedRetryNote: ({ noteId, version }) => ({
      model: modifyFields(model, {
        maybeActionError: () => Option.none(),
        isRetrying: () => false,
        ...(isCurrentNote(model, noteId)
          ? {
              baseVersion: () => version,
              maybeSyncError: () => Option.none(),
            }
          : {}),
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedRetryNote: ({ message }) => ({
      model: modifyFields(model, {
        isRetrying: () => false,
        maybeActionError: () => Option.some(message),
      }),
    }),

    FlushedNoteOnHide: () => flushEditor(model),
  })

// ENTRY CAPABILITIES

/** The root folds this when `/notes` is entered. */
export const enteredIndex = (model: Model): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    isIndexActive: () => true,
    isEditorActive: () => false,
    maybeNoteId: () => Option.none(),
    loadGeneration: () => model.loadGeneration + 1,
    isLoadPending: () => false,
    query: () => '',
    searchHits: () => [],
    isSearching: () => false,
    isOfflineSearch: () => false,
    selectedTagIds: () => [],
    showArchived: () => false,
    isCreatingNote: () => false,
    maybeIndexError: () => Option.none(),
    announcement: () => '',
  }),
})

/** The root folds this when `/notes/trash` is entered. */
export const enteredTrash = (model: Model): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    isIndexActive: () => false,
    isEditorActive: () => false,
    maybeNoteId: () => Option.none(),
    loadGeneration: () => model.loadGeneration + 1,
    isLoadPending: () => false,
    maybeTrashError: () => Option.none(),
    maybeRestoringId: () => Option.none(),
    announcement: () => '',
  }),
})

/** The root folds this when `/notes/[id]` is entered or its id changes. */
export const enteredNote = (
  model: Model,
  options: Readonly<{ noteId: string; isStoreReady: boolean }>,
): CommandReturn => {
  const previousId = Option.getOrNull(model.maybeNoteId)
  const isPreviousNote =
    model.isEditorActive &&
    previousId !== null &&
    previousId !== options.noteId &&
    model.loadState === 'ready' &&
    !model.isTrashed
  const flushed = isPreviousNote ? flushEditor(model) : { model }
  const generation = model.loadGeneration + 1
  const isLoadPending = options.isStoreReady
  const next = modifyFields(flushed.model, {
    maybeNoteId: () => Option.some(options.noteId),
    isEditorActive: () => true,
    isIndexActive: () => false,
    loadState: () => 'loading' as const,
    loadGeneration: () => generation,
    isLoadPending: () => isLoadPending,
    maybeLoadHint: () => Option.none(),
    maybeActionError: () => Option.none(),
    maybeSyncError: () => Option.none(),
    isRetrying: () => false,
    isRestoring: () => false,
    title: () => '',
    text: () => '',
    savedTitle: () => '',
    savedText: () => '',
    baseVersion: () => 0,
    tagIds: () => [],
    isPinned: () => false,
    isArchived: () => false,
    isTrashed: () => false,
    saveState: () => 'idle' as const,
    saveGeneration: () => 0,
    draftRevision: () => 0,
    saveRevision: () => 0,
    announcement: () => '',
  })

  return {
    model: next,
    commands: [
      ...(flushed.commands ?? []),
      ...(isLoadPending
        ? [LoadNoteEditor({ noteId: options.noteId, generation })]
        : []),
    ],
  }
}

/** Flush the editor before a route change leaves `/notes/[id]`. */
export const leftNote = (model: Model): CommandReturn => {
  const flushed = flushEditor(model)
  const next = modifyFields(flushed.model, { isEditorActive: () => false })

  return flushed.commands === undefined
    ? { model: next }
    : { model: next, commands: flushed.commands }
}

/**
 * A mirror read settled. While the editor is waiting for a load and the store
 * is ready, start it; once loaded, adopt the row's version, tombstone and
 * sync-error marker without touching the user's draft.
 */
export const mirrorSettled = (model: Model, inputs: Inputs): CommandReturn => {
  if (!inputs.isStoreReady) {
    return { model }
  }

  const maybeNoteId = model.maybeNoteId

  if (Option.isNone(maybeNoteId)) {
    return { model }
  }

  if (
    model.isEditorActive &&
    model.loadState === 'loading' &&
    !model.isLoadPending
  ) {
    const generation = model.loadGeneration + 1

    return {
      model: modifyFields(model, {
        loadGeneration: () => generation,
        isLoadPending: () => true,
      }),
      commands: [LoadNoteEditor({ noteId: maybeNoteId.value, generation })],
    }
  }

  const noteId = maybeNoteId.value
  const maybeRow = Array.findFirst(
    Array.appendAll(inputs.mirror.notes, inputs.mirror.trashedNotes),
    row => row.id === noteId,
  )

  return Option.match(maybeRow, {
    onNone: () => ({ model }),
    onSome: row => {
      const canReanchor =
        row.version !== model.baseVersion && row.text === model.savedText

      return {
        model: modifyFields(model, {
          isTrashed: () => row.deletedAt !== null,
          maybeSyncError: () => row.syncErrorCode,
          ...(canReanchor
            ? {
                baseVersion: () => row.version,
                savedTitle: () => row.title,
                savedText: () => row.text,
              }
            : {}),
        }),
      }
    },
  })
}

// SUBSCRIPTION

const eventStream = <A>(
  subscribe: (emit: (value: A) => void) => () => void,
): Stream.Stream<A> =>
  Stream.callback<A>(queue =>
    Effect.acquireRelease(
      Effect.sync(() =>
        subscribe(value => {
          Queue.offerUnsafe(queue, value)
        }),
      ),
      unsubscribe => Effect.sync(unsubscribe),
    ).pipe(Effect.flatMap(() => Effect.never)),
  )

const pageHideEvents: Stream.Stream<Message> = eventStream(emit => {
  const onPageHide = () => emit(Message.FlushedNoteOnHide())
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      emit(Message.FlushedNoteOnHide())
    }
  }

  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    window.removeEventListener('pagehide', onPageHide)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
})

const keyboardEvents: Stream.Stream<Message> = eventStream(emit => {
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      emit(Message.PressedSearchShortcut())
    }
  }

  window.addEventListener('keydown', onKeyDown)

  return () => {
    window.removeEventListener('keydown', onKeyDown)
  }
})

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  noteDraftDebounce: entry(
    {
      isEditorActive: Schema.Boolean,
      loadState: LoadState,
      isTrashed: Schema.Boolean,
      draftRevision: Schema.Int,
    },
    {
      modelToDependencies: model => ({
        isEditorActive: model.isEditorActive,
        loadState: model.loadState,
        isTrashed: model.isTrashed,
        draftRevision: model.draftRevision,
      }),
      dependenciesToStream: dependencies =>
        Stream.when(
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Effect.sleep(Duration.millis(120))
              return Message.TickedNoteDraft({
                revision: dependencies.draftRevision,
              })
            }),
          ),
          Effect.succeed(
            dependencies.isEditorActive &&
              dependencies.loadState === 'ready' &&
              !dependencies.isTrashed &&
              dependencies.draftRevision > 0,
          ),
        ),
    },
  ),

  noteSaveDebounce: entry(
    {
      isEditorActive: Schema.Boolean,
      loadState: LoadState,
      isTrashed: Schema.Boolean,
      saveRevision: Schema.Int,
    },
    {
      modelToDependencies: model => ({
        isEditorActive: model.isEditorActive,
        loadState: model.loadState,
        isTrashed: model.isTrashed,
        saveRevision: model.saveRevision,
      }),
      dependenciesToStream: dependencies =>
        Stream.when(
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Effect.sleep(Duration.millis(700))
              return Message.TickedNoteSave({
                revision: dependencies.saveRevision,
              })
            }),
          ),
          Effect.succeed(
            dependencies.isEditorActive &&
              dependencies.loadState === 'ready' &&
              !dependencies.isTrashed &&
              dependencies.saveRevision > 0,
          ),
        ),
    },
  ),

  notePageHide: entry(
    {
      isEditorActive: Schema.Boolean,
      loadState: LoadState,
      isTrashed: Schema.Boolean,
    },
    {
      modelToDependencies: model => ({
        isEditorActive: model.isEditorActive,
        loadState: model.loadState,
        isTrashed: model.isTrashed,
      }),
      dependenciesToStream: dependencies =>
        Stream.when(
          pageHideEvents,
          Effect.succeed(
            dependencies.isEditorActive &&
              dependencies.loadState === 'ready' &&
              !dependencies.isTrashed,
          ),
        ),
    },
  ),

  noteKeyboard: entry(
    { isIndexActive: Schema.Boolean },
    {
      modelToDependencies: model => ({ isIndexActive: model.isIndexActive }),
      dependenciesToStream: dependencies =>
        Stream.when(keyboardEvents, Effect.succeed(dependencies.isIndexActive)),
    },
  ),
}))

// VIEW

export const indexView = Submodel.defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => notesIndexView(model, inputs, h),
)

export const noteView = Submodel.defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => noteEditorView(model, inputs, h),
)

export const trashView = Submodel.defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => notesTrashView(model, inputs, h),
)
