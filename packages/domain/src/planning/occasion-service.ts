import { Schema } from "effect"
import { Visibility } from "../common.js"
import { LocalDate, OccasionId, TimeZone } from "./common.js"
import { Occasion } from "./occasion.js"
import {
  OccasionAdvanceReminder,
  OccasionOccurrence
} from "./occasion-projection.js"
import { Task } from "./task.js"

/**
 * `OccasionService` contract (ticket #59; FR-CAL-02).
 *
 * The service is server-authoritative like the other Slice-2/3 aggregates: it
 * stamps versions/timestamps, mints ids the client did not, validates the
 * origin date and the offset, and writes through the #34 one-batch
 * version/feed/ledger path. `clientMutationId` makes every mutation replay-safe.
 *
 * The read side never materialises a year: `occurrences` projects the origin
 * date into the requested window and `advanceReminders` derives the offset
 * reminders for #60 to materialise. `prepareTask` is the one write that touches
 * a second aggregate (a real task row) and it does so atomically.
 */

// ── Typed errors (`docs/error-model-draft.md` §2) ────────────────────────

/** The occasion does not exist, or is not visible to this viewer. */
export class OccasionNotFound extends Schema.TaggedError<OccasionNotFound>()(
  "OccasionNotFound",
  { id: OccasionId }
) {}

/** The row exists but this viewer may not read/write it. */
export class OccasionForbidden extends Schema.TaggedError<OccasionForbidden>()(
  "OccasionForbidden",
  {
    id: Schema.NullOr(Schema.String),
    reason: Schema.Literals(["private", "household", "noHousehold"])
  }
) {}

/** Field-level validation (empty title, impossible date, bad offset, …). */
export class OccasionValidationError extends Schema.TaggedError<OccasionValidationError>()(
  "OccasionValidationError",
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
export class OccasionConflict extends Schema.TaggedError<OccasionConflict>()(
  "OccasionConflict",
  { id: Schema.String }
) {}

export const OccasionServiceError = Schema.Union([
  OccasionNotFound,
  OccasionForbidden,
  OccasionValidationError,
  OccasionConflict
])
export type OccasionServiceError = Schema.Schema.Type<typeof OccasionServiceError>

// ── Mutation inputs ──────────────────────────────────────────────────────

const advanceDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 365 }))
)

const occasionFields = {
  title: Schema.String,
  originDate: LocalDate,
  timeZone: TimeZone,
  yearly: Schema.Boolean,
  advanceReminderDays: advanceDays,
  color: Schema.NullOr(Schema.String)
}

export const OccasionCreateInput = Schema.Struct({
  /** A client may mint the UUID v7 offline; the server mints one otherwise. */
  id: Schema.optional(OccasionId),
  clientMutationId: Schema.String,
  title: occasionFields.title,
  originDate: occasionFields.originDate,
  timeZone: Schema.optional(occasionFields.timeZone),
  yearly: Schema.optional(occasionFields.yearly),
  advanceReminderDays: Schema.optional(occasionFields.advanceReminderDays),
  color: Schema.optional(occasionFields.color),
  visibility: Schema.optional(Visibility)
})
export type OccasionCreateInput = Schema.Schema.Type<typeof OccasionCreateInput>

/** Patch-style fields; omitted fields keep their stored value. */
export const OccasionPatch = Schema.Struct({
  title: Schema.optional(occasionFields.title),
  originDate: Schema.optional(occasionFields.originDate),
  timeZone: Schema.optional(occasionFields.timeZone),
  yearly: Schema.optional(occasionFields.yearly),
  advanceReminderDays: Schema.optional(occasionFields.advanceReminderDays),
  color: Schema.optional(occasionFields.color),
  visibility: Schema.optional(Visibility)
})
export type OccasionPatch = Schema.Schema.Type<typeof OccasionPatch>

export const OccasionUpdateInput = Schema.Struct({
  id: OccasionId,
  clientMutationId: Schema.String,
  /** Informational; the update re-reads and retries on a lost CAS. */
  baseVersion: Schema.optional(Schema.Int),
  patch: OccasionPatch
})
export type OccasionUpdateInput = Schema.Schema.Type<typeof OccasionUpdateInput>

export const OccasionMutationInput = Schema.Struct({
  id: OccasionId,
  clientMutationId: Schema.String
})
export type OccasionMutationInput = Schema.Schema.Type<typeof OccasionMutationInput>

// ── Queries ──────────────────────────────────────────────────────────────

/** Inclusive `from` / `to` local-date window (the projection's convention). */
export const OccasionOccurrenceQuery = Schema.Struct({
  from: LocalDate,
  to: LocalDate
})
export type OccasionOccurrenceQuery = Schema.Schema.Type<typeof OccasionOccurrenceQuery>

/** The one-tap preparation task request. */
export const OccasionPrepareInput = Schema.Struct({
  id: OccasionId,
  clientMutationId: Schema.String,
  /** The occurrence to prepare for; defaults to the next one from today. */
  occurrenceDate: Schema.optional(LocalDate),
  /** Overrides the default task title (`آمادهسازی برای <occasion>`). */
  title: Schema.optional(Schema.String),
  /** Overrides the default due date (the advance-reminder date). */
  dueDate: Schema.optional(LocalDate)
})
export type OccasionPrepareInput = Schema.Schema.Type<typeof OccasionPrepareInput>

/**
 * An occasion plus its next projected occurrence and advance reminder.
 * `next`/`nextReminder` are `null` for a one-off date that already passed.
 */
export const OccasionDetail = Schema.Struct({
  occasion: Occasion,
  next: Schema.NullOr(OccasionOccurrence),
  nextReminder: Schema.NullOr(OccasionAdvanceReminder)
})
export type OccasionDetail = Schema.Schema.Type<typeof OccasionDetail>

/** The result of the one-tap preparation: the updated occasion and the task. */
export const OccasionPreparation = Schema.Struct({
  occasion: Occasion,
  task: Task,
  /** `false` when a live preparation task already existed (idempotent tap). */
  created: Schema.Boolean
})
export type OccasionPreparation = Schema.Schema.Type<typeof OccasionPreparation>
