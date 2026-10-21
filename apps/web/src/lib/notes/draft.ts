/**
 * Crash-safe note drafts (#40; FR-NOTE-01).
 *
 * The draft lives in the local store's `drafts` object store — a separate
 * IndexedDB store, so it survives a reload or a sudden close even when the
 * debounced mirror write never ran. It records the note version the editor was
 * based on:
 *
 * - If a local mutation for the note is still queued, the draft is the user's
 *   newest intent and wins on reopen.
 * - Otherwise a draft at least as new as the mirrored server version wins.
 * - A draft *older* than the mirrored version loses: a remote edit landed
 *   while this device was closed, and applying the draft would clobber newer
 *   server text.
 */

export interface NoteDraft {
  /** The note version the text was written against. */
  readonly version: number
  readonly text: string
  /** ISO instant, for diagnostics. */
  readonly savedAt: string
}

export type DraftDecision =
  | { readonly apply: true; readonly text: string }
  | { readonly apply: false; readonly reason: "missing" | "empty" | "server-newer" | "unchanged" }

export const noteDraftKey = (noteId: string): string => `note.draft.${noteId}`

export const parseNoteDraft = (raw: string | undefined): NoteDraft | undefined => {
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object") return undefined
    const record = parsed as Record<string, unknown>
    if (
      typeof record.version !== "number" ||
      !Number.isInteger(record.version) ||
      typeof record.text !== "string" ||
      typeof record.savedAt !== "string"
    ) {
      return undefined
    }
    return { version: record.version, text: record.text, savedAt: record.savedAt }
  } catch {
    return undefined
  }
}

export const serializeNoteDraft = (draft: NoteDraft): string => JSON.stringify(draft)

/**
 * Decide what the editor should show after reopening a note. `serverVersion`
 * is the mirror's last server version (0 for a never-synced local note) and
 * `serverText` the text currently rendered from the mirror.
 */
export const reconcileDraft = (input: {
  readonly draft: NoteDraft | undefined
  readonly serverVersion: number
  readonly serverText: string
  readonly hasPending: boolean
}): DraftDecision => {
  const { draft } = input
  if (draft === undefined) return { apply: false, reason: "missing" }
  if (draft.text === "") {
    return { apply: false, reason: input.serverText === "" ? "unchanged" : "empty" }
  }
  if (draft.text === input.serverText) return { apply: false, reason: "unchanged" }
  // A queued mutation is this device's newest intent: the push engine will
  // carry it to the server in FIFO order, so the draft is not stale.
  if (input.hasPending) return { apply: true, text: draft.text }
  if (draft.version >= input.serverVersion) return { apply: true, text: draft.text }
  return { apply: false, reason: "server-newer" }
}
