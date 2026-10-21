# Tali Glossary

The shared vocabulary for Tali's domain and architecture. Use these terms in
code, issues, tests, and docs. See `docs/adr/` for the decisions behind them.

## Auth

### Password

The human secret typed into a Tali form. It exists only in the browser and is
never sent to the API, logged, or stored anywhere. The UI requires at least 12
characters; there are no composition rules. See
[ADR-0001](docs/adr/0001-client-side-password-kdf.md).

_Avoid:_ using "password" for anything sent over the wire — that is the
**Login Key**.

### Login Key

The browser-derived credential that replaces the password on the wire:
`argon2id(password, KDF Salt, { m: 19456 KiB, t: 2, p: 1, dkLen: 32 })`,
encoded as unpadded base64url (43 characters). It is password-equivalent in
transit, so it only travels over TLS and is never logged. `RegisterInput` and
`LoginInput` carry a `loginKey`, not a password.

### KDF Salt

The deterministic argon2id salt:
`SHA-256("tali:kdf:v1:" + normalizeEmail(email))`. Deterministic so login needs
no pre-login request (and no account-existence probe). It is **not** the
per-user `credentialSalt` stored in D1.

### Credential Verifier

The value stored in `users.credential_verifier`:
`SHA-256(credentialSalt || Login Key)`, hex, compared in constant time. The
per-user random `credentialSalt` (16 bytes, hex) prevents a shared precomputed
table across accounts. A database dump yields nothing replayable as a login.

### Rate limit

The D1 fixed-window counter (`login_attempts`) keyed by normalized email + client
IP: five failed logins per 15 minutes are allowed; the next attempt is answered
with `429 RateLimited` before any credential comparison.

## Preferences

### Display Preferences

The per-user settings in `user_preferences`: **Time Zone** (IANA), **Week
Start** (Saturday/Sunday/Monday), **Digits** (Persian/Latin), **Dashboard
Section Order** (a full permutation of the known dashboard sections), and
**Checked Item Placement** (`bottom`/`inPlace`). The server is the source of
truth; the browser keeps a read-only cache for offline boot. They do **not**
ride the sync outbox. See
[ADR-0002](docs/adr/0002-preferences-server-of-record-local-cache.md).

_Avoid:_ "user settings" for auth/profile fields — those live on `users` and
change through the auth routes.

### Week Start

The first day of the displayed Jalali week: `saturday` (default), `sunday`, or
`monday`. It drives `jalaliWeek()` and the month grid; it is presentation only,
never a date-storage convention.

### Digits

How numerals are displayed: `persian` (default, ۱۲۳) or `latin` (123). Domain
values always stay plain numbers/ISO strings; only rendering localizes them.

