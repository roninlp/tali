import { Schema } from "effect"
import { Visibility } from "../common.js"
import { NoteId, TagIds } from "./common.js"

/**
 * NoteService contract (ticket #40; FR-NOTE-01/03).
 *
 * The service is server-authoritative: timestamps and versions are stamped
 * here, and `clientMutationId` is the replay key the write path dedupes on
 * (`applied_mutations`). Every mutation reuses the #34 one-batch
 * entity/feed/ledger primitives, so a note change is visible to `/sync/pull`
 * at exactly the version the mutation returned.
 *
 * ## Autosave is keyed by version
 *
 * `NoteSaveInput.baseVersion` is the version the editor last saw. The save is
 * applied only when that version is still current. If the server moved on
 * (another device wrote newer text), the call fails with `NoteConflict` and
 * carries the current version, so the editor can reconcile instead of
 * clobbering the newer text. Saving text identical to what is stored is a
 * no-op — repeated autosaves never create duplicate versions — and a replay of
 * the same `clientMutationId` returns the stored row without writing.
 *
 * ## Body shape
 *
 * `body` stays the aggregate's structured-JSON column. The first editor ships
 * a Markdown/plain-text fallback inside that same envelope (a ProseMirror-
 * shaped doc of paragraphs; see `docs`/the #40 resolution), so a later rich
 * editor can read the same column without a migration. `plainText` is always
 * derived server-side when `body` is supplied.
 */

// ── Typed errors (`docs/error-model-draft.md` §2) ────────────────────────

/** The note does not exist, or is not visible to this viewer. */
export class NoteNotFound extends Schema.TaggedError<NoteNotFound>()("NoteNotFound", {
  id: NoteId
}) {}

/** The row exists but this viewer may not read/write it. */
export class NoteForbidden extends Schema.TaggedError<NoteForbidden>()("NoteForbidden", {
  id: Schema.NullOr(Schema.String),
  reason: Schema.Literals(["private", "household", "noHousehold"])
}) {}

/** Field-level validation (foreign/private tag, malformed body, …). */
export class NoteValidationError extends Schema.TaggedError<NoteValidationError>()(
  "NoteValidationError",
  {
    issues: Schema.Array(
      Schema.Struct({
        field: Schema.String,
        message: Schema.String
      })
    )
  }
) {}

/**
 * The autosave's `baseVersion` is behind the stored row. `version` is the
 * current server version, which the client uses to reconcile.
 */
export class NoteConflict extends Schema.TaggedError<NoteConflict>()("NoteConflict", {
  id: NoteId,
  version: Schema.Int
}) {}

/** A trashed note older than the 30-day retention window cannot be restored. */
export class NoteNotRestorable extends Schema.TaggedError<NoteNotRestorable>()(
  "NoteNotRestorable",
  {
    id: NoteId,
    deletedAt: Schema.String
  }
) {}

export const NoteServiceError = Schema.Union([
  NoteNotFound,
  NoteForbidden,
  NoteValidationError,
  NoteConflict,
  NoteNotRestorable
])
export type NoteServiceError = Schema.Schema.Type<typeof NoteServiceError>

// ── FR-NOTE-03: 30-day trash retention (purge job lands with Slice 5) ────

export const NOTE_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// ── Mutation inputs ──────────────────────────────────────────────────────

/**
 * Create is quick: the title is optional and every other field has a benign
 * default, so "new note" is one click and zero form fields.
 */
export const NoteCreateInput = Schema.Struct({
  /** A client may mint the UUID v7 offline; the server mints one otherwise. */
  id: Schema.optional(NoteId),
  clientMutationId: Schema.String,
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.NullOr(Schema.Json)),
  plainText: Schema.optional(Schema.String),
  isPinned: Schema.optional(Schema.Boolean),
  isArchived: Schema.optional(Schema.Boolean),
  tagIds: Schema.optional(TagIds),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  visibility: Schema.optional(Visibility)
})
export type NoteCreateInput = Schema.Schema.Type<typeof NoteCreateInput>

/** Patch-style note fields; omitted fields keep their stored value. */
export const NotePatch = Schema.Struct({
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.NullOr(Schema.Json)),
  plainText: Schema.optional(Schema.String),
  isPinned: Schema.optional(Schema.Boolean),
  isArchived: Schema.optional(Schema.Boolean),
  tagIds: Schema.optional(TagIds),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  visibility: Schema.optional(Visibility)
})
export type NotePatch = Schema.Schema.Type<typeof NotePatch>

export const NoteUpdateInput = Schema.Struct({
  id: NoteId,
  clientMutationId: Schema.String,
  /** Informational; the update re-reads and retries on a lost CAS. */
  baseVersion: Schema.optional(Schema.Int),
  patch: NotePatch
})
export type NoteUpdateInput = Schema.Schema.Type<typeof NoteUpdateInput>

/**
 * The autosave payload: text (and optional title) bound to the version the
 * editor last saw. `body` wins over `plainText`; `plainText` is derived.
 */
export const NoteSaveInput = Schema.Struct({
  id: NoteId,
  clientMutationId: Schema.String,
  baseVersion: Schema.Int,
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.NullOr(Schema.Json))
})
export type NoteSaveInput = Schema.Schema.Type<typeof NoteSaveInput>

/** Only the row id plus the replay key (trash/restore). */
export const NoteMutationInput = Schema.Struct({
  id: NoteId,
  clientMutationId: Schema.String
})
export type NoteMutationInput = Schema.Schema.Type<typeof NoteMutationInput>

/** Idempotent pin/archive set: the target state, not a toggle. */
export const NoteFlagInput = Schema.Struct({
  id: NoteId,
  clientMutationId: Schema.String,
  value: Schema.Boolean
})
export type NoteFlagInput = Schema.Schema.Type<typeof NoteFlagInput>

/** Tag assignment is a full replacement of the note's tag set. */
export const NoteTagInput = Schema.Struct({
  id: NoteId,
  clientMutationId: Schema.String,
  tagIds: TagIds
})
export type NoteTagInput = Schema.Schema.Type<typeof NoteTagInput>

// ── Query inputs ─────────────────────────────────────────────────────────

export const NoteListInput = Schema.Struct({
  /** Chips are an OR filter: a note matches if it carries any listed tag. */
  tagIds: Schema.optional(TagIds),
  /** The archive view; the default list is active notes only. */
  includeArchived: Schema.optional(Schema.Boolean)
})
export type NoteListInput = Schema.Schema.Type<typeof NoteListInput>

// ── Body helpers (shared by the service and the editor) ──────────────────

/**
 * Extract text from a structured note body. It walks the ProseMirror/TipTap
 * `content`/`text` shape, so the current paragraph-doc fallback and a future
 * rich editor both feed `plainText` the same way. FTS Persian normalization
 * stays with #41; this is extraction only.
 */
export const extractNotePlainText = (body: unknown): string => {
  const parts: Array<string> = []
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      parts.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry)
      return
    }
    if (node === null || typeof node !== "object") return
    const record = node as Record<string, unknown>
    if (typeof record.text === "string") parts.push(record.text)
    if (Array.isArray(record.content)) {
      for (const entry of record.content) walk(entry)
    }
  }
  walk(body)
  return parts.join(" ").replace(/\s+/g, " ").trim()
}
