import { Schema } from "effect"
import { Visibility } from "../common.js"
import { HabitEntryId, HabitId, LocalDate, TimeZone } from "./common.js"
import {
  HabitEntryStatus,
  HabitFrequency,
  HabitReminderTime
} from "./habit.js"

/**
 * HabitService contract (ticket #63; FR-HAB-01).
 *
 * The service is server-authoritative: it stamps `createdAt`/`updatedAt`/
 * `version`, seeds the frequency history, and validates the frequency union
 * and the local reminder time. Every mutation rides the #34 one-batch
 * version/feed/ledger path, so a habit the service writes is immediately
 * visible to `/sync/pull` at exactly the version the call returned.
 *
 * `clientMutationId` is the replay key the write path dedupes on
 * (`applied_mutations`), so an RPC retry after a lost response is
 * exactly-once.
 *
 * ## Delete and undo
 *
 * `delete` is a **soft** delete: the row keeps its identity and carries a
 * `deletedAt` tombstone, so the undo toast on the habits screen (#66) calls
 * `restore` with the same id and gets the habit back — no second habit, no
 * lost history. Both calls carry their own `clientMutationId`.
 *
 * ## The daily tap (#64)
 *
 * `HabitEntryLogInput` is the log mutation: one row per `(habitId, localDate)`
 * for all time, so a tap replaces the day's status instead of appending. The
 * server owns the backdating window (≤ 7 days in the viewer's local calendar)
 * and revives a tombstoned day in place — the generic sync push's
 * tombstone-wins rule refuses that, which is why the tap has a service/RPC
 * path of its own. `HabitEntryRangeInput` is the half-open range read that
 * Today and the statistics use.
 *
 * ## Not here
 *
 * The streak/stats maths (#65) and the screens (#66) are separate tickets. This
 * contract is definition + persistence + logging + sync only.
 */

// ── Typed errors (`docs/error-model-draft.md` §2) ────────────────────────

/** The habit does not exist, or is not visible to this viewer. */
export class HabitNotFound extends Schema.TaggedError<HabitNotFound>()("HabitNotFound", {
  id: HabitId
}) {}

/** The row exists but this viewer may not read/write it. */
export class HabitForbidden extends Schema.TaggedError<HabitForbidden>()("HabitForbidden", {
  id: Schema.NullOr(Schema.String),
  reason: Schema.Literals(["private", "household", "noHousehold"])
}) {}

/** Field-level validation (empty title, empty/duplicate weekdays, bad time, …). */
export class HabitValidationError extends Schema.TaggedError<HabitValidationError>()(
  "HabitValidationError",
  {
    issues: Schema.Array(
      Schema.Struct({
        field: Schema.String,
        message: Schema.String
      })
    )
  }
) {}

/** A concurrent writer won the version CAS; the caller may retry. */
export class HabitConflict extends Schema.TaggedError<HabitConflict>()("HabitConflict", {
  id: Schema.String
}) {}

/**
 * A tap outside the ≤ 7-day backdating window (#64; FR-HAB-02).
 *
 * The bounds are the inclusive local dates the tap could have used. This is a
 * **typed** refusal, never a clamp: silently writing "today" instead of the
 * day the user chose was the #63 review's finding, and the opposite mistake
 * (dropping the tap) would be just as wrong.
 */
export class HabitEntryOutOfWindow extends Schema.TaggedError<HabitEntryOutOfWindow>()(
  "HabitEntryOutOfWindow",
  {
    localDate: LocalDate,
    earliest: LocalDate,
    latest: LocalDate
  }
) {}

/** The replayed entry no longer exists (already purged past its trash window). */
export class HabitEntryNotFound extends Schema.TaggedError<HabitEntryNotFound>()(
  "HabitEntryNotFound",
  {
    id: HabitEntryId
  }
) {}

export const HabitServiceError = Schema.Union([
  HabitNotFound,
  HabitForbidden,
  HabitValidationError,
  HabitConflict,
  HabitEntryOutOfWindow,
  HabitEntryNotFound
])
export type HabitServiceError = Schema.Schema.Type<typeof HabitServiceError>

// ── Mutation inputs ──────────────────────────────────────────────────────

/**
 * The habit fields a create/patch carries.
 *
 * Kept in one place because the service input, the patch input and the domain
 * model must never drift: a field that is not listed here is not
 * client-writable. `frequencyHistory` and `startedOn` are server-managed (a
 * client edit could rewrite the past, or move the day the habit began), so they
 * are not in this list.
 */
