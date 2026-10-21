# ADR-0003: Notes use a plain-text editor inside the structured-JSON body

- **Status:** Accepted (2026-10-21)
- **Deciders:** Tali owner + developer (wayfinder #40)
- **Related:** tickets #40 (notes), #41 (search), #34 (sync registry), #17 (local store)

## Context

FR-NOTE-01/03 needs quick create, autosave, tags, pin, archive and trash, and
the feature map's backend shape is a Note aggregate whose `body` is a
TipTap/ProseMirror JSON document. Ticket #40 asked for the editor to be verified
under the client-only Solid v2 RC and allowed a plain-text/Markdown fallback
inside the same JSON envelope if the editor library fought the RC.

TipTap has no Solid binding (official packages cover React/Vue/Svelte), and
ProseMirror is a vanilla `EditorView` with its own transaction/reconciliation
model. Mounting it by hand under Solid v2 RC would add a second reactivity
system, a jsdom-hostile test surface, and a large dependency for FR-NOTE-02's
"not a full editor" scope. Meanwhile the sync protocol has a related constraint:
a soft-deleted row is tombstone-wins (#34), so an offline upsert can never
resurrect it.

## Decision

- `Note.body` stays `Schema.Json` and the first editor stores a
  **ProseMirror-shaped paragraph document**:
  `{ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }`.
  Newlines are paragraph boundaries, so plain text/Markdown round-trips and a
  later rich editor reads the same column without a migration.
- The editor is a textarea. `plainText` is derived server-side by walking the
  document's `text` nodes (`extractNotePlainText`), so extraction is identical
  for the fallback and any future rich document.
- Autosave is local-first: a debounced `writeLocal` commits the mirror row and
  outbox entry, and the sync engine pushes it with a version anchor. The
  server's `SaveNote` RPC keeps the same rule for direct callers — identical
  text is a no-op and stale `baseVersion` is a typed `NoteConflict`.
- A crash draft lives in the local store's `drafts` object store keyed by note
  id plus the version the text was based on. On reopen a queued local mutation
  or a draft at/after the mirrored version wins; an older draft loses to newer
  server text.
- **Restore is online-only.** `RestoreNote` runs on the server and the returned
  row is merged into the mirror. A queued local upsert cannot undelete a
  tombstone, so the trash screen flushes the outbox before restoring and says
  so when offline. Offline reading, creating, editing, pinning, archiving,
  tagging and trashing all keep working.

## Consequences

- Quick create is one IndexedDB transaction: the editor opens and accepts text
  in ~100 ms locally, well inside the 2 s acceptance criterion, and no text is
  lost on a sudden close (draft + pagehide flush).
- FR-NOTE-02's full formatting set is not delivered yet; the fallback supports
  plain text and Markdown source. The body column is already in the final shape,
  so a TipTap/ProseMirror editor can land without touching sync, SQL or search.
- Restore needs connectivity, unlike the other note mutations. This is a
  protocol-level property (tombstone-wins), not a UI shortcut; adding a
  dedicated restore op to the sync wire would be the way to lift it.
- Tag assignment writes the denormalized `tag_ids` through the local outbox
  (like tasks) while the service path also maintains the canonical `item_tags`
  join. Search (#41) will read the denormalized `plainText`.
