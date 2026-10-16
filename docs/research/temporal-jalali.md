# Research: Temporal API for Jalali (Persian) dates and recurrence

- Ticket: https://github.com/roninlp/tali/issues/5
- Date: 2026-10-16
- Question: What does Temporal (current stage) support for the Persian (Jalali) calendar via Intl, and can it carry the Must recurrence + date-math needs with no external date dependency?

## TL;DR

1. **Temporal is Stage 4** (finalized at the TC39 March 2026 meeting; it is the date/time API of ECMAScript 2026). It is **shipped and on by default** in Firefox 139+, Chrome/Edge 144+, and Node.js 26. Safari is partial (Technology Preview). Two polyfills exist for the gap.
2. **Yes, `persian` works with Temporal.** The `persian` calendar identifier (the Solar Hijri / Jalali calendar) is a sanctioned Intl calendar, listed in the ECMA-402-supported calendar set and usable both for display (`Intl.DateTimeFormat`) and for Temporal date objects, arithmetic, and field access. Temporal's "Full support for non-Gregorian calendars" explicitly covers the Persian calendar.
3. **Leap-year and month-boundary correctness is delegated to ICU** (the host Intl implementation), which implements the Solar Hijri calendar (12 months, 29–31 days, 30-day Esfand in leap years). Temporal exposes `inLeapYear`, `daysInMonth`, `daysInYear`, `monthsInYear`, `monthCode`, and `with()`/`add()` with defined overflow handling. Correctness is as good as ICU's Persian calendar — a mature, independent implementation, *not* jalaali-js.
4. **IANA timezone handling is first-class** (`Temporal.ZonedDateTime`, `Temporal.TimeZone`, DST-safe arithmetic, IANA primary-identifier normalization).
5. **The recurrence layer does not exist in Temporal.** There is no `Temporal.Recurrence` / RRULE / `COUNT` / `UNTIL` / occurrence-exception API. Temporal provides only the *primitives* (immutable dates, `add`/`subtract`/`with`, `dayOfWeek`, `daysInMonth`, `PlainMonthDay`), and the official cookbook shows recurrence patterns hand-rolled on top. So recurrence + exceptions **must** be hand-rolled regardless — but Temporal + Intl can carry all the underlying *date math* with no external date dependency.

---

## 1. Status: stage and availability

- **Stage 4.** Temporal reached Stage 4 at the TC39 March 2026 meeting and becomes part of ECMAScript 2026. The proposal repo's landing page is titled "Stage 4 Draft / July 27, 2026". Source: https://github.com/tc39/proposal-temporal , https://tc39.es/proposal-temporal , https://socket.dev/blog/tc39-advances-temporal-to-stage-4
- **Ship status** (from the Bloomberg announcement and Node.js release notes):
  - Firefox 139 (May 2025) — first to ship by default.
  - Chrome 144 and Edge 144 (January 2026) — shipped by default (V8).
  - Node.js 26.0.0 (2026-05-05) — "The Temporal API is now enabled by default in Node.js 26… without any flags or experimental settings." Source: https://nodejs.org/en/blog/release/v26.0.0
  - Safari — partial, Technology Preview.
  - TypeScript 6.0 (Feb 2026) — type definitions.
  - Polyfills: `@js-temporal/polyfill` (champions, alpha), `temporal-polyfill` (FullCalendar, stable), `temporal-polyfill-lite` (RC). Source: https://bloomberg.github.io/js-blog/post/temporal , https://github.com/tc39/proposal-temporal

MDN still flags Temporal as "Limited availability / not Baseline" because Safari is partial. Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal

**Practical implication for Tali:** the backend (Node 26 / Effect) can use Temporal today with no polyfill. The frontend (Solid/SolidStart) must either polyfill for Safari or keep the browser bundle on a polyfill until Safari ships.

## 2. Does the `persian` calendar work with Temporal? Yes.

