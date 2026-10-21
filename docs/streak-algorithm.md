# Tali — Streak and habit statistics algorithm

> **Status:** DECIDED (2026-10-21) — owner + developer in wayfinder
> [#65](https://github.com/roninlp/tali/issues/65). This is the contract that
> [#63](https://github.com/roninlp/tali/issues/63) feeds, [#64](https://github.com/roninlp/tali/issues/64)
> writes into and [#66](https://github.com/roninlp/tali/issues/66) renders;
> changing a rule here means reopening #65.
>
> **Source authority:** PRD §5 (FR-HAB-03 and the §5.4 edge cases),
> `docs/must-have-feature-map.html` FR-HAB-03,
> `docs/domain-model-draft.md` §3.2, and
> [ADR-0007](adr/0007-habit-streak-periods.md).
>
> **Scope:** the statistic only. Recording entries (#64), the aggregate and
> schema (#63), the screens, badge and heatmap (#66) are separate tickets.
> This document defines a **pure function**: no clock, no time zone, no I/O.

---

## 1. The decision in one page

| # | Rule |
|---|---|
| **R1** | A **habit entry** is one day's answer for one habit: `done`, `partial` or `missed`, keyed by the local date. A day with no entry is **blank**, and blank is not a state that gets rewritten. |
| **R2** | **Credit** (streak and quota): `done` = 1, `partial` = 1, `missed` = 0, blank = 0. Partial counts fully, because the streak answers "did you show up". |
| **R3** | **Weight** (success rate): `done` = 1, `partial` = 0.5, `missed` = 0, blank = 0. |
| **R4** | **The unit follows the frequency.** Daily and selected-weekday habits count **days**; X-times-a-week habits count **weeks**. Because a period keeps the frequency it opened with (R10), the last period of the previous unit can still be counting for a few days after a change; `current.unit` is the unit of that last period, and a number is never shown without its unit. |
| **R5** | **Expected days** are the days a habit is due: every day for `daily`, the selected weekdays for `weekdays`. Only expected days can extend or break a day streak; every other day is **transparent**. |
| **R6** | A counting week is **Saturday through Friday, inclusive, in the owner's local calendar, fixed by the product**. It is a partition of local dates — no zone boundary, no midnight instant — and it does not follow the display Week Start preference (#35), so changing that preference can never rewrite a streak. |
| **R7** | A week is **satisfied** when the sum of the credit of its days **at or after `startedOn`** reaches `times`. **Surplus does not bank** into the next week and nothing is **pro-rated**. |
| **R8** | A **closed** period that is not satisfied **breaks** the streak. A `missed` entry never subtracts from anything; it is simply a day that did not earn credit. |
| **R9** | The **open** period can never break a streak. It **advances** the streak the moment it is satisfied. An explicit `missed` inside the open period is displayed, but a day streak's break lands only when the period closes (the tap can still be cycled forward). |
| **R10** | **Frequency changes are judged period by period.** The frequency in force when a period *started* governs that whole period, and an era boundary is always the first period start of the new unit (§5.2), never the day of the edit. Same-unit changes (2×/week → 3×/week) do **not** interrupt the streak; a change of **unit** (daily ↔ X/week) closes it, keeps it in `best`, and starts a new streak at the new unit's first period. |
| **R11** | A habit's **first period** can only start a streak, never break one. There is no pro-rating for a habit created mid-week. |
| **R12** | All arithmetic is on **local calendar dates** (`PlainDate`). No `Instant` arithmetic anywhere: DST, Jalali leap years and a device time-zone change cannot add, remove or move a day. Only "what is today" reads a zone. |
| **R13** | The **success rate** is quota-relative and capped at 100% (R15–R16). An open period counts toward it only once it is satisfied — so an unfinished **today** is outside a day rate's denominator, and an unsatisfied open week is outside a week rate. |
| **R14** | **Best streak is kept per unit** (`days` and `weeks`). A day streak and a week streak are not comparable numbers. |
| **R15** | The rate window is **N local days ending today** (`7`, `30` or `90`; the PRD's "weekly" and "monthly" figures are the 7-day and 30-day windows). A period qualifies when it is **closed and fully inside the window**, or when it is the **open period and satisfied** (R13); it must also have begun at or after `startedOn` **and belong to the current unit** (`current.unit`). Nothing is prorated. |
| **R16** | The rate is defined per unit in §5.5: for a week unit it is the **mean of the capped per-period ratios** over the qualifying weeks; for a day unit it is the **pooled weighted credit** of the qualifying expected days — plus the weight of in-window bonus days — divided by the number of qualifying expected days, capped at 100%. If no period qualifies (or the day-unit denominator is 0), `rate` is `null` and the UI shows the open period's progress instead. |

Read R2 against R3 once more: **credit** (partial = 1) is what the streak and the
weekly quota use, **weight** (partial = 0.5) is what the success rate uses. Both
are derived from the same entries; neither is negotiable in isolation.

---

## 2. Vocabulary

The glossary terms used below are defined in `GLOSSARY.md` § Habits:
**Habit**, **Habit Entry**, **Frequency**, **Expected Day**, **Streak Period**,
**Satisfied Period**, **Streak**, **Best Streak**, **Success Rate**.

Two working notes that are not glossary material:

- A **period** is one counting unit: one expected day, or one Saturday–Friday week.
- A **run** is a maximal sequence of satisfied periods, bounded by an unsatisfied
  closed period or by a unit change.

---

## 3. Frequency → unit and requirement

`HabitFrequency` is the union from `docs/domain-model-draft.md` §3.2:

```ts
type HabitFrequency =
  | { _tag: "daily" }
  | { _tag: "weekdays"; days: ReadonlyArray<number> } // ISO weekday, 1 = Monday … 7 = Sunday
  | { _tag: "weekly"; times: number }                 // "X times a week"
```

| Frequency | Unit | Applicable periods | Requirement per period | Period start |
|---|---|---|---|---|
| `daily` | day | every local date from `startedOn` | 1 | the day |
| `weekdays(days)` | day | only the selected ISOs | 1 | the day |
| `weekly(times)` | week | every Saturday–Friday week that overlaps the habit's life | `times` | the Saturday |

Constraints (validated in `packages/domain`, #63):

- `days` is a non-empty, duplicate-free subset of `1..7`.
- `times` is an integer in `1..7`. `weekly(7)` is legal: it requires all seven
  days and is still counted in **weeks**. It is not normalised to `daily` —
  the owner chose the frequency, and the badge must say weeks.
- A `weekdays` habit whose `days` is all seven is still a **day** streak of
  expected days, and reads identically to `daily`.

---

## 4. The pure function

### 4.1 Shape

```ts
// Module: packages/domain/src/planning/habit-streak.ts
// #63 ships the inputs (Habit/startedOn/frequencyHistory/HabitEntry); this pure
// function lands with its first consumer, #66, or a small follow-up to #63.
import type { LocalDate } from "./common.js"                 // existing
import type { HabitFrequency, HabitEntryStatus } from "./habit.js" // #63

export type StreakUnit = "day" | "week"

/** One era of one frequency. `effectiveFrom` is the era's first period start (era 0: `startedOn`). */
export interface StreakFrequencyEra {
  readonly effectiveFrom: LocalDate
  readonly frequency: HabitFrequency
}

export interface StreakEntry {
  /** The entry's local date — `HabitEntry.localDate` in #63. */
  readonly localDate: LocalDate
  readonly status: HabitEntryStatus // "done" | "partial" | "missed"
}

export interface StreakInput {
  /** The habit's local creation date — a domain fact, not `createdAt` instant. */
  readonly startedOn: LocalDate
  /**
   * Oldest first, non-overlapping, `effectiveFrom` strictly increasing, never
   * empty. Era 0 is written at creation with `effectiveFrom = startedOn`; every
   * later era's `effectiveFrom` is its first period start (§5.2), not the edit
   * date.
   */
  readonly frequencyHistory: ReadonlyArray<StreakFrequencyEra>
  /** Entries for this habit; order is irrelevant, one row per `localDate`. */
  readonly entries: ReadonlyArray<StreakEntry>
  /** The owner's local today, resolved by the caller (their IANA zone). */
  readonly today: LocalDate
  /** Rate window in local days. The streak itself is all-time and ignores it. */
  readonly windowDays: 7 | 30 | 90
}

export interface StreakPeriod {
  readonly unit: StreakUnit
  readonly start: LocalDate
  readonly end: LocalDate          // inclusive
  readonly frequency: HabitFrequency // the rule in force when the period started (era at max(start, startedOn))
  readonly requirement: number     // 1 for an expected day, `times` for a week
  readonly credit: number          // done + partial, integers (R2)
  readonly weighted: number        // done + 0.5 × partial (R3)
  readonly satisfied: boolean      // credit >= requirement (R8/R9)
  readonly open: boolean           // contains `today`
  readonly inWindow: boolean       // fully inside the rate window and not predating `startedOn` (R15)
}

export interface StreakResult {
  readonly current: {
    readonly unit: StreakUnit       // unit of the last applicable period; era 0's unit when there is none
    readonly count: number         // 0 when the current run is empty
    readonly since: LocalDate | null // first day of the run, never before `startedOn`
  }
  readonly open: StreakPeriod | null // the open period, for "2 of 3 this week" copy; null on a rest day or before `startedOn`
  readonly best: { readonly days: number; readonly weeks: number }
  readonly rate: number | null     // 0..1, unrounded; null when no period qualifies (R16)
  readonly periods: ReadonlyArray<StreakPeriod> // applicable periods, oldest first, incl. the open one
  /** One entry per era boundary whose unit changed (a same-unit change keeps the run and is not listed). */
  readonly unitChanges: ReadonlyArray<{
    readonly on: LocalDate
    readonly from: StreakUnit
    readonly to: StreakUnit
  }>
}
```

### 4.2 Contract

- **Deterministic, and total over valid inputs.** Same input → same output. No
  `Date.now()`, no `Temporal.Now`, no time zone lookup, no database. `today` is a
  parameter. Every input #63 can produce has a result (§4.3); the malformed
  rows there are contract violations, not user errors.
- **Inputs are trusted.** `StreakInput` is produced by the habit service (#63);
  the validation that belongs to a schema (`times` in `1..7`, a non-empty
  duplicate-free weekday set, a non-empty era list) happens there. A malformed
  era boundary is a programming defect, not a user error, and may be asserted
  rather than returned as an `HabitError` (§4.3).
- `periods` contains **applicable periods only**: expected days and weeks. A
  non-expected day never appears; its entry (if any) is a **bonus** (R5, §6 E12).
- Entries dated **before `startedOn` or after `today` are ignored**. Backfill
  (#64) can only produce past dates, but a device with a wrong clock can sync a
  future one; ignoring it is the whole handling.
- A **deleted habit** has no badge: #66 does not render a streak for a row in the
  trash and the caller does not ask. The function has no `deletedAt` — restoring
  the habit (same id, same entries) produces exactly the same result as before
  the delete, because nothing was rewritten.

### 4.3 Degenerate and malformed inputs

Every row below is a defined answer, not left to the implementer. "Assert"
means the function reports a programming defect (a thrown error in the domain
package, not an `HabitError` envelope); #63's schema and service make it
unreachable in production.

| Input | Result |
|---|---|
| No entry for a day | blank; credit 0, weight 0 (R1). |
| A future-dated entry (`> today`) | ignored (§4.2). |
| A duplicate entry for one `localDate` | a contract violation; the DB's `UNIQUE(habit_id, local_date)` and #64's upsert make it unreachable. If it is passed anyway, the function's result is unspecified — do **not** depend on input order (§5.1). |
| `today < startedOn` (a bad clock, or a restored row from a future-dated device) | `periods = []`, `current = { unit: unit(era 0), count: 0, since: null }`, `open = null`, `best = { 0, 0 }`, `rate = null`, `unitChanges = []`. |
| `startedOn == today` | day unit: one open day period when today is expected (none on a rest day); week unit: the opening week is open (E9). |
| Today is **not an expected day** (a `weekdays` rest day) | no open period: `open = null`; `current` is the last closed run (E12). |
| The habit was created mid-period | the period containing `startedOn` is judged by era 0 with `startedOn` as its lower bound; it can only start a run (R11, E9). |
| A same-day change, or a change and its revert | the computed boundary is at or before the last era's; that pending era is **replaced**, never stacked. A leftover same-frequency era is a no-op for the streak (§5.2). |
| An era set with a gap | not an error: the earlier era covers the gap (§5.2). |
| An era set with two eras on one date (overlap) | assert; #63's model requires strictly increasing boundaries. |
| An empty `frequencyHistory` | assert; #63 writes era 0 at creation. |
| `times` outside `1..7`, or empty/duplicate weekday set | rejected by the #63 schema; assert if it reaches the function. |
| An entry whose `status` is not one of the three | rejected by the schema; assert. |

---

## 5. The algorithm

### 5.1 Day table

Build `Map<LocalDate, status>` from `entries`. One entry per date is a database
guarantee (`UNIQUE(habit_id, local_date)`, #63/#64), so order is irrelevant and
a duplicate is malformed input, not a last-one-wins rule (§4.3).

### 5.2 Eras

`frequencyHistory` is the habit's frequency over time. Era boundaries are
computed **when the change is made**, not when the streak is computed (#63):

```
eraStart(newFrequency, changeDate) =
  max( firstPeriodStart(newFrequency.unit, strictlyAfter: changeDate),
       dayAfter(unitPeriodEnding(changeDate, oldFrequency.unit)) )

firstPeriodStart("day",  after d) = d + 1 day
firstPeriodStart("week", after d) = the Saturday strictly after d
unitPeriodEnding(d, "day")  = d          // whether or not d is an expected day
unitPeriodEnding(d, "week") = the Friday of d's Saturday–Friday week
```

`unitPeriodEnding` is deliberately **unit-period**, not "expected period": a
`weekdays` habit changed on a rest day still has a day unit period ending that
day. Without that, the formula would be undefined for a change made on a
Tuesday of a `weekdays(Sat, Mon, Wed)` habit — the boundary would depend on
which day the owner happened to open the form.

Worked: an owner changes **daily → 3×/week on Wed 21 Oct 2026**.
`firstPeriodStart("week", after 21 Oct)` = Sat 24 Oct; the current day period
ends 21 Oct, so `+1 day` = Thu 22 Oct; `max` = **Sat 24 Oct**. The daily era
therefore still covers Wed 21 – Fri 23, and the weekly era starts Sat 24.

An owner changes **3×/week → daily on Wed 21 Oct**. The current week ends Fri 23,
so `+1 day` = Sat 24; `firstPeriodStart("day", after 21 Oct)` = Thu 22;
`max` = **Sat 24 Oct**. The week 17–23 is judged at 3× (it opened that way) and
the daily era starts Sat 24 — the two eras never overlap, so no day is counted
twice.

The **partition is exact**. Every date at or after `startedOn` belongs to exactly
one era: `era[i]` covers `[effectiveFrom[i], effectiveFrom[i+1])` and era 0
starts at `startedOn`, with no boundary inside a period of either unit. The
single exception is the opening week, whose Saturday precedes `startedOn`; it is
still period 0 and is judged by era 0. A **gap** in the stored boundaries is
therefore harmless — the earlier era covers it — while two eras on one date
would count a day twice, so #63's model rejects non-increasing boundaries. The
frequency for a period is therefore:

```
era in force at period.start, except that the period containing `startedOn`
uses era 0 — i.e. look up last(era where effectiveFrom <= max(period.start, startedOn))
```

Era 0 is special only because a weekly habit created mid-week has an **opening
week** whose Saturday precedes `startedOn`; that week is judged by the creation
frequency, with `startedOn` as the first day that can earn credit (§6 E9).

A **same-day edit** is not a new era. If the computed `eraStart` is at or before
the last era's `effectiveFrom`, that pending era is **replaced** rather than
stacked, so two eras never share a boundary. A change-and-revert can therefore
leave a same-frequency era at the boundary; it is a no-op for the streak (same
unit, same requirement) and does not need to be pruned.

### 5.3 Period sequence

Walk every applicable period from the first one at or after `startedOn` (for the
week unit, the week containing `startedOn`) through the period containing `today`:

- **Day unit**: every applicable day (expected days only) from `startedOn` to `today`.
- **Week unit**: every Saturday–Friday week whose period overlaps
  `[startedOn, today]`, including the opening week and the open week.

No period starts after `today`, so the walk is finite: at most
`today − startedOn + 1` day periods or `⌈days / 7⌉ + 1` week periods. There is no
recursion and no unbounded lookback. If `today < startedOn` there are no periods
at all (§4.3).

For each period, evaluate only its days at or after `startedOn` and at or before
`today` (a week is seven days otherwise):

```
credit     = Σ credit(day)      // done=1, partial=1, missed=0, blank=0
weighted   = Σ weight(day)      // done=1, partial=0.5, else 0
satisfied  = credit >= requirement
open       = period.start <= today <= period.end
```

### 5.4 The walk (streak and best)

One forward pass. `run` counts the current sequence of satisfied periods;
`best.days` / `best.weeks` keep the maxima **of this pass over the current
entries** — `best` is recomputed, never stored, so a correction can lower it
(E6).

```
run = 0
for each period p in order (oldest → newest):
  if p starts a new era and unit(p) != unit(previous era):
     run = 0                                  // R10: a unit change closes the streak
  if p.satisfied:
     run += 1
     best[unit(p)] = max(best[unit(p)], run)
  else if not p.open:
     run = 0                                  // R8: a closed, unsatisfied period breaks
  // else: open and unsatisfied — leave `run` untouched (R9)

current.count = run
current.unit  = unit(last applicable period), or unit(era 0) when there is none
current.since = max(start of the first period in the run, startedOn), or null
```

`unitChanges` gets one row at each era boundary where the unit differs from the
previous era's — the same points at which `run` was reset. A same-unit change is
not listed.

Consequences worth spelling out:

- For a day-unit habit, **today is an open period**. A blank today leaves the
  streak standing; a blank *yesterday* is closed and has already broken it.
  A `partial` today is satisfied and advances immediately.
- For a week-unit habit, a 2-of-3 Wednesday shows the completed run so far and
  `open.credit = 2`; nothing is broken until Friday ends (E1).
- A satisfied open week advances **on the day it is satisfied**, not at week's
  end (E2). For `times = 1` the badge can grow on Saturday morning.
- A `missed` inside the open period is visible in the heatmap but is not a break
  until the period closes (R9, E14).
- `best` includes a run that is still in progress: the run of 6 is a best of 6
  even if it breaks tomorrow. Because it is recomputed, a correction that
  un-satisfies the only satisfied week also lowers `best` (E6) — that is the
  price of not caching a counter.
- The **first** period can only start a run: `run` begins at 0, so an opening
  week that falls short breaks nothing (E9).

### 5.5 Success rate

The window is `[today − (windowDays − 1), today]`, in local days. A period is
`inWindow` when it is **fully inside** the window (`start >= windowStart` and
`end <= today`) **and** it began at or after `startedOn`; nothing is prorated
(R7, R15). The opening **week** of a habit created mid-week therefore never
counts against the rate (E9) — it is excluded, not averaged in at a disadvantage.
(A day-unit habit's opening day *is* `startedOn`, so it counts once it closes.)

`inWindow` is not by itself the inclusion predicate: the open period is included
by the second clause below even though `end > today` makes `inWindow` false.

**The rate is for the current unit only.** A 30- or 90-day window can contain
both day and week periods after a unit change; those are two incomparable
denominators and §5.5 does not average them. Periods whose `unit` differs from
`current.unit` (the `unit` of the last applicable period) are excluded, exactly
as `best` is kept per unit. A unit change therefore starts a new rate history as
well as a new streak, and a window that holds no period of the new unit returns
`null` until one closes.

Within that unit, include a period if it is closed and `inWindow`, **or** it is
the open period and satisfied (R13). Then:

- **Day unit**
  `rate = min(1, (Σ weight(included expected days) + Σ weight(bonus days)) ÷ count(included expected days))`
  where **bonus days** are days in the window, at or after `startedOn`, inside a
  **day-unit** era, that the frequency did not expect and that carry an entry.
  The open day is today: an undone today is neither satisfied nor closed, so it
  is **not** in the denominator; a done or partial today is in both. A rest-day
  entry adds weight but never a denominator place (E12).
- **Week unit**
  `rate = mean(min(1, weighted ÷ times))` over the included weeks.
- If no period qualifies, or the day-unit denominator is 0 → `rate = null`.
  #66 shows progress («۲ از ۳ این هفته») instead of a percentage; it must not
  render `0%` (E13).

The cap is deliberate: a 5-of-3 week is a 100% week, and a rest-day `done` is
credit without inflating the percentage (R13, E12). The value is returned
**unrounded** (`0..1`); #66 rounds to the nearest whole percent for display.

### 5.6 Cost

One pass over the applicable periods: O(days since `startedOn`) for a day-unit
habit, O(weeks) for a week-unit habit, plus one pass over the entries and one
over the (short) era list. Bounded and cheap; #66 should still memoise per
`(habit.version, entry set version)` because Today re-renders on every tap.

---

## 6. Worked examples

All dates are local. Today is **Wed 21 Oct 2026 = 29 Mehr 1405** unless the row
says otherwise. Week labels:

- **W−2** = Sat 3 – Fri 9 Oct 2026 = 11–17 Mehr 1405
- **W−1** = Sat 10 – Fri 16 Oct 2026 = 18–24 Mehr 1405
- **W0** = Sat 17 – Fri 23 Oct 2026 = **25 Mehr – 1 Aban 1405** (straddles a Jalali month boundary)
- **W+1** = Sat 24 – Fri 30 Oct 2026 = 2–8 Aban 1405

### E1 — the basic weekly quota, open week not broken

`weekly(3)`, `startedOn` 3 Oct. W−2: done Mon 5, Tue 6 → credit 2 → closed,
**unsatisfied**. W−1: done Sun 11, Tue 13, Thu 15 → credit 3 → **satisfied**.
W0: done Sat 17, Mon 19 → credit 2, **open**.

```
current = { unit: "week", count: 1, since: 2026-10-10 }
open    = { start: 2026-10-17, requirement: 3, credit: 2, satisfied: false }
best    = { days: 0, weeks: 1 }
rate (30d, window 22 Sep–21 Oct) = (min(1,2/3) + min(1,3/3)) / 2 = 83%
```

The 2-of-3 Wednesday does **not** read as a broken streak, and the badge does
not decrement from 1 to 0.

### E2 — a satisfied open period advances immediately

`weekly(1)`, five satisfied weeks through W−1, then W0 logged on **Sat 17 Oct**.
W0 is satisfied the moment the first done-day lands, even though the week is
open.

```
current = { unit: "week", count: 6, since: 2026-09-12 }
open    = { start: 2026-10-17, requirement: 1, credit: 1, satisfied: true }
```

Waiting until Friday to increment would make a 1×/week habit's badge lag six days.

### E3 — Partial is full credit, half weight

`weekly(3)`, `today` 21 Oct, four weeks satisfied through W−2. W−1: **partial**
Mon 12, **done** Tue 13, **partial** Wed 14, nothing else.

```
credit   = 1 + 1 + 1 = 3      → satisfied (R2)  → current = 5 weeks
weighted = 0.5 + 1 + 0.5 = 2  → rate for W−1 = min(1, 2/3) = 67% (R3)
```

The streak says "five weeks", the rate says "the fifth was two-thirds of the
commitment". Both are true.

### E4 — the rate is capped, the surplus is real but not banked

`weekly(3)`, W−1: five done-days. `credit = 5` (satisfied), `min(1, 5/3) = 100%`.
The two extra days do **not** pre-pay W0 (R7).

### E5 — a backfill can grow a streak after the fact

`weekly(3)`, `startedOn` 3 Oct; W−2 done Mon 5, Tue 6 only; W−1 empty;
`today` **Wed 14 Oct**. Before: W−2 closed unsatisfied → `current = 0`,
W−1 open 0/3. The owner backfills **Fri 9 Oct** as done (5 days back, inside the
7-day window):

```
W−2 credit = 3 → satisfied → current = { unit: "week", count: 1, since: 2026-10-03 }
```

Because history is mutable for 7 days, the streak is **not append-only**. #66
must recompute from the pure function, never from a stored counter.

### E6 — a correction can break a streak (and lower `best`)

As E1, but `today` is **Sun 18 Oct**: W−1 satisfied (Sun 11, Tue 13, Thu 15),
W0 has Sat 17 (E1's Mon 19 entry is after today, so it is ignored). `current = 1`.
The owner corrects Tue 13 Oct from done to **missed**:

```
W−1 credit = 2 → unsatisfied → current = 0, best = { days: 0, weeks: 0 }
```

`best` falls with the correction, because the function recomputes both numbers
from the same entries and stores neither (R14, §5.4): after the correction there
is no satisfied week left in the data. The user's own correction wins over the
number. Allowed by design; the UI may warn when a correction flips the current
streak, but must not forbid it.

### E7 — changing the Week Start preference changes nothing

Same data as E1. The owner switches Week Start from `saturday` to `monday`
(#35). The calendar and month grid re-cut the display week as Mon 19 – Sun 25 Oct,
but the habit's counting periods remain Sat 17 – Fri 23:

```
current = 1 week (unchanged), rate = 83% (unchanged)
```

Had the period followed the preference, the days of W−1 would be re-cut into
**Mon 5 – Sun 11** (holding only Sun 11) and **Mon 12 – Sun 18** (holding Tue 13
and Thu 15): the three done-days split 1 + 2 and **both** periods fall short of
3 — silently turning a satisfied week into two broken ones. This is why R6 fixes
the period (ADR-0007).

### E8 — DST and Jalali leap years are invisible

Berlin, `daily`, done Sat 24 Oct, **Sun 25 Oct 2026** (a 25-hour day: the
fall-back adds an hour), Mon 26 Oct:

```
current = { unit: "day", count: 3, since: "2026-10-24" }
```

Each period is a `PlainDate`; the 25-hour day is still one day (R12), and a
spring-forward 23-hour day would be one day too. The same holds across a Jalali
year boundary: in a leap year Esfand 30 is one plain day, in a common year (e.g.
1405) it does not exist, so no entry can name it and no period is skipped or
duplicated.

### E9 — a habit created mid-period

Both halves happen on **Fri 23 Oct 2026 = 1 Aban** (not the default 21 Oct), so
every logged day is in the past or today.

**(a) Created Fri 23 Oct, `weekly(3)`, nothing logged.** W0 has one applicable
day (Fri 23) and can reach credit 1 at most:

```
current = { unit: "week", count: 0, since: null }
best    = { days: 0, weeks: 0 }
open    = { start: 2026-10-17, requirement: 3, credit: 0, satisfied: false }
```

Nothing breaks (there is no prior run), and nothing is credited either. If W+1
is satisfied, `current = 1 week, since: 2026-10-24`. **No pro-rating** — a
Friday-created habit would otherwise start life "broken" or start with a
half-credit that no other week can match.

**(b) Created Wed 21 Oct, `weekly(3)`, logged Wed 21, Thu 22, Fri 23.** W0
reaches credit 3 and **starts** the streak (it is satisfied while still open, so
R9 advances it on Fri 23):

```
current = { unit: "week", count: 1, since: 2026-10-21 }  // clamped to startedOn
open    = { start: 2026-10-17, requirement: 3, credit: 3, satisfied: true }
```

The period start is 17 Oct, but `since` is never earlier than the habit existed.

### E10 — raising the quota mid-week does not rewrite the current week

Five satisfied weeks at `weekly(2)`. On Wed 21 Oct the owner raises it to
`weekly(3)`. W0 opened on Sat 17 under `2`, and has done Sat 17 + Mon 19:

```
W0 requirement = 2 (the rule it opened with) → satisfied → current = 6 weeks
era starts    = Sat 2026-10-24 → W+1 is the first week judged at 3
```

Had W0 only one done-day, it would close unsatisfied **at 2** and break the
streak — the new bar never applies retroactively (R10).

### E11 — a unit change closes the streak

`daily` with a 12-day streak through Tue 20 Oct. On Wed 21 Oct the owner switches
to `weekly(3)`:

```
Wed 21 – Fri 23 Oct : still day periods (daily rule) — the streak can reach 15 days
Sat 24 Oct          : weekly era starts → unit change → current = { unit: "week", count: 0 }
best                = { days: 15, weeks: <previous weekly best> }
W+1 satisfied       : current = { unit: "week", count: 1, since: 2026-10-24 }
```

A 15-day run cannot be expressed in weeks, so it stays in `best.days` and the
new unit starts its own run. The day run remains in the data, so switching back
to `daily` later still reports `best.days = 15` and starts a new day run at the
next day period.

The **rate** follows the same boundary: before Sat 24 it is the day-unit rate; from
Sat 24 the 30-day window still holds day periods but the function reports the
`week` rate only (R15, §5.5), and W0 is open, so `rate = null` until a week
closes. Mixing the two denominators would produce a number that means neither.

### E12 — a rest-day `done` is a bonus, not a bridge

`weekdays(Sat, Mon, Wed)`, `startedOn` Sat 17 Oct. Sat 17 was **not logged**; done
Mon 19, Wed 21, **also done Thu 22** (not selected). `today` = Thu 22:

```
current = { unit: "day", count: 2, since: 2026-10-19 }  // Mon + Wed
```

Thursday does not extend the run (Wed → Sat is the next expected pair) and
cannot break it either. Its entry still paints a heatmap cell and, because it is
a day-unit era's non-expected day, adds weight to the day-unit rate numerator
(capped), so the effort is visible (R5, R13, §5.5).

### E13 — a 7-day window has no closed week

`weekly(3)`, `today` Wed 21 Oct, `windowDays = 7` → window 15–21 Oct. W−1 ends
Fri 16 Oct but starts Sat 10 Oct, outside the window; W0 is open and not
satisfied.

```
rate = null
```

This is structural, not an accident of the date: a closed counting week is seven
days long, so it can fit inside a seven-day window only by ending today — which
makes it the **open** week. A closed week can therefore **never** contribute to a
7-day rate. For an X-times-a-week habit the 7-day tab shows the current week's
progress («۲ از ۳ این هفته») while the week is unsatisfied; once the open week
is satisfied it is the single qualifying period (R13) and the rate is its capped
ratio, which is the same number as the progress. The first **closed** week enters
the rate on the 30-day tab. #66 must not render `0%` for a `null` rate.

### E14 — an explicit miss today vs a blank today

`weekdays(Sat, Mon, Wed)`, `startedOn` Sat 17 Oct, done Sat 17 and Mon 19,
`today` Wed 21.

- **Blank today** → `current = 2`, open, not broken.
- **Missed today** → `current = 2`, open, `satisfied: false`, not broken yet.
  The heatmap shows a missed cell.
- **Missed yesterday**: for this bullet only, suppose Tuesday is also selected
  (`weekdays(Sat, Mon, Tue, Wed)`) and Tue 20 is **missed** → it is a closed,
  unsatisfied expected day → `current = 0`. For the three-day habit above, Tue 20
  is a rest day, so its entry (missed or done) can neither break nor extend the
  run (R5, E12).

The break lands at the period's close, so cycling the wrong tap back to done on
the same day restores the streak.

### E15 — a week is not a month

W0 (25 Mehr – 1 Aban) is **one** period with one requirement of 3. The heatmap
(#66) paints its days across two Jalali months, while the quota stays whole: a
Jalali month is not a Streak Period, so the PRD's "monthly" rate is the 30-day
window of R15/R16 — not a per-month quota and not a day-weighted average. The
same week is judged once, however many month boundaries it crosses.

### E16 — a missed day never subtracts

`weekly(3)`, W−1: done Mon 12, Tue 13, Wed 14, **missed** Thu 15.
`credit = 3` → satisfied; `weighted = 3` → 100%. The miss costs nothing beyond
the day it consumed; it does not undo the other three.

---

## 7. Traceability to the PRD's edge cases (§5.4)

| PRD edge case | Answered by |
|---|---|
| «روزهای بدون ثبت نباید به‌عنوان «شکست» قطعی تفسیر شوند؛ برای فراوانی‌های «X بار در هفته» منطق انعطاف‌پذیر باشد.» | R7, R8, R9, E1, E14: a blank day is "not a done", never a verdict inside an open period; a weekly habit absorbs up to `7 − times` blank days per week without breaking. |
| «تغییر فراوانی یک عادت نباید آمار گذشته را بازنویسی کند.» | R10, E10: entries are never rewritten; each period keeps the rule it opened with; eras never overlap. |
| «سال کبیسه و تغییر ساعت فصلی نباید در محاسبه‌ی زنجیره اختلال ایجاد کند.» | R12, E8: `PlainDate` only; no instant arithmetic; Jalali leap days exist or do not exist as dates, never as 24 h offsets. |
| FR-HAB-03 «تعداد روزهای پیاپی» / acceptance "correct for 3×/week" | R4, §3: the unit follows the frequency; the badge names its unit (E1, E11). |

---

## 8. Consequences for the other tickets

### #63 — habit aggregate

**Shipped by #63 (PR #71):** `startedOn: LocalDate` (the owner's local creation
date in the habit's own IANA zone, immutable, and era 0's `effectiveFrom`);
`frequencyHistory` as eras whose later `effectiveFrom` is `habitEraStartAfter`
(§5.2) and never the edit day, with a same-boundary replacement; `HabitEntry`
keyed `UNIQUE(habit_id, local_date)` with the three-state status; and no cached
streak columns. The field is `localDate`/`local_date`, not `date`.

What #63 does **not** ship, and the contract still requires:

- The **pure function** itself (`habit-streak.ts`): #63 deliberately stops at the
  data, so the module in §4.1 lands with its first consumer (#66) or a follow-up
  to #63. It takes `startedOn`, `frequencyHistory`, the entries for the range,
  `today` (the owner's zone) and the requested `windowDays` — nothing else — and
  nothing else in the chain may re-implement the rules.
- The **entry range read** the function needs is `HabitEntryRepo.listInRange`
  (already shipped); `today` is resolved once per request by the caller.
- **No `kind` field in Must** (decided in #65): a medication habit is an ordinary
  daily habit with a strict streak. A "record instead of streak" mode would need
  a habit kind and is explicitly deferred; #63 must not grow the field
  speculatively.

### #64 — logging and backfill

- The ≤7-day backfill writes ordinary entries; nothing about it is special to
  the algorithm except that it can change a closed period *after* it closed
  (E5, E6).
- Idempotent upsert keeps one row per `(habit, localDate)`; cycling the status
  overwrites, never appends.
- A tap on today is an entry in the **open** period: it advances the streak
  immediately when it earns credit (E2, E14).

### #66 — badge, stats, heatmap

- The badge prints `current.count` **with its unit** («۵ هفته پیاپی» /
  «۱۲ روز پیاپی») and, when `open` is non-null and unsatisfied, the progress
  (`open.credit` of `open.requirement`). It never prints a bare number.
- `rate === null` renders progress, not `0%`; the rate is for `current.unit`, so
  a unit change can leave the 30/90-day tab without a rate until a period of the
  new unit closes.
- For a weekly habit, name the counting period on the stats row (e.g.
  «۲۵ مهر – ۱ آبان») so the fixed Sat–Fri turn is visible when the display Week
  Start is Sunday or Monday (E7).
- `best` renders **the current unit's** best; don't compare `days` and `weeks`.
  `best` is recomputed, so it can go down after a correction; the UI must accept
  that rather than keep a historical maximum.
- Round `rate` to the nearest whole percent here; the function returns an
  unrounded fraction.
- The heatmap paints raw entry statuses (done / partial / missed / blank) and
  must not re-derive weights or quotas; the flame and the heatmap may disagree
  legitimately (a partial is green-ish and half-weight).
- Recompute on every entry change; the streak and `best` are not monotonic
  (E5, E6).
- A rest-day entry of a **day-unit** habit is painted and can add rate weight
  but never changes the streak (E12).

### #60/#61/#67 — reminders

A "Done" answer on a habit-linked reminder writes a habit entry for the owner's
**local today** (the same write as a tap). The reminder path adds no streak
rules of its own.

---

## 9. What this deliberately does not decide

- **Streak freezes / skip days / weekend awareness.** Not in Must; the quota and
  the open-period rule already provide the flexibility the PRD asks for.
- **A streak history list** (every past run with dates). Only `best` per unit is
  exposed; a history view is a later feature, and the function's `periods` array
  is enough to build it without a schema change.
- **A medication "record instead of streak" mode.** Needs a habit `kind`
  (deliberately not added, #63).
- **Shared-habit streaks** (FR-HAB-06 is Should). If it lands, the streak stays
  **per owner**; a joint streak is a new decision.
- **Heatmap buckets and colours** (#66), **window selector copy** (#66), and
  Persian digit rendering (presentation, #35/#19).
- **What "today" is** when the device zone and the preference zone disagree —
  #64/#42 resolve it once per request, exactly as `/today` does.

---

## 10. Rejected alternatives

| Alternative | Why not |
|---|---|
| **Rolling 7-day window** ("3 in any 7 days") | No boundary means no honest moment for the streak to advance; the badge would either grow daily on a trailing count or wait arbitrarily. |
| **Slack days** ("no gap longer than 2–3 days") | Silently redefines `3×/week` as "at least one every 2–3 days" — a different habit. |
| **Partial = 0.5 toward the quota** | 3 partials satisfy a 3×/week week while 2 done + 1 partial (more effort) does not. Correct arithmetic, wrong verdict. |
| **Partial = nothing for the streak** | A month of half-effort reads as zero; the three-state log loses its middle meaning. |
| **Days-only unit for every habit** | A 5-week run prints as 15 (log days, understated) or 35 (calendar days, inflated by rest days); the number stops meaning anything for weekly habits. |
| **Counting week follows the #35 Week Start** | Switching Sat→Mon re-cuts history and can turn satisfied weeks into broken ones (E7); makes a display preference semantic, contradicting `GLOSSARY.md` and ADR-0002. |
| **Fixed ISO Monday** | Stable, but the default (Saturday) user's weekly boundary would disagree with the week strip on the same screen; the product is Persian-first. |
| **Re-judge all history at the current frequency** | Raising the quota retroactively erases satisfied weeks — forbidden by PRD §5.4. |
| **Reset the streak on any frequency change** | A 2→3→2 typo fix destroys a real streak. |
| **Calendar-relative rate (÷7)** | A fully met 3×/week week reads 43% — the number calls success a failure. |
| **Uncapped rate** | 5-of-3 reads 167% on a "success rate" progress bar. |
| **One best number across units** | 40 days and 5 weeks cannot share a field; one of them would be a lie (E11). |
| **Pro-rating the opening period** | A habit created on Friday starts "broken" or with an unmatchable partial credit, and the quota starts depending on the creation weekday. |
| **Add a habit `kind` now for medication** | #63 is unbuilt so it is cheap, but nothing in Must renders a record view; a speculative field in a strict schema is worse than a documented deferral. |
| **Cached streak counters** | Backfill and corrections make the streak and `best` non-monotonic (E5, E6); a counter would drift from the entries. |
| **Dating a new era from the day of the edit** | A weekly→daily change made mid-week would start day periods inside a week that is still judged as a week, so one day counts twice; eras overlap. §5.2 moves the boundary to the new unit's next period start. |
| **One rate across mixed units** | A 30/90-day window after a unit change holds day periods and week periods; their denominators are incomparable, so the mean would mix 1-day and 7-day quotas. The rate is per unit, like `best` (R14, §5.5). |
| **A historical `best` that survives a correction** | It is a cached maximum under another name, and it would contradict the pure function that recomputes from the entries (E6). |
