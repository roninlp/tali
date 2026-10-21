import { Schema } from "effect"
import { Model } from "effect/schema"
import { Temporal } from "temporal-polyfill/full"
import {
  commonItemFields,
  HabitEntryId,
  HabitId,
  LocalDate,
  TimestampUtc,
  TimeZone
} from "./common.js"
import { HouseholdId, UserId, Visibility } from "../common.js"

/**
 * `Habit` + `HabitEntry` aggregates (Slice 4 / ticket #63; FR-HAB-01/02).
 *
 * Source of truth: `docs/domain-model-draft.md` §3.2 and the shape decisions
 * recorded in `docs/adr/0006-habit-shape.md`.
 *
 * ## What a habit is
 *
 * A habit is a repeating intention — read, walk, take the medication — that
 * the user wants to keep up. The aggregate carries the common-item sync
 * contract (`commonItemFields`) plus the definition: a title, optional
 * description, colour/icon, the **frequency union** and an optional local
 * reminder time. It does **not** carry a streak, a success rate or a heatmap:
 * those are derived from the entries by the algorithm settled in #65, and
 * computing them here would freeze a decision the grilling ticket owns.
 *
 * ## Frequency is a union, and it is versioned
 *
 * `frequency` is one of three shapes, so "daily **and** three times a week" is
 * not representable:
 *
 * - `daily` — every day;
 * - `weekdays` — a non-empty, duplicate-free set of ISO weekdays (1 = Monday …
 *   7 = Sunday), i.e. "Mon/Wed/Fri";
 * - `weekly` — a target count per week (1..7), i.e. "3 times a week".
 *
 * `frequencyHistory` is the **versioned** form: one era per frequency the habit
 * has had, oldest first, each carrying the local date it took effect. The last
 * entry always equals the current `frequency`; a change appends a new era whose
 * boundary is computed at change time (the first period of the new frequency
 * after the period the change happened in has ended), never a back-dated date,
 * so eras never overlap and #65 can answer "what did this habit ask of the user
 * last month?" (FR-HAB-03's edge case).
 *
 * ## The habit owns a zone
 *
 * `timeZone` is the habit's own IANA zone, like a task's due date: the
 * reminder time is a **local** wall-clock time (`HH:mm`) and the history's
 * effective dates are local dates, so both stay unambiguous when the reader's
 * device is in another zone or the owner travels. It defaults to the owner's
 * profile zone at creation.
 *
 * ## `HabitEntry` is a separate row
 *
 * `HabitEntry` is deliberately **not** a common item: it has no title, no
 * colour, no owner-facing identity. It is the log — one row per
 * `(habitId, localDate)` — and the draft's open question #2 settled it as its
 * own table so a tap is one idempotent upsert and a 7/30/90-day window is one
 * indexed range scan.
 *
 * The daily tap itself (the status cycle, the ≤ 7-day backdating window) is
 * ticket #64; this module ships the shape, the table and the sync path the tap
 * will write through.
 */

// ── Frequency ─────────────────────────────────────────────────────────────

/** ISO weekday: 1 = Monday … 7 = Sunday (matching `RecurrenceRule.byDay`). */
export const HabitWeekday = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 }))
export type HabitWeekday = Schema.Schema.Type<typeof HabitWeekday>

/**
 * How often the habit is meant to happen.
 *
 * - `daily` — every calendar day.
 * - `weekdays` — the selected ISO weekdays. Non-empty and duplicate-free; an
 *   empty selection would mean "never", which is a deleted habit, not a
 *   frequency.
 * - `weekly` — `times` completions per week (1..7). Which days count is the
 *   streak algorithm's business (#65).
 */
export const HabitFrequency = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("daily") }),
  Schema.Struct({
    _tag: Schema.Literal("weekdays"),
    days: Schema.Array(HabitWeekday)
      .check(Schema.isMinLength(1), Schema.isUnique())
  }),
  Schema.Struct({
    _tag: Schema.Literal("weekly"),
    times: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 }))
  })
])
export type HabitFrequency = Schema.Schema.Type<typeof HabitFrequency>

/**
 * One **era** of a habit's frequency: the first local date it applies from.
 *
 * `effectiveFrom` is a wall date in the habit's own zone, so "from Saturday"
 * means the owner's Saturday, not UTC's. It is `startedOn` for the first era
 * and, for a change, the boundary computed at change time (see
 * `habitFrequencyHistoryAfter`): the first period of the new frequency after
 * the period the change happened in has ended. Eras therefore never overlap and
 * never leave a gap — the previous era implicitly runs until the next one
 * starts.
 */
export const HabitFrequencyChange = Schema.Struct({
  effectiveFrom: LocalDate,
  frequency: HabitFrequency
})
export type HabitFrequencyChange = Schema.Schema.Type<typeof HabitFrequencyChange>

