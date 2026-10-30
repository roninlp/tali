import { Array } from 'effect'

import type { NoteRow } from '../mirror'

/**
 * Pure projections for the notes screens, ported from
 * `apps/web/src/lib/notes/mirror.ts`.
 *
 * The mirror rows arrive as update/view inputs; these helpers decide section
 * order, the any-of tag filter, the trash order and pending ids, so the
 * Submodel and its views stay declarative.
 */

/** Pinned first, then most recently changed (FR-NOTE-03). */
export const sortNoteRows = (
  notes: ReadonlyArray<NoteRow>,
): ReadonlyArray<NoteRow> =>
  [...notes].sort((left, right) => {
    if (left.isPinned !== right.isPinned) {
      return left.isPinned ? -1 : 1
    }

    const byUpdated = right.updatedAt.localeCompare(left.updatedAt)

    return byUpdated !== 0 ? byUpdated : left.id.localeCompare(right.id)
  })

/** Trash order: the most recently deleted first. */
export const sortTrashedNoteRows = (
  notes: ReadonlyArray<NoteRow>,
): ReadonlyArray<NoteRow> =>
  [...notes].sort((left, right) => {
    const byDeleted = (right.deletedAt ?? '').localeCompare(
      left.deletedAt ?? '',
    )

    return byDeleted !== 0 ? byDeleted : left.id.localeCompare(right.id)
  })

/** Any-of tag filter, matching the service's OR semantics. */
export const filterNoteRowsByTags = (
  notes: ReadonlyArray<NoteRow>,
  tagIds: ReadonlyArray<string>,
): ReadonlyArray<NoteRow> =>
  Array.isReadonlyArrayEmpty(tagIds)
    ? notes
    : Array.filter(notes, note =>
        Array.some(note.tagIds, tagId => Array.contains(tagIds, tagId)),
      )

export interface NoteSections {
  readonly pinned: ReadonlyArray<NoteRow>
  readonly active: ReadonlyArray<NoteRow>
  readonly archived: ReadonlyArray<NoteRow>
}

export const noteSections = (
  notes: ReadonlyArray<NoteRow>,
  selectedTagIds: ReadonlyArray<string>,
): NoteSections => {
  const filtered = filterNoteRowsByTags(notes, selectedTagIds)
  const active = sortNoteRows(Array.filter(filtered, note => !note.isArchived))
  const archived = sortNoteRows(Array.filter(filtered, note => note.isArchived))

  return {
    pinned: Array.filter(active, note => note.isPinned),
    active: Array.filter(active, note => !note.isPinned),
    archived,
  }
}

const NOTE_KEY_PREFIX = 'note\u0000'

/** The note ids with an unsent outbox entry. */
export const pendingNoteIds = (
  pendingKeys: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  Array.flatMap(pendingKeys, key =>
    key.startsWith(NOTE_KEY_PREFIX) ? [key.slice(NOTE_KEY_PREFIX.length)] : [],
  )
