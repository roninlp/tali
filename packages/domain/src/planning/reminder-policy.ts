import { Temporal } from "temporal-polyfill/full"
import type {
  DispatchResponse,
  ReminderRepeat,
  ReminderTier,
  ReminderType
} from "./reminder.js"

/**
 * The reminder scheduling policy (ticket #13, settled by ADR-0005).
 *
 * This module is deliberately **pure**: no D1, no Worker, no clock. The claim
 * path (#61) calls `reminderDeliverAt` inside the sweep, the write path (#60)
 * calls `reminderFireAt` to derive the next fire, and the response path uses
 * `snoozeInstant` / `isOnTime`. Keeping the rules here means the cron, the
 * service and the tests cannot drift.
 *
 * ## The rules in one place
 *
 * - Quiet hours are **23:00–07:00 in the owner's zone**, evaluated per
 *   instant. A normal-tier fire inside the window is held until the next
 *   local 07:00; nothing is dropped (ADR-0005 §5).
 * - The medication (`critical`) tier **bypasses** quiet hours. The only thing
 *   that silences it is the reminder's own `silencedUntil`.
 * - Silence is not a hold: a fire at or before `silencedUntil` is
 *   **suppressed** — no dispatch row at all.
 * - Snooze presets are fixed: 5, 10, 15, 30, 60 minutes. A snooze is
 *   this-occurrence-only; its child ledger row carries the original
 *   `rootScheduledFor`, so the on-time window does not restart.
 * - A dispatch is **on time** when it is answered `done` within 30 minutes of
 *   the *root* fire (early counts). `dismiss` and silence are never on time.
 * - A dispatch is **missed** when it is unanswered and its scheduled instant
 *   has passed. After 24 hours it leaves the inbox view for history; the
 *   ledger row is never deleted (PRD §8.3.1).
 */

