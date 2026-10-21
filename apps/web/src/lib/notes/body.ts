import { extractNotePlainText } from "@tali/domain"

/**
 * Note body ⇄ editor text for the #40 fallback editor.
 *
 * The aggregate's `body` stays structured JSON (the TipTap/ProseMirror slot
 * from the feature map). The first editor is plain text/Markdown because no
 * Solid v2 binding exists for TipTap and mounting ProseMirror by hand would
 * add a second reactivity model to the RC shell. The fallback therefore stores
 * a ProseMirror-shaped paragraph document — the exact shape a later rich
 * editor reads — so switching editors needs no migration:
 *
 *   { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
 *
 * Newlines become paragraph boundaries, so plain-text notes round-trip.
 */

export interface NoteTextNode {
  readonly type: "text"
  readonly text: string
}

export interface NoteParagraph {
  readonly type: "paragraph"
  readonly content: ReadonlyArray<NoteTextNode>
}

export interface NoteDocument {
  readonly type: "doc"
  readonly content: ReadonlyArray<NoteParagraph>
}

const EMPTY_DOCUMENT: NoteDocument = { type: "doc", content: [] }

export const textToNoteBody = (text: string): NoteDocument => {
  if (text === "") return EMPTY_DOCUMENT
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line === "" ? [] : [{ type: "text", text: line }]
    }))
  }
}

/** Text for a paragraph-shaped doc; anything else falls back to extraction. */
export const noteTextFromBody = (body: unknown): string => {
  if (body === null || body === undefined) return ""
  if (typeof body === "object" && !Array.isArray(body)) {
    const content = (body as { content?: unknown }).content
    if (Array.isArray(content)) {
      const lines: Array<string> = []
      // A block-shaped node (paragraph/list item/heading) is one editor line,
      // even when it is empty. Anything else (a bare text node, a hard break)
      // is not representable in the textarea, so fall back to the shared
      // extractor rather than silently dropping its text.
      let unrepresentable = false
      for (const block of content) {
        if (block === null || typeof block !== "object") {
          lines.push("")
          continue
        }
        const nodes = (block as { content?: unknown }).content
        const text = (block as { text?: unknown }).text
        if (Array.isArray(nodes)) {
          lines.push(
            nodes
              .map((node) =>
                node !== null && typeof node === "object" && typeof (node as { text?: unknown }).text === "string"
                  ? (node as { text: string }).text
                  : ""
              )
              .join("")
          )
          continue
        }
        if (typeof text === "string") unrepresentable = true
        lines.push("")
      }
      const joined = lines.join("\n")
      // Whitespace-only text is still the user's text: preserve it exactly.
      // Only an unrepresentable doc shape (which yields nothing readable) uses
      // the extractor, and never at the cost of blank-line round-tripping.
      if (unrepresentable && joined.trim() === "") return extractNotePlainText(body)
      return joined
    }
  }
  return extractNotePlainText(body)
}

/** The editor's text, preferring the body and falling back to `plainText`. */
export const noteTextFromData = (data: Readonly<Record<string, unknown>>): string => {
  const text = noteTextFromBody(data.body)
  if (text !== "") return text
  return typeof data.plainText === "string" ? data.plainText : ""
}

/** A display title: the explicit title, else the first non-empty line. */
export const noteDisplayTitle = (
  data: Readonly<Record<string, unknown>>,
  fallback = "یادداشت بی‌نام"
): string => {
  const title = typeof data.title === "string" ? data.title.trim() : ""
  if (title !== "") return title
  const firstLine = noteTextFromData(data)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "")
  return firstLine === undefined ? fallback : firstLine
}

/** A short, single-line excerpt for the list. */
export const noteExcerpt = (
  data: Readonly<Record<string, unknown>>,
  maxLength = 90
): string => {
  const text = noteTextFromData(data).replace(/\s+/g, " ").trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength).trimEnd()}…`
}
