import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { Note, type NoteId, type TagId, type UserId } from "@tali/domain"

/**
 * D1-backed repository for `Note` (ticket #33; FR-NOTE-01/03).
 *
 * `body` is the TipTap/ProseMirror document as JSON TEXT; `plain_text` is the
 * normalized extraction. Pinning/archiving are booleans and trash is the
 * common soft delete. True FTS5 indexing lands with #41.
 */

const NOTE_COLUMNS =
  `id, type, title, body, plain_text AS plainText, owner_id AS ownerId, ` +
  `household_id AS householdId, visibility, is_pinned AS isPinned, ` +
  `is_archived AS isArchived, tag_ids AS tagIds, color, ` +
  `created_at AS createdAt, updated_at AS updatedAt, version, deleted_at AS deletedAt`

interface NoteRow extends Omit<Note, "body" | "isPinned" | "isArchived" | "tagIds"> {
  readonly body: string | null
  readonly isPinned: number | boolean
  readonly isArchived: number | boolean
  readonly tagIds: string
}

const bit = (value: boolean): number => (value ? 1 : 0)
const encodeTagIds = (ids: ReadonlyArray<TagId>): string => JSON.stringify(ids)

const toNote = (row: NoteRow): Note =>
  new Note({
    ...row,
    body: row.body === null ? null : (JSON.parse(row.body) as Note["body"]),
    isPinned: row.isPinned === true || row.isPinned === 1,
    isArchived: row.isArchived === true || row.isArchived === 1,
    tagIds: JSON.parse(row.tagIds) as ReadonlyArray<TagId>
  })

export class NoteRepo extends Context.Service<NoteRepo>()("NoteRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const findById = (id: NoteId) =>
      Effect.map(
        sql<NoteRow>`SELECT ${sql.literal(NOTE_COLUMNS)} FROM notes WHERE id = ${id}`,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toNote)
      )

    const listVisible = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<NoteRow>`
          SELECT ${sql.literal(NOTE_COLUMNS)} FROM notes
          WHERE household_id = ${input.householdId}
            AND deleted_at IS NULL
            AND (owner_id = ${input.userId} OR visibility = 'shared')
          ORDER BY is_pinned DESC, updated_at DESC, id ASC
        `,
        (rows) => rows.map(toNote)
      )

    /** Dashboard pinned section (pinned notes first, then recency). */
    const listPinned = (input: { readonly householdId: string; readonly userId: UserId }) =>
      Effect.map(
        sql<NoteRow>`
          SELECT ${sql.literal(NOTE_COLUMNS)} FROM notes
          WHERE household_id = ${input.householdId}
            AND deleted_at IS NULL
            AND is_pinned = 1
            AND is_archived = 0
            AND (owner_id = ${input.userId} OR visibility = 'shared')
          ORDER BY updated_at DESC, id ASC
        `,
        (rows) => rows.map(toNote)
      )

    const insert = (note: Note) =>
      Effect.map(
        sql<NoteRow>`
          INSERT INTO notes
            (id, type, title, body, plain_text, owner_id, household_id, visibility,
             is_pinned, is_archived, tag_ids, color, created_at, updated_at, version, deleted_at)
          VALUES
            (${note.id}, ${note.type}, ${note.title},
             ${note.body === null ? null : JSON.stringify(note.body)}, ${note.plainText},
             ${note.ownerId}, ${note.householdId}, ${note.visibility},
             ${bit(note.isPinned)}, ${bit(note.isArchived)}, ${encodeTagIds(note.tagIds)},
             ${note.color}, ${note.createdAt}, ${note.updatedAt}, ${note.version}, ${note.deletedAt})
          RETURNING ${sql.literal(NOTE_COLUMNS)}
        `,
        (rows) => toNote(rows[0]!)
      )

    const update = (note: Note) =>
      Effect.map(
        sql<NoteRow>`
          UPDATE notes SET
            title = ${note.title},
            body = ${note.body === null ? null : JSON.stringify(note.body)},
            plain_text = ${note.plainText},
            visibility = ${note.visibility},
            is_pinned = ${bit(note.isPinned)},
            is_archived = ${bit(note.isArchived)},
            tag_ids = ${encodeTagIds(note.tagIds)},
            color = ${note.color},
            updated_at = ${note.updatedAt},
            version = ${note.version},
            deleted_at = ${note.deletedAt}
          WHERE id = ${note.id}
          RETURNING ${sql.literal(NOTE_COLUMNS)}
        `,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toNote)
      )

    return { findById, listVisible, listPinned, insert, update } as const
  })
}) {}

export const NoteRepoLive = Layer.effect(NoteRepo, NoteRepo.make)
