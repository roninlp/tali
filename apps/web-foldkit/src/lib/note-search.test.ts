import { Option } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { NoteRow } from '../mirror'
import { markMatches, searchNotesLocally } from './note-search'

/**
 * Ported from `apps/web/src/lib/notes/search.test.ts`: the offline search.
 *
 * The server's FTS5 index is the primary search; when the network is gone the
 * local mirror answers instead, with the same variant-insensitive matching.
 */

const row = (overrides: Partial<NoteRow> & { readonly id: string }): NoteRow =>
  NoteRow.make({
    title: '',
    text: '',
    excerpt: '',
    isPinned: false,
    isArchived: false,
    tagIds: [],
    updatedAt: '2026-10-20T09:30:00.000Z',
    deletedAt: null,
    version: 1,
    syncErrorCode: Option.none(),
    ...overrides,
  })

describe('markMatches', () => {
  test('splits the text into plain and matched runs', () => {
    expect(markMatches('قرص دارو می‌خورم', /دارو/gu)).toEqual([
      { text: 'قرص ', match: false },
      { text: 'دارو', match: true },
      { text: ' می‌خورم', match: false },
    ])
  })

  test('marks every occurrence', () => {
    expect(markMatches('نان و نان', /نان/gu)).toEqual([
      { text: 'نان', match: true },
      { text: ' و ', match: false },
      { text: 'نان', match: true },
    ])
  })

  test('returns the whole text as plain when nothing matches', () => {
    expect(markMatches('نان', /پنیر/gu)).toEqual([
      { text: 'نان', match: false },
    ])
  })
})

describe('searchNotesLocally', () => {
  const notes: ReadonlyArray<NoteRow> = [
    row({ id: 'n-1', title: 'خرید دارو', text: 'قرص میروم' }),
    row({ id: 'n-2', title: 'نان', text: 'نان و پنیر' }),
    row({
      id: 'n-3',
      title: 'محرمانه',
      text: 'رمز خانواده',
      deletedAt: '2026-10-20T10:00:00.000Z',
    }),
  ]

  test('finds a note by another Persian spelling', () => {
    const hits = searchNotesLocally(notes, 'میروم')
    expect(hits.map(hit => hit.id)).toEqual(['n-1'])
  })

  test('finds a note across the half-space', () => {
    const hits = searchNotesLocally(notes, 'میروم')
    expect(hits.map(hit => hit.id)).toEqual(['n-1'])
  })

  test('never returns a trashed note', () => {
    expect(searchNotesLocally(notes, 'رمز')).toEqual([])
  })

  test('returns nothing for a query with nothing searchable', () => {
    expect(searchNotesLocally(notes, '')).toEqual([])
    expect(searchNotesLocally(notes, '---')).toEqual([])
  })

  test('marks the match in the snippet', () => {
    const hits = searchNotesLocally(notes, 'پنیر')

    expect(hits).toHaveLength(1)
    expect(hits[0]?.segments.some(segment => segment.match)).toBe(true)
  })
})