/** Quiet hours start, minutes after local midnight. */
export const QUIET_HOURS_START_MINUTES = 23 * 60
/** Quiet hours end (exclusive), minutes after local midnight. */
export const QUIET_HOURS_END_MINUTES = 7 * 60
/** The fixed snooze choices (minutes); free-form snoozing is out of scope. */
export const SNOOZE_PRESETS_MINUTES = [5, 10, 15, 30, 60] as const
export type SnoozeMinutes = (typeof SNOOZE_PRESETS_MINUTES)[number]
/** A missed reminder leaves the inbox view for history after this long. */
export const MISSED_INBOX_HOURS = 24
/** "Done" within this window of the root fire counts as on time (#13 §2.6). */
export const ON_TIME_GRACE_MINUTES = 30
/** The delivery horizon from ADR-0005 §4 (owned by #61, recorded here). */
export const DELIVERY_HORIZON_MINUTES = 15
/** The default local hour of an all-day task/event reminder. */
export const ALL_DAY_REMINDER_HOUR = 9

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** `medication` is the only critical tier in the MVP (#13 §2.2). */
export const reminderTierFor = (kind: ReminderType): ReminderTier =>
  kind === "medication" ? "critical" : "normal"

const asInstant = (value: string): Temporal.Instant => Temporal.Instant.from(value)

const iso = (instant: Temporal.Instant): string =>
  new Date(Number(instant.epochMilliseconds)).toISOString()

/** Parse a local `HH:mm` into hour/minute. */
const clockOf = (time: string): { readonly hour: number; readonly minute: number } => {
  const [hour, minute] = time.split(":").map(Number)
  return { hour: hour ?? 0, minute: minute ?? 0 }
}

/** Is `instant` inside quiet hours in `timeZone`? (start inclusive, end exclusive) */
export const isQuietHoursInstant = (instant: string, timeZone: string): boolean => {
  const zoned = asInstant(instant).toZonedDateTimeISO(timeZone)
  const minutes = zoned.hour * 60 + zoned.minute
  return minutes >= QUIET_HOURS_START_MINUTES || minutes < QUIET_HOURS_END_MINUTES
}

/**
 * The first local 07:00 strictly after `instant`, in `timeZone` — the moment
 * a quiet-hours hold is flushed. Returns `null` when the instant is outside
 * the window.
 */
export const quietHoursEndAfter = (instant: string, timeZone: string): string | null => {
  const zoned = asInstant(instant).toZonedDateTimeISO(timeZone)
  const minutes = zoned.hour * 60 + zoned.minute
  if (minutes < QUIET_HOURS_START_MINUTES && minutes >= QUIET_HOURS_END_MINUTES) {
    return null
  }
  // Before 07:00 the flush is today; at/after 23:00 it is tomorrow.
  const date = minutes >= QUIET_HOURS_START_MINUTES
    ? zoned.toPlainDate().add({ days: 1 })
    : zoned.toPlainDate()
  const flush = date
    .toPlainDateTime({ hour: 7, minute: 0 })
    .toZonedDateTime(timeZone)
  return iso(flush.toInstant())
}

/**
 * The policy output for a claimed fire (ADR-0005 §5):
 *
 * - `suppress` — the reminder is silenced at this instant; emit no dispatch.
 * - `claim` — a dispatch row is written with `deliverAt`.
 */
export type ReminderClaimPlan =
  | { readonly _tag: "suppress" }
  | { readonly _tag: "claim"; readonly deliverAt: string }

/**
 * Evaluate one fire. `ownerTimeZone` comes from `user_preferences.time_zone`
 * (ADR-0002), falling back to the profile zone; the reminder's own zone is for
 * deriving the *next* fire, not for quiet hours (those follow the owner).
 */
export const reminderDeliverAt = (
  reminder: {
    readonly tier: ReminderTier
    readonly silencedUntil: string | null
  },
  ownerTimeZone: string,
  scheduledFor: string
): ReminderClaimPlan => {
  if (
    reminder.silencedUntil !== null &&
    Date.parse(reminder.silencedUntil) > Date.parse(scheduledFor)
  ) {
    return { _tag: "suppress" }
  }
  if (reminder.tier === "critical") {
    return { _tag: "claim", deliverAt: scheduledFor }
  }
  const flush = quietHoursEndAfter(scheduledFor, ownerTimeZone)
  return { _tag: "claim", deliverAt: flush ?? scheduledFor }
}

/** Is a preset snooze length legal? */
export const isSnoozeMinutes = (minutes: number): minutes is SnoozeMinutes =>
  (SNOOZE_PRESETS_MINUTES as ReadonlyArray<number>).includes(minutes)

/**
 * When a snoozed occurrence re-fires: `respondedAt + minutes`.
 *
 * Returns `null` for a length outside the preset set, so the caller can answer
 * with a typed validation error instead of inventing a schedule.
 */
export const snoozeInstant = (respondedAt: string, minutes: number): string | null =>
  isSnoozeMinutes(minutes)
    ? new Date(Date.parse(respondedAt) + minutes * MINUTE_MS).toISOString()
    : null

/** The first local occurrence of a repeat at/after (`inclusive`) or after `after`. */
const nextOccurrence = (
  repeat: ReminderRepeat,
  timeZone: string,
  after: string,
  inclusive: boolean
): string | null => {
  const afterInstant = asInstant(after)
  if (repeat._tag === "once") return null
  if (repeat._tag === "interval") {
    return iso(afterInstant.add({ hours: repeat.hours }))
  }

  const zoned = afterInstant.toZonedDateTimeISO(timeZone)
  const today = zoned.toPlainDate()
  const clock = clockOf(repeat.time)
  const days = repeat._tag === "weekly" ? repeat.days : null
  // A week is enough to find the next matching weekday (8 days of headroom).
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = today.add({ days: offset })
    if (days !== null && !days.includes(date.dayOfWeek as never)) continue
    const candidate = date
      .toPlainDateTime({ hour: clock.hour, minute: clock.minute })
      .toZonedDateTime(timeZone)
    const comparison = Temporal.Instant.compare(candidate.toInstant(), afterInstant)
    if (comparison > 0 || (inclusive && comparison === 0)) {
      return iso(candidate.toInstant())
    }
  }
  return null
}

/** The next fire strictly after a claimed/suppressed instant (#61 advances with this). */
export const reminderNextFireAfter = (
  repeat: ReminderRepeat,
  timeZone: string,
  after: string
): string | null => nextOccurrence(repeat, timeZone, after, false)

