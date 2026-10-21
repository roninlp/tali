-- Tali — 0009: note full-text search (Slice 2 / ticket #41)
--
-- D1 ships SQLite's FTS5 module, but none of its tokenizers understand
-- Persian: `unicode61` treats the half-space (ZWNJ) and the harakat as
-- separators, and it spells yeh and kaf two ways (`ي`/`ی`, `ك`/`ک`), so a
-- note written in one spelling is invisible to the other. D1 has no
-- custom-tokenizer escape hatch either (that is C-only), so the folding
-- happens in application code — `packages/domain/src/persian.ts` — and the
-- server stores the folded text in the index.
--
-- `notes_fts` is a **standalone** FTS5 table: it keeps its own copy of the
-- folded title and body, so `snippet()`/`highlight()` read exactly the text
-- that was tokenized and the offsets always line up. (The alternative — an
-- external-content table over `notes` — would index the *raw* text, because
-- FTS5 reads the content table's columns, and would lose the folding
-- entirely.)
--
-- `note_id` is UNINDEXED: it is the join key back to `notes` and the key the
-- write path deletes on, never a searchable term.
--
-- `prefix = '1 2 3'` gives the prefix index the type-ahead needs, so `دار`
-- already finds `دارو`.

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id UNINDEXED,
  search_title,
  search_body,
  tokenize = "unicode61 remove_diacritics 2",
  prefix = '1 2 3'
);

-- Backfill for the rows that already exist: the exact text is indexed, so
-- those notes are findable by their own spelling. Every later write re-indexes
-- the row with the folded text (the server owns the folding), so the folded
-- spelling takes over from here on.
INSERT INTO notes_fts (note_id, search_title, search_body)
SELECT id, title, plain_text FROM notes WHERE deleted_at IS NULL;
