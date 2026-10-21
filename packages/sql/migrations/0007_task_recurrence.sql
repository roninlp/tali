-- Tali — 0007: task recurrence (Slice 2 / ticket #38, FR-TASK-04)
-- Applied out-of-band (D1 has no interactive transactions). See README.md.
--
-- `recurrence` is the structured rule from docs/domain-model-draft.md §3.3,
-- stored as JSON text: frequency/interval/byDay/byMonthDay/nthWeekday/end.
-- `recurrence_mode` is 'onCompletion' or 'onDueDate'. They are set and cleared
-- together; `NULL, NULL` is a one-off task. Rules are Jalali-semantic (month
-- and year fields), while dates stay ISO in storage.
--
-- `recurrence_parent_id` is the instance that spawned this row. It is what
-- makes next-instance generation exactly-once: a completed instance can have
-- at most one successor, however many times its completion is replayed or
-- undone/re-done. It is an internal bookkeeping column (not part of the sync
-- wire payload) and is NULL for every pre-existing task and for one-off tasks.

ALTER TABLE tasks ADD COLUMN recurrence TEXT;
ALTER TABLE tasks ADD COLUMN recurrence_mode TEXT;
ALTER TABLE tasks ADD COLUMN recurrence_parent_id TEXT;

-- Exactly one next occurrence per completed instance. Partial, so the many
-- NULLs (every non-recurring/one-off row) do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_recurrence_parent
  ON tasks (recurrence_parent_id) WHERE recurrence_parent_id IS NOT NULL;

-- Recurring tasks are a small subset; a partial index keeps the "next due"
-- lookups cheap without carrying the nullable majority.
CREATE INDEX IF NOT EXISTS idx_tasks_recurring_due
  ON tasks (household_id, due_date)
  WHERE recurrence IS NOT NULL AND deleted_at IS NULL;
