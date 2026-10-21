import { textToNoteBody } from "./body"
import { noteDraftKey, parseNoteDraft } from "./draft"
import type { LocalStore } from "../local-store/types"

/**
 * Debounced-autosave target for one note (#40; FR-NOTE-01).
 *
 * Autosave is local-first: the mutation commits to the IndexedDB mirror and
 * the outbox in one transaction, then the sync engine pushes it. So autosave
 * works offline and survives a crash — and the server-side `SaveNote` keeps
 * the version rule (identical text is a no-op, stale text conflicts) for any
 * caller that goes straight to RPC.
 *
 * The saver dedupes identical saves locally too. Without that, a timer that
 * fires twice would queue two outbox entries for the same text, minting two
 * server versions for one edit. Saves are serialized so a slow IndexedDB
 * transaction cannot overtake the next one.
 */

export interface NoteText {
  readonly title: string
  readonly text: string
}

export type NoteSaveOutcome = "saved" | "unchanged"

export interface NoteSaver {
  readonly lastSaved: () => NoteText
  /** Commit the current text/title; identical input is a no-op. */
  readonly save: (input: NoteText) => Promise<NoteSaveOutcome>
  /**
   * Record a title that was already persisted to the mirror by a direct patch.
   * Without this, the next body autosave would treat the (stale) baseline
   * title as a change and mint a duplicate version for an unchanged note.
   */
  readonly markTitleSaved: (title: string) => void
}

export const createNoteSaver = (
  store: LocalStore,
  noteId: string,
  initial: NoteText
): NoteSaver => {
  let saved: NoteText = { title: initial.title, text: initial.text }
  let queue: Promise<unknown> = Promise.resolve()

  const save = (input: NoteText): Promise<NoteSaveOutcome> => {
    const run = async (): Promise<NoteSaveOutcome> => {
      if (input.title === saved.title && input.text === saved.text) return "unchanged"
      await store.writeLocal({
        entityType: "note",
        entityId: noteId,
        op: "upsert",
        patch: {
          title: input.title,
          body: textToNoteBody(input.text),
          plainText: input.text
        }
      })
      saved = { title: input.title, text: input.text }
      // The mirror now holds this text durably, so the draft for it is
      // redundant. But a keystroke typed while this save was in flight wrote a
      // newer draft: clearing that unconditionally would lose it on a sudden
      // close. Only drop a draft that matches what we just committed.
      try {
        const draft = parseNoteDraft(await store.readDraft(noteDraftKey(noteId)))
        if (draft === undefined || draft.text === input.text) {
          await store.clearDraft(noteDraftKey(noteId))
        }
      } catch {
        // The mirror write already committed; a draft-read failure must not
        // turn a successful save into a failure (or delete the draft).
      }
      return "saved"
    }
    const next = queue.then(run, run)
    // Keep the chain alive even when a save rejects.
    queue = next.catch(() => undefined)
    return next
  }

  return {
    lastSaved: () => saved,
    save,
    markTitleSaved: (title) => {
      saved = { title, text: saved.text }
    }
  }
}
