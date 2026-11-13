import 'fake-indexeddb/auto'
import { Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { Note, uuidV7 } from '@tali/domain'
import { type LocalStore, openLocalStore } from '@tali/sync-client'

import { noteTextFromData, textToNoteBody } from './note-body'
import { noteDraftKey, serializeNoteDraft } from './note-draft'
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
} from './note-writes'

/**
 * Ported from `apps/web/src/lib/notes/notes.test.ts` and `saver.test.ts`:
 * autosave dedupes identical saves (one server version per real edit), the
 * mirror commits before the network, and a draft survives a reload while a
 * newer draft typed during a save is kept.
 */

const open = (): Promise<LocalStore> => openLocalStore(`user-${uuidV7()}`)

const NOW = '2026-10-20T09:30:00.000Z'

describe('note quick create', () => {
  test('writes the note into the mirror and outbox before any network call', async () => {
    const store = await open()
    const id = uuidV7(1_700_000_000_000)

    await createNoteInMirror(store, id, NOW)

    const record = await store.get('note', id)
    expect(record).toMatchObject({
      version: 0,
      deletedAt: null,
      data: {
        id,
        type: 'note',
        title: '',
        plainText: '',
        isPinned: false,
        tagIds: [],
      },
    })
    expect((await store.pending()).map(entry => entry.entityId)).toEqual([id])
    expect((await store.list('note')).map(row => row.entityId)).toEqual([id])
    expect(await store.readDraft(noteDraftKey(id))).toBeUndefined()
    store.close()
  })
})

describe('note autosave', () => {
  test('commits text to the mirror and folds an unsent edit into one mutation', async () => {
    const store = await open()
    const id = uuidV7(1_700_000_000_000)
    await createNoteInMirror(store, id, NOW)

    expect(
      await saveNoteContentInMirror(store, id, { title: '', text: '' }, NOW),
    ).toBe('unchanged')
    expect(await store.pending()).toHaveLength(1)
    const [created] = await store.pending()

    expect(
      await saveNoteContentInMirror(
        store,
        id,
        { title: '', text: 'نان سنگک' },
        NOW,
      ),
    ).toBe('saved')
    expect(
      await saveNoteContentInMirror(
        store,
        id,
        { title: '', text: 'نان سنگک' },
        NOW,
      ),
    ).toBe('unchanged')

    const afterFirstBody = await store.pending()
    expect(afterFirstBody).toHaveLength(1)
    expect(afterFirstBody[0]?.clientMutationId).toBe(created?.clientMutationId)
    expect(afterFirstBody[0]?.patch).toMatchObject({ plainText: 'نان سنگک' })

    const record = await store.get('note', id)
    expect(noteTextFromData(record!.data)).toBe('نان سنگک')
    expect(record!.data.body).toEqual(textToNoteBody('نان سنگک'))

    expect(
      await saveNoteContentInMirror(
        store,
        id,
        { title: '', text: 'نان سنگک و پنیر' },
        NOW,
      ),
    ).toBe('saved')
    const pending = await store.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      entityType: 'note',
      entityId: id,
      baseVersion: 0,
    })
    expect(pending[0]?.patch).toMatchObject({
      plainText: 'نان سنگک و پنیر',
    })
    store.close()
  })

  test('keeps a draft typed while an older save was in flight', async () => {
    const store = await open()
    const id = uuidV7(1_700_000_000_000)
    await createNoteInMirror(store, id, NOW)

    const saving = saveNoteContentInMirror(
      store,
      id,
      { title: '', text: 'متن اول' },
      NOW,
    )

    await store.saveDraft(
      noteDraftKey(id),
      serializeNoteDraft({
        version: 0,
        baseText: '',
        text: 'متن دوم',
        savedAt: NOW,
      }),
    )
    await saving

    expect((await readNoteDraft(store, id))?.text).toBe('متن دوم')
    store.close()
  })

  test('drops a redundant draft once its exact text is durable', async () => {
    const store = await open()
    const id = uuidV7(1_700_000_000_000)
    await createNoteInMirror(store, id, NOW)
    await saveNoteDraft(store, id, {
      version: 0,
      baseText: '',
      text: 'همان',
      savedAt: NOW,
    })
    await saveNoteContentInMirror(store, id, { title: '', text: 'همان' }, NOW)
    expect(await readNoteDraft(store, id)).toBeUndefined()
    store.close()
  })

  test('does not re-write a title that a direct patch already persisted', async () => {
    const store = await open()
    const id = uuidV7(1_700_000_000_000)
    await createNoteInMirror(store, id, NOW)

    await store.writeLocal({
      entityType: 'note',
      entityId: id,
      op: 'upsert',
      patch: { title: 'خرید' },
    })
    const pendingBefore = (await store.pending()).length

    expect(
      await saveNoteContentInMirror(
        store,
        id,
        { title: 'خرید', text: '' },
        NOW,
      ),
    ).toBe('unchanged')
    expect(await store.pending()).toHaveLength(pendingBefore)
    store.close()
  })

  test('clears the crash draft once the mirror write is durable', async () => {
    const store = await open()
    const id = uuidV7(1_700_000_000_000)
    await createNoteInMirror(store, id, NOW)
    await saveNoteDraft(store, id, {
      version: 0,
      text: 'نیمه‌نوشته',
      savedAt: NOW,
    })

    await saveNoteContentInMirror(
      store,
      id,
      { title: '', text: 'نیمه‌نوشته' },
      NOW,
    )

    expect(await readNoteDraft(store, id)).toBeUndefined()
    expect(noteTextFromData((await store.get('note', id))!.data)).toBe(
      'نیمه‌نوشته',
    )
    store.close()
  })

  test('an explicit clear removes the draft', async () => {
    const store = await open()
    const id = uuidV7(1_700_000_000_000)
    await createNoteInMirror(store, id, NOW)
    await saveNoteDraft(store, id, {
      version: 0,
      text: 'پیش‌نویس',
      savedAt: NOW,
    })
    await clearNoteDraft(store, id)
    expect(await readNoteDraft(store, id)).toBeUndefined()
    store.close()
  })
})

