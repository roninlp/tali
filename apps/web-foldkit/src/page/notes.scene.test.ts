import { Option } from 'effect'
import {
  Command,
  click,
  expect,
  given,
  label,
  role,
  scene,
  text,
  type,
  withViewInputs,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import { syncFailureMessage } from '../lib/sync-copy'
import { emptyMirrorSnapshot } from '../mirror'
import * as Notes from './notes'
import type { Inputs, Model } from './notes'
import {
  NOTE_ID,
  TAG_ID,
  TRASHED_NOTE_ID,
  archivedNoteRow,
  editorModel,
  indexModel,
  mirrorWithNotes,
  noteRow,
  notesInputs,
  pinnedNoteRow,
  trashModel,
  trashedEditorModel,
} from './notes-test-fixtures'

const indexScene = (model: Model, overrides: Partial<Inputs> = {}) => {
  const viewInputs = notesInputs(overrides)

  return {
    update: (notes: Model, message: Notes.Message) =>
      Notes.update(notes, message, viewInputs),
    view: withViewInputs(Notes.indexView, viewInputs)(),
  }
}

const editorScene = (model: Model, overrides: Partial<Inputs> = {}) => {
  const viewInputs = notesInputs(overrides)

  return {
    update: (notes: Model, message: Notes.Message) =>
      Notes.update(notes, message, viewInputs),
    view: withViewInputs(Notes.noteView, viewInputs)(),
  }
}

const trashScene = (model: Model, overrides: Partial<Inputs> = {}) => {
  const viewInputs = notesInputs(overrides)

  return {
    update: (notes: Model, message: Notes.Message) =>
      Notes.update(notes, message, viewInputs),
    view: withViewInputs(Notes.trashView, viewInputs)(),
  }
}

describe('Notes index', () => {
  test('an empty index offers the create action and the legacy empty copy', () => {
    scene(
      indexScene(indexModel(), {
        mirror: emptyMirrorSnapshot(),
      }),
      given(indexModel()),
      expect(role('heading', { name: 'یادداشت‌ها' })).toExist(),
      expect(text('هنوز یادداشتی ندارید.')).toExist(),
      expect(
        text(
          'از هر صفحه با دکمه‌ی «یادداشت تازه» یا Alt+N شروع کنید؛ همان لحظه باز می‌شود.',
        ),
      ).toExist(),
      expect(role('button', { name: 'یادداشت تازه' })).toExist(),
      expect(role('link', { name: 'سطل زباله' })).toExist(),
    )
  })

  test('the create button is disabled until the local store is ready', () => {
    scene(
      indexScene(indexModel(), {
        isStoreReady: false,
        mirror: emptyMirrorSnapshot(),
      }),
      given(indexModel()),
      expect(role('button', { name: 'یادداشت تازه' })).toBeDisabled(),
    )
  })

  test('pinned notes lead, active notes follow, and the archive opens', () => {
    scene(
      indexScene(indexModel()),
      given(indexModel()),
      expect(role('link', { name: 'ایده‌های هفته' })).toExist(),
      expect(role('link', { name: 'خرید دارو' })).toExist(),
      expect(role('link', { name: 'یادداشت آرشیوی' })).toBeAbsent(),
      expect(role('button', { name: 'آرشیو (۱)' })).toExist(),
      click(role('button', { name: 'آرشیو (۱)' })),
      expect(role('link', { name: 'یادداشت آرشیوی' })).toExist(),
    )
  })

  test('tag chips filter the sections and report their pressed state', () => {
    const inputs = notesInputs({
      mirror: mirrorWithNotes({
        notes: [
          noteRow({ tagIds: [TAG_ID] }),
          pinnedNoteRow({ tagIds: [] }),
          archivedNoteRow(),
        ],
      }),
    })

    scene(
      indexScene(indexModel(), inputs),
      given(indexModel()),
      expect(role('button', { name: 'دارو' })).toHaveAttr(
        'aria-pressed',
        'false',
      ),
      click(role('button', { name: 'دارو' })),
      expect(role('button', { name: 'دارو' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      expect(role('link', { name: 'خرید دارو' })).toExist(),
      expect(role('link', { name: 'ایده‌های هفته' })).toBeAbsent(),
    )
  })

  test('pending and rejected rows carry their badges', () => {
    const inputs = notesInputs({
      pendingKeys: [`note\u0000${NOTE_ID}`],
      mirror: mirrorWithNotes({
        notes: [
          noteRow({ syncErrorCode: Option.some('InvalidPatch') }),
          pinnedNoteRow(),
          archivedNoteRow(),
        ],
      }),
    })

    scene(
      indexScene(indexModel(), inputs),
      given(indexModel()),
      expect(text('در انتظار ارسال')).toExist(),
      expect(text('خطا در همگام‌سازی')).toExist(),
    )
  })

  test('the offline hint explains the local-first writes', () => {
    scene(
      indexScene(indexModel(), { isOnline: false }),
      given(indexModel()),
      expect(
        text(
          'آفلاین هستید؛ همه‌ی تغییرها روی همین دستگاه ذخیره می‌شوند و بعد همگام می‌شوند.',
        ),
      ).toExist(),
    )
  })

  test('search asks the server and renders the marked result', () => {
    scene(
      indexScene(indexModel()),
      given(indexModel()),
      type(label('جست‌وجو در یادداشت‌ها (Ctrl+K)'), 'دارو'),
      Command.expectExact(
        Notes.SearchNotes({ query: 'دارو', generation: 1, delayMs: 180 }),
      ),
      Command.resolve(
        Notes.SearchNotes,
        Notes.Message.SucceededSearchNotes({
          query: 'دارو',
          generation: 1,
          hits: [
            {
              id: NOTE_ID,
              title: 'خرید دارو',
              segments: [{ text: 'دارو', match: true }],
              updatedAt: '2026-10-20T09:30:00.000Z',
            },
          ],
        }),
      ),
      expect(role('heading', { name: 'نتیجه‌ها' })).toExist(),
      expect(role('link', { name: 'خرید دارو' })).toExist(),
      expect(text('دارو')).toExist(),
    )
  })

  test('a failed search falls back to the mirror with the offline notice', () => {
    scene(
      indexScene(indexModel()),
      given(indexModel()),
      type(label('جست‌وجو در یادداشت‌ها (Ctrl+K)'), 'دارو'),
      Command.resolve(
        Notes.SearchNotes,
        Notes.Message.FailedSearchNotes({ query: 'دارو', generation: 1 }),
      ),
      expect(
        text(
          'جست‌وجو روی همین دستگاه انجام شد؛ نتیجه‌های سرور بعد از همگام‌سازی کامل می‌شود.',
        ),
      ).toExist(),
      expect(role('link', { name: 'خرید دارو' })).toExist(),
    )
  })

  test('the clear action returns to the note list', () => {
    const model = Notes.Model.make({
      ...indexModel(),
      query: 'دارو',
      searchGeneration: 1,
      searchHits: [],
    })

    scene(
      indexScene(model),
      given(model),
      click(role('button', { name: 'پاک کردن' })),
      expect(text('چیزی پیدا نشد.')).toBeAbsent(),
      expect(role('link', { name: 'خرید دارو' })).toExist(),
    )
  })

  test('creating from the index opens a local note', () => {
    scene(
      indexScene(indexModel()),
      given(indexModel()),
      click(role('button', { name: 'یادداشت تازه' })),
      Command.expectExact(Notes.CreateNote()),
      Command.resolve(
        Notes.CreateNote,
        Notes.Message.CompletedCreateNote({ noteId: NOTE_ID }),
      ),
    )
  })
})

describe('Note editor', () => {
  test('a missing note shows the hint and a way back', () => {
    const model = Notes.Model.make({
      ...editorModel(),
      loadState: 'missing',
      maybeLoadHint: Option.some('این یادداشت پیدا نشد؛ شاید حذف شده باشد.'),
    })

    scene(
      editorScene(model),
      given(model),
      expect(text('این یادداشت پیدا نشد؛ شاید حذف شده باشد.')).toExist(),
      expect(role('link', { name: 'بازگشت' })).toExist(),
    )
  })

  test('the loading state names what is happening', () => {
    const model = Notes.Model.make({
      ...editorModel(),
      loadState: 'loading',
      title: '',
      text: '',
    })

    scene(
      editorScene(model),
      given(model),
      expect(text('در حال باز کردن یادداشت…')).toExist(),
    )
  })

  test('a ready editor renders the title, body, tags and saved state', () => {
    scene(
      editorScene(editorModel()),
      given(editorModel()),
      expect(label('عنوان')).toHaveValue('خرید دارو'),
      expect(label('متن (ساده یا مارک‌داون)')).toHaveValue(
        'قرص می‌روم و دارو می‌خورم',
      ),
      expect(role('button', { name: 'دارو' })).toExist(),
      expect(role('status')).toContainText('ذخیره شد'),
      expect(role('button', { name: 'پین کردن' })).toExist(),
      expect(role('button', { name: 'آرشیو' })).toExist(),
      expect(role('button', { name: 'انتقال به سطل زباله' })).toExist(),
    )
  })

  test('a pending queue shows the local-first save state', () => {
    scene(
      editorScene(editorModel(), { pending: 2 }),
      given(editorModel()),
      expect(role('status')).toContainText('ذخیره شد؛ در انتظار همگام‌سازی'),
    )
  })

  test('a failed autosave reports the retry copy', () => {
    const model = editorModel({ saveState: 'error' })

    scene(
      editorScene(model),
      given(model),
      expect(role('status')).toContainText('ذخیره نشد؛ دوباره تلاش می‌شود.'),
    )
  })

  test('a trashed note warns, disables editing, and offers restore', () => {
    scene(
      editorScene(trashedEditorModel()),
      given(trashedEditorModel()),
      expect(text('این یادداشت در سطل زباله است.')).toExist(),
      expect(label('عنوان')).toBeDisabled(),
      expect(label('متن (ساده یا مارک‌داون)')).toBeDisabled(),
      expect(role('button', { name: 'بازگردانی' })).toExist(),
      expect(role('link', { name: 'سطل زباله' })).toExist(),
    )
  })

  test('restoring a trashed editor queues the local restore', () => {
    scene(
      editorScene(trashedEditorModel()),
      given(trashedEditorModel()),
      click(role('button', { name: 'بازگردانی' })),
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
    )
  })

  test('a sync rejection explains the failure and offers a retry', () => {
    const model = editorModel({
      maybeSyncError: Option.some('InvalidPatch'),
    })

    scene(
      editorScene(model),
      given(model),
      expect(text(syncFailureMessage('InvalidPatch'))).toExist(),
      expect(
        text('این یادداشت فعلاً فقط روی این دستگاه ذخیره شده است.'),
      ).toExist(),
      click(role('button', { name: 'تلاش دوباره' })),
      Command.expectExact(Notes.RetryNoteSync({ noteId: NOTE_ID })),
      Command.resolve(
        Notes.RetryNoteSync,
        Notes.Message.CompletedRetryNote({ noteId: NOTE_ID, version: 5 }),
      ),
    )
  })

  test('typing updates the body draft in place', () => {
    scene(
      editorScene(editorModel()),
      given(editorModel()),
      type(label('متن (ساده یا مارک‌داون)'), 'خط تازه'),
      expect(label('متن (ساده یا مارک‌داون)')).toHaveValue('خط تازه'),
    )
  })
})

describe('Notes trash', () => {
  test('an empty trash says so', () => {
    scene(
      trashScene(trashModel(), {
        mirror: mirrorWithNotes({ trashedNotes: [] }),
      }),
      given(trashModel()),
      expect(role('heading', { name: 'سطل زباله' })).toExist(),
      expect(text('سطل زباله خالی است.')).toExist(),
      expect(role('link', { name: 'بازگشت به یادداشت‌ها' })).toExist(),
    )
  })

  test('trashed rows show their title and excerpt', () => {
    scene(
      trashScene(trashModel()),
      given(trashModel()),
      expect(text('یادداشت حذف‌شده')).toExist(),
      expect(text('متن حذف‌شده')).toExist(),
      expect(role('button', { name: 'بازگردانی' })).toExist(),
    )
  })

  test('restoring a row queues the local restore and shows the busy label', () => {
    scene(
      trashScene(trashModel()),
      given(trashModel()),
      click(role('button', { name: 'بازگردانی' })),
      Command.expectExact(
        Notes.RestoreNote({ noteId: TRASHED_NOTE_ID, source: 'trash' }),
      ),
      expect(role('button', { name: 'در حال بازگردانی…' })).toBeDisabled(),
      Command.resolve(
        Notes.RestoreNote,
        Notes.Message.CompletedRestoreNote({
          noteId: TRASHED_NOTE_ID,
          source: 'trash',
        }),
      ),
    )
  })

  test('a restore error is announced in the trash', () => {
    const model = Notes.Model.make({
      ...trashModel(),
      maybeTrashError: Option.some('بازگردانی انجام نشد.'),
    })

    scene(
      trashScene(model),
      given(model),
      expect(role('alert')).toContainText('بازگردانی انجام نشد.'),
    )
  })

  test('the trash model keeps its own error and busy state', () => {
    const model = modifyFields(trashModel(), {
      maybeRestoringId: () => Option.some(TRASHED_NOTE_ID),
    })

    scene(
      trashScene(model),
      given(model),
      expect(role('button', { name: 'در حال بازگردانی…' })).toBeDisabled(),
    )
  })
})
