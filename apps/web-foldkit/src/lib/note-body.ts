import { Option, Schema } from 'effect'

import {
  type NoteParagraph,
  type NoteTextDocument,
  type NoteTextNode,
  extractNotePlainText,
  plainTextToNoteBody,
} from '@tali/domain'

/**
 * Note body ⇄ editor text, ported from `apps/web/src/lib/notes/body.ts`.
 *
 * The aggregate's `body` stays structured JSON (the TipTap/ProseMirror slot
 * from the feature map). The first editor is plain text/Markdown because no
 * rich binding exists yet, so a note stores a ProseMirror-shaped paragraph
 * document — the exact shape a later rich editor reads — and switching editors
 * needs no migration:
 *
 *   { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
 *
 * Newlines become paragraph boundaries, so plain-text notes round-trip.
 */

export type { NoteParagraph, NoteTextDocument, NoteTextNode }

export type NoteDocument = NoteTextDocument

export const textToNoteBody = (text: string): NoteDocument =>
  plainTextToNoteBody(text)

/**
 * The fields a note row exposes to the editor. Every field stays encoded, so
 * a row written by an older build still decodes and a malformed field falls
 * back to its display default instead of failing the whole row.
 */
export const NoteData = Schema.Struct({
  title: Schema.optional(Schema.Unknown),
  body: Schema.optional(Schema.Unknown),
  plainText: Schema.optional(Schema.Unknown),
  isPinned: Schema.optional(Schema.Unknown),
  isArchived: Schema.optional(Schema.Unknown),
  tagIds: Schema.optional(Schema.Unknown),
})

export type NoteData = typeof NoteData.Type

export const emptyNoteData = (): NoteData => NoteData.make({})

const NoteTextNodeSchema = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
})

const NoteParagraphSchema = Schema.Struct({
  type: Schema.Literal('paragraph'),
  content: Schema.Array(NoteTextNodeSchema),
})

const NoteTextDocumentSchema = Schema.Struct({
  type: Schema.Literal('doc'),
  content: Schema.Array(NoteParagraphSchema),
})

const asNoteDocument = Schema.decodeUnknownOption(NoteTextDocumentSchema)

const asString = Schema.decodeUnknownOption(Schema.String)

const asStringArray = Schema.decodeUnknownOption(Schema.Array(Schema.String))

/** Text for a paragraph-shaped doc; anything else falls back to extraction. */
export const noteTextFromBody = (body: NoteData['body']): string =>
  Option.match(asNoteDocument(body), {
    onNone: () => extractNotePlainText(body),
    onSome: document =>
      document.content
        .map(paragraph => paragraph.content.map(node => node.text).join(''))
        .join('\n'),
  })

/** The editor's text, preferring the body and falling back to `plainText`. */
export const noteTextFromData = (data: NoteData): string => {
  const text = noteTextFromBody(data.body)

  return text !== ''
    ? text
    : Option.getOrElse(asString(data.plainText), () => '')
}

/** The title exactly as stored, for the editor field (no display fallback). */
export const noteTitleFromData = (data: NoteData): string =>
  Option.getOrElse(asString(data.title), () => '')

/** A display title: the explicit title, else the first non-empty line. */
export const noteDisplayTitle = (
  data: NoteData,
  fallback = 'یادداشت بی‌نام',
): string => {
  const title = noteTitleFromData(data).trim()

  if (title !== '') {
    return title
  }

  const firstLine = noteTextFromData(data)
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '')

  return firstLine === undefined ? fallback : firstLine
}

/** A short, single-line excerpt for the list. */
export const noteExcerpt = (data: NoteData, maxLength = 90): string => {
  const text = noteTextFromData(data).replace(/\s+/g, ' ').trim()

  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength).trimEnd()}…`
}

/** The full text of a note row, as the pinned-note lane shows it. */
export const noteRowText = (data: NoteData): string => noteTextFromData(data)

/** The tags a note carries, ignoring malformed entries. */
export const tagIdsOf = (value: NoteData['tagIds']): ReadonlyArray<string> =>
  Option.getOrElse(asStringArray(value), () => [])
