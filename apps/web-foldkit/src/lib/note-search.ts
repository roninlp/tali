import { Array } from 'effect'

import { buildVariantInsensitivePattern } from '@tali/domain'

import type { NoteRow } from '../mirror'

/**
 * The offline note search, ported from `apps/web/src/lib/notes/search.ts`.
 *
 * The server's FTS5 index is the primary search, but the app is local-first:
 * when the network is gone the mirror still holds every note, so the search
 * box keeps working. This is the fallback — a substring match over the
 * mirror, with the same variant-insensitive matching the index uses, so a
 * query finds the same notes offline and online.
 */

export interface NoteSearchSegment {
  readonly text: string
  readonly match: boolean
}

export interface LocalNoteHit {
  readonly id: string
  readonly title: string
  /** The note's text with the matches marked. */
  readonly segments: ReadonlyArray<NoteSearchSegment>
  readonly updatedAt: string
}

/** Split a text into plain and matched runs, using a global pattern. */
export const markMatches = (
  text: string,
  pattern: RegExp,
): ReadonlyArray<NoteSearchSegment> => {
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  )

  const segments: Array<NoteSearchSegment> = []
  let cursor = 0
  let match: RegExpExecArray | null = global.exec(text)

  while (match !== null) {
    if (match.index > cursor) {
      segments.push({ text: text.slice(cursor, match.index), match: false })
    }

    segments.push({ text: match[0], match: true })
    cursor = match.index + match[0].length

    if (match[0].length === 0) {
      global.lastIndex += 1
    }

    match = global.exec(text)
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), match: false })
  }

  return segments
}

/**
 * The excerpt around the first match, with every match inside it marked.
 *
 * The server's snippet is built from the folded text, so it drops the user's
 * half-space. The mirror still has the note exactly as it was written, so the
 * client re-marks the match in the original text and shows a window around it.
 */
export const excerptAroundMatch = (
  text: string,
  pattern: RegExp,
  radius = 48,
): ReadonlyArray<NoteSearchSegment> => {
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  )

  const first = global.exec(text)

  if (first === null) return []

  const start = Math.max(0, first.index - radius)
  const end = Math.min(text.length, first.index + first[0].length + radius)
  const window = text.slice(start, end)
  const marked: Array<NoteSearchSegment> = [...markMatches(window, pattern)]

  if (start > 0) {
    marked.unshift({ text: '…', match: false })
  }

  if (end < text.length) {
    marked.push({ text: '…', match: false })
  }

  return marked
}

/**
 * The notes that match the query, in the mirror's order.
 *
 * Trashed notes are never a hit; archived notes are (the search is its own
 * surface, not a filter of the default list).
 */
export const searchNotesLocally = (
  notes: ReadonlyArray<NoteRow>,
  query: string,
): ReadonlyArray<LocalNoteHit> => {
  const pattern = buildVariantInsensitivePattern(query)

  if (pattern === undefined) return []

  return Array.flatMap(notes, note => {
    if (note.deletedAt !== null) return []

    const haystack = `${note.title} ${note.text}`
    const probe = new RegExp(pattern.source, pattern.flags)

    if (!probe.test(haystack)) return []

    const segments =
      note.text === ''
        ? excerptAroundMatch(note.title, pattern)
        : excerptAroundMatch(note.text, pattern)

    return [
      {
        id: note.id,
        title: note.title,
        segments: Array.isReadonlyArrayNonEmpty(segments)
          ? segments
          : [{ text: note.excerpt, match: false }],
        updatedAt: note.updatedAt,
      },
    ]
  })
}
