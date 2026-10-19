-- Tali — 0004: Web Push subscriptions (Slice 1 / Foundation, ticket #20)
-- Applied out-of-band (D1 has no interactive transactions; Effect's Migrator
-- cannot run here). See packages/sql/migrations/README.md.
--
-- The dispatch ledger and reminder scheduler land in a later slice; this table
-- only holds the per-device subscription the shell registers.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  expiration_time TEXT,
  user_agent      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- A push endpoint identifies one browser installation; re-registering refreshes
-- the keys in place instead of duplicating the row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint
  ON push_subscriptions (endpoint);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions (user_id);
