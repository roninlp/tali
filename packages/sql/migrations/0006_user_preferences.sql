-- Tali — 0006: per-user display preferences (Slice 2 / ticket #35)
-- Applied out-of-band (D1 has no interactive transactions; Effect's Migrator
-- cannot run here). See README.md.
--
-- One row per user, keyed by `user_id`. These are not syncable common items:
-- the server is the source of truth and the browser keeps a read-only cache
-- for offline boot (docs/adr/0002-preferences-server-of-record-local-cache.md).
-- Auth/professional-profile fields stay on `users`; this table only carries
-- the Slice 2 display choices, so a missing row is a valid "use defaults".
--
-- `dashboard_section_order` is a JSON array of section ids in display order;
-- the API validates it as a full permutation before storing it.

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id                 TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  time_zone               TEXT NOT NULL,
  week_start              TEXT NOT NULL DEFAULT 'saturday',
  digits                  TEXT NOT NULL DEFAULT 'persian',
  dashboard_section_order TEXT NOT NULL
    DEFAULT '["tasks","events","reminders","habits","notes"]',
  checked_item_placement  TEXT NOT NULL DEFAULT 'bottom',
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
