-- Tali — 0003: offline-first sync engine (Slice 1 / Foundation, ticket #18)
-- Applied out-of-band (D1 has no interactive transactions; Effect's Migrator
-- cannot run here). See packages/sql/migrations/README.md.
--
-- Two monotonic numbers, deliberately separate (docs/sync-protocol-draft.md §2):
--   * `change_feed.seq`   — global, append-only; the pull cursor.
--   * `list_items.version` — per-row; the conflict/CAS anchor.

-- The dummy aggregate now carries the household/visibility metadata the feed
-- filter and conflict resolver need. Defaults keep pre-sync rows harmless.
ALTER TABLE list_items ADD COLUMN household_id TEXT;
ALTER TABLE list_items ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE list_items ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared';

CREATE INDEX IF NOT EXISTS idx_list_items_household ON list_items (household_id);

-- One row per committed mutation, written in the same D1 batch as the entity
-- write. `ownerId`/`visibility` are denormalized so the pull filter is a
-- single-table WHERE (no join), and `household_id` scopes the feed.
CREATE TABLE IF NOT EXISTS change_feed (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  op           TEXT NOT NULL,
  version      INTEGER NOT NULL,
  updated_at   TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  visibility   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_change_feed_household_seq ON change_feed (household_id, seq);
-- Retention window: prune by age (90 days), not by seq (docs/sync-protocol §DP-8).
CREATE INDEX IF NOT EXISTS idx_change_feed_updated_at ON change_feed (updated_at);

-- Exactly-once replay: a retried push (lost response) reuses the stored result
-- instead of applying the mutation twice. Purged with the feed window.
CREATE TABLE IF NOT EXISTS applied_mutations (
  client_mutation_id TEXT PRIMARY KEY,
  household_id       TEXT NOT NULL,
  entity_type        TEXT NOT NULL,
  entity_id          TEXT NOT NULL,
  server_version     INTEGER NOT NULL,
  seq                INTEGER NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_applied_mutations_created_at ON applied_mutations (created_at);