const habitFields = {
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(Schema.String),
  frequency: HabitFrequency,
  reminderTime: Schema.NullOr(HabitReminderTime),
  timeZone: TimeZone
}

/** Create input. A habit needs a title and a frequency; everything else defaults. */
export const HabitCreateInput = Schema.Struct({
  /** A client may mint the UUID v7 offline; the server mints one otherwise. */
  id: Schema.optional(HabitId),
  clientMutationId: Schema.String,
  title: habitFields.title,
  frequency: habitFields.frequency,
  description: Schema.optional(habitFields.description),
  color: Schema.optional(habitFields.color),
  icon: Schema.optional(habitFields.icon),
  reminderTime: Schema.optional(habitFields.reminderTime),
  /** Defaults to the viewer's profile zone. */
  timeZone: Schema.optional(habitFields.timeZone),
  visibility: Schema.optional(Visibility)
})
export type HabitCreateInput = Schema.Schema.Type<typeof HabitCreateInput>

/** Patch-style habit fields; omitted fields keep their stored value. */
export const HabitPatch = Schema.Struct({
  title: Schema.optional(habitFields.title),
  description: Schema.optional(habitFields.description),
  color: Schema.optional(habitFields.color),
  icon: Schema.optional(habitFields.icon),
  frequency: Schema.optional(habitFields.frequency),
  reminderTime: Schema.optional(habitFields.reminderTime),
  timeZone: Schema.optional(habitFields.timeZone),
  visibility: Schema.optional(Visibility)
})
export type HabitPatch = Schema.Schema.Type<typeof HabitPatch>

export const HabitUpdateInput = Schema.Struct({
  id: HabitId,
  clientMutationId: Schema.String,
  /** Informational; the update re-reads and retries on a lost CAS. */
  baseVersion: Schema.optional(Schema.Int),
  patch: HabitPatch
})
export type HabitUpdateInput = Schema.Schema.Type<typeof HabitUpdateInput>

/** Delete/restore carry only the row id plus the replay key. */
export const HabitMutationInput = Schema.Struct({
  id: HabitId,
  clientMutationId: Schema.String
})
export type HabitMutationInput = Schema.Schema.Type<typeof HabitMutationInput>

/**
 * Log (or re-log) one habit day (#64; FR-HAB-02).
 *
 * `localDate` is the wall date being logged, in the **tap's** zone, and
 * `status` is the answer the tap computed — the client cycles Done → Partial →
 * Missed locally (`nextHabitEntryStatus`) so the write is already complete when
 * it lands in the mirror. The server validates the day against the ≤ 7-day
 * window in the viewer's zone, resolves the day's existing row (live or
 * tombstoned) by `(habitId, localDate)` and updates it in place; `id` is only
 * used when the day has never been logged, so two devices can never end up
 * with two rows for one day.
 *
 * `visibility` is deliberately absent: the entry inherits the habit's, exactly
 * like the sync path, so a tap can never widen a private habit's log.
 */
export const HabitEntryLogInput = Schema.Struct({
  /** A client-minted id for a brand-new day; ignored when the day has a row. */
  id: Schema.optional(HabitEntryId),
  clientMutationId: Schema.String,
  habitId: HabitId,
  localDate: LocalDate,
  status: HabitEntryStatus,
  /** The zone the tap happened in; defaults to the viewer's profile zone. */
  timeZone: Schema.optional(TimeZone)
})
export type HabitEntryLogInput = Schema.Schema.Type<typeof HabitEntryLogInput>

/**
 * The range read that feeds Today and the statistics (#64 → #66).
 *
 * `[from, before)` is half-open, matching every other date-range read in the
 * codebase: consecutive windows concatenate without counting a day twice. The
 * result is scoped to the viewer's household and to their own or shared
 * entries, so a private habit's log cannot leak through this read.
 */
export const HabitEntryRangeInput = Schema.Struct({
  from: LocalDate,
  before: LocalDate,
  habitId: Schema.optional(HabitId)
})
export type HabitEntryRangeInput = Schema.Schema.Type<typeof HabitEntryRangeInput>

// ── Query inputs ─────────────────────────────────────────────────────────

/**
 * Listing habits has no filters in the Must slice: they are one personal list
 * per member, and the list is read whole (like lists and tags). The
 * date-range reads belong to the entries (#64) and the streak/stats windows
 * (#65/#66), and go through `HabitEntryRepo` rather than this contract.
 */
