-- Tali — 0001: list_items (dummy aggregate for the scaffold round-trip)
-- Applied out-of-band (D1 has no interactive transactions; Effect's Migrator
-- cannot run here). See packages/sql/migrations/README.md.

CREATE TABLE IF NOT EXISTS list_items (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  checked    INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_list_items_updated_at ON list_items (updated_at);