/** The first fire at or after `now` for a pattern reminder (write-time derivation). */
export const reminderFirstFireAt = (
  repeat: ReminderRepeat,
  timeZone: string,
  now: string
): string | null => nextOccurrence(repeat, timeZone, now, true)

/** `YYYY-MM-DD` + 09:00 local — the default instant of an all-day linked item. */
export const allDayReminderInstant = (date: string, timeZone: string): string =>
  iso(
    Temporal.PlainDate.from(date)
      .toPlainDateTime({ hour: ALL_DAY_REMINDER_HOUR, minute: 0 })
      .toZonedDateTime(timeZone)
      .toInstant()
  )

/**
 * Derive a reminder's `fireAt` at write time.
 *
 * - A **once** reminder fires either at its linked item's instant minus
 *   `offsetMinutes` (task due / event start), or at the explicit `fireAt` the
 *   caller supplied when it has no schedulable link.
 * - A **pattern** reminder fires at the first occurrence of the pattern at or
 *   after `now`; the offset is a linked-item lead time and does not shift the
 *   pattern's own wall time.
 *
 * Returns `null` when no fire can be derived (a once reminder with neither a
 * linked instant nor an explicit fireAt), which the service reports as a
 * validation error.
 */
export const reminderFireAt = (input: {
  readonly repeat: ReminderRepeat
  readonly timeZone: string
  readonly now: string
  readonly offsetMinutes?: number
  readonly explicitFireAt?: string | null
  readonly linkInstant?: string | null
}): string | null => {
  if (input.repeat._tag !== "once") {
    return reminderFirstFireAt(input.repeat, input.timeZone, input.now)
  }
  // An explicit fire time is the user's own answer and wins over the link's
  // instant; the link-derived instant is the default when none was supplied.
  if (input.explicitFireAt !== undefined && input.explicitFireAt !== null) {
    const parsed = Date.parse(input.explicitFireAt)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  }
  if (input.linkInstant !== undefined && input.linkInstant !== null) {
    const base = Date.parse(input.linkInstant)
    if (!Number.isFinite(base)) return null
    return new Date(base - (input.offsetMinutes ?? 0) * MINUTE_MS).toISOString()
  }
  return null
}

/** A ledger row's state for the inbox: answered, still upcoming, inbox, or history. */
export const inboxStateOf = (
  dispatch: {
    readonly response: DispatchResponse | null
    readonly scheduledFor: string
  },
  now: string
): "answered" | "upcoming" | "inbox" | "history" => {
  if (dispatch.response !== null) return "answered"
  const scheduled = Date.parse(dispatch.scheduledFor)
  const current = Date.parse(now)
  if (scheduled >= current) return "upcoming"
  return current - scheduled > MISSED_INBOX_HOURS * HOUR_MS ? "history" : "inbox"
}

/** "Missed" is a predicate, not a job (ADR-0005 §7). */
export const isMissed = (
  dispatch: {
    readonly response: DispatchResponse | null
    readonly scheduledFor: string
  },
  now: string
): boolean => inboxStateOf(dispatch, now) !== "answered" && Date.parse(dispatch.scheduledFor) < Date.parse(now)

/**
 * On-time adherence: `done` with `respondedAt <= rootScheduledFor + grace`.
 * Early answers count; `dismiss`, silence and unanswered rows do not.
 */
export const isOnTime = (
  dispatch: {
    readonly response: DispatchResponse | null
    readonly rootScheduledFor: string
    readonly respondedAt: string | null
  },
  graceMinutes: number = ON_TIME_GRACE_MINUTES
): boolean => {
  if (dispatch.response !== "done" || dispatch.respondedAt === null) return false
  return (
    Date.parse(dispatch.respondedAt) <=
      Date.parse(dispatch.rootScheduledFor) + graceMinutes * MINUTE_MS
  )
}

/** Duration of a quiet-hours window in hours, for copy/tests. */
export const QUIET_HOURS_HOURS =
  (24 * 60 - QUIET_HOURS_START_MINUTES + QUIET_HOURS_END_MINUTES) / 60
