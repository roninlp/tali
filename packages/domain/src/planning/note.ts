import { Schema } from "effect"
import { Model } from "effect/schema"
import { Visibility } from "../common.js"
import { commonItemFields, NoteId, TagIds } from "./common.js"

/**
 * `Note` aggregate (FR-NOTE-01/03, docs/domain-model-draft.md §3.7).
 *
 * `body` is the TipTap/ProseMirror document as structured JSON, not an HTML
 * string. `plainText` is the Persian-normalized extraction written alongside
 * it so full-text search (#41) never has to walk the document at query time.
 * Trash is a soft delete (`deletedAt`) with a 30-day purge.
 */
export class Note extends Model.Class<Note>("Note")({
  ...commonItemFields("note", NoteId),
  title: Schema.String,
  body: Schema.NullOr(Schema.Json),
  /** Extracted text, normalized at write time for FTS + snippets. */
  plainText: Schema.String,
  isPinned: Schema.Boolean,
  isArchived: Schema.Boolean,
  /** Denormalized tag ids; `item_tags` remains the source of truth. */
  tagIds: TagIds
}) {}

export const NoteCreate = Schema.Struct({
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.NullOr(Schema.Json)),
  plainText: Schema.optional(Schema.String),
  isPinned: Schema.optional(Schema.Boolean),
  isArchived: Schema.optional(Schema.Boolean),
  tagIds: Schema.optional(TagIds),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  visibility: Schema.optional(Visibility)
})
export type NoteCreate = Schema.Schema.Type<typeof NoteCreate>
