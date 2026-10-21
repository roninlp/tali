-- Tali — 0010: events (Slice 3 / ticket #57, FR-CAL-01)
-- Applied out-of-band (D1 has no interactive transactions; Effect's Migrator
-- cannot run here). See README.md.
--
-- Source: docs/domain-model-draft.md §3.3. An event carries the common-item
-- sync contract (UUID v7 id, owner + household visibility, ISO-8601 UTC
-- created/updated pair, a server-monotonic per-row version, a nullable
-- deleted_at tombstone) plus its own fields.
--
-- TIMING
--   An event is EITHER timed (start_at/end_at, UTC instants) OR all-day
--   (all_day_date, a local calendar date). The two shapes never coexist, so
--   the columns are nullable and the union is enforced by the domain model
--   and the service, not by the table.
--   `time_zone` is the event's own IANA zone (the per-item rule the tasks
--   use): it makes the all-day date unambiguous and keeps a timed event
--   stable when a device changes its zone.
--
-- RECURRENCE
--   `recurrence` is the structured rule from §3.3 (frequency/interval/byDay/
--   byMonthDay/nthWeekday/end) stored as JSON text — never an RRULE string,
--   because the month/year fields are Jalali. NULL means a one-off event.
--
-- EXCEPTIONS
--   `exceptions` holds the per-occurrence deviations of a recurring series
--   ("this occurrence only"): a JSON array of {id, instanceId, action,
--   overrides, createdAt}. The list lives in the event row on purpose — one
--   series, one row — so an occurrence edit and its series cannot disagree.
--   The expansion engine (#58) reads it without a second query.
--
-- RESERVED RELATIONS
--   `occasion_id` points at the annual date an event comes from (ticket #59).
--   There is deliberately NO foreign key yet: the `occasions` table does not
--   exist until #59, and a foreign key to a missing table makes every insert
--   fail. The column is plain TEXT; #59 owns the table and the constraint
--   decision. The reminder link (ticket #60) lives on the reminder row and
--   needs nothing here.

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL DEFAULT 'event',
  title         TEXT NOT NULL DEFAULT '',
  description   TEXT,
  location      TEXT,
  -- Free-text category label ("work", "family", "health", …).
  category      TEXT,
  -- People involved, by name (JSON array).
  people        TEXT NOT NULL DEFAULT '[]',
  owner_id      TEXT NOT NULL,
  household_id  TEXT NOT NULL,
  visibility    TEXT NOT NULL DEFAULT 'shared',
  color         TEXT,
  -- Timed instants (UTC) OR an all-day local date — never both.
  start_at      TEXT,
  end_at        TEXT,
  all_day_date  TEXT,
  -- The event's IANA zone.
  time_zone     TEXT NOT NULL DEFAULT 'UTC',
  -- Structured recurrence rule (JSON text); NULL for a one-off event.
  recurrence    TEXT,
  -- Per-occurrence exceptions (JSON array).
  exceptions    TEXT NOT NULL DEFAULT '[]',
  -- Reserved relation to an annual occasion (#59).
  occasion_id   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_household ON events (household_id);
CREATE INDEX IF NOT EXISTS idx_events_owner ON events (owner_id);
CREATE INDEX IF NOT EXISTS idx_events_updated_at ON events (updated_at);
-- The calendar reads one household over a date range: timed rows by their
-- instant, all-day rows by their local date.
CREATE INDEX IF NOT EXISTS idx_events_start_at ON events (household_id, start_at);
CREATE INDEX IF NOT EXISTS idx_events_all_day ON events (household_id, all_day_date);
-- The recurrence engine expands a series from its anchor, which may sit
-- months before the requested range, so the live recurring rows need their
-- own cheap index.
CREATE INDEX IF NOT EXISTS idx_events_recurring ON events (household_id, all_day_date)
  WHERE recurrence IS NOT NULL AND deleted_at IS NULL;
