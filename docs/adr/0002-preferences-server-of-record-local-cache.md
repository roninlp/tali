# ADR-0002: Preferences are server-of-record with a local read cache

- **Status:** Accepted (2026-10-21)
- **Deciders:** Tali owner + developer (wayfinder #35)
- **Related:** tickets #17 (local store/outbox), #33 (Slice 2 schema), #35

## Context

Slice 2 adds per-user display preferences: IANA time zone, week start (Saturday
by default), digit style (Persian by default), dashboard section order, and the
default placement of checked list items. The dashboard must render them, and an
offline reload must still show the last-known week start and numerals instead
of flashing back to defaults.

All other user-facing data in Tali is local-first: `writeLocal()` writes the
IndexedDB mirror row **and** a queued sync mutation in one transaction, and the
sync engine later pushes the outbox. That is the right model when either device
may create or edit rows offline and conflicts are resolved per field.

Preferences are different in three ways:

1. **One row per user, last-writer-wins by design.** There is no mergeable
   structure worth a per-field conflict engine.
2. **They are settings, not content.** A stale offline change silently
   reverting the other device's explicit choice is worse than an inline error.
3. **The client needs the value at boot, before any network round trip.** A
   synchronous cache is required; an IndexedDB outbox is not.

## Decision

The server is the **source of truth** for preferences and the browser keeps a
**read-only cache** of the last server-confirmed values.

- `GET /preferences` returns the stored row, or the defaults (profile time
  zone, Saturday, Persian digits, default dashboard order, checked items at the
  bottom). A read never creates a row.
- `PATCH /preferences` merges a typed partial patch into the current values and
  writes one upsert. It is online-only: a failure is shown in settings and the
  cache keeps the last confirmed value.
- The browser caches the response synchronously in `localStorage`
  (`tali.preferences.v1.<userId>`, `apps/web/src/lib/preferences-cache.ts`) —
  the `session-cache` convention — and the `PreferencesProvider` adopts it
  before the network settles, so `/today` can render the saved week start and
  digits on an offline boot.
- **Preferences never enter the sync outbox** (`writeLocal`/`SyncPushEntry`)
  and are not part of the change feed. There is no `version`/`deletedAt`
  contract on the table.
- Auth/profile fields stay on `users`; `user_preferences` holds only these
  display choices, so removing a row safely falls back to defaults.

## Consequences

- Offline boot renders correctly; offline editing of preferences is a surfaced
  error, not a queue.
- Two devices converge through an explicit PATCH, with no conflict-resolution
  code (and no risk of a stale preference overwriting a newer one at push).
- A settings change on one device reaches the other on its next boot/refresh,
  not through the 3.5 s sync poll. Acceptable for display settings; revisit if
  live preference sync ever becomes a product requirement.
- The cache is per-user and can outlive a sign-out (like the mirror), so a
  signed-out user's display settings are never shown to the other account.
