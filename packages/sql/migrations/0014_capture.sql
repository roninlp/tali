-- Tali — 0014: Capture (ticket #101; ADR-0012)
-- Applied out-of-band (D1 has no interactive transactions; Effect's Migrator
-- cannot run here). See README.md.
--
-- CAPTURE is the server-of-record log of one free-text submission: the text,
-- its lifecycle status, the drafts a Dissect proposed, and the rows a Capture
-- Commit created. It is owner-only and deliberately OUTSIDE the sync
-- machinery: no version, no change_feed row, no partner visibility, exactly
-- like user_preferences under ADR-0002. The raw text of everything a user
-- typed does not belong in the household feed.
--
-- `dedupe_key` is the Persian-folded text. A second identical submission
-- inside 60 seconds returns the existing row instead of paying for another
-- model run (ADR-0012 §9). `created_ids` is the JSON list of rows a commit
-- wrote, so a partial commit can report what landed and a retry can replay the
-- rest.
--
-- Rows are purged after 90 days by the nightly maintenance cron.
CREATE TABLE IF NOT EXISTS capture (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  text         TEXT NOT NULL,
  -- pending | parsed | failed | committed
  status       TEXT NOT NULL DEFAULT 'pending',
  -- JSON array of CaptureDraft values.
  drafts       TEXT NOT NULL DEFAULT '[]',
  -- JSON array of { type, id, title }.
  created_ids  TEXT NOT NULL DEFAULT '[]',
  -- The model/network failure message while status = 'failed'.
  error        TEXT,
  -- The Persian-folded text used by the 60-second dedupe.
  dedupe_key   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  committed_at TEXT
);

-- History reads one owner's captures, newest first.
CREATE INDEX IF NOT EXISTS idx_capture_owner_created
  ON capture (owner_id, created_at DESC);
-- The 60-second identical-text dedupe.
CREATE INDEX IF NOT EXISTS idx_capture_dedupe
  ON capture (owner_id, dedupe_key, created_at);

-- The per-user hourly Dissect window (20 runs/hour). A fixed-window counter
-- shaped exactly like login_attempts: the increment and read are one
-- INSERT ... RETURNING, so concurrent requests serialise on the row.
CREATE TABLE IF NOT EXISTS capture_attempts (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);
