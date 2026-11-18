import { Context, Effect, Layer, Option, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { Note, type NoteId, TagId, type UserId } from '@tali/domain'
import {
  type ColumnValues,
  column,
  columnCodecs,
  defineTable,
  insertStatement,
  selectList,
  updateStatement,
} from './columns'
import { visibleScopeSql } from './scope'

/**
 * D1-backed repository for `Note` (ticket #33; FR-NOTE-01/03).
 *
 * `body` is the TipTap/ProseMirror document as JSON TEXT; `plain_text` is the
 * normalized extraction. Pinning/archiving are booleans and trash is the
 * common soft delete. True FTS5 indexing lands with #41.
 */

/**
 * The one place `notes`' columns are declared (#115): the repo's SELECT, INSERT
 * and UPDATE lists below, and the sync registry's projection and statements,
 * are all generated from this descriptor.
 */
export const NOTE_TABLE = defineTable('notes', [
  column('id', { updatable: false }),
  column('type', { updatable: false }),
  column('title', { codec: columnCodecs.text }),
  column('body', { codec: columnCodecs.jsonOrNull }),
  column('plain_text', 'plainText', { codec: columnCodecs.text }),
  column('owner_id', 'ownerId', { updatable: false }),
  column('household_id', 'householdId', { updatable: false }),
  column('visibility'),
  column('color', { codec: columnCodecs.nullableText }),
  column('is_pinned', 'isPinned', { codec: columnCodecs.bit }),
  column('is_archived', 'isArchived', { codec: columnCodecs.bit }),
  column('tag_ids', 'tagIds', { codec: columnCodecs.json }),
  column('created_at', 'createdAt', {
    updatable: false,
    codec: columnCodecs.text,
  }),
  column('updated_at', 'updatedAt', { codec: columnCodecs.text }),
  column('version', { codec: columnCodecs.int }),
  column('deleted_at', 'deletedAt', { codec: columnCodecs.nullableText }),
])

const NOTE_SELECT = selectList(NOTE_TABLE)

interface NoteRow extends Omit<
  Note,
  'body' | 'isPinned' | 'isArchived' | 'tagIds'
> {
  readonly body: string | null
  readonly isPinned: number | boolean
  readonly isArchived: number | boolean
  readonly tagIds: string
}

const asBody = Schema.decodeOption(Schema.fromJsonString(Schema.Json))

const asTagIds = Schema.decodeOption(Schema.fromJsonString(Schema.Array(TagId)))

const toNote = (row: NoteRow): Note =>
  new Note({
    ...row,
    body: row.body === null ? null : Option.getOrThrow(asBody(row.body)),
    isPinned: row.isPinned === true || row.isPinned === 1,
    isArchived: row.isArchived === true || row.isArchived === 1,
    tagIds: Option.getOrElse(asTagIds(row.tagIds), () => []),
  })

/** The model's column values; the descriptor's codecs do the encoding. */
const noteValues = (note: Note): ColumnValues<typeof NOTE_TABLE> => ({
  id: note.id,
  type: note.type,
  title: note.title,
  body: note.body,
  plainText: note.plainText,
  ownerId: note.ownerId,
  householdId: note.householdId,
  visibility: note.visibility,
  color: note.color,
  isPinned: note.isPinned,
  isArchived: note.isArchived,
  tagIds: note.tagIds,
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
  version: note.version,
  deletedAt: note.deletedAt,
})

export class NoteRepo extends Context.Service<NoteRepo>()('NoteRepo', {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const findById = (id: NoteId) =>
      Effect.map(
        sql<NoteRow>`SELECT ${sql.literal(NOTE_SELECT)} FROM notes WHERE id = ${id}`,
        rows => Option.map(Option.fromUndefinedOr(rows[0]), toNote),
      )

    const listVisible = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<NoteRow>`
          SELECT ${sql.literal(NOTE_SELECT)} FROM notes
          WHERE ${visibleScopeSql(sql, input)}
          ORDER BY is_pinned DESC, updated_at DESC, id ASC
        `,
        rows => rows.map(toNote),
      )

    /** The default notes list: live, not archived. Pinned first (FR-NOTE-03). */
    const listActive = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<NoteRow>`
          SELECT ${sql.literal(NOTE_SELECT)} FROM notes
          WHERE ${visibleScopeSql(sql, input)}
            AND is_archived = 0
          ORDER BY is_pinned DESC, updated_at DESC, id ASC
        `,
        rows => rows.map(toNote),
      )

    /**
     * Trash view (FR-NOTE-03): soft-deleted notes, most recently trashed first.
     * (The inverted half of the shared scope: `trash: 'only'`.)
     */
    const listTrashed = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<NoteRow>`
          SELECT ${sql.literal(NOTE_SELECT)} FROM notes
          WHERE ${visibleScopeSql(sql, input, { trash: 'only' })}
          ORDER BY deleted_at DESC, id ASC
        `,
        rows => rows.map(toNote),
      )

    /** Dashboard pinned section (pinned notes first, then recency). */
    const listPinned = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<NoteRow>`
          SELECT ${sql.literal(NOTE_SELECT)} FROM notes
          WHERE ${visibleScopeSql(sql, input)}
            AND is_pinned = 1
            AND is_archived = 0
          ORDER BY updated_at DESC, id ASC
        `,
        rows => rows.map(toNote),
      )

    const insert = (note: Note) =>
      Effect.map(
        insertStatement<NoteRow>(sql, NOTE_TABLE, {
          values: noteValues(note),
          returning: NOTE_SELECT,
        }),
        rows => toNote(rows[0]!),
      )

    /**
     * Tag-join maintenance is version-gated like the task service's (#36): the
     * statements only touch `item_tags` when the note row carries the exact
     * version/updatedAt this mutation wrote. A lost CAS therefore leaves the
     * join and the denormalized `tag_ids` column in agreement instead of
     * drifting when the whole batch is retried or reports a conflict.
     */
    const detachTagsIfVersion = (input: {
      readonly noteId: NoteId
      readonly version: number
      readonly updatedAt: string
    }) =>
      sql`
        DELETE FROM item_tags
        WHERE item_id = ${input.noteId} AND item_type = 'note'
          AND EXISTS (
            SELECT 1 FROM notes
            WHERE id = ${input.noteId}
              AND version = ${input.version}
              AND updated_at = ${input.updatedAt}
          )
      `

    const attachTagIfVersion = (input: {
      readonly noteId: NoteId
      readonly tagId: TagId
      readonly householdId: string
      readonly createdAt: string
      readonly version: number
      readonly updatedAt: string
    }) =>
      sql`
        INSERT INTO item_tags (item_id, item_type, tag_id, household_id, created_at)
        SELECT ${input.noteId}, 'note', ${input.tagId}, ${input.householdId}, ${input.createdAt}
        WHERE EXISTS (
          SELECT 1 FROM notes
          WHERE id = ${input.noteId}
            AND version = ${input.version}
            AND updated_at = ${input.updatedAt}
        )
        ON CONFLICT DO NOTHING
      `

    const update = (note: Note) =>
      Effect.map(
        updateStatement<NoteRow>(sql, NOTE_TABLE, {
          id: note.id,
          values: noteValues(note),
          returning: NOTE_SELECT,
        }),
        rows => Option.map(Option.fromUndefinedOr(rows[0]), toNote),
      )

    return {
      findById,
      listVisible,
      listActive,
      listTrashed,
      listPinned,
      insert,
      update,
      detachTagsIfVersion,
      attachTagIfVersion,
    }
  }),
}) {}

export const NoteRepoLive = Layer.effect(NoteRepo, NoteRepo.make)
