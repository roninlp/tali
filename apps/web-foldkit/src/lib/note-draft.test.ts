import { describe, expect, test } from 'vitest'

import {
  noteDraftKey,
  parseNoteDraft,
  reconcileDraft,
  serializeNoteDraft,
} from './note-draft'

/**
 * Ported from `apps/web/src/lib/notes/notes.test.ts` and `saver.test.ts`:
 * draft parsing and reconciliation. A draft never clobbers newer server text,
 * but a queued local edit or our own ack keeps the user's typing.
 */

const draft = (version: number, text: string) => ({
  version,
  text,
  savedAt: '2026-10-20T09:30:00.000Z',
})

describe('draft reconciliation', () => {
  test('parses only well-formed drafts', () => {
    expect(parseNoteDraft(serializeNoteDraft(draft(2, 'متن')))).toEqual(
      draft(2, 'متن'),
    )
    expect(
      parseNoteDraft(
        serializeNoteDraft({ ...draft(2, 'متن'), baseText: 'قبلی' }),
      ),
    ).toEqual({ ...draft(2, 'متن'), baseText: 'قبلی' })
    expect(parseNoteDraft('not json')).toBeUndefined()
    expect(
      parseNoteDraft(JSON.stringify({ version: 1, text: 'x' })),
    ).toBeUndefined()
    expect(parseNoteDraft(undefined)).toBeUndefined()
  })

  test('the draft key matches the legacy IndexedDB key', () => {
    expect(noteDraftKey('note-1')).toBe('note.draft.note-1')
  })

  test('applies a draft at the mirrored version after a sudden close', () => {
    expect(
      reconcileDraft({
        draft: draft(4, 'نیمه‌نوشته'),
        serverVersion: 4,
        serverText: 'قدیمی',
        hasPending: false,
      }),
    ).toEqual({ apply: true, text: 'نیمه‌نوشته' })
  })

  test('applies a queued local edit even when the mirror is behind', () => {
    expect(
      reconcileDraft({
        draft: draft(2, 'ویرایش محلی'),
        serverVersion: 5,
        serverText: 'متن سرور',
        hasPending: true,
      }),
    ).toEqual({ apply: true, text: 'ویرایش محلی' })
  })

  test('never clobbers newer server text', () => {
    expect(
      reconcileDraft({
        draft: draft(3, 'پیش‌نویس کهنه'),
        serverVersion: 6,
        serverText: 'متن تازه‌تر',
        hasPending: false,
      }),
    ).toEqual({ apply: false, reason: 'server-newer' })
  })

  test('keeps a draft when the version moved but the text did not', () => {
    expect(
      reconcileDraft({
        draft: { ...draft(0, 'نیمه‌نوشته'), baseText: '' },
        serverVersion: 1,
        serverText: '',
        hasPending: false,
      }),
    ).toEqual({ apply: true, text: 'نیمه‌نوشته' })

    expect(
      reconcileDraft({
        draft: { ...draft(4, 'T1 و یک کلید'), baseText: 'T1' },
        serverVersion: 5,
        serverText: 'T1',
        hasPending: false,
      }),
    ).toEqual({ apply: true, text: 'T1 و یک کلید' })

    expect(
      reconcileDraft({
        draft: { ...draft(4, 'T1 و یک کلید'), baseText: 'T1' },
        serverVersion: 5,
        serverText: 'متن دستگاه دیگر',
        hasPending: false,
      }),
    ).toEqual({ apply: false, reason: 'server-newer' })
  })

  test('applies an empty draft when the user cleared the note', () => {
    expect(
      reconcileDraft({
        draft: { ...draft(4, ''), baseText: 'متن قبلی' },
        serverVersion: 4,
        serverText: 'متن قبلی',
        hasPending: false,
      }),
    ).toEqual({ apply: true, text: '' })

    expect(
      reconcileDraft({
        draft: draft(4, ''),
        serverVersion: 4,
        serverText: 'متن',
        hasPending: false,
      }),
    ).toEqual({ apply: false, reason: 'empty' })
  })

  test('ignores an identical draft', () => {
    expect(
      reconcileDraft({
        draft: draft(4, 'همان'),
        serverVersion: 4,
        serverText: 'همان',
        hasPending: false,
      }),
    ).toEqual({ apply: false, reason: 'unchanged' })
  })
})
