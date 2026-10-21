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

## Calendar

### Event

Something that happens at a specific time and shows up on the calendar: an
appointment, a meeting, a trip. An event is **timed** (two UTC instants) or
**all-day** (one local calendar date) — never both — and it carries its own
**Time Zone**, so a device that changes its zone never moves a stored event.

_Avoid:_ "appointment" or "meeting" for the entity itself — those are events.

### Occurrence

One appearance of a recurring event. A recurring event is **one** row; its
occurrences are computed from its recurrence rule by the expansion engine, not
stored. The occurrence's key is its local start date (`YYYY-MM-DD`) in the
event's time zone.

### Exception

A deviation of a single occurrence from its series: `delete` (the occurrence
does not happen) or `override` (it happens, with its own title/time/place).
Exceptions live inside their event's `exceptions` list — "this occurrence
only".

### Occasion

An annual important date (a birthday, an anniversary) that usually needs
preparation. It is not an event: it recurs every year on its own month/day and
events may be created from it.

### Recurrence Rule

The structured rule that makes an event or a task repeat — frequency,
interval, optional by-fields, and an end (never / count / until). It is a
JSON object, **never** an RRULE string: the month and year fields are Jalali,
which string RRULE parsers do not implement. See
[ADR-0004](docs/adr/0004-event-timing-and-exception-storage.md).

## Reminders

### Reminder

A standing intention to tell its owner something at a time — "take your
medication at 08:00", "the bin goes out on Tuesday". It carries a **Tier**
(medication is critical by its kind, never chosen by hand), a **Repeat**, the
next **Fire** instant, a **Reminder Link** to the task/event/habit it is about,
and an optional **Silence**.

_Avoid:_ "notification" for the reminder itself — that is the delivery.

### Fire

One occurrence of a reminder becoming due: the instant `fire_at` passes. A fire
is a fact about the calendar, not about the network; a reminder can fire without
anybody being told.

### Dispatch

One attempt to tell the owner about one **Fire**, recorded as a ledger row
before anything is sent. Its state is *owed*, *done* (a response: done, snooze,
dismiss) or *expired* (nobody could be told usefully). The dispatch ledger, not
the push, is the truth about whether a reminder happened. See
[ADR-0005](docs/adr/0005-reminder-firing.md).

### Claim

Writing the dispatch row that makes a fire *this* sweep's responsibility. One
claim per (reminder, fire instant, origin) is enforced by the ledger's unique
key, so a repeated, late or overlapping sweep cannot notify twice.

### Sweep

The once-a-minute pass that claims every due fire and every owed dispatch, then
lets the policy decide when each one may be delivered. It is a catch-up query
rather than a timer: nothing is scheduled ahead, so nothing is lost when the
Worker is down.

### Overnight Queue

The normal-tier dispatches held back inside 23:00–07:00 in the owner's zone.
They are not a message queue and not a second store: a held dispatch is an owed
dispatch whose **Deliver At** is the end of the window. Medication-tier fires
never enter it.

### Deliver At

The instant a dispatch may actually be pushed, chosen by the policy when the
fire is claimed: the fire instant, the end of quiet hours, or the end of a
**Silence**. The sweep compares one column and asks no further questions.

### Silence

`Reminder.silencedUntil` — the point past which the whole series may fire again.
It is the only way to quiet a medication reminder, and it is a different thing
from a **Snooze**.

### Snooze

"Tell me again in X minutes", for one occurrence only (5, 10, 15, 30 or 60). It
closes the current dispatch as answered `snooze` and opens a new one at
`now + X`; the series' schedule does not move. A snoozed fire ignores quiet
hours — asking again is consent.

### Missed Inbox

The list of dispatches that are due and unanswered — whether or not a push ever
reached a browser. It is derived from the ledger, so "delivered but ignored" and
"browser was closed" land in one place, and nothing leaves it by being deleted:
after 24 hours an unanswered dispatch moves from the inbox view to history.

### On-time

The adherence measure: a dispatch is on-time when it was answered `done` no
later than 30 minutes after its fire instant. Snoozed-then-done is *late*; a
dismiss or an unanswered dispatch is not on-time.

