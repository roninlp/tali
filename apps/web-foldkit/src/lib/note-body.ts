import { Array, Option } from 'effect'

import {
  extractNotePlainText,
  plainTextToNoteBody,
  type NoteParagraph,
  type NoteTextDocument,
  type NoteTextNode,
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

const blockText = (block: unknown): Option.Option<string> => {
  if (block === null || typeof block !== 'object') {
    return Option.none()
  }

  const content = Reflect.get(block, 'content')
  if (Array.isArray(content)) {
    return Option.some(
      content
        .map(node =>
          node !== null &&
          typeof node === 'object' &&
          typeof Reflect.get(node, 'text') === 'string'
            ? String(Reflect.get(node, 'text'))
            : '',
        )
        .join(''),
    )
  }

  return Option.none()
}

/** Text for a paragraph-shaped doc; anything else falls back to extraction. */
export const noteTextFromBody = (body: unknown): string => {
  if (body === null || body === undefined) {
    return ''
  }

  if (typeof body !== 'object' || Array.isArray(body)) {
    return extractNotePlainText(body)
  }

  const content = Reflect.get(body, 'content')
  if (!Array.isArray(content)) {
    return extractNotePlainText(body)
  }

  const lines = content.map(block =>
    Option.getOrElse(blockText(block), () => ''),
  )
  const hasUnrepresentableBlock = content.some(
    block =>
      block !== null &&
      typeof block === 'object' &&
      !Array.isArray(Reflect.get(block, 'content')) &&
      typeof Reflect.get(block, 'text') === 'string',
  )
  const joined = lines.join('\n')

  return hasUnrepresentableBlock && joined.trim() === ''
    ? extractNotePlainText(body)
    : joined
}

/** The editor's text, preferring the body and falling back to `plainText`. */
export const noteTextFromData = (
  data: Readonly<Record<string, unknown>>,
): string => {
  const text = noteTextFromBody(data.body)

  return text !== ''
    ? text
    : typeof data.plainText === 'string'
      ? data.plainText
      : ''
}

/** The title exactly as stored, for the editor field (no display fallback). */
export const noteTitleFromData = (
  data: Readonly<Record<string, unknown>>,
): string => (typeof data.title === 'string' ? data.title : '')

/** A display title: the explicit title, else the first non-empty line. */
export const noteDisplayTitle = (
  data: Readonly<Record<string, unknown>>,
  fallback = 'یادداشت بی‌نام',
): string => {
  const title = typeof data.title === 'string' ? data.title.trim() : ''

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
export const noteExcerpt = (
  data: Readonly<Record<string, unknown>>,
  maxLength = 90,
): string => {
  const text = noteTextFromData(data).replace(/\s+/g, ' ').trim()

  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength).trimEnd()}…`
}

/** The full text of a note row, as the pinned-note lane shows it. */
export const noteRowText = (data: Readonly<Record<string, unknown>>): string =>
  noteTextFromData(data)

/** The tags a note carries, ignoring malformed entries. */
export const tagIdsOf = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? Array.filter(value, (entry): entry is string => typeof entry === 'string')
    : []
