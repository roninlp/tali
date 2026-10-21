# ADR-0004: Event timing is a union with a per-event zone, and exceptions live inside the event

- **Status:** Accepted (2026-10-21)
- **Deciders:** Tali owner + developer (wayfinder #57)
- **Related:** tickets #57 (event aggregate), #58 (recurrence engine), #59 (occasions), #60 (reminders), #38 (task recurrence)

## Context

FR-CAL-01 needs an event with a title, a date and a start/end time, a place,
a description, a color/category, people, a reminder, plus all-day events and
recurring events whose occurrences can be edited "this occurrence only" or
"this and following". Ticket #57 lays the **shape and the plumbing** — the
domain model, the migration, the repo, the sync-registry entry and the service
— so the slices that follow (#58–#62) need no migration on `events`.

Two shape questions had to be answered before that plumbing could exist:

1. **How is an event's time stored?** The first draft (`docs/domain-model-draft.md`
   §3.3) put the IANA `timeZone` *inside* the all-day variant of the timing
   union, which left a timed event with no zone at all — even though FR-CAL-07
   requires that a device's zone change never moves a stored event, and even
   though the tasks (#33/#36) already store the zone per item.
2. **Where do the per-occurrence exceptions live?** The draft modelled
   `EventException` as its own row with its own id and version. A separate
   table would need its own sync entity type, its own parent-before-child
   ordering in the push path, and a second query for every expansion.

## Decision

- **Timing is a discriminated union, and the zone is a field of the event.**
  `timing` is `{ _tag: "timed", start, end }` (two UTC instants) or
  `{ _tag: "allDay", date }` (one local `YYYY-MM-DD`), and the event carries
  `timeZone` next to it — the same per-item rule the tasks use, defaulting to
  the owner's profile zone at creation. "An instant *and* an all-day date" is
  not representable; in D1 the columns are `start_at`/`end_at` **or**
  `all_day_date`, plus `time_zone`.
- **The exceptions live inside the event row.** `events.exceptions` is a JSON
  array of `{ id, instanceId, action, overrides, createdAt }`. One series, one
  row: an occurrence edit and the series it belongs to cannot disagree, and the
  expansion engine reads a series without a second query. The exception keeps
  its own `id` (the stable handle for "this occurrence only"); the **event's**
  version versions the whole list.
- **The occurrence key is the local start date.** `instanceId` is the
  occurrence's `YYYY-MM-DD` in the event's zone — one key per occurrence, in
  the calendar the engine expands in.
- **The title is structurally a string; the service enforces a non-empty one.**
  A delete-only sync push inserts a tombstone row whose title is empty by
  construction, so the *model* cannot require a non-empty title (the service
  still rejects one with a typed validation error).
- **The relations to the next slices are reserved, not guessed.** `occasionId`
  points at the annual date an event comes from (#59 adds the `occasions`
  table and the constraint decision), and the `ReminderLink` union (§3.6)
  already carries the `event` variant, so the reminder aggregate (#60) needs
  no migration either. Neither relation has a foreign key yet: `occasions` does
  not exist, and a foreign key to a missing table makes every insert fail.

## Consequences

- #58 (recurrence engine, exceptions, edit scope), #59 (occasions) and #60
  (reminders) work on the shape that already ships; none of them needs a
  migration on `events`.
- The event's wire payload carries the timing union and the exception list as
  nested objects, so a client reads one field (`timing`) to know the shape and
  one field (`exceptions`) to know the deviations — no column-name knowledge.
- An occurrence edit is an edit of the event row: the LWW granularity of
  "this occurrence only" is the whole series' exception list, not one
  occurrence. For a two-person household that is the right trade — an
  independent row per occurrence would buy per-occurrence merging at the cost
  of a second sync entity type and a join in every expansion.
- The zone is stored for timed events too, so a later "show this event in the
  author's zone" affordance needs no migration.
