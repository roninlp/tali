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
 * `frequencyHistory` is the **versioned** form: one entry per frequency the
 * habit has had, oldest first, each carrying the local date it took effect.
 * The last entry always equals the current `frequency`; a change appends
 * (or replaces same-day) instead of rewriting the past, so the stats #65
 * defines can answer "what did this habit ask of the user last month?"
 * without a migration (FR-HAB-03's edge case).
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
 * One version of a habit's frequency: the local date it started applying.
 *
 * `effectiveFrom` is a wall date in the habit's own zone, so "from Saturday"
 * means the owner's Saturday, not UTC's.
 */
export const HabitFrequencyChange = Schema.Struct({
  effectiveFrom: LocalDate,
  frequency: HabitFrequency
})
export type HabitFrequencyChange = Schema.Schema.Type<typeof HabitFrequencyChange>

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
 * Used for the history's `effectiveFrom`: the day a change takes effect is
 * the owner's wall date, never the UTC date. Pure; the service and the sync
 * merge both call it so both write paths agree.
 */
export const localDateIn = (instant: string, timeZone: string): LocalDate =>
  Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDate().toString() as LocalDate

/**
 * Append (or replace) a version of the frequency. Pure, so the RPC service and
 * the offline sync merge cannot drift.
 *
 * - an unchanged frequency leaves the history exactly as it is (a no-op edit
 *   never grows the log);
 * - the same effective day replaces the last entry, so editing a habit twice
 *   on one day records one version, not two;
 * - otherwise the new version is appended and the previous one keeps the date
 *   it started on.
 */
export const habitFrequencyHistoryAfter = (input: {
  readonly history: ReadonlyArray<HabitFrequencyChange>
  readonly frequency: HabitFrequency
  readonly effectiveFrom: LocalDate
}): ReadonlyArray<HabitFrequencyChange> => {
  const history = input.history
  const last = history[history.length - 1]
  if (last !== undefined && sameHabitFrequency(last.frequency, input.frequency)) {
    return history
  }
  const next = { effectiveFrom: input.effectiveFrom, frequency: input.frequency }
  return last !== undefined && last.effectiveFrom === input.effectiveFrom
    ? [...history.slice(0, -1), next]
    : [...history, next]
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
  /** The habit as it is defined today. */
  frequency: HabitFrequency,
  /**
   * Every frequency the habit has had, oldest first; the last entry equals
   * `frequency`. A frequency change appends here instead of rewriting the past.
   */
  frequencyHistory: Schema.Array(HabitFrequencyChange),
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
