import { Schema } from "effect"
import { Model } from "effect/schema"
import { HouseholdId, UserId, Visibility } from "../common.js"

/**
 * Shared building blocks for the core-planning aggregates (Slice 2).
 *
 * Source of truth: `docs/domain-model-draft.md` §2–§3 and ticket #33. Every
 * aggregate carries the common-item contract from §2.4 so sync, trash and
 * (later) search work uniformly:
 *
 * - a client-mintable UUID v7 id;
 * - `ownerId` + household `visibility` for the per-client pull filter;
 * - a server-monotonic `version` and `updatedAt` for conflict resolution;
 * - a nullable `deletedAt` tombstone (30-day trash, then purge).
 *
 * Timestamps are ISO-8601 UTC **strings**, matching the D1 column shape and
 * the existing auth/push models (`packages/domain/src/auth.ts`). D1 returns
 * TEXT, so a `Model.DateTime*` variant would need a second decode step for no
 * benefit.
 */

// ── Branded ids (docs/domain-model-draft.md §2.2) ─────────────────────────
//
// UUID v7 is time-ordered and client-mintable, which is what makes offline
// inserts possible. Branding forbids accidental cross-aggregate assignment.

export const TaskId = Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand("TaskId"))
export type TaskId = Schema.Schema.Type<typeof TaskId>

export const ProjectId = Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand("ProjectId"))
export type ProjectId = Schema.Schema.Type<typeof ProjectId>

export const TagId = Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand("TagId"))
export type TagId = Schema.Schema.Type<typeof TagId>

export const ListId = Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand("ListId"))
export type ListId = Schema.Schema.Type<typeof ListId>

export const ListItemId = Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand("ListItemId"))
export type ListItemId = Schema.Schema.Type<typeof ListItemId>

export const NoteId = Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand("NoteId"))
export type NoteId = Schema.Schema.Type<typeof NoteId>

/** `Event` aggregate id (Slice 3 / ticket #57). */
export const EventId = Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand("EventId"))
export type EventId = Schema.Schema.Type<typeof EventId>

/**
 * A per-occurrence exception's own id.
 *
 * The exception is stored inside its event's exception list (one series, one
 * row), so the id is the stable handle a client uses to address a single
 * occurrence ("this occurrence only") without addressing the series.
 */
export const EventExceptionId = Schema.String.check(Schema.isUUID(7)).pipe(
  Schema.brand("EventExceptionId")
)
export type EventExceptionId = Schema.Schema.Type<typeof EventExceptionId>

/**
 * Annual occasion id — **reserved** for ticket #59 (`Occasion`).
 *
 * The brand exists now because `Event.occasionId` (the relation between an
 * event and the annual date it comes from) is part of the event shape, so the
 * occasions slice lands without touching the events table.
 */
export const OccasionId = Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand("OccasionId"))
export type OccasionId = Schema.Schema.Type<typeof OccasionId>

/**
 * `Habit` aggregate id (Slice 4 / ticket #63).
 *
 * The brand existed before the aggregate (the `ReminderLink` union's habit
 * variant) so the reminder slice needs no redefinition.
 */
export const HabitId = Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand("HabitId"))
export type HabitId = Schema.Schema.Type<typeof HabitId>

/**
 * One day's log of a habit (ticket #63; FR-HAB-02).
 *
 * An entry is a **separate row**, not a field on the habit (settled in #7):
 * a streak/heatmap reads a date range, and the tap is an idempotent upsert
 * keyed by `(habitId, localDate)`. The id is client-mintable like every other
 * row so an offline tap can write immediately.
 */
export const HabitEntryId = Schema.String.check(Schema.isUUID(7)).pipe(
  Schema.brand("HabitEntryId")
)
export type HabitEntryId = Schema.Schema.Type<typeof HabitEntryId>

/** `Reminder` aggregate id (Slice 3 / ticket #60). */
export const ReminderId = Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand("ReminderId"))
export type ReminderId = Schema.Schema.Type<typeof ReminderId>

/** One dispatch-ledger row (ADR-0005); also the address of a notification action. */
export const ReminderDispatchId = Schema.String.check(Schema.isUUID(7)).pipe(
  Schema.brand("ReminderDispatchId")
)
export type ReminderDispatchId = Schema.Schema.Type<typeof ReminderDispatchId>

// ── Enums (docs/domain-model-draft.md §2.3) ───────────────────────────────

/**
 * Discriminator for a syncable entity. Kept identical to the sync wire enum
 * (`SyncEntityType` re-exports this) so the mirror can address every aggregate
 * before its model lands.
 */
export const ItemType = Schema.Literals([
  "habit",
  "habitEntry",
  "event",
  "occasion",
  "task",
  "reminder",
  "note",
  "tag",
  "list",
  "listItem",
  "project"
])
export type ItemType = Schema.Schema.Type<typeof ItemType>

/** Task lifecycle. Transitions stamp `startedAt` / `completedAt` server-side. */
export const TaskStatus = Schema.Literals(["todo", "doing", "done"])
export type TaskStatus = Schema.Schema.Type<typeof TaskStatus>

export const Priority = Schema.Literals(["high", "medium", "low"])
export type Priority = Schema.Schema.Type<typeof Priority>

/** Per-list default ordering for list items. */
export const ListItemSort = Schema.Literals(["manual", "alpha", "status"])
export type ListItemSort = Schema.Schema.Type<typeof ListItemSort>

/**
 * Where a list shows completed items. `bottom` is the feature-map default
 * (FR-LIST-02: "move checked to bottom (configurable)"); `inPlace` keeps them
 * in manual order.
 */
export const ListCheckedPlacement = Schema.Literals(["inPlace", "bottom"])
export type ListCheckedPlacement = Schema.Schema.Type<typeof ListCheckedPlacement>

// ── Scalar conventions ────────────────────────────────────────────────────

/** ISO-8601 UTC instant, stored as TEXT (Temporal/Jalali is display-only). */
export const TimestampUtc = Schema.String
export type TimestampUtc = Schema.Schema.Type<typeof TimestampUtc>

/** Local calendar date `YYYY-MM-DD`, with the owning item's IANA time zone. */
export const LocalDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))
export type LocalDate = Schema.Schema.Type<typeof LocalDate>

const isIanaTimeZone = Schema.makeFilter<string>((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return "must be a valid IANA time zone identifier"
  }
})

/** IANA time-zone identifier; stored per item so all-day dates stay unambiguous. */
export const TimeZone = Schema.String.check(isIanaTimeZone)
export type TimeZone = Schema.Schema.Type<typeof TimeZone>

/** Household-scoped tag ids carried denormalized on an item (join is canonical). */
export const TagIds = Schema.Array(TagId)
export type TagIds = Schema.Schema.Type<typeof TagIds>

// ── Common-item field map (docs/domain-model-draft.md §2.4) ───────────────

/**
 * The fields every core-planning aggregate shares. Each model spreads this map
 * into its own `Model.Class` and adds its own `type` literal, title/name and
 * aggregate-specific columns. The id is the only insert-generated field; the
 * server stamps timestamps and versions on write, so the model only declares
 * their shape.
 */
export const commonItemFields = <const T extends ItemType, const B extends string>(
  type: T,
  id: Schema.brand<Schema.String, B>
) => ({
  id: Model.UuidV7Insert(id),
  type: Schema.Literal(type),
  ownerId: UserId,
  householdId: HouseholdId,
  visibility: Visibility,
  color: Schema.NullOr(Schema.String),
  createdAt: TimestampUtc,
  updatedAt: TimestampUtc,
  version: Schema.Int,
  deletedAt: Schema.NullOr(TimestampUtc)
})
