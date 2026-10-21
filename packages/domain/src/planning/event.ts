import { Schema } from "effect"
import { Model } from "effect/schema"
import { RecurrenceRule } from "../recurrence.js"
import {
  commonItemFields,
  EventExceptionId,
  EventId,
  LocalDate,
  OccasionId,
  TimeZone,
  TimestampUtc
} from "./common.js"

/**
 * `Event` aggregate (FR-CAL-01, docs/domain-model-draft.md §3.3).
 *
 * An event is something that happens at a specific time and shows up on the
 * calendar: an appointment, a meeting, a trip. It is the first Slice-3
 * aggregate and the anchor the calendar views (#62), the recurrence engine
 * (#58), occasions (#59) and reminders (#60) all hang off.
 *
 * ## Timing: timed instants **or** an all-day local date
 *
 * `timing` is a discriminated union, so "an event with a start instant *and*
 * an all-day date" is not representable:
 *
 * - `timed` — two UTC instants (`start`, `end`). The instants are absolute:
 *   a device that changes its time zone sees the same moment, never a
 *   different one (FR-CAL-07).
 * - `allDay` — one local calendar date (`YYYY-MM-DD`) in the event's own IANA
 *   zone. The date is stored next to the zone so "the 3rd of Esfand" stays
 *   the 3rd of Esfand when the reader is in another zone.
 *
 * The **zone lives on the event** (`timeZone`), exactly like a task's due
 * date, so an all-day event and a timed event are both unambiguous and the
 * default is the owner's profile zone at creation time.
 *
 * ## Recurrence is a structured rule, never a string
 *
 * `recurrence` is the same `RecurrenceRule` union the tasks use (#7/#38):
 * a JSON object with frequency/interval/by-fields/end — never an RRULE
 * string, because the month/year fields are Jalali. A `null` rule is a
 * one-off event.
 *
 * ## Exceptions: "this occurrence only"
 *
 * `exceptions` holds the per-occurrence deviations of a recurring series:
 * `delete` removes one occurrence, `override` replaces it with its own
 * title/time/place. The list lives **inside** the event row on purpose — one
 * series, one row — so an occurrence edit and the series it belongs to can
 * never disagree, and the recurrence engine (#58) can expand a series without
 * a second query.
 *
 * The occurrence key (`instanceId`) is the occurrence's **local start date**
 * in the event's zone. One key per occurrence, in the same calendar the
 * recurrence engine expands in.
 *
 * ## Relations reserved for the next slices
 *
 * - `occasionId` — the annual date an event comes from (#59). Reserved here
 *   so the occasions slice needs no migration on `events`.
 * - The reminder link lives on the reminder (`ReminderLink`, §3.6) and points
 *   back at `EventId`, so #60 needs no migration either.
 */
export const EventTiming = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("timed"),
    /** Start instant (UTC, ISO-8601). */
    start: TimestampUtc,
    /** End instant (UTC, ISO-8601). Never earlier than `start`. */
    end: TimestampUtc
  }),
  Schema.Struct({
    _tag: Schema.Literal("allDay"),
    /** Local calendar date `YYYY-MM-DD`, in the event's `timeZone`. */
    date: LocalDate
  })
])
export type EventTiming = Schema.Schema.Type<typeof EventTiming>

/** What an exception does to its occurrence. */
export const EventExceptionAction = Schema.Literals(["delete", "override"])
export type EventExceptionAction = Schema.Schema.Type<typeof EventExceptionAction>

/**
 * The fields an `override` exception replaces. Every field is optional: an
 * override that only moves the occurrence leaves the series' title alone.
 */
export const EventExceptionOverrides = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  location: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  /** The occurrence's own timing (timed instants or an all-day date). */
  timing: Schema.optional(EventTiming),
  /** The occurrence's own zone; inherits the event's when omitted. */
  timeZone: Schema.optional(TimeZone)
})
export type EventExceptionOverrides = Schema.Schema.Type<typeof EventExceptionOverrides>

/**
 * One occurrence of a recurring series that deviates from the rule.
 *
 * `id` is a stable handle for the occurrence (the client addresses "this
 * occurrence only" by id); `instanceId` is the occurrence key the expansion
 * engine produces. `createdAt` is server-stamped.
 */
export const EventException = Schema.Struct({
  id: EventExceptionId,
  /** The occurrence's local start date (`YYYY-MM-DD`) in the event's zone. */
  instanceId: LocalDate,
  action: EventExceptionAction,
  /** Only meaningful with `action = "override"`. */
  overrides: Schema.NullOr(EventExceptionOverrides),
  createdAt: TimestampUtc
})
export type EventException = Schema.Schema.Type<typeof EventException>

export class Event extends Model.Class<Event>("Event")({
  ...commonItemFields("event", EventId),
  /**
   * The event's name. The model only checks the *shape* (a string): the
   * service enforces a non-empty title, because a tombstone row inserted by a
   * delete-only sync push carries an empty title by construction.
   */
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** Free-text place ("پارکینگ طبقه دوم"). */
  location: Schema.NullOr(Schema.String),
  /** Free-text category label ("work", "family", "health", …). */
  category: Schema.NullOr(Schema.String),
  /** People involved, by name (household members and guests alike). */
  people: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  /** Timed instants or an all-day local date — never both. */
  timing: EventTiming,
  /** The event's IANA zone; the all-day date is read in it. */
  timeZone: TimeZone,
  /** Structured recurrence rule; `null` for a one-off event. */
  recurrence: Schema.NullOr(RecurrenceRule),
  /** Per-occurrence exceptions ("this occurrence only"). */
  exceptions: Schema.Array(EventException),
  /** The annual date this event comes from — reserved for #59. */
  occasionId: Schema.NullOr(OccasionId)
}) {}
