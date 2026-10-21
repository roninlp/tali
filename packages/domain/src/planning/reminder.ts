import { Schema } from "effect"
import { Model } from "effect/schema"
import { commonItemFields, ReminderDispatchId, ReminderId, TimeZone, TimestampUtc } from "./common.js"
import { ReminderLink } from "./reminder-link.js"

/**
 * `Reminder` aggregate (FR-REM-01, docs/domain-model-draft.md §3.6).
 *
 * A reminder is a *time* the owner wants to be told something, optionally
 * attached to the thing that should be marked done. Scheduling state is one
 * field — `fireAt`, the next fire instant — and the delivery ledger
 * (`ReminderDispatch`) is the source of truth for what was actually sent and
 * answered (ADR-0005).
 *
 * ## Type drives tier
 *
 * `kind` is what the user picks (medication / exercise / chore / general);
 * `tier` is derived from it at write time (`medication → critical`, everything
 * else → normal) and never chosen by hand. A critical reminder bypasses quiet
 * hours; the only thing that silences it is an explicit per-reminder
 * `silencedUntil` (#13 §2.2).
 *
 * ## Repeat is a structured union, never a string
 *
 * The supported patterns are the Must set: a one-off, a daily local time, a
 * weekly set of weekdays at a local time, and an interval in hours ("every 8
 * hours" for medication). `time` is a local wall-clock `HH:mm`; the zone is on
 * the reminder (`timeZone`), so the same reminder keeps its wall time when the
 * device travels — the same per-item rule tasks and events use.
 *
 * ## The link is the response target
 *
 * `link` is the discriminated `ReminderLink` union from #7/#57. "Done" applies
 * the link's effect (`task` → completed, `event` → log-only, `habit` → a
 * documented seam until #63/#64, `none` → log-only), never a pile of nullable
 * foreign keys.
 *
 * ## Offset
 *
 * `offsetMinutes` is the lead time before a **linked** item's instant: a
 * reminder attached to a task due at 16:00 with a 30-minute offset fires at
 * 15:30. For standalone pattern reminders the offset is stored (and shown) but
 * does not shift the pattern — the pattern's local time already is the fire
 * time. The service derives `fireAt` from the repeat + link at write time.
 */
export const ReminderType = Schema.Literals(["medication", "exercise", "chore", "general"])
export type ReminderType = Schema.Schema.Type<typeof ReminderType>

/**
 * `critical` is the medication tier. The domain model (§3.6) calls it
 * "critical = medication"; #13 §2.2 settles that only medication is critical
 * in the MVP.
 */
export const ReminderTier = Schema.Literals(["normal", "critical"])
export type ReminderTier = Schema.Schema.Type<typeof ReminderTier>

/**
 * Persian labels for the four reminder kinds. Shared so the push body, the
 * missed inbox and the reminder list say the same thing.
 */
export const REMINDER_KIND_LABELS: Readonly<Record<ReminderType, string>> = {
  medication: "دارو",
  exercise: "ورزش",
  chore: "کار خانه",
  general: "یادآوری"
}

/** Local wall-clock time `HH:mm` (00:00–23:59), interpreted in the reminder's zone. */
export const ClockTime = Schema.String.check(
  Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)
)
export type ClockTime = Schema.Schema.Type<typeof ClockTime>

/** ISO weekday, 1 = Monday … 7 = Sunday — the numbering the recurrence engine uses. */
export const IsoWeekday = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 }))
export type IsoWeekday = Schema.Schema.Type<typeof IsoWeekday>

export const ReminderRepeat = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("once") }),
  Schema.Struct({
    _tag: Schema.Literal("daily"),
    /** Local `HH:mm` in the reminder's zone. */
    time: ClockTime
  }),
  Schema.Struct({
    _tag: Schema.Literal("weekly"),
    /** The weekdays it repeats on. */
    days: Schema.Array(IsoWeekday).check(Schema.isMinLength(1)),
    /** Local `HH:mm` in the reminder's zone. */
    time: ClockTime
  }),
  Schema.Struct({
    _tag: Schema.Literal("interval"),
    /** "Every N hours" — the medication pattern. */
    hours: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
  })
])
export type ReminderRepeat = Schema.Schema.Type<typeof ReminderRepeat>