/**
 * The version log: non-empty, oldest first, with **strictly increasing**
 * boundaries.
 *
 * Enforced at the model boundary because a duplicate or out-of-order boundary
 * would make "which frequency was in force on day X" ambiguous and could count
 * one day in two eras. Only the server writes this field (it is not in the
 * writable allowlist); the check is the last line of defence, not a client
 * validation rule.
 */
export const HabitFrequencyHistory = Schema.Array(HabitFrequencyChange).check(
  Schema.makeFilter<ReadonlyArray<HabitFrequencyChange>>((history) => {
    if (history.length === 0) {
      return "the frequency history must contain at least the starting era"
    }
    for (let index = 1; index < history.length; index += 1) {
      if (!(history[index]!.effectiveFrom > history[index - 1]!.effectiveFrom)) {
        return "frequency eras must have strictly increasing effective dates"
      }
    }
    return true
  })
)
export type HabitFrequencyHistory = Schema.Schema.Type<typeof HabitFrequencyHistory>

/** Local wall-clock time `HH:mm` (24h). Stored as text; the zone is the habit's. */
export const HabitReminderTime = Schema.String.check(
  Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)
)
export type HabitReminderTime = Schema.Schema.Type<typeof HabitReminderTime>

/**
 * Two frequencies are the same definition.
 *
 * The weekday selection is a *set*, so `[3, 1]` and `[1, 3]` are one
 * frequency: comparing them as arrays would record a phantom version on every
 * save that round-trips through a differently ordered control.
 */
export const sameHabitFrequency = (a: HabitFrequency, b: HabitFrequency): boolean =>
  canonicalHabitFrequency(a) === canonicalHabitFrequency(b)

const canonicalHabitFrequency = (frequency: HabitFrequency): string =>
  frequency._tag === "weekdays"
    ? JSON.stringify({
      _tag: "weekdays",
      days: [...frequency.days].sort((left, right) => left - right)
    })
    : JSON.stringify(frequency)

/**
 * The local calendar date of an instant in a zone.
 *
 * Used for a habit's `startedOn`: the day a habit began is the owner's wall
 * date, never the UTC date. Pure; the service and the sync merge both call it
 * so both write paths agree. Throws on an unusable instant/zone — trusted
 * inputs only; the sync path uses `localDateInOption`.
 */
export const localDateIn = (instant: string, timeZone: string): LocalDate =>
  Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDate().toString() as LocalDate

/**
 * As `localDateIn`, but a malformed instant or IANA zone yields `null`.
 *
 * The sync path receives both values from a client patch, so it must never
 * throw: a bad zone is later rejected by the `Habit`/`HabitEntry` schema as an
 * `InvalidPatch` instead of turning the whole push into a retryable 500.
 */
export const localDateInOption = (instant: string, timeZone: string): LocalDate | null => {
  try {
    return localDateIn(instant, timeZone)
  } catch {
    return null
  }
}

// ── Frequency eras (#65) ──────────────────────────────────────────────────

/** The counting unit of a frequency: day for daily/weekdays, week for weekly. */
const habitUnit = (frequency: HabitFrequency): "day" | "week" =>
  frequency._tag === "weekly" ? "week" : "day"

const addDays = (date: LocalDate, days: number): LocalDate =>
  Temporal.PlainDate.from(date).add({ days }).toString() as LocalDate

/** ISO weekday 6 = Saturday, 5 = Friday (the fixed counting week, #65). */
const SATURDAY = 6
const FRIDAY = 5

/** The last day of the period of `unit` containing `date`. */
const periodEndIn = (date: LocalDate, unit: "day" | "week"): LocalDate => {
  if (unit === "day") return date
  const dayOfWeek = Temporal.PlainDate.from(date).dayOfWeek
  return addDays(date, (FRIDAY - dayOfWeek + 7) % 7)
}

/** The first day of the next `unit` period strictly after `date`. */
const nextPeriodStartAfter = (date: LocalDate, unit: "day" | "week"): LocalDate => {
  if (unit === "day") return addDays(date, 1)
  const dayOfWeek = Temporal.PlainDate.from(date).dayOfWeek
  // A Saturday change belongs to the week that opened that day, so its next
  // boundary is a full week later.
  return addDays(date, ((SATURDAY - dayOfWeek + 7) % 7) || 7)
}

/**
 * The first date the next frequency era applies from (#65 §5.2).
 *
 * `max(first period start of the new unit after the change,
 *       end of the old period containing the change + 1 day)`.
 *
 * The old period always finishes under the frequency it opened with, so a
 * mid-week change never re-cuts the week in progress, and the two eras cannot
 * overlap. The result is always **strictly after** `changeDate`.
 */
const habitEraStartAfter = (input: {
  readonly previous: HabitFrequency
  readonly next: HabitFrequency
  readonly changeDate: LocalDate
}): LocalDate => {
  const afterOldPeriod = addDays(periodEndIn(input.changeDate, habitUnit(input.previous)), 1)
  const nextStart = nextPeriodStartAfter(input.changeDate, habitUnit(input.next))
  return afterOldPeriod > nextStart ? afterOldPeriod : nextStart
}

