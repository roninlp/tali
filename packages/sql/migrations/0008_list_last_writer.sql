-- Tali — 0008: list "updated by" attribution (Slice 2 / ticket #39, FR-LIST-03)
-- Applied out-of-band (D1 has no interactive transactions). See README.md.
--
-- `change_feed.owner_id` is the row's *owner* (creator) because pull filters on
-- it; it deliberately does not change when the other household member edits.
-- The list screen needs the actual last writer for its subtle "updated by"
-- label, so both list rows carry a server-stamped writer id. It is set on
-- every committed mutation in the same D1 batch as the entity/feed/ledger.
--
-- The column is not client-writable (the sync allowlist never exposes it), and
-- nullable so every pre-existing row remains valid.

ALTER TABLE lists ADD COLUMN last_writer_id TEXT;
ALTER TABLE list_items ADD COLUMN last_writer_id TEXT;
