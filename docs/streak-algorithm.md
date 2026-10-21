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
> [ADR-0006](adr/0006-habit-streak-periods.md).
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
| **R4** | **The unit follows the frequency.** Daily and selected-weekday habits count **days**; X-times-a-week habits count **weeks**. A number is never shown without its unit. |
| **R5** | **Expected days** are the days a habit is due: every day for `daily`, the selected weekdays for `weekdays`. Only expected days can extend or break a day streak; every other day is **transparent**. |
| **R6** | A counting week is **Saturday 00:00 → Friday 24:00 in the owner's local calendar, fixed by the product**. It does not follow the display Week Start preference (#35), so changing that preference can never rewrite a streak. |
| **R7** | A week is **satisfied** when the sum of its seven days' credit reaches `times`. **Surplus does not bank** into the next week and nothing is **pro-rated**. |
| **R8** | A **closed** period that is not satisfied **breaks** the streak. A `missed` entry never subtracts from anything; it is simply a day that did not earn credit. |
| **R9** | The **open** period can never break a streak. It **advances** the streak the moment it is satisfied. An explicit `missed` inside the open period is displayed, but a day streak's break lands only when the period closes (the tap can still be cycled forward). |
| **R10** | **Frequency changes are judged period by period.** The frequency in force when a period *started* governs that whole period. Same-unit changes (2×/week → 3×/week) do **not** interrupt the streak; a change of **unit** (daily ↔ X/week) closes it, keeps it in `best`, and starts a new streak at the new unit's first period. |
| **R11** | A habit's **first period** can only start a streak, never break one. There is no pro-rating for a habit created mid-week. |
| **R12** | All arithmetic is on **local calendar dates** (`PlainDate`). No `Instant` arithmetic anywhere: DST, Jalali leap years and a device time-zone change cannot add, remove or move a day. Only "what is today" reads a zone. |
| **R13** | The **success rate** is quota-relative and capped at 100% (R15–R16). An open period counts toward it only once it is satisfied. |
| **R14** | **Best streak is kept per unit** (`days` and `weeks`). A day streak and a week streak are not comparable numbers. |
| **R15** | The rate window is **N local days ending today** (`7`, `30` or `90`). Only periods **fully inside** the window qualify, and a period that began before `startedOn` never qualifies. Nothing is prorated. |
| **R16** | The rate is the **mean of the capped per-period ratios** over the qualifying periods; if none qualifies, `rate` is `null` and the UI shows the open period's progress instead. |

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
// Module: packages/domain/src/planning/habit-streak.ts (lands with #63)
import type { LocalDate } from "./common.js"                 // existing
import type { HabitFrequency, HabitEntryStatus } from "./habit.js" // #63

export type StreakUnit = "day" | "week"

/** One era of one frequency. `effectiveFrom` is the era's first period start. */
export interface StreakFrequencyEra {
  readonly effectiveFrom: LocalDate
  readonly frequency: HabitFrequency
}

export interface StreakEntry {
  readonly date: LocalDate
  readonly status: HabitEntryStatus // "done" | "partial" | "missed"
}

export interface StreakInput {
  /** The habit's local creation date — a domain fact, not `createdAt` instant. */
  readonly startedOn: LocalDate
  /** Oldest first, non-overlapping, `effectiveFrom` strictly increasing. Never empty. */
  readonly frequencyHistory: ReadonlyArray<StreakFrequencyEra>
  /** Entries for this habit; order is irrelevant, one row per `date`. */
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
  readonly frequency: HabitFrequency // the rule in force when the period started
  readonly requirement: number     // 1 for an expected day, `times` for a week
  readonly credit: number          // done + partial, integers (R2)
  readonly weighted: number        // done + 0.5 × partial (R3)
  readonly satisfied: boolean      // credit >= requirement (R8/R9)
  readonly open: boolean           // contains `today`
  readonly inWindow: boolean       // fully inside the rate window and not predating `startedOn` (R15)
}

