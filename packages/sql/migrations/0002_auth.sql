-- Tali — 0002: auth & shared space (Slice 1 / Foundation, ticket #15)
-- Applied out-of-band (D1 has no interactive transactions; Effect's Migrator
-- cannot run here). See packages/sql/migrations/README.md.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  time_zone     TEXT NOT NULL,
  week_start    TEXT NOT NULL DEFAULT 'saturday',
  digits        TEXT NOT NULL DEFAULT 'persian',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email);

CREATE TABLE IF NOT EXISTS households (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  invite_code TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_households_invite_code ON households (invite_code);

CREATE TABLE IF NOT EXISTS memberships (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL,
  joined_at    TEXT NOT NULL
);

-- Two known users, one household each: a user belongs to at most one household.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_user ON memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_household ON memberships (household_id);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
