import { textToNoteBody } from "./body"
import { noteDraftKey } from "./draft"
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
      // The mirror now holds the text durably; the draft is redundant.
      await store.clearDraft(noteDraftKey(noteId))
      return "saved"
    }
    const next = queue.then(run, run)
    // Keep the chain alive even when a save rejects.
    queue = next.catch(() => undefined)
    return next
  }

  return {
    lastSaved: () => saved,
    save
  }
}