export interface StreakResult {
  readonly current: {
    readonly unit: StreakUnit
    readonly count: number         // 0 when the current run is empty
    readonly since: LocalDate | null // first day of the run, never before `startedOn`
  }
  readonly open: StreakPeriod | null // the open period, for "2 of 3 this week" copy
  readonly best: { readonly days: number; readonly weeks: number }
  readonly rate: number | null     // 0..1; null when no period qualifies (R16)
  readonly periods: ReadonlyArray<StreakPeriod> // applicable periods, oldest first, incl. the open one
  readonly eraChanges: ReadonlyArray<{
    readonly on: LocalDate
    readonly from: StreakUnit
    readonly to: StreakUnit
  }>
}
```

### 4.2 Contract

- **Deterministic and total.** Same input → same output. No `Date.now()`, no
  `Temporal.Now`, no time zone lookup, no database. `today` is a parameter.
- **Inputs are trusted.** `StreakInput` is produced by the habit service (#63);
  a malformed era boundary is a programming defect, not a user error, and may be
  asserted rather than returned as an `HabitError`.
- `periods` contains **applicable periods only**: expected days and weeks. A
  non-expected day never appears; its entry (if any) is a **bonus** (R5, §6 E12).
- Entries dated **before `startedOn` or after `today` are ignored**. Backfill
  (#64) can only produce past dates, never future ones.

---

## 5. The algorithm

### 5.1 Day table

Build `Map<LocalDate, status>` from `entries`. One entry per date is a database
guarantee (`UNIQUE(habit_id, date)`, #63/#64); if a duplicate is passed anyway,
the last one in the input wins — the function does not depend on it.

### 5.2 Eras

`frequencyHistory` is the habit's frequency over time. Era boundaries are
computed **when the change is made**, not when the streak is computed (#63):

```
eraStart(newFrequency, changeDate) =
  max( firstPeriodStart(newFrequency.unit, strictlyAfter: changeDate),
       end(periodContaining(changeDate, oldFrequency)) + 1 day )
```

Worked: an owner changes **daily → 3×/week on Wed 21 Oct 2026**.
`firstPeriodStart("week", after 21 Oct)` = Sat 24 Oct; the current day period
ends 21 Oct, so `+1 day` = Thu 22 Oct; `max` = **Sat 24 Oct**. The daily era
therefore still covers Wed 21 – Fri 23, and the weekly era starts Sat 24.

An owner changes **3×/week → daily on Wed 21 Oct**. The current week ends Fri 23,
so `+1 day` = Sat 24; `firstPeriodStart("day", after 21 Oct)` = Thu 22;
`max` = **Sat 24 Oct**. The week 17–23 is judged at 3× (it opened that way) and
the daily era starts Sat 24 — the two eras never overlap, so no day is counted
twice.

The frequency for a period is `last(era where effectiveFrom <= period.start)`.
Era 0's `effectiveFrom` is `startedOn`; a weekly habit created mid-week still
has its **opening week** judged as one week (§6 E9).

### 5.3 Period sequence

Walk from the period containing `startedOn` to the period containing `today`:

- **Day unit**: every applicable day (expected days only) from `startedOn` to `today`.
- **Week unit**: every Saturday–Friday week whose period overlaps
  `[startedOn, today]`, including the opening week and the open week.

For each period, evaluate its seven days (weeks) or its one day:

```
credit     = Σ credit(day)      // done=1, partial=1, missed=0, blank=0
weighted   = Σ weight(day)      // done=1, partial=0.5, else 0
satisfied  = credit >= requirement
open       = period.start <= today <= period.end
```

### 5.4 The walk (streak and best)

One forward pass. `run` counts the current sequence of satisfied periods;
`best.days` / `best.weeks` keep the maxima.

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
current.unit  = unit(last applicable period)
current.since = max(start of the first period in the run, startedOn), or null
```

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
  even if it breaks tomorrow.
- The **first** period can only start a run: `run` begins at 0, so an opening
  week that falls short breaks nothing (E9).

### 5.5 Success rate

The window is `[today − (windowDays − 1), today]`, in local days. A period is
`inWindow` when it is **fully inside** the window (`start >= windowStart` and
`end <= today`) **and** it began at or after `startedOn`; nothing is prorated
(R7, R15). The opening period of a habit created mid-week therefore never counts
against the rate (E9) — it is excluded, not averaged in at a disadvantage.

Include a period in the rate if it is closed and `inWindow`, **or** it is the
open period and satisfied (R13). Then:

