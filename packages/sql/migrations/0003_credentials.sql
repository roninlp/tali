-- Tali — 0003: client-side credentials (Slice 1 / ticket #25, decided in #21)
-- Applied out-of-band; see README.md.
--
-- No account has ever been deployed, so this replaces the interim PBKDF2
-- auth shape instead of migrating rows: the old tables are dropped (including
-- any local PBKDF2 test accounts) and recreated with the credential columns
-- from ADR-0001. The API never stores a password — only a per-user salt and
-- SHA-256(credentialSalt || loginKey).

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS households;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL,
  -- SHA-256(credential_salt || login_key), hex. Never leaves the server.
  credential_verifier TEXT NOT NULL,
  -- 16 random bytes, hex; per user.
  credential_salt     TEXT NOT NULL,
  -- Browser KDF recipe version (1 = argon2id m=19456, t=2, p=1).
  kdf_version         INTEGER NOT NULL DEFAULT 1,
  display_name        TEXT NOT NULL,
  time_zone           TEXT NOT NULL,
  week_start          TEXT NOT NULL DEFAULT 'saturday',
  digits              TEXT NOT NULL DEFAULT 'persian',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_users_email ON users (email);

CREATE TABLE households (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  invite_code TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users (id),
  created_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_households_invite_code ON households (invite_code);

CREATE TABLE memberships (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households (id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  joined_at    TEXT NOT NULL
);

-- Two known users, one household each: a user belongs to at most one household.
CREATE UNIQUE INDEX idx_memberships_user ON memberships (user_id);
CREATE INDEX idx_memberships_household ON memberships (household_id);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_sessions_token ON sessions (token_hash);
CREATE INDEX idx_sessions_user ON sessions (user_id);

-- Fixed-window login limiter (ADR-0001): 5 failures per email+IP per window.
CREATE TABLE login_attempts (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  failures     INTEGER NOT NULL
);

CREATE INDEX idx_login_attempts_window ON login_attempts (window_start);
