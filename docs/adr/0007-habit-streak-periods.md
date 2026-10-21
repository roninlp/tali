# ADR-0007: A habit streak counts periods, and a counting week is a fixed Saturday–Friday

- **Status:** Accepted (2026-10-21)
- **Deciders:** Tali owner + developer (wayfinder #65)
- **Related:** tickets #65 (this decision), #63 (habit aggregate), #64 (logging and backfill), #66 (badge/stats/heatmap), #35 (week start preference), #19 (Jalali date module), ADR-0002 (preferences are presentation, server-of-record), ADR-0006 (the habit shape this builds on); `docs/streak-algorithm.md` is the normative spec.

## Context

FR-HAB-03 asks for a streak that is correct for non-daily frequencies, while its
own wording («تعداد روزهای پیاپی انجام») is daily-only, and the PRD's §5.4 adds
three hard constraints: blank days must not read as definitive failure, a
frequency change must not rewrite past statistics, and leap years/DST must not
disturb the count.

Three things had to be settled together:

1. **What breaks a streak** for "3 times a week" — a missed week, a week below
   quota, or a spacing rule.
2. **What the number counts** — days or periods — because a badge must print a
   unit and a 5-week run cannot be expressed honestly in days.
3. **Which week** — the user's Week Start preference (#35, Saturday/Sunday/Monday)
   or a fixed one. `GLOSSARY.md` says Week Start is *presentation only, never a
   date-storage convention*, and the recurrence engine (`recurrence.ts`) already
   fixed its weeks for the same reason: a display preference must not change the
   meaning of stored data.

## Decision

1. **The unit follows the frequency.** Daily and selected-weekday habits count
   consecutive **expected days**; X-times-a-week habits count consecutive
   **satisfied weeks**. The badge always names its unit.
2. **A counting week is Saturday–Friday, in the owner's local calendar, fixed by
   the product.** It does not follow the #35 Week Start preference, so changing
   that preference cannot re-cut history or rewrite a streak.
3. **Each period is judged by the frequency in force when it started**, eras never
   overlap (the next era starts at the first boundary of the new unit after the
   old period ends), and a same-unit threshold change does not interrupt the
   streak. A unit change closes the streak, keeps it as `best`, and starts a new
   run at the new unit. A change made mid-period therefore takes effect at the
   next boundary, not on the day it was made.
4. **The open period can never break a streak** and advances it the moment it is
   satisfied. Nothing is pro-rated and surplus does not bank.
5. **The success rate is quota-relative and capped at 100%**, Partial is half
   weight there and full credit in the streak.

The rules, the pure-function contract and the worked examples live in
`docs/streak-algorithm.md`.

## Consequences

- **Week Start stays presentation-only.** A user who prefers Monday or Sunday
  sees their calendar week start there, while a weekly habit's quota still turns
  over on Saturday. That mismatch is accepted and is the price of stable stats;
  it affects only X-per-week habits, and #66 must label the counting period
  (e.g. «۲۵ مهر – ۱ آبان») so the turn is visible even when the display week
  starts elsewhere.
- **#63 stores `startedOn: LocalDate` and frequency *eras*.** Era 0 is written at
  creation with `effectiveFrom = startedOn`; every later era's `effectiveFrom`
  is its first period start under the new unit (never the day the edit was
  made, and never back-dated). No cached streak columns.
- **The streak and `best` are not monotonic.** A ≤7-day backfill can grow the
  streak and a correction can shrink it *and* `best`; #66 must recompute rather
  than store a counter. A `best` that survived a correction would be a cache by
  another name.
- **No habit `kind` in Must.** A medication habit keeps a strict daily streak; a
  "record instead of streak" mode is deferred, not smuggled into #63.
- A `weekly(7)` habit is legal and is counted in weeks, not normalised to `daily`.

## Rejected alternatives

- **Rolling 7-day window** — boundary-free, but the streak has no honest moment
  to advance.
- **Slack days** ("no gap longer than 2–3 days") — silently redefines the habit.
- **Week start from the #35 preference** — makes a display preference semantic
  and lets a settings change rewrite satisfied weeks into broken ones.
- **Fixed ISO Monday** — stable, but wrong for the product's Saturday-first
  default user, whose quota boundary would disagree with the visible calendar.
- **Days-only streak for every frequency** — 15 or 35 instead of "5 weeks";
  neither is the thing the user is proud of.
- **Re-judging history at the current frequency / resetting on any change** —
  both violate "don't rewrite past stats" or punish a corrected typo.
- **Dating the new era from the day of the edit** — a weekly→daily change made
  mid-week would start day periods inside a week that is still being judged as
  a week, so one day would count twice. The new era must start at the new
  unit's next boundary (`docs/streak-algorithm.md` §5.2).