- The ECMA-402-supported calendar set (the table `Intl.supportedValuesOf("calendar")` returns) includes `persian`, documented as: **"Persian (or Solar Hijri) calendar, proleptic. There is one era."** MDN states these calendar values "can be used for the `calendar` option … as well as for creating `Temporal` date objects." Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/supportedValuesOf
- The epoch is the Hijri/Solar Hijri epoch: `persian` uses "year: 1 … corresponds to the ISO year 622" (so Jalali year ≈ ISO year − 621). Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal/PlainDate/year
- The proposal's own docs name the Persian calendar among the calendars Temporal supports ("the Chinese calendar, the Hebrew Calendar, the Coptic calendar, the Persian calendar, one of several Islamic calendars…"), and the proposal intro lists "Full support for non-Gregorian calendars" as a headline feature. Source: https://tc39.es/proposal-temporal , https://github.com/tc39/proposal-temporal

Usage shape (from the proposal's calendar docs):

```js
// Construct in the Persian calendar from a field bag
Temporal.PlainDate.from({ year: 1403, month: 7, day: 15, calendar: 'persian' });

// Or convert an ISO date into the Persian calendar
Temporal.PlainDate.from('2024-10-06').withCalendar('persian');

// Read Persian fields
date.year;        // Jalali year (1403…)
date.month;       // 1..12, continuous
date.monthCode;   // 'M01'..'M12'
date.day;
date.inLeapYear;  // Esfand has 30 days this year?
date.daysInYear;  // 365 or 366
date.monthCode;   // stable month identifier
```

Source: https://github.com/tc39/proposal-temporal/blob/main/docs/calendar-review.md

## 3. How Temporal models non-ISO calendars (important for correctness)

Temporal stores every date **internally as its ISO date** and treats a non-ISO calendar as a **projection** over it. "Internally, the day is always represented in the ISO calendar… Operations on Temporal instances interpret all month, day, and year values in context of the calendar system." So `date.add({ months: 1 })`, `date.with({ day: 1 })`, and all field getters route through the attached calendar. Source: https://github.com/tc39/proposal-temporal/blob/main/docs/calendar-review.md

The calendar-agnostic invariants hold for all built-in calendars, which is what makes the code safe:

- `obj.with({ day: Number.MAX_VALUE })` → last day of the month.
- `obj.with({ month: obj.monthsInYear, day: Number.MAX_VALUE })` → last day of the year.
- `dayOfWeek`, `dayOfYear`, `weekOfYear` are 1-based and increment consecutively, resetting at week/year boundaries.
- `monthsInYear`, `daysInMonth`, `daysInYear`, `inLeapYear` are the calendar-correct values.

Source: https://tc39.es/proposal-temporal/docs/calendars.html

Leap-day/month-boundary edge handling is specified: when `with()`/`from()` receive a month/day that does not exist in the target year, an `overflow` option (default "constrain") picks the closest valid day in that month (or the nearest valid date). Source: https://tc39.es/proposal-temporal/docs/calendars.html

**Correctness caveat (to verify in tests, not a blocker):** Temporal does not ship its own Persian arithmetic — it delegates to the host's Intl/ICU calendar. ICU's Persian (Solar Hijri) calendar is a mature, widely-used implementation, but it is **not** jalaali-js, and their leap-year rules can differ for pre-modern dates. The feature map currently names jalaali-js as "the only date-math location." If Tali standardizes on Temporal + Intl `persian`, the two implementations should be cross-checked over the supported date range (modern dates will agree; historical pre-~1178 AH dates may diverge). This is a *test* obligation, not a reason to keep jalaali-js.

## 4. IANA timezone handling — covered

- `Temporal.ZonedDateTime` is "an instant paired with a specific time zone"; `Temporal.TimeZone` models the zone itself; `Temporal.Instant` is an exact moment with no zone/calendar. DST-safe arithmetic is a headline feature ("First-class support for all time zones, including DST-safe arithmetic"). Source: https://tc39.es/proposal-temporal , https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal
- `Intl.supportedValuesOf("timeZone")` returns the IANA set, and the Temporal standard "requires browsers to always return the primary identifier in the IANA database" (e.g. `Asia/Kolkata`, not `Asia/Calcutta`). Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/supportedValuesOf
- This directly satisfies the feature-map requirements: "Store instants as timestamptz" (`Instant`/`ZonedDateTime`) and "all-day as date + IANA timezone" (`PlainDate` + `timeZoneId`); "user profile timezone captured once." Source: `docs/must-have-feature-map.html` FR-CAL-05, CC-04.

## 5. The recurrence layer is NOT in Temporal — the core gap

Temporal's complete type surface is: `Instant`, `ZonedDateTime`, `PlainDateTime`, `PlainDate`, `PlainTime`, `PlainYearMonth`, `PlainMonthDay`, `Duration`, plus the `Now`, `Calendar`, and `TimeZone` namespaces. There is **no recurrence / RRULE / repeat type**, and no `COUNT` / `UNTIL` / `EXDATE` (exception) machinery. Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal , https://tc39.es/proposal-temporal

The official cookbook contains recipes titled "Daily occurrence in local time", "Nth weekday of the month", "Next weekly occurrence", and "Weekday of yearly occurrence" — each implemented **manually** with `add({days})`, `dayOfWeek`, `daysInMonth`, and `PlainYearMonth.toPlainDate({day})`. Their existence as *recipes* (not API) confirms recurrence is a build-it-yourself concern. Source: https://tc39.es/proposal-temporal/docs/cookbook.html

A second, compounding fact: the standard recurrence grammar (iCalendar `RRULE`, RFC 5545) is **Gregorian by default**. Non-Gregorian recurrence (e.g. Jalali) requires the RFC 7529 **`RSCALE`** extension, which is rarely implemented by RRULE libraries. So even a third-party `rrule` library would not give correct Jalali recurrence out of the box. Source: https://www.rfc-editor.org/info/rfc7529

**Conclusion:** the recurrence engine is a hand-rolled layer *no matter what*. The question is only whether the *date math underneath* it can be dependency-free — and the answer is **yes**: Temporal + Intl `persian` provides correct Jalali year/month/day arithmetic, leap detection, month boundaries, day-of-week, and timezone-aware instants, so jalaali-js (and any other external date-math dependency) can be dropped.

## 6. Requirement-by-requirement gap analysis

| Must requirement (from feature map) | Temporal + Intl `persian` support | Gap / notes |
|---|---|---|
| **Daily** | Buildable: `date.add({ days: 1 })` loop; cookbook "Daily occurrence in local time" | No built-in recurrence; hand-roll an iterator. |
| **Weekly, selected weekdays** | Buildable: `dayOfWeek` (1-based, calendar-dependent) + `add({ days: 7 })`; cookbook "Next weekly occurrence" | Weekday semantics for Persian: `dayOfWeek` is calendar-defined; week *start* is a formatting/config concern via `Intl.Locale.getWeekInfo()`. Hand-roll. |
| **Monthly, specific day** | Buildable: `with({ day: N })` with `overflow` handling (clamps 31→30, 30→29 in non-leap Esfand) | Hand-roll; overflow policy must be chosen. |
| **Monthly, nth weekday** | Buildable: cookbook "Nth weekday of the month" recipe (first/last/nth weekday from `dayOfWeek` + `daysInMonth`) | Hand-roll; recipe covers first/second/last. |
| **Yearly** | Buildable: `add({ years: 1 })`, or `PlainMonthDay.toPlainDate({ year })` (cookbook "Birthday in 2030", "Weekday of yearly occurrence") | Persian has a leap *day* (Esfand 30), not a leap month, so `PlainMonthDay.toPlainDate` handles the Feb-29-style edge cleanly. Hand-roll. |
| **Occasion-annual** (origin local date + timezone, advance reminder) | Buildable: `PlainMonthDay` (month/day + calendar) + `toPlainDate({year})` + `ZonedDateTime` for the reminder instant | Hand-roll the "N days before" offset expansion. |
| **End by date OR count** | Trivial loop termination against `Temporal.PlainDate.compare` | No `UNTIL`/`COUNT` primitive; hand-roll (and store them as your own rule fields). |
| **Occurrence exceptions** (delete/override "this occurrence", "this and following") | **No support at all.** Temporal has no exception/exclusion model. | Must be stored (exception table) and applied during your expansion. Fully hand-rolled. |
| **RRULE expression validation** (feature map FR-CAL-03) | **No support.** No parser/validator exists in Temporal. | Hand-roll a rule schema (or adapt an RRULE grammar); note RSCALE caveat above. |
| **Occurrence expansion cache** (feature map) | No built-in cache; but Temporal objects are immutable, so caching expanded `PlainDate`/`Instant` results is natural. | Hand-roll the cache keyed on (rule, range, timezone). |
| **Recurring tasks** ("on completion" / "on due date" modes) | Same as above — next-instance generation via `add`/`with` primitives, idempotently. | Hand-roll; Temporal gives the arithmetic, not the mode logic. |
| **Jalali↔Gregorian conversion + display** | **Covered.** `withCalendar('persian')` / `toLocaleString(..., {calendar:'persian'})`; `Intl.DateTimeFormat` with `calendar: 'persian'`; Persian digits via `Intl.NumberFormat('fa-IR')` numbering system (`arabext`). | Replaces jalaali-js conversion and jalaali display code. |
| **Accurate conversion (leap years, month boundaries)** | **Covered** via ICU Persian calendar + `inLeapYear`/`daysInMonth`/`daysInYear` + overflow handling. | Verify ICU-vs-jalaali-js equivalence across the supported range (test obligation). |
| **IANA timezone** | **Covered** (`ZonedDateTime`, `TimeZone`, DST-safe). | None. |

## 7. Bottom line

- **Date math / calendar / timezone: Temporal + Intl `persian` fully carries it.** No jalaali-js, no date-fns, no Luxon required for Jalali conversion, leap-year/month-boundary correctness, day-of-week, or IANA timezone handling.
- **Recurrence + exceptions: not in Temporal, not in any single Intl primitive.** This is a hand-rolled layer regardless of approach — recurrence rules (freq, by-day, by-month-day, nth-weekday, end-by-count/date), occurrence expansion, and per-occurrence exception storage all live in Tali's `RecurrenceService`/`CalendarService` (feature map), which should be built *on top of* Temporal primitives.
- **One architectural consequence:** the feature map currently pins jalaali-js as "the only date-math location." That should be revised to Temporal + Intl `persian` (with a test that cross-checks against jalaali-js/ICU during migration), since Temporal is now the standard, dependency-free path and jalaali-js becomes a redundant external dependency.

## Sources (primary)

- TC39 Temporal proposal (Stage 4): https://github.com/tc39/proposal-temporal ; https://tc39.es/proposal-temporal
- TC39 Temporal calendar design: https://github.com/tc39/proposal-temporal/blob/main/docs/calendar-review.md
- TC39 Temporal calendars doc (invariants, overflow, leap handling): https://tc39.es/proposal-temporal/docs/calendars.html
- TC39 Temporal cookbook (recurrence recipes): https://tc39.es/proposal-temporal/docs/cookbook.html
- MDN Temporal: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal
- MDN Temporal.PlainDate (incl. calendar annotation `[u-ca=…]`): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal/PlainDate
- MDN Temporal.PlainDate.prototype.year (persian epoch 622 CE): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal/PlainDate/year
- MDN Intl.supportedValuesOf (persian = Solar Hijri; timezone primary identifiers): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/supportedValuesOf
- MDN Intl.Locale.prototype.getCalendars: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Locale/getCalendars
- Node.js 26.0.0 release (Temporal enabled by default): https://nodejs.org/en/blog/release/v26.0.0
- Bloomberg JS Blog (ship matrix: Firefox 139 / Chrome 144 / Edge 144 / TS 6.0 / Node 26): https://bloomberg.github.io/js-blog/post/temporal
- Socket (Stage 4): https://socket.dev/blog/tc39-advances-temporal-to-stage-4
- RFC 7529 (RSCALE — non-Gregorian recurrence in iCalendar): https://www.rfc-editor.org/info/rfc7529
