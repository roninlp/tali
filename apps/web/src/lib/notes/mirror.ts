import { uuidV7 } from "@tali/domain"
import type { Note } from "@tali/domain"
import type { MirrorRecord, ServerRow } from "../local-store/types"
import type { LocalStore } from "../local-store/types"
import { noteDisplayTitle, noteExcerpt, noteTextFromData, textToNoteBody } from "./body"

/**
 * Mirror projections for the notes screens (#40).
 *
 * Reads render from the local mirror first (offline-first); the server row is
 * only consulted when the mirror has never seen the note. Tags are mirrored
 * aggregates too, so chip filters work offline.
 */

export interface NoteRow {
  readonly id: string
  readonly data: Readonly<Record<string, unknown>>
  readonly version: number
  readonly updatedAt: string
  readonly deletedAt: string | null
  readonly isPinned: boolean
  readonly isArchived: boolean
  readonly tagIds: ReadonlyArray<string>
  readonly title: string
  readonly text: string
  readonly excerpt: string
}

const stringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

export const toNoteRow = (record: MirrorRecord): NoteRow => ({
  id: record.entityId,
  data: record.data,
  version: record.version,
  updatedAt: record.updatedAt,
  deletedAt: record.deletedAt,
  isPinned: record.data.isPinned === true,
  isArchived: record.data.isArchived === true,
  tagIds: stringArray(record.data.tagIds),
  title: noteDisplayTitle(record.data),
  text: noteTextFromData(record.data),
  excerpt: noteExcerpt(record.data)
})

/** Pinned first, then most recently changed (FR-NOTE-03). */
export const sortNotes = (rows: ReadonlyArray<NoteRow>): ReadonlyArray<NoteRow> =>
  [...rows].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
    return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
  })

/** Any-of tag filter, matching the service's OR semantics. */
export const filterNotesByTags = (
  rows: ReadonlyArray<NoteRow>,
  tagIds: ReadonlyArray<string>
): ReadonlyArray<NoteRow> =>
  tagIds.length === 0
    ? rows
    : rows.filter((row) => row.tagIds.some((tagId) => tagIds.includes(tagId)))

/**
 * An RPC-returned note in the mirror's server-row shape, so a successful
 * restore can be adopted without waiting for the cursor poll.
 */
export const noteToServerRow = (note: Note): ServerRow => {
  const { version, updatedAt, deletedAt, ...data } = note
  return {
    entityType: "note",
    entityId: note.id,
    version,
    updatedAt,
    deletedAt,
    data: { ...data }
  }
}

/**
 * Create a note in the mirror + outbox without waiting for the network. This
 * is the whole quick-create path: one IndexedDB transaction, then the editor
 * route opens with the note already renderable offline.
 */
export const createNoteInMirror = async (
  store: LocalStore,
  now: string = new Date().toISOString()
): Promise<string> => {
  const id = uuidV7()
  await store.writeLocal({
    entityType: "note",
    entityId: id,
    op: "upsert",
    patch: {
      id,
      type: "note",
      title: "",
      body: textToNoteBody(""),
      plainText: "",
      isPinned: false,
      isArchived: false,
      tagIds: [],
      visibility: "shared",
      createdAt: now
    },
    now
  })
  return id
}
