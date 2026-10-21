-- Tali — 0013: occasions (Slice 3 / ticket #59, FR-CAL-02)
-- Applied out-of-band (D1 has no interactive transactions; Effect's Migrator
-- cannot run here). See README.md.
--
-- Source: docs/domain-model-draft.md §3.4. An occasion carries the common-item
-- sync contract (UUID v7 id, owner + household visibility, ISO-8601 UTC
-- created/updated pair, a server-monotonic per-row version, a nullable
-- deleted_at tombstone) plus its own fields.
--
-- ORIGIN DATE, NOT A RECURRENCE RULE
--   `origin_date` is the one stored local date (`YYYY-MM-DD`) plus the
--   occasion's own IANA `time_zone`. The annual occurrence is derived at read
--   time by projecting the origin's Jalali month/day into each requested
--   Jalali year — no occurrence row and no per-year rule is written. This is
--   why there is no `recurrence` column here: an occasion has no interval,
--   count or end, and the shared RecurrenceRule cannot express "clamp Esfand 30
--   to Esfand 29 in a common year" (it deliberately skips impossible dates).
--
-- YEARLY MARKER
--   `yearly = 1` (the birthday/anniversary default) repeats every Jalali year;
--   `yearly = 0` keeps a one-off important date on its origin date only.
--
-- ADVANCE REMINDER
--   `advance_reminder_days` is an offset (`7` → "seven days before"), expanded
--   by date for the occurrence being read. It is deliberately NOT a reminder
--   row: the Reminder aggregate is ticket #60 and owns its own table. #59
--   exposes `OccasionAdvanceReminder` (a typed draft) so #60 can materialise a
--   reminder with `ReminderLink._tag = 'occasion'` without a second table or a
--   migration here. `NULL` = no advance reminder.
--
-- PREPARATION TASK
--   `preparation_task_id` links the optional "prepare gift" task created from
--   the occasion. It is a normal `tasks` row, so the task aggregate owns its
--   lifecycle and sync. The link is deliberately unenforced (no foreign key):
--   soft-deleted tasks are retained for the 30-day trash window, and an offline
--   client may create the task before the server has the occasion row.
--
-- RESERVED RELATION
--   `events.occasion_id` (migration 0010) points here. It stays a plain TEXT
--   column with no foreign key: a sync pull may deliver the event and the
--   occasion in either order, and a tombstone is retained rather than deleted.
--   The relation is validated by the services that set it, not by SQLite.

CREATE TABLE IF NOT EXISTS occasions (
  id                    TEXT PRIMARY KEY,
  type                  TEXT NOT NULL DEFAULT 'occasion',
  title                 TEXT NOT NULL DEFAULT '',
  owner_id              TEXT NOT NULL,
  household_id          TEXT NOT NULL,
  visibility            TEXT NOT NULL DEFAULT 'shared',
  color                 TEXT,
  -- The origin local date and the zone it is read in.
  origin_date           TEXT NOT NULL,
  time_zone             TEXT NOT NULL DEFAULT 'UTC',
  -- 1 = an annual birthday/anniversary; 0 = a one-off important date.
  yearly                INTEGER NOT NULL DEFAULT 1,
  -- Days before the occurrence to remind; NULL = no advance reminder.
  advance_reminder_days INTEGER,
  -- Optional linked "prepare gift" task (tasks.id).
  preparation_task_id   TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 0,
  deleted_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_occasions_household ON occasions (household_id);
CREATE INDEX IF NOT EXISTS idx_occasions_owner ON occasions (owner_id);
CREATE INDEX IF NOT EXISTS idx_occasions_updated_at ON occasions (updated_at);
-- Month/agenda reads load one household's live dates; the projection needs the
-- origin month/day, so a plain household index is enough. The partial index
-- keeps the "occasions with a reminder" scan small for #60's future use.
CREATE INDEX IF NOT EXISTS idx_occasions_origin ON occasions (household_id, origin_date);
CREATE INDEX IF NOT EXISTS idx_occasions_reminders ON occasions (household_id, advance_reminder_days)
  WHERE advance_reminder_days IS NOT NULL AND deleted_at IS NULL;
