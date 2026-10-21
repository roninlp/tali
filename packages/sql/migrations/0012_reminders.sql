-- Tali — 0012: reminders + dispatch ledger (Slice 3 / ticket #60; FR-REM-01/03)
-- Applied out-of-band (D1 has no interactive transactions; Effect's Migrator
-- cannot run here). See README.md.
--
-- Source of truth: ADR-0005 (firing mechanism) and
-- docs/domain-model-draft.md §3.6. #60 lands the aggregate, the policy and the
-- ledger; the per-minute sweep and Web Push dispatch are #61 and add no column
-- here.
--
-- REMINDERS
--   The common-item sync contract (UUID v7 id, owner + household visibility,
--   ISO-8601 created/updated pair, per-row version, nullable deleted_at)
--   plus the scheduling fields. `tier` is DERIVED from `kind` at write time
--   (medication → critical), never chosen by hand. `fire_at` is the only
--   scheduling state: it is the next fire instant, derived by the service from
--   `repeat` and the linked item's instant. `silenced_until` pauses the series
--   ("silence until date"); it is distinct from a snooze, which lives on the
--   dispatch row.
--
-- REMINDER_DISPATCHES (the ledger)
--   One row per claim, never deleted. The row is the mutex: the unique key
--   (reminder_id, scheduled_for, origin) makes an overlapping or repeated tick
--   converge on one claim (ADR-0005 §3). `origin` is 'schedule' or
--   'snooze:<parentDispatchId>'; `root_scheduled_for` preserves the original
--   fire across snoozes so the on-time metric does not reset.
--   `push_outcome` records what the push service answered — `accepted` means
--   accepted, not delivered — and the response columns are the permanent
--   history FR-REM-03 requires.
--
--   The parent's snooze child is at most one per parent (partial unique index),
--   so a double tap cannot queue two re-fires.

CREATE TABLE IF NOT EXISTS reminders (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL DEFAULT 'reminder',
  title           TEXT NOT NULL,
  note            TEXT,
  owner_id        TEXT NOT NULL,
  household_id    TEXT NOT NULL,
  visibility      TEXT NOT NULL DEFAULT 'shared',
  color           TEXT,
  -- medication / exercise / chore / general
  kind            TEXT NOT NULL DEFAULT 'general',
  -- normal / critical (critical = medication; derived from kind at write time)
  tier            TEXT NOT NULL DEFAULT 'normal',
  -- Structured repeat union (JSON text): once / daily / weekly / interval.
  repeat          TEXT NOT NULL,
  -- Lead time before a linked item's instant, in minutes.
  offset_minutes  INTEGER NOT NULL DEFAULT 0,
  -- The next fire instant (UTC ISO-8601); the only scheduling state.
  fire_at         TEXT NOT NULL,
  -- The ReminderLink union, flattened: 'none' | 'habit' | 'task' | 'event'.
  link_type       TEXT NOT NULL DEFAULT 'none',
  link_id         TEXT,
  -- Series-level silence ("silence until"); NULL means not silenced.
  silenced_until  TEXT,
  -- The IANA zone the repeat's local HH:mm is read in.
  time_zone       TEXT NOT NULL DEFAULT 'UTC',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT
);

-- The sweep's due query: `fire_at <= scheduledTime` over live rows (#61).
CREATE INDEX IF NOT EXISTS idx_reminders_fire_at
  ON reminders (fire_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_household ON reminders (household_id);
CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders (owner_id);
CREATE INDEX IF NOT EXISTS idx_reminders_updated_at ON reminders (updated_at);

CREATE TABLE IF NOT EXISTS reminder_dispatches (
  id                  TEXT PRIMARY KEY,
  reminder_id         TEXT NOT NULL REFERENCES reminders (id) ON DELETE CASCADE,
  -- The owner whose subscribed devices should receive it.
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The claimed fire instant.
  scheduled_for       TEXT NOT NULL,
  -- The policy's deliver-at (quiet-hours hold / snooze target).
  deliver_at          TEXT NOT NULL,
  -- The original fire instant; unchanged across snooze children.
  root_scheduled_for  TEXT NOT NULL,
  -- 'schedule' or 'snooze:<parentDispatchId>'.
  origin              TEXT NOT NULL DEFAULT 'schedule',
  -- pending / accepted / failed / expired
  push_outcome        TEXT NOT NULL DEFAULT 'pending',
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_attempt_at     TEXT,
  parent_dispatch_id  TEXT,
  -- done / snooze / dismiss; NULL until answered.
  response            TEXT,
  responded_at        TEXT,
  snoozed_until       TEXT,
  created_at          TEXT NOT NULL
);

-- The claim mutex (ADR-0005 §3): one row per fire, per origin.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_dispatches_fire
  ON reminder_dispatches (reminder_id, scheduled_for, origin);
-- At most one snooze child per parent dispatch (a double tap is a no-op).
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_dispatches_parent
  ON reminder_dispatches (parent_dispatch_id) WHERE parent_dispatch_id IS NOT NULL;
-- The sweep's owed query: unanswered, retryable, deliver-at arrived.
CREATE INDEX IF NOT EXISTS idx_reminder_dispatches_owed
  ON reminder_dispatches (response, push_outcome, deliver_at);
-- The inbox query: one owner's unanswered rows by fire instant.
CREATE INDEX IF NOT EXISTS idx_reminder_dispatches_inbox
  ON reminder_dispatches (user_id, response, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_reminder_dispatches_reminder
  ON reminder_dispatches (reminder_id, scheduled_for);
