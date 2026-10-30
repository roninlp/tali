import { describe, expect, test } from 'vitest'

import {
  noteDisplayTitle,
  noteExcerpt,
  noteTextFromBody,
  noteTextFromData,
  noteTitleFromData,
  textToNoteBody,
} from './note-body'

/**
 * Ported from `apps/web/src/lib/notes/notes.test.ts`: the ProseMirror-shaped
 * plain-text envelope and the list projections.
 */

describe('note body', () => {
  test('round-trips multiline Persian text through the ProseMirror-shaped doc', () => {
    const text = 'نان سنگک\n\nشیر و پنیر'
    const body = textToNoteBody(text)

    expect(noteTextFromBody(body)).toBe(text)
    expect(noteTextFromData({ body, plainText: 'ignored' })).toBe(text)
  })

  test('round-trips unicode, ZWNJ, emoji, quotes, and JSON-ish text', () => {
    const text = [
      'می‌خواهم (ZWNJ) بنویسم',
      '"نقل قول" و \'تک کوتیشن\'',
      '{ "type": "doc", "content": [] }',
      'emoji: 😀 👩‍👩‍👧‍👦 — RTL/123',
      'backslash \\ and tab\there',
    ].join('\n')

    expect(noteTextFromBody(textToNoteBody(text))).toBe(text)
  })

  test('round-trips whitespace-only text and blank edges exactly', () => {
    for (const text of [
      '\n',
      '\n\n',
      '  ',
      '  \n\n  ',
      '\n leading',
      'trailing \n',
      'a\rb',
    ]) {
      expect(noteTextFromBody(textToNoteBody(text))).toBe(text)
    }
  })

  test('falls back to plainText for a legacy/rich body it cannot read', () => {
    expect(noteTextFromData({ body: null, plainText: 'متن ذخیره‌شده' })).toBe(
      'متن ذخیره‌شده',
    )
    expect(
      noteTextFromBody({
        type: 'doc',
        content: [
          { type: 'heading', content: [{ type: 'text', text: 'تیتر' }] },
        ],
      }),
    ).toBe('تیتر')
  })

  test('derives a list title and a bounded excerpt', () => {
    expect(
      noteDisplayTitle({ title: '  ', body: textToNoteBody('خط اول\nخط دوم') }),
    ).toBe('خط اول')
    expect(noteDisplayTitle({ title: '', body: null, plainText: '' })).toBe(
      'یادداشت بی‌نام',
    )
    expect(
      noteDisplayTitle({ title: 'خرید', body: null, plainText: 'نان' }),
    ).toBe('خرید')
    expect(noteExcerpt({ body: textToNoteBody('a'.repeat(120)) }, 10)).toBe(
      'aaaaaaaaaa…',
    )
  })

  test('keeps the raw title for the editor field', () => {
    expect(noteTitleFromData({ title: '  خرید  ' })).toBe('  خرید  ')
    expect(noteTitleFromData({ title: 42 })).toBe('')
  })
})
