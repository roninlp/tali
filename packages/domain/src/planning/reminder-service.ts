import { Schema } from "effect"
import { Visibility } from "../common.js"
import { ReminderDispatchId, ReminderId, TimeZone, TimestampUtc } from "./common.js"
import {
  ClockTime,
  DispatchResponse,
  IsoWeekday,
  ReminderDispatch,
  ReminderInboxItem,
  ReminderRepeat,
  ReminderType
} from "./reminder.js"
import { ReminderLink } from "./reminder-link.js"

/**
 * `ReminderService` contract (ticket #60; FR-REM-01/03).
 *
 * The service owns the write-time derivations the model cannot: `tier` from
 * `kind`, and `fireAt` from the repeat + the linked item's instant. A client
 * may create a reminder offline through the sync path, but the RPC/HTTP path
 * is the authoritative one for linked reminders and for the response log.
 *
 * `clientMutationId` is the replay key the write path dedupes on
 * (`applied_mutations`), so a retried create/update/delete is exactly-once.
 */

/** The reminder fields a create/patch carries. */
const reminderFields = {
  title: Schema.String,
  note: Schema.NullOr(Schema.String),
  kind: ReminderType,
  repeat: ReminderRepeat,
  /** Only needed for a one-off reminder with no schedulable link. */
  fireAt: Schema.NullOr(TimestampUtc),
  offsetMinutes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  link: ReminderLink,
  silencedUntil: Schema.NullOr(TimestampUtc),
  timeZone: TimeZone,
  color: Schema.NullOr(Schema.String),
  visibility: Visibility
}

export const ReminderCreateInput = Schema.Struct({
  /** A client may mint the UUID v7 offline; the server mints one otherwise. */
  id: Schema.optional(ReminderId),
  clientMutationId: Schema.String,
  title: Schema.String.check(Schema.isMinLength(1)),
  kind: reminderFields.kind,
  repeat: reminderFields.repeat,
  note: Schema.optional(reminderFields.note),
  /** Required only when a `once` reminder has no task/event link. */
  fireAt: Schema.optional(reminderFields.fireAt),
  /** Lead time before a linked item's instant; ignored by pattern reminders. */
  offsetMinutes: Schema.optional(reminderFields.offsetMinutes),
  link: Schema.optional(reminderFields.link),
  silencedUntil: Schema.optional(reminderFields.silencedUntil),
  timeZone: Schema.optional(reminderFields.timeZone),
  color: Schema.optional(reminderFields.color),
  visibility: Schema.optional(reminderFields.visibility)
})
export type ReminderCreateInput = Schema.Schema.Type<typeof ReminderCreateInput>

/** Patch-style fields; omitted fields keep their stored value. */
export const ReminderPatch = Schema.Struct({
  title: Schema.optional(reminderFields.title),
  note: Schema.optional(reminderFields.note),
  kind: Schema.optional(reminderFields.kind),
  repeat: Schema.optional(reminderFields.repeat),
  fireAt: Schema.optional(reminderFields.fireAt),
  offsetMinutes: Schema.optional(reminderFields.offsetMinutes),
  link: Schema.optional(reminderFields.link),
  silencedUntil: Schema.optional(reminderFields.silencedUntil),
  timeZone: Schema.optional(reminderFields.timeZone),
  color: Schema.optional(reminderFields.color),
  visibility: Schema.optional(reminderFields.visibility)
})
export type ReminderPatch = Schema.Schema.Type<typeof ReminderPatch>

export const ReminderUpdateInput = Schema.Struct({
  id: ReminderId,
  clientMutationId: Schema.String,
  /** Informational; the update re-reads and retries on a lost CAS. */
  baseVersion: Schema.optional(Schema.Int),
  patch: ReminderPatch
})
export type ReminderUpdateInput = Schema.Schema.Type<typeof ReminderUpdateInput>

/** Delete carries only the row id plus the replay key. */
export const ReminderMutationInput = Schema.Struct({
  id: ReminderId,
  clientMutationId: Schema.String
})
export type ReminderMutationInput = Schema.Schema.Type<typeof ReminderMutationInput>

export const ReminderListInput = Schema.Struct({
  /** Include trashed rows (the 30-day trash view). */
  includeDeleted: Schema.optional(Schema.Boolean)
})
export type ReminderListInput = Schema.Schema.Type<typeof ReminderListInput>

// ── Ledger responses (FR-REM-03) ─────────────────────────────────────────

