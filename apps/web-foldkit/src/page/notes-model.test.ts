import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { NoteRow } from '../mirror'
import {
  filterNoteRowsByTags,
  noteSections,
  pendingNoteIds,
  sortNoteRows,
  sortTrashedNoteRows,
} from './notes-model'

/**
 * Ported from `apps/web/src/lib/notes/notes.test.ts`: pinned-first ordering
 * and the any-of tag filter.
 */

const row = (overrides: Partial<NoteRow> & { readonly id: string }): NoteRow =>
  NoteRow.make({
    title: '',
    text: '',
    excerpt: '',
    isPinned: false,
    isArchived: false,
    tagIds: [],
    updatedAt: '2026-10-20T10:00:00.000Z',
    deletedAt: null,
    version: 1,
    syncErrorCode: Option.none(),
    ...overrides,
  })

describe('note row ordering', () => {
  test('puts pinned notes first, then newest', () => {
    const rows = [
      row({ id: 'a', title: 'الف', updatedAt: '2026-10-20T10:00:00.000Z' }),
      row({
        id: 'b',
        title: 'ب',
        isPinned: true,
        updatedAt: '2026-10-19T10:00:00.000Z',
      }),
      row({
        id: 'c',
        title: 'ج',
        isPinned: true,
        updatedAt: '2026-10-21T10:00:00.000Z',
      }),
    ]

    expect(sortNoteRows(rows).map(note => note.id)).toEqual(['c', 'b', 'a'])
  })

  test('filters by any selected tag', () => {
    const rows = [
      row({ id: 'a', tagIds: ['t1'] }),
      row({ id: 'b', tagIds: ['t2'] }),
      row({ id: 'c', tagIds: [] }),
    ]

    expect(
      filterNoteRowsByTags(rows, ['t2', 't1']).map(note => note.id),
    ).toEqual(['a', 'b'])
    expect(filterNoteRowsByTags(rows, [])).toHaveLength(3)
  })

  test('splits pinned, active and archived rows', () => {
    const rows = [
      row({ id: 'pinned', isPinned: true }),
      row({ id: 'active' }),
      row({ id: 'archived', isArchived: true }),
    ]

    const sections = noteSections(rows, [])

    expect(sections.pinned.map(note => note.id)).toEqual(['pinned'])
    expect(sections.active.map(note => note.id)).toEqual(['active'])
    expect(sections.archived.map(note => note.id)).toEqual(['archived'])
  })

  test('orders trash by deletion instant, newest first', () => {
    const rows = [
      row({ id: 'old', deletedAt: '2026-10-20T09:00:00.000Z' }),
      row({ id: 'new', deletedAt: '2026-10-21T09:00:00.000Z' }),
    ]

    expect(sortTrashedNoteRows(rows).map(note => note.id)).toEqual([
      'new',
      'old',
    ])
  })

  test('reads note keys out of the pending overlay', () => {
    expect(
      pendingNoteIds(['note\u0000n-1', 'task\u0000t-1', 'note\u0000n-2']),
    ).toEqual(['n-1', 'n-2'])
  })
})