describe('note mirror flags', () => {
  test('pin, archive and tags update the mirror and queue', async () => {
    const store = await open()
    const id = uuidV7(1_700_000_000_000)
    await createNoteInMirror(store, id, NOW)

    await setNotePinnedInMirror(store, id, true, NOW)
    await setNoteArchivedInMirror(store, id, true, NOW)
    await setNoteTagsInMirror(store, id, ['tag-a'], NOW)

    const record = await store.get('note', id)
    expect(record?.data).toMatchObject({
      isPinned: true,
      isArchived: true,
      tagIds: ['tag-a'],
    })
    store.close()
  })

  test('trash keeps the row only in the tombstone list', async () => {
    const store = await open()
    const id = uuidV7(1_700_000_000_000)
    await createNoteInMirror(store, id, NOW)

    await trashNoteInMirror(store, id, NOW)
    const record = await store.get('note', id)
    expect(record?.deletedAt).toBe(NOW)
    expect(await store.list('note')).toEqual([])
    expect((await store.listTrashed('note')).map(row => row.entityId)).toEqual([
      id,
    ])
    store.close()
  })

  test('a restored server row clears the tombstone once the queue drained', async () => {
    const store = await open()
    const id = uuidV7(1_700_000_000_000)
    const ownerId = uuidV7(1_700_000_000_001)
    const householdId = uuidV7(1_700_000_000_002)
    await createNoteInMirror(store, id, NOW)
    await trashNoteInMirror(store, id, NOW)
    await store.ack(
      (await store.pending()).map(entry => entry.clientMutationId),
    )

    const restored = Schema.decodeUnknownSync(Note)({
      id,
      type: 'note',
      ownerId,
      householdId,
      visibility: 'shared',
      color: null,
      createdAt: NOW,
      updatedAt: NOW,
      version: 3,
      deletedAt: null,
      title: 'خرید دارو',
      body: textToNoteBody('خرید دارو'),
      plainText: 'خرید دارو',
      isPinned: false,
      isArchived: false,
      tagIds: [],
    })

    await store.mergeServer([noteToServerRow(restored)])
    const record = await store.get('note', id)
    expect(record?.deletedAt).toBeNull()
    expect(record?.version).toBe(3)
    expect((await store.list('note')).map(row => row.entityId)).toEqual([id])
    store.close()
  })

  test('retry clears the rejection and queues one fresh upsert', async () => {
    const store = await open()
    const id = uuidV7(1_700_000_000_000)
    const clientMutationId = uuidV7(1_700_000_000_001)
    await store.mergeServer([
      {
        entityType: 'note',
        entityId: id,
        version: 4,
        updatedAt: NOW,
        deletedAt: null,
        data: {
          id,
          type: 'note',
          title: 'خرید دارو',
          body: textToNoteBody('متن قدیمی'),
          plainText: 'متن قدیمی',
          isPinned: false,
          isArchived: false,
          tagIds: [],
          visibility: 'shared',
          createdAt: NOW,
        },
      },
    ])
    await store.ack(
      [],
      [],
      [
        {
          entityType: 'note',
          entityId: id,
          code: 'InvalidPatch',
          message: 'bad title',
          at: NOW,
          clientMutationId,
        },
      ],
    )

    const version = await retryNoteInMirror(store, id)

    expect(version).toBe(4)
    const [queued] = await store.pending()
    expect(queued).toMatchObject({
      entityType: 'note',
      entityId: id,
      op: 'upsert',
      baseVersion: 4,
      patch: { title: 'خرید دارو', plainText: 'متن قدیمی' },
    })
    expect(queued?.clientMutationId).not.toBe(clientMutationId)
    expect((await store.get('note', id))?.syncError).toBeUndefined()
    store.close()
  })

  test('retry returns undefined for a note this device does not have', async () => {
    const store = await open()
    expect(await retryNoteInMirror(store, uuidV7())).toBeUndefined()
    store.close()
  })
})

describe('notes row projection inputs', () => {
  test('a sync failure marker is readable from the row', async () => {
    const store = await open()
    const id = uuidV7(1_700_000_000_000)
    const clientMutationId = uuidV7(1_700_000_000_001)
    await createNoteInMirror(store, id, NOW)
    await store.ack(
      [],
      [],
      [
        {
          entityType: 'note',
          entityId: id,
          code: 'InvalidPatch',
          message: 'bad title',
          at: NOW,
          clientMutationId,
        },
      ],
    )

    const record = await store.get('note', id)
    expect(record?.syncError?.code).toBe('InvalidPatch')
    store.close()
  })
})