export class Reminder extends Model.Class<Reminder>("Reminder")({
  ...commonItemFields("reminder", ReminderId),
  /** The reminder's own heading ("داروی فشار"). */
  title: Schema.String,
  /** Optional free text ("همراه با غذا"). */
  note: Schema.NullOr(Schema.String),
  kind: ReminderType,
  /** Derived from `kind` at write time; never client-chosen. */
  tier: ReminderTier,
  repeat: ReminderRepeat,
  /** The next fire instant (UTC ISO-8601); the only scheduling state. */
  fireAt: TimestampUtc,
  /** Lead time before the linked item's instant, in minutes. */
  offsetMinutes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  link: ReminderLink,
  /** Series-level silence ("silence until"): pauses every fire before it. */
  silencedUntil: Schema.NullOr(TimestampUtc),
  /** The IANA zone the repeat's local time is read in. */
  timeZone: TimeZone
}) {}

/** The answer a dispatch can receive (#13 §2.3). */
export const DispatchResponse = Schema.Literals(["done", "snooze", "dismiss"])
export type DispatchResponse = Schema.Schema.Type<typeof DispatchResponse>

/** Where a ledger row came from: a schedule claim or a snooze of another row. */
export const DispatchOrigin = Schema.String

/** Push lifecycle of a claimed dispatch. `accepted` means the push service took it, not that a device saw it. */
export const PushOutcome = Schema.Literals(["pending", "accepted", "failed", "expired"])
export type PushOutcome = Schema.Schema.Type<typeof PushOutcome>

/**
 * One row of the dispatch ledger (ADR-0005 §3, §6).
 *
 * The row is written when a fire is **claimed** (not when a reminder is
 * created) and is never deleted: that is how "never silently dropped" holds.
 * `response` is the log the adherence metric reads; `rootScheduledFor` keeps
 * the on-time window anchored to the original fire across snoozes.
 */
export class ReminderDispatch extends Model.Class<ReminderDispatch>("ReminderDispatch")({
  id: Model.UuidV7Insert(ReminderDispatchId),
  reminderId: ReminderId,
  /** The owner whose devices should receive it (never a household-wide broadcast). */
  userId: Schema.String,
  /** The nominal fire instant this row represents. */
  scheduledFor: TimestampUtc,
  /** When the policy says it may be pushed (quiet hours / snooze target). */
  deliverAt: TimestampUtc,
  /** The original fire instant; unchanged across snooze children. */
  rootScheduledFor: TimestampUtc,
  /** `schedule` or `snooze:<parentDispatchId>`. */
  origin: DispatchOrigin,
  pushOutcome: PushOutcome,
  attempts: Schema.Int,
  lastAttemptAt: Schema.NullOr(TimestampUtc),
  parentDispatchId: Schema.NullOr(ReminderDispatchId),
  response: Schema.NullOr(DispatchResponse),
  respondedAt: Schema.NullOr(TimestampUtc),
  snoozedUntil: Schema.NullOr(TimestampUtc),
  createdAt: TimestampUtc
}) {}

/**
 * What the missed-reminder inbox renders: the ledger row plus the reminder
 * summary the user needs to act on it (title/kind/tier/link), so a client does
 * not have to join the mirror to show the inbox.
 */
export const ReminderInboxItem = Schema.Struct({
  dispatch: ReminderDispatch,
  reminderId: ReminderId,
  title: Schema.String,
  /** The reminder's free text, shown under the title in the inbox. */
  note: Schema.NullOr(Schema.String),
  kind: ReminderType,
  tier: ReminderTier,
  link: ReminderLink,
  /** `inbox` = unanswered and under 24 h old; `history` = everything else. */
  state: Schema.Literals(["inbox", "history"])
})
export type ReminderInboxItem = Schema.Schema.Type<typeof ReminderInboxItem>