- **Day unit**
  `rate = min(1, (Σ weight(included expected days) + Σ weight(bonus days in window)) ÷ count(included expected days))`
- **Week unit**
  `rate = mean(min(1, weighted ÷ times))` over the included weeks.
- If no period qualifies → `rate = null`. #66 shows progress («۲ از ۳ این هفته»)
  instead of a percentage; it must not render `0%` (E13).

The cap is deliberate: a 5-of-3 week is a 100% week, and a rest-day `done` is
credit without inflating the percentage (R13, E12).

### 5.6 Cost

One pass over the applicable periods: O(days since `startedOn`) for a day-unit
habit, O(weeks) for a week-unit habit, plus one pass over the entries. Bounded
and cheap; #66 should still memoise per `(habit.version, entry set version)`
because Today re-renders on every tap.

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

### E6 — a correction can break a streak

As E1, but `today` is **Sun 18 Oct**: W−1 satisfied (Sun 11, Tue 13, Thu 15),
W0 has Sat 17 only. `current = 1`. The owner corrects Tue 13 Oct from done to
**missed**:

```
W−1 credit = 2 → unsatisfied → current = 0, best = { days: 0, weeks: 1 }
```

The user's own correction wins over the number. Allowed by design; the UI may
warn when a correction flips the current streak, but must not forbid it.

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
the period (ADR-0006).

### E8 — DST and Jalali leap years are invisible

Berlin, `daily`, done Sat 24 Oct, **Sun 25 Oct 2026** (a 23-hour day across the
fall-back), Mon 26 Oct:

```
current = { unit: "day", count: 3, since: 2026-10-24 }
```

Each period is a `PlainDate`; the 23-hour day is still one day (R12). The same
holds across a Jalali year boundary: in a leap year Esfand 30 is one plain day,
in a common year (e.g. 1405) it does not exist, so no entry can name it and no
period is skipped or duplicated.

### E9 — a habit created mid-period

**(a) Created Fri 23 Oct (1 Aban), `weekly(3)`, nothing logged.** W0 has one
applicable day and can reach credit 1 at most:

```
current = { unit: "week", count: 0, since: null }
best    = { days: 0, weeks: 0 }
open    = { start: 2026-10-17, requirement: 3, credit: 0 }
```

Nothing breaks (there is no prior run), and nothing is credited either. If W+1
is satisfied, `current = 1 week, since: 2026-10-24`. **No pro-rating** — a
Friday-created habit would otherwise start life "broken" or start with a
half-credit that no other week can match.

**(b) Created Wed 21 Oct, `weekly(3)`, logged Wed 21, Thu 22, Fri 23.** W0
reaches credit 3 and **starts** the streak:

