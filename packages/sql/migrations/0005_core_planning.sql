-- Tali — 0005: core-planning schema (Slice 2 / ticket #33)
-- Applied out-of-band (D1 has no interactive transactions; Effect's Migrator
-- cannot run here). See README.md.
--
-- Source: docs/domain-model-draft.md §2–§3. Every aggregate carries the
-- common-item sync contract: UUID v7 id, owner + household visibility, an
-- ISO-8601 UTC created/updated pair, a server-monotonic per-row version, and a
-- nullable deleted_at tombstone. Soft delete is a committed mutation; the
-- 30-day purge is a later job.
--
-- `0003_sync_engine.sql` already added owner_id/visibility/household_id to the
-- scaffold `list_items` table. This migration extends that same table for the
-- real ListItem aggregate instead of creating a parallel one, so the Slice 1
-- sync path keeps working until #34 generalises it.

-- ── Projects (Task.projectId) ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL DEFAULT 'project',
  title        TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  household_id TEXT NOT NULL,
  visibility   TEXT NOT NULL DEFAULT 'shared',
  color        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_household ON projects (household_id);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_id);
CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects (updated_at);

-- ── Tasks ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL DEFAULT 'task',
  title        TEXT NOT NULL,
  description  TEXT,
  owner_id     TEXT NOT NULL,
  household_id TEXT NOT NULL,
  visibility   TEXT NOT NULL DEFAULT 'shared',
  status       TEXT NOT NULL DEFAULT 'todo',
  priority     TEXT NOT NULL DEFAULT 'medium',
  -- Timed due instant (UTC) OR all-day local date + IANA zone. The UI sets one.
  due_at       TEXT,
  due_date     TEXT,
  time_zone    TEXT NOT NULL DEFAULT 'UTC',
  project_id   TEXT REFERENCES projects (id) ON DELETE SET NULL,
  -- Denormalized tag ids (JSON array); item_tags is the source of truth.
  tag_ids      TEXT NOT NULL DEFAULT '[]',
  color        TEXT,
  -- Server-stamped lifecycle transitions (todo → doing → done).
  started_at   TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_household ON tasks (household_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks (owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks (updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks (project_id);
-- Today/overdue/upcoming buckets scan one household and range the local due day
-- or the timed instant; status keeps the live/open filter cheap.
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks (household_id, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON tasks (household_id, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks (household_id, status, due_date);

-- ── Tags (household-scoped vocabulary) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS tags (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL DEFAULT 'tag',
  name         TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  household_id TEXT NOT NULL,
  visibility   TEXT NOT NULL DEFAULT 'shared',
  color        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_tags_household ON tags (household_id);
CREATE INDEX IF NOT EXISTS idx_tags_owner ON tags (owner_id);
-- A tag name is unique among live tags in a household (soft-deleted names
-- may be re-used; the partial index ignores tombstones).
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_household_name
  ON tags (household_id, name) WHERE deleted_at IS NULL;

-- ── item_tags (source of truth for assignments) ───────────────────────────

CREATE TABLE IF NOT EXISTS item_tags (
  item_id      TEXT NOT NULL,
  item_type    TEXT NOT NULL,
  tag_id       TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  household_id TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (item_id, item_type, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags (tag_id);
CREATE INDEX IF NOT EXISTS idx_item_tags_item ON item_tags (item_type, item_id);
CREATE INDEX IF NOT EXISTS idx_item_tags_household ON item_tags (household_id);

-- ── Lists ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lists (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL DEFAULT 'list',
  title             TEXT NOT NULL,
  description       TEXT,
  owner_id          TEXT NOT NULL,
  household_id      TEXT NOT NULL,
  visibility        TEXT NOT NULL DEFAULT 'shared',
  color             TEXT,
  icon              TEXT,
  sort              TEXT NOT NULL DEFAULT 'manual',
  checked_placement TEXT NOT NULL DEFAULT 'bottom',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 0,
  deleted_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_lists_household ON lists (household_id);
CREATE INDEX IF NOT EXISTS idx_lists_owner ON lists (owner_id);
CREATE INDEX IF NOT EXISTS idx_lists_updated_at ON lists (updated_at);

-- ── List items: extend the scaffold table, do not fork it ─────────────────
--
-- New columns are nullable/defaulted so the Slice 1 rows (title/checked/
-- sort_order) stay readable by the old repo. The real repo writes both sets
-- until #34/#39 retire the scaffold columns.

ALTER TABLE list_items ADD COLUMN list_id TEXT;
ALTER TABLE list_items ADD COLUMN name TEXT;
ALTER TABLE list_items ADD COLUMN done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE list_items ADD COLUMN ordering INTEGER NOT NULL DEFAULT 0;
ALTER TABLE list_items ADD COLUMN checked_at TEXT;
ALTER TABLE list_items ADD COLUMN color TEXT;
ALTER TABLE list_items ADD COLUMN tag_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE list_items ADD COLUMN type TEXT NOT NULL DEFAULT 'listItem';

-- Backfill the real columns from the scaffold ones; the legacy repo keeps
-- writing title/checked/sort_order, so this stays harmless for those rows.
UPDATE list_items SET name = title WHERE name IS NULL;
UPDATE list_items SET done = checked WHERE checked != 0;
UPDATE list_items SET ordering = sort_order WHERE ordering = 0;

CREATE INDEX IF NOT EXISTS idx_list_items_owner ON list_items (owner_id);
-- Manual ordering within a list: the list screen reads (list_id, ordering).
CREATE INDEX IF NOT EXISTS idx_list_items_list_order ON list_items (list_id, ordering);
CREATE INDEX IF NOT EXISTS idx_list_items_checked_at ON list_items (list_id, checked_at);

-- ── Notes ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL DEFAULT 'note',
  title        TEXT NOT NULL DEFAULT '',
  -- TipTap/ProseMirror document as JSON text; plain_text is normalized for FTS.
  body         TEXT,
  plain_text   TEXT NOT NULL DEFAULT '',
  owner_id     TEXT NOT NULL,
  household_id TEXT NOT NULL,
  visibility   TEXT NOT NULL DEFAULT 'shared',
  is_pinned    INTEGER NOT NULL DEFAULT 0,
  is_archived  INTEGER NOT NULL DEFAULT 0,
  tag_ids      TEXT NOT NULL DEFAULT '[]',
  color        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_household ON notes (household_id);
CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes (owner_id);
CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes (updated_at);
-- Pinned dashboard section and archive view are household-scoped.
CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes (household_id, is_pinned, updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_archived ON notes (household_id, is_archived, updated_at);