/**
 * Append (or replace) an era of the frequency. Pure, so the RPC service and
 * the offline sync merge cannot drift.
 *
 * `changeDate` is the owner's local date of the change **at the moment the
 * server applies it** — never a client edit day. An era boundary is therefore
 * never back-dated: a change can only take effect in a future period.
 *
 * - an unchanged frequency leaves the history exactly as it is (a no-op edit
 *   never grows the log);
 * - otherwise the new era starts at `habitEraStartAfter`;
 * - a second change before that boundary lands (two edits in the same period)
 *   replaces the pending era instead of stacking two eras on one boundary.
 */
export const habitFrequencyHistoryAfter = (input: {
  readonly history: ReadonlyArray<HabitFrequencyChange>
  readonly frequency: HabitFrequency
  readonly changeDate: LocalDate
}): ReadonlyArray<HabitFrequencyChange> => {
  const history = input.history
  const last = history[history.length - 1]
  if (last !== undefined && sameHabitFrequency(last.frequency, input.frequency)) {
    return history
  }
  if (last === undefined) {
    return [{ effectiveFrom: input.changeDate, frequency: input.frequency }]
  }
  const effectiveFrom = habitEraStartAfter({
    previous: last.frequency,
    next: input.frequency,
    changeDate: input.changeDate
  })
  // Keep the log strictly increasing. A boundary behind the stored one (a clock
  // that crossed it between the read and the write) updates the pending era
  // instead of rewriting an era that already started.
  return effectiveFrom <= last.effectiveFrom
    ? [...history.slice(0, -1), { effectiveFrom: last.effectiveFrom, frequency: input.frequency }]
    : [...history, { effectiveFrom, frequency: input.frequency }]
}

// ── Habit ─────────────────────────────────────────────────────────────────

export class Habit extends Model.Class<Habit>("Habit")({
  ...commonItemFields("habit", HabitId),
  /**
   * The habit's name. The model only checks the *shape* (a string): the
   * service enforces a non-empty title, because a tombstone row inserted by a
   * delete-only sync push carries an empty title by construction.
   */
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** Emoji or icon key chosen by the user; a free string, like a list's icon. */
  icon: Schema.NullOr(Schema.String),
  /**
   * The owner's local date the habit began (#65).
   *
   * A domain fact, not `createdAt`: the instant must not decide which day the
   * habit started when the owner changes zone, and the streak/statistics never
   * look before this date. Server-managed, like the history.
   */
  startedOn: LocalDate,
  /** The habit as it is defined today. */
  frequency: HabitFrequency,
  /**
   * Every frequency era, oldest first and strictly increasing; the last entry
   * equals `frequency`. A frequency change appends here instead of rewriting
   * the past.
   */
  frequencyHistory: HabitFrequencyHistory,
  /** Local `HH:mm` reminder time, or `null` for "no reminder time". */
  reminderTime: Schema.NullOr(HabitReminderTime),
  /** The habit's IANA zone; `reminderTime` and the history dates are read in it. */
  timeZone: TimeZone
}) {}

// ── HabitEntry ────────────────────────────────────────────────────────────

/** The three states a day can be logged with (FR-HAB-02). */
export const HabitEntryStatus = Schema.Literals(["done", "partial", "missed"])
export type HabitEntryStatus = Schema.Schema.Type<typeof HabitEntryStatus>

/**
 * One day's log for one habit.
 *
 * Keyed by `(habitId, localDate)` — enforced by a UNIQUE index on the table,
 * because schemas validate a row's shape, not cross-row uniqueness. It carries
 * the sync envelope's scope columns (`ownerId`/`householdId`/`visibility`)
 * denormalized so `/sync/pull` can filter it without a join, exactly like
 * every other synced row.
 *
 * `timeZone` is the zone `localDate` was written in: "the 3rd" stays the 3rd
 * when the entry is read from another zone (the per-item date rule).
 */
export class HabitEntry extends Model.Class<HabitEntry>("HabitEntry")({
  id: Model.UuidV7Insert(HabitEntryId),
  habitId: HabitId,
  /** The member whose log this is; entries are never reattributed. */
  ownerId: UserId,
  householdId: HouseholdId,
  /** The habit's visibility at write time; a private habit's log stays private. */
  visibility: Visibility,
  /** The local calendar date (`YYYY-MM-DD`) this entry logs. */
  localDate: LocalDate,
  /** The zone `localDate` was written in. */
  timeZone: TimeZone,
  status: HabitEntryStatus,
  createdAt: TimestampUtc,
  updatedAt: TimestampUtc,
  version: Schema.Int,
  deletedAt: Schema.NullOr(TimestampUtc)
}) {}