/**
 * The Done/Snooze/Dismiss answer for one dispatch (ADR-0005 §6).
 *
 * `snoozeMinutes` is required for `snooze` and must be one of
 * `{5, 10, 15, 30, 60}`; a double tap is a no-op that returns the stored
 * answer rather than answering twice.
 */
export const ReminderRespondInput = Schema.Struct({
  dispatchId: ReminderDispatchId,
  response: DispatchResponse,
  snoozeMinutes: Schema.optional(Schema.Int)
})
export type ReminderRespondInput = Schema.Schema.Type<typeof ReminderRespondInput>

/** The answered dispatch, the snooze child (if any), and the on-time verdict. */
export const ReminderResponseResult = Schema.Struct({
  dispatch: ReminderDispatch,
  child: Schema.NullOr(ReminderDispatch),
  onTime: Schema.Boolean
})
export type ReminderResponseResult = Schema.Schema.Type<typeof ReminderResponseResult>

/** `GET /reminders/inbox` payload (the ledger view + reminder summaries). */
export const ReminderInboxResponse = Schema.Struct({
  items: Schema.Array(ReminderInboxItem)
})
export type ReminderInboxResponse = Schema.Schema.Type<typeof ReminderInboxResponse>

/** `history=true` asks for the rows that rolled off the inbox view. */
export const ReminderInboxQuery = Schema.Struct({
  history: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })))
})
export type ReminderInboxQuery = Schema.Schema.Type<typeof ReminderInboxQuery>

/** A local-time repeat pattern the UI offers as a preset ("every 8 hours"). */
export const ReminderRepeatPreset = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  repeat: ReminderRepeat
})
export type ReminderRepeatPreset = Schema.Schema.Type<typeof ReminderRepeatPreset>

/**
 * The common patterns FR-REM-01 names. Kept in the shared package so the
 * client's picker and the server's validator speak the same set.
 */
export const REMINDER_REPEAT_PRESETS: ReadonlyArray<{
  readonly id: string
  readonly label: string
  readonly repeat: ReminderRepeat
}> = [
  { id: "once", label: "یک‌بار", repeat: { _tag: "once" } },
  { id: "daily-22", label: "هر روز ۲۲:۰۰", repeat: { _tag: "daily", time: "22:00" } },
  { id: "daily-08", label: "هر روز ۰۸:۰۰", repeat: { _tag: "daily", time: "08:00" } },
  { id: "weekly-friday", label: "هر جمعه ۱۰:۰۰", repeat: { _tag: "weekly", days: [5], time: "10:00" } },
  { id: "interval-8h", label: "هر ۸ ساعت", repeat: { _tag: "interval", hours: 8 } }
]

/** A clock time is a valid local pattern input for the presets/pickers. */
export const isClockTime = (value: string): value is ClockTime => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)

/** A weekday is in the 1..7 ISO range. */
export const isIsoWeekday = (value: number): value is IsoWeekday =>
  Number.isInteger(value) && value >= 1 && value <= 7

// ── Typed errors (`docs/error-model-draft.md` §2) ────────────────────────

/** The reminder does not exist, or is not visible to this viewer. */
export class ReminderNotFound extends Schema.TaggedError<ReminderNotFound>()("ReminderNotFound", {
  id: ReminderId
}) {}

/** The dispatch does not exist, or is not this viewer's to answer. */
export class ReminderDispatchNotFound extends Schema.TaggedError<ReminderDispatchNotFound>()(
  "ReminderDispatchNotFound",
  { id: ReminderDispatchId }
) {}

/** The row exists but this viewer may not read/write it. */
export class ReminderForbidden extends Schema.TaggedError<ReminderForbidden>()(
  "ReminderForbidden",
  {
    id: Schema.NullOr(Schema.String),
    reason: Schema.Literals(["private", "household", "noHousehold"])
  }
) {}

/** Field-level validation (empty title, missing fire time, bad snooze preset, …). */
export class ReminderValidationError extends Schema.TaggedError<ReminderValidationError>()(
  "ReminderValidationError",
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
export class ReminderConflict extends Schema.TaggedError<ReminderConflict>()("ReminderConflict", {
  id: Schema.String
}) {}

export const ReminderServiceError = Schema.Union([
  ReminderNotFound,
  ReminderDispatchNotFound,
  ReminderForbidden,
  ReminderValidationError,
  ReminderConflict
])
export type ReminderServiceError = Schema.Schema.Type<typeof ReminderServiceError>