```
current = { unit: "week", count: 1, since: 2026-10-21 }  // clamped to startedOn
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

A 15-day run cannot be expressed in weeks, so it is kept as `best.days` and the
new unit starts its own run. Switching back to `daily` later restores `best.days`
and starts a new day run at the next day period.

### E12 — a rest-day `done` is a bonus, not a bridge

`weekdays(Sat, Mon, Wed)`. Sat 17 Oct was **not logged**; done Mon 19, Wed 21,
**also done Thu 22** (not selected). `today` = Thu 22:

```
current = { unit: "day", count: 2, since: 2026-10-19 }  // Mon + Wed
```

Thursday does not extend the run (Wed → Sat is the next expected pair) and
cannot break it either. Its entry still paints a heatmap cell and adds weight to
the day-unit rate numerator (capped), so the effort is visible (R5, R13).

### E13 — a 7-day window has no closed week

`weekly(3)`, `today` Wed 21 Oct, `windowDays = 7` → window 15–21 Oct. W−1 ends
Fri 16 Oct but starts Sat 10 Oct, outside the window; W0 is open.

```
rate = null
```

This is structural, not an accident of the date: a closed counting week is seven
days long, so it can fit inside a seven-day window only by ending today — which
makes it the **open** week. For an X-times-a-week habit the 7-day tab therefore
shows the current week's progress («۲ از ۳ این هفته») while the week is short,
and its capped ratio once the week is satisfied; the first **closed** week enters
the rate on the 30-day tab. #66 must not render `0%` for a `null` rate.

### E14 — an explicit miss today vs a blank today

`weekdays(Sat, Mon, Wed)`, done Sat 17 and Mon 19, `today` Wed 21.

- **Blank today** → `current = 2`, open, not broken.
- **Missed today** → `current = 2`, open, `satisfied: false`, not broken yet.
  The heatmap shows a missed cell.
- **Missed yesterday** (Tue 20, had it been selected) → closed and unsatisfied →
  `current = 0`.

The break lands at the period's close, so cycling the wrong tap back to done on
the same day restores the streak.

### E15 — a week is not a month

W0 (25 Mehr – 1 Aban) is **one** period with one requirement of 3. The heatmap
(#66) paints its days across two Jalali months; the quota is not split, and the
monthly success rate is a day-weighted average over the window, not a per-month
quota.

### E16 — a missed day never subtracts

`weekly(3)`, W−1: done Mon 12, Tue 13, Wed 14, **missed** Thu 15.
`credit = 3` → satisfied; `weighted = 3` → 100%. The miss costs nothing beyond
the day it consumed; it does not undo the other three.

---

## 7. Traceability to the PRD's edge cases (§5.4)

| PRD edge case | Answered by |
|---|---|
| «روزهای بدون ثبت نباید به‌عنوان شکست قطعی تفسیر شوند؛ برای فراوانی X بار در هفته منطق انعطاف‌پذیر باشد» | R7, R8, R9, E1, E14: a blank day is "not a done", never a verdict inside an open period; a weekly habit absorbs up to `7 − times` blank days per week without breaking. |
| «تغییر فراوانی نباید آمار گذشته را بازنویسی کند» | R10, E10: entries are never rewritten; each period keeps the rule it opened with; eras never overlap. |
| «سال کبیسه و تغییر ساعت فصلی نباید در محاسبه زنجیره اختلال ایجاد کند» | R12, E8: `PlainDate` only; no instant arithmetic; Jalali leap days exist or do not exist as dates, never as 24 h offsets. |
| FR-HAB-03 «تعداد روزهای پیاپی» / acceptance "correct for 3×/week" | R4, §3: the unit follows the frequency; the badge names its unit (E1, E11). |

---

## 8. Consequences for the other tickets

### #63 — habit aggregate

- Add **`startedOn: LocalDate`** to `Habit` (the owner's local date at creation).
  `createdAt` is an instant; the day a habit began must not move when the owner
  changes time zone.
- `frequencyHistory` stores **eras**, and `effectiveFrom` is the era's first
  period start, computed at change time by the formula in §5.2. It is never
  back-dated: the UI offers "from now on" only, which is what keeps history
  immutable.
- `HabitEntry` keeps `UNIQUE(habit_id, date)` and the three-state status; entries
  are soft-deleted with the habit and purged after 30 days like other items.
- **No `kind` field in Must** (decided in #65): a medication habit is an ordinary
  daily habit with a strict streak. A "record instead of a streak" mode would
  need a habit kind and is explicitly deferred; #63 must not grow the field
  speculatively.
- **No cached streak columns.** The number is derived (§5.6).

### #64 — logging and backfill

- The ≤7-day backfill writes ordinary entries; nothing about it is special to
  the algorithm except that it can change a closed period *after* it closed
  (E5, E6).
- Idempotent upsert keeps one row per day; cycling the status overwrites, never
  appends.
- A tap on today is an entry in the **open** period: it advances the streak
  immediately when it earns credit (E2, E14).

### #66 — badge, stats, heatmap

- The badge prints `current.count` **with its unit** («۵ هفته پیاپی» /
  «۱۲ روز پیاپی») and, when the open period is unsatisfied, the progress
  (`open.credit` of `open.requirement`). It never prints a bare number.
- `rate === null` renders progress, not `0%`.
- `best` renders **the current unit's** best; don't compare `days` and `weeks`.
- The heatmap paints raw entry statuses (done / partial / missed / blank) and
  must not re-derive weights or quotas; the flame and the heatmap may disagree
  legitimately (a partial is green-ish and half-weight).
- Recompute on every entry change; the streak is not monotonic (E5, E6).
- A rest-day entry is painted and counted in the rate but never changes the
  streak (E12).

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
| **Cached streak counters** | Backfill and corrections make the streak non-monotonic (E5, E6); a counter would drift from the entries. |
