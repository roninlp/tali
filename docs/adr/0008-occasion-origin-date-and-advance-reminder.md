# ADR-0008: Occasions store one origin date and project the Jalali month/day, clamping Esfand 30

- **Status:** Accepted (2026-10-21)
- **Deciders:** Tali owner + developer (wayfinder #59)
- **Related:** tickets #59 (occasions), #60 (reminder aggregate), #61 (delivery), #62 (calendar views), #58 (event recurrence), #38 (recurrence engine), #13 (reminder policy), ADR-0004 (event shape), ADR-0005 (reminder firing)

## Context

FR-CAL-02 needs personal dates that come back every year — a birthday, an
anniversary — shown in the calendar with an advance reminder ("seven days
before") and an optional preparation task. Three questions had to be answered
before the aggregate could be built:

1. **What is stored?** The draft (`docs/domain-model-draft.md` §3.4) suggested a
   `monthDay: { month, day }` pair. The ticket asks for the **origin local date**
   and its time zone, which also answers "how many years" and keeps the exact
   day the user first entered.
2. **How does an annual date stay annual across calendars?** A birthday is
   "12 Farvardin", not "1 April": the Gregorian date drifts by a day or two
   across Jalali years. The display must be derived, not stored per year.
3. **What happens to Esfand 30 in a common year?** The shared recurrence engine
   (#38) deliberately **skips** impossible dates, so a yearly rule on Esfand 30
   silently disappears in four years out of five. A person's birthday cannot
   disappear.

Ticket #60 (the `Reminder` aggregate) is not on `main` yet. The occasions slice
must not create a second reminder table or pre-empt #60's design.

## Decision

- **One local origin date plus the occasion's own IANA zone.** `occasions` stores
  `origin_date` (`YYYY-MM-DD`) and `time_zone`; it has no occurrence table, no
  `recurrence` column and no `monthDay` pair. The Jalali month/day is derived
  from the origin (`occasion-projection.ts`), and the annual occurrence is
  rebuilt in each requested Jalali year. Both the Jalali and Gregorian fields
  travel with every projected occurrence, so the month view can show both
  without a second conversion.
- **The projection clamps Esfand 30 to Esfand 29 in a common year.** This is
  the one place where the occasion semantics intentionally differ from the
  shared recurrence engine: an occasion is a date-of-record, not a schedule
  that can skip a period. The behaviour is documented at the builder and tested.
- **The yearly marker is a boolean on the same aggregate.** `yearly = true`
  (default) repeats every Jalali year; `yearly = false` keeps a one-off
  important date on its origin only. A `RecurrenceRule` would carry interval,
  count and end semantics an occasion does not have.
- **The advance reminder is an offset, expanded at read time.** `advance_reminder_days`
  produces `occurrenceDate − N days` and a default 09:00 fire instant in the
  occasion's zone. No per-year reminder row is written. The service exposes
  `OccasionAdvanceReminder` drafts with a stable `reminderKey` and
  `ReminderLink { _tag: "occasion" }` — the **documented seam for #60**. #60
  owns the `reminders` table and materialises the draft; #61's sweep consumes
  the fire instant. The `ReminderLink` union gains the `occasion` variant now
  because the draft needs a typed target; no reminder table is created here.
- **The preparation task is a real task row.** The one-tap action writes a
  normal `tasks` row (so it completes, syncs, and appears on `/today`) and links
  it from `occasions.preparation_task_id` in the same D1 batch. The task insert
  is gated on the occasion's CAS that links it, so a lost CAS cannot leave an
  orphan; a second tap returns the live linked task. The link has no foreign
  key: soft-deleted tasks are retained and an offline client may create the task
  before the occasion reaches the server.

## Consequences

- The month view (#43, and #62's richer UI) overlays occasions from the local
  mirror with the same pure builder the API uses; an annual chip is correct
  offline and needs no change to the `/month` read model or its ETag.
- A leap-day birthday is celebrated on Esfand 29 in common years and is never
  omitted. Tests pin both the leap and the common year.
- The advance reminder has no delivery state of its own until #60 lands. That
  is deliberate: a second table would diverge from the dispatch ledger ADR-0005
  makes the source of truth for fires and answers. The seam returns a due date,
  a default instant and a stable key, which is everything a reminder row needs.
- `events.occasion_id` (reserved in 0010) still has no foreign key. Events and
  occasions can arrive in either order on a sync pull; the relation is validated
  by the services that set it.
