# ADR-0006: A habit is a definition with a versioned frequency; a day's log is a separate row

- **Status:** Accepted (2026-10-21)
- **Deciders:** Tali owner + developer (wayfinder #63)
- **Related:** tickets #63 (habit aggregate), #64 (daily logging/backfill), #65 (streak algorithm), #66 (habits UI), #7 (domain model), #34 (sync registry)

## Context

FR-HAB-01 needs a habit with a title, optional description, colour/icon, a
frequency — **daily**, **selected weekdays**, or **X times per week** — and an
optional reminder time. FR-HAB-02 needs a per-day log (Done / Partial /
Missed) that is idempotent per `(habit, day)`. FR-HAB-03 needs a streak and
stats over 7/30/90-day windows; #65 decided what a streak means for a
non-daily habit (`docs/streak-algorithm.md`), and this ticket ships the shape
that algorithm consumes.

Ticket #63 lays the **shape and the plumbing** — the domain model, the
migration, the repos, the sync-registry entries and the service — so #64, #65
and #66 need no migration on `habits` or `habit_entries`.

Three shape questions had to be answered before that plumbing could exist:

1. **How is the frequency stored, and what happens to history when it
   changes?** FR-HAB-03's edge case says a frequency change must not rewrite
   past stats. A single mutable field would make every past day mean something
   new the moment the user changes their mind.
2. **Does a habit — and an entry — need its own IANA zone?** The reminder time
   is a *local* `HH:mm`, and a streak window is a range of *local* days.
3. **Is a day's log a row, or a field on the habit?** Settled as a separate
   table in #7 (open question #2), but the uniqueness and soft-delete semantics
   had to be decided before the sync path could be wired.

## Decision

- **The frequency is a discriminated union, and it is versioned into eras.**
  `frequency` is `{ _tag: "daily" }`, `{ _tag: "weekdays", days: [1..7] }` (a
  non-empty, duplicate-free ISO-weekday set) or `{ _tag: "weekly", times: 1..7 }`.
  `frequencyHistory` is an append-only list of
  `{ effectiveFrom: localDate, frequency }`, oldest first; the last entry always
  equals `frequency`. Era 0 starts on the habit's `startedOn`. A change starts a
  new era at the first period of the new frequency **after** the period the
  change happened in has ended (`max(next period boundary, end of the old
  period + 1 day)`), so a weekly era opens on the fixed Saturday boundary and a
  day era opens the next day. A second change before that boundary replaces the
  pending era. The model rejects an empty or unordered log, so eras can never
  overlap. One pure helper (`habitFrequencyHistoryAfter`) is used by both the RPC
  service and the offline sync merge, so the two write paths cannot drift.
- **A habit records the day it began.** `startedOn` is the owner's local
  creation date — a domain fact, not the UTC `createdAt` instant — and the
  streak/statistics (#65) never look before it.
- **An era boundary is computed when the change is applied, and is never
  back-dated.** The service uses the mutation's server instant in the habit's
  zone; the sync merge uses the server's commit instant, *not* the client's
  `clientUpdatedAt`. An offline edit therefore takes effect at the next period
  boundary after it syncs, which is what keeps past periods immutable. The
  boundary is always strictly after the change date, so it can never reach
  behind the era it replaces.
- **The habit carries its own zone.** `timeZone` is the IANA zone the local
  reminder time and the history dates are read in — the same per-item rule
  tasks and events use. It defaults to the owner's profile zone at creation.
  Entries carry the zone they were written in, so "the 3rd" stays the 3rd when
  read from another zone.
- **`HabitEntry` is a separate table, one row per `(habit, day)` for all time.**
  The UNIQUE index covers tombstones too. A tap therefore never inserts a
  duplicate: `HabitEntryRepo.findForDate` finds the day's row (live or
  soft-deleted) and the tap updates it in place, reviving a tombstone when the
  user re-logs a day they had cleared. A racing second device that mints a new
  id for the same day is refused by the index and reported as a `rejected` sync
  entry (code `UniqueViolation`) rather than silently duplicated.
- **Entries are not common items, but they do carry the sync scope columns.**
  No title, no colour, no versioned document — just `habitId`, `localDate`,
  `timeZone`, `status`, plus `ownerId`/`householdId`/`visibility` denormalized
  so `/sync/pull` filters them without a join. The sync engine resolves the
  entry's habit before writing and **forces the entry's visibility to the
  habit's**, refusing an entry whose habit is missing, trashed, private to
  another member or in another household, so a private habit's log stays private
  even when a client omits or flips the field.
- **Delete is a soft delete with an undo path.** `DeleteHabit` stamps a
  `deletedAt` tombstone and records a `delete` op on the feed; `RestoreHabit`
  clears the same row, so the undo toast (#66) returns the identical habit —
  same id, same frequency history, same entries. There is no second `create`.
- **The service does not compute a streak or a success rate.** #65 owns the
  algorithm; #63 ships the data it needs (the frequency version log and the
  entry range read) and nothing more.

## Consequences

- #64 builds the tap on `HabitEntryRepo.findForDate` + CAS update, and reads
  its date ranges from `listInRange`; it needs no migration.
- #65 can evaluate any past day against the frequency that was in force then
  (`frequencyHistory`) instead of today's; #66 renders from the same reads.
- A frequency change is one row write, so the history grows by one small JSON
  entry per change — negligible for a personal habit, and it keeps a
  two-person household's habits on a single sync entity type.
- The `(habit, day)` uniqueness is stronger than the sync protocol's
  per-row-version conflict model: two devices logging the same day converge on
  one row's version, and the losing insert is dropped by the client rather than
  merged. That is the correct trade for a tap — the later status is the one the
  user chose, and there is exactly one row to show it.
- The streak maths is deliberately still open (#65). Nothing in this schema
  presumes "streak in days" or "streak in periods".
