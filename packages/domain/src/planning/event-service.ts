import { Schema } from "effect"
import { Visibility } from "../common.js"
import { RecurrenceRule } from "../recurrence.js"
import { EventExceptionId, EventId, LocalDate, OccasionId, TimeZone } from "./common.js"
import {
  Event,
  EventException,
  EventExceptionOverrides,
  EventTiming
} from "./event.js"

/**
 * EventService contract (ticket #57; FR-CAL-01).
 *
 * The service is server-authoritative: it stamps `createdAt`/`updatedAt`/
 * `version`, mints ids the client did not, and validates the timing union
 * (an event has either instants or an all-day date — never both).
 *
 * `clientMutationId` is the replay key the write path dedupes on
 * (`applied_mutations`), so an RPC/HTTP retry after a lost response is
 * exactly-once.
 */

/**
 * The event fields a create/patch carries.
 *
 * Kept in one place because the service input, the patch input and the
 * domain model must never drift: a field that is not listed here is not
 * client-writable.
 */
const eventFields = {
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  people: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  timing: EventTiming,
  timeZone: TimeZone,
  recurrence: Schema.NullOr(RecurrenceRule),
  exceptions: Schema.Array(EventException),
  occasionId: Schema.NullOr(OccasionId)
}


// ── Typed errors (`docs/error-model-draft.md` §2) ────────────────────────

/** The event does not exist, or is not visible to this viewer. */
export class EventNotFound extends Schema.TaggedError<EventNotFound>()("EventNotFound", {
  id: EventId
}) {}

/** The row exists but this viewer may not read/write it. */
export class EventForbidden extends Schema.TaggedError<EventForbidden>()("EventForbidden", {
  id: Schema.NullOr(Schema.String),
  reason: Schema.Literals(["private", "household", "noHousehold"])
}) {}

/** Field-level validation (empty title, both timing shapes, end before start, …). */
export class EventValidationError extends Schema.TaggedError<EventValidationError>()(
  "EventValidationError",
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
export class EventConflict extends Schema.TaggedError<EventConflict>()("EventConflict", {
  id: Schema.String
}) {}

export const EventServiceError = Schema.Union([
  EventNotFound,
  EventForbidden,
  EventValidationError,
  EventConflict
])
export type EventServiceError = Schema.Schema.Type<typeof EventServiceError>

// ── Mutation inputs ──────────────────────────────────────────────────────

/**
 * Create input. The timing is required: an event without a date is not an
 * event, and the quick-add paths always know the day they were clicked from.
 */
export const EventCreateInput = Schema.Struct({
  /** A client may mint the UUID v7 offline; the server mints one otherwise. */
  id: Schema.optional(EventId),
  clientMutationId: Schema.String,
  title: eventFields.title,
  /**
   * The event's time. Required: an event without a date is not an event, and
   * the quick-add paths always know the day they were clicked from.
   */
  timing: eventFields.timing,
  description: Schema.optional(eventFields.description),
  location: Schema.optional(eventFields.location),
  category: Schema.optional(eventFields.category),
  color: Schema.optional(eventFields.color),
  people: Schema.optional(eventFields.people),
  timeZone: Schema.optional(eventFields.timeZone),
  recurrence: Schema.optional(eventFields.recurrence),
  exceptions: Schema.optional(eventFields.exceptions),
  occasionId: Schema.optional(eventFields.occasionId),
  visibility: Schema.optional(Visibility)
})
export type EventCreateInput = Schema.Schema.Type<typeof EventCreateInput>

/** Patch-style event fields; omitted fields keep their stored value. */
export const EventPatch = Schema.Struct({
  title: Schema.optional(eventFields.title),
  description: Schema.optional(eventFields.description),
  location: Schema.optional(eventFields.location),
  category: Schema.optional(eventFields.category),
  color: Schema.optional(eventFields.color),
  people: Schema.optional(eventFields.people),
  timing: Schema.optional(eventFields.timing),
  timeZone: Schema.optional(eventFields.timeZone),
  recurrence: Schema.optional(eventFields.recurrence),
  exceptions: Schema.optional(eventFields.exceptions),
  occasionId: Schema.optional(eventFields.occasionId),
  visibility: Schema.optional(Visibility)
})
export type EventPatch = Schema.Schema.Type<typeof EventPatch>

export const EventUpdateInput = Schema.Struct({
  id: EventId,
  clientMutationId: Schema.String,
  /** Informational; the update re-reads and retries on a lost CAS. */
  baseVersion: Schema.optional(Schema.Int),
  patch: EventPatch
})
export type EventUpdateInput = Schema.Schema.Type<typeof EventUpdateInput>

/** Delete carries only the row id plus the replay key. */
export const EventMutationInput = Schema.Struct({
  id: EventId,
  clientMutationId: Schema.String
})
export type EventMutationInput = Schema.Schema.Type<typeof EventMutationInput>

// ── Occurrence-level edits (ticket #58; FR-CAL-03) ───────────────────────

/**
 * Which part of a recurring series an edit applies to.
 *
 * - `thisOccurrence` writes one exception on the series row.
 * - `thisAndFollowing` splits the series at the occurrence.
 */
export const EventEditScope = Schema.Literals(["thisOccurrence", "thisAndFollowing"])
export type EventEditScope = Schema.Schema.Type<typeof EventEditScope>

/**
 * Edit one occurrence: a new time/title/location/colour, scoped to that
 * occurrence or to it and the rest of the series.
 *
 * `instanceId` is the occurrence key (its local start date in the event's own
 * zone, per ADR-0004). `followingId`/`followingMutationId` are required only
 * for a split; the client mints them so a retry is exactly-once even though
 * the batch writes two rows.
 */
export const EventOccurrenceEditInput = Schema.Struct({
  id: EventId,
  instanceId: LocalDate,
  clientMutationId: Schema.String,
  scope: EventEditScope,
  /** Optional client-minted exception id (a stable handle for the occurrence). */
  exceptionId: Schema.optional(EventExceptionId),
  /** The new series row's id, for `thisAndFollowing`. */
  followingId: Schema.optional(EventId),
  /** The new series row's replay key, for `thisAndFollowing`. */
  followingMutationId: Schema.optional(Schema.String),
  overrides: EventExceptionOverrides
})
export type EventOccurrenceEditInput = Schema.Schema.Type<typeof EventOccurrenceEditInput>

/** Delete one occurrence, or everything from it on. */
export const EventOccurrenceDeleteInput = Schema.Struct({
  id: EventId,
  instanceId: LocalDate,
  clientMutationId: Schema.String,
  scope: EventEditScope,
  /** Optional client-minted exception id for a `thisOccurrence` delete. */
  exceptionId: Schema.optional(EventExceptionId)
})
export type EventOccurrenceDeleteInput = Schema.Schema.Type<typeof EventOccurrenceDeleteInput>

/**
 * What an occurrence edit wrote: the series row (as stored) and, for a split,
 * the new tail row. `following` is `null` for every non-split edit.
 */
export const EventOccurrenceChange = Schema.Struct({
  series: Event,
  following: Schema.NullOr(Event)
})
export type EventOccurrenceChange = Schema.Schema.Type<typeof EventOccurrenceChange>

// ── Query inputs ─────────────────────────────────────────────────────────

export const EventListInput = Schema.Struct({
  /** Inclusive local-date lower bound, in the viewer's zone. */
  from: Schema.optional(LocalDate),
  /** Exclusive local-date upper bound, in the viewer's zone. */
  before: Schema.optional(LocalDate)
})
export type EventListInput = Schema.Schema.Type<typeof EventListInput>
