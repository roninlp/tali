-- Tali — 0011: habits and habit entries (Slice 4 / ticket #63, FR-HAB-01/02)
-- Applied out-of-band (D1 has no interactive transactions; Effect's Migrator
-- cannot run here). See README.md.
--
-- Source: docs/domain-model-draft.md §3.2 and docs/adr/0006-habit-shape.md.
-- A habit carries the common-item sync contract (UUID v7 id, owner +
-- household visibility, ISO-8601 UTC created/updated pair, a server-monotonic
-- per-row version, a nullable deleted_at tombstone) plus its definition.
--
-- FREQUENCY
--   `frequency` is the structured union from §3.2 stored as JSON text:
--     {"_tag":"daily"}
--     {"_tag":"weekdays","days":[1,3,5]}   -- ISO weekdays, 1 = Monday
--     {"_tag":"weekly","times":3}          -- X times per week
--   Never a string like "3x/week": the variants have different fields, and the
--   service + sync registry validate the union on every write.
--
-- FREQUENCY HISTORY
--   `frequency_history` is a JSON array of {effectiveFrom, frequency}, oldest
--   first, each carrying the *local* date that version took effect. The last
--   entry always equals `frequency`. Changing the frequency appends a version
--   instead of rewriting the past, so the stats algorithm (#65) can ask what
--   the habit asked of the user last month. FR-HAB-03's edge case.
--
-- TIME ZONE
--   `time_zone` is the habit's own IANA zone. `reminder_time` is a local
--   `HH:mm`, and the history's effective dates are local dates, so both need
--   the zone on the row (the per-item rule the tasks use). Defaults to the
--   owner's profile zone at creation.
--
-- HABIT ENTRIES
--   A separate table (settled in #7, open question #2): the log is one row per
--   (habit_id, local_date), so a tap is an idempotent upsert and a 7/30/90-day
--   window is one indexed range scan. Entries are deliberately NOT common
--   items — no title, no colour — but they still carry owner_id/household_id/
--   visibility, because /sync/pull filters every synced row through those
--   columns without a join.
--
--   The UNIQUE index covers tombstones too: exactly one row exists per
--   (habit, day) for all time, so #64's upsert revives the tombstoned row in
--   place instead of racing a second insert.

CREATE TABLE IF NOT EXISTS habits (
  id                 TEXT PRIMARY KEY,
  type               TEXT NOT NULL DEFAULT 'habit',
  title              TEXT NOT NULL DEFAULT '',
  description        TEXT,
  icon               TEXT,
  owner_id           TEXT NOT NULL,
  household_id       TEXT NOT NULL,
  visibility         TEXT NOT NULL DEFAULT 'shared',
  color              TEXT,
  -- The structured frequency union (JSON text).
  frequency          TEXT NOT NULL DEFAULT '{"_tag":"daily"}',
  -- Every version of the frequency, oldest first (JSON array).
  frequency_history  TEXT NOT NULL DEFAULT '[]',
  -- Local wall-clock "HH:mm", or NULL for no reminder time.
  reminder_time      TEXT,
  -- The habit's IANA zone (reminder time + history effective dates).
  time_zone          TEXT NOT NULL DEFAULT 'UTC',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 0,
  deleted_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_habits_household ON habits (household_id);
CREATE INDEX IF NOT EXISTS idx_habits_owner ON habits (owner_id);
CREATE INDEX IF NOT EXISTS idx_habits_updated_at ON habits (updated_at);

CREATE TABLE IF NOT EXISTS habit_entries (
  id            TEXT PRIMARY KEY,
  habit_id      TEXT NOT NULL REFERENCES habits (id) ON DELETE CASCADE,
  -- Denormalized for the sync pull filter and per-member reads.
  owner_id      TEXT NOT NULL,
  household_id  TEXT NOT NULL,
  visibility    TEXT NOT NULL DEFAULT 'shared',
  -- The local calendar date this entry logs (YYYY-MM-DD).
  local_date    TEXT NOT NULL,
  -- The zone `local_date` was written in.
  time_zone     TEXT NOT NULL DEFAULT 'UTC',
  -- done | partial | missed
  status        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT
);

-- One log per habit per day, tombstones included (see the header note).
CREATE UNIQUE INDEX IF NOT EXISTS idx_habit_entries_habit_date
  ON habit_entries (habit_id, local_date);
-- The stats/heatmap windows (#65/#66) scan one member's dates, and the Today
-- lane (#66) reads one day across habits.
CREATE INDEX IF NOT EXISTS idx_habit_entries_owner_date
  ON habit_entries (owner_id, local_date);
CREATE INDEX IF NOT EXISTS idx_habit_entries_household_date
  ON habit_entries (household_id, local_date);
CREATE INDEX IF NOT EXISTS idx_habit_entries_updated_at ON habit_entries (updated_at);
