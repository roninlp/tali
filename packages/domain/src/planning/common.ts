import { Schema } from 'effect'
import { Model } from 'effect/schema'
import { HouseholdId, UserId } from '../common.js'

/**
 * Re-exported so the planning aggregates read every shared scalar from this
 * module. The definition lives in `../common.ts` because the auth/push/capture
 * contracts need the same check and must not depend on the planning layer.
 */
export { NonEmptyString } from '../common.js'

/**
 * Re-exported for the same reason as `NonEmptyString`: the definition lives in
 * `../common.ts` so `auth.ts` can validate a profile zone without importing the
 * planning layer, and every planning aggregate keeps importing it from here.
 */
export { TimeZone } from '../common.js'

/**
 * Shared building blocks for the core-planning aggregates (Slice 2).
 *
 * Source of truth: `docs/domain-model-draft.md` §2–§3 and ticket #33. Every
 * aggregate carries the common-item contract from §2.4 so sync, trash and
 * (later) search work uniformly:
 *
 * - a client-mintable UUID v7 id;
 * - `ownerId` for the per-client pull filter, plus a **resolved** `visibility`
 *   that each model adds itself from its `VisibilityPolicy` (ADR-0011);
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

/** A client-mintable UUID v7, branded to one aggregate. */
export const uuid7Id = <const Brand extends string>(brand: Brand) =>
  Schema.String.check(Schema.isUUID(7)).pipe(
    // `Schema.brand`'s single-key guard is a conditional type that cannot be
    // reduced for a generic key, so pass the key at the guard's own type.
    Schema.brand<Brand>(brand as Parameters<typeof Schema.brand<Brand>>[0]),
  )

export const TaskId = uuid7Id('TaskId')
export type TaskId = Schema.Schema.Type<typeof TaskId>

export const ProjectId = uuid7Id('ProjectId')
export type ProjectId = Schema.Schema.Type<typeof ProjectId>

export const TagId = uuid7Id('TagId')
export type TagId = Schema.Schema.Type<typeof TagId>

export const ListId = uuid7Id('ListId')
export type ListId = Schema.Schema.Type<typeof ListId>

export const ListItemId = uuid7Id('ListItemId')
export type ListItemId = Schema.Schema.Type<typeof ListItemId>

export const NoteId = uuid7Id('NoteId')
export type NoteId = Schema.Schema.Type<typeof NoteId>

/** `Event` aggregate id (Slice 3 / ticket #57). */
export const EventId = uuid7Id('EventId')
export type EventId = Schema.Schema.Type<typeof EventId>

/**
 * A per-occurrence exception's own id.
 *
 * The exception is stored inside its event's exception list (one series, one
 * row), so the id is the stable handle a client uses to address a single
 * occurrence ("this occurrence only") without addressing the series.
 */
export const EventExceptionId = uuid7Id('EventExceptionId')
export type EventExceptionId = Schema.Schema.Type<typeof EventExceptionId>

/**
 * Annual occasion id — **reserved** for ticket #59 (`Occasion`).
 *
 * The brand exists now because `Event.occasionId` (the relation between an
 * event and the annual date it comes from) is part of the event shape, so the
 * occasions slice lands without touching the events table.
 */
export const OccasionId = uuid7Id('OccasionId')
export type OccasionId = Schema.Schema.Type<typeof OccasionId>

/**
 * `Habit` aggregate id (Slice 4 / ticket #63).
 *
 * The brand existed before the aggregate (the `ReminderLink` union's habit
 * variant) so the reminder slice needs no redefinition.
 */
export const HabitId = uuid7Id('HabitId')
export type HabitId = Schema.Schema.Type<typeof HabitId>

/**
 * One day's log of a habit (ticket #63; FR-HAB-02).
 *
 * An entry is a **separate row**, not a field on the habit (settled in #7):
 * a streak/heatmap reads a date range, and the tap is an idempotent upsert
 * keyed by `(habitId, localDate)`. The id is client-mintable like every other
 * row so an offline tap can write immediately.
 */
export const HabitEntryId = uuid7Id('HabitEntryId')
export type HabitEntryId = Schema.Schema.Type<typeof HabitEntryId>

/** `Reminder` aggregate id (Slice 3 / ticket #60). */
export const ReminderId = uuid7Id('ReminderId')
export type ReminderId = Schema.Schema.Type<typeof ReminderId>

/** One dispatch-ledger row (ADR-0005); also the address of a notification action. */
export const ReminderDispatchId = uuid7Id('ReminderDispatchId')
export type ReminderDispatchId = Schema.Schema.Type<typeof ReminderDispatchId>

// ── Enums (docs/domain-model-draft.md §2.3) ───────────────────────────────

/**
 * Discriminator for a syncable entity. Kept identical to the sync wire enum
 * (`SyncEntityType` re-exports this) so the mirror can address every aggregate
 * before its model lands.
 */
export const ItemType = Schema.Literals([
  'habit',
  'habitEntry',
  'event',
  'occasion',
  'task',
  'reminder',
  'note',
  'tag',
  'list',
  'listItem',
  'project',
])
export type ItemType = Schema.Schema.Type<typeof ItemType>

/** Task lifecycle. Transitions stamp `startedAt` / `completedAt` server-side. */
export const TaskStatus = Schema.Literals(['todo', 'doing', 'done'])
export type TaskStatus = Schema.Schema.Type<typeof TaskStatus>

export const Priority = Schema.Literals(['high', 'medium', 'low'])
export type Priority = Schema.Schema.Type<typeof Priority>

/** Per-list default ordering for list items. */
export const ListItemSort = Schema.Literals(['manual', 'alpha', 'status'])
export type ListItemSort = Schema.Schema.Type<typeof ListItemSort>

/**
 * Where a list shows completed items. `bottom` is the feature-map default
 * (FR-LIST-02: "move checked to bottom (configurable)"); `inPlace` keeps them
 * in manual order.
 */
export const ListCheckedPlacement = Schema.Literals(['inPlace', 'bottom'])
export type ListCheckedPlacement = Schema.Schema.Type<
  typeof ListCheckedPlacement
>

// ── Scalar conventions ────────────────────────────────────────────────────

/** ISO-8601 UTC instant, stored as TEXT (Temporal/Jalali is display-only). */
export const TimestampUtc = Schema.String
export type TimestampUtc = Schema.Schema.Type<typeof TimestampUtc>

/** Local calendar date `YYYY-MM-DD`, with the owning item's IANA time zone. */
export const LocalDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
)
export type LocalDate = Schema.Schema.Type<typeof LocalDate>

/** Household-scoped tag ids carried denormalized on an item (join is canonical). */
export const TagIds = Schema.Array(TagId)
export type TagIds = Schema.Schema.Type<typeof TagIds>

// ── Common-item field map (docs/domain-model-draft.md §2.4) ───────────────

/**
 * The fields every core-planning aggregate shares. Each model spreads this map
 * into its own `Model.Class` and adds its own `type` literal, title/name,
 * aggregate-specific columns, and — because it is derived from the aggregate's
 * policy rather than chosen by the user — `visibility`. The id is the only
 * insert-generated field; the server stamps timestamps and versions on write,
 * so the model only declares their shape.
 */
export const commonItemFields = <
  const T extends ItemType,
  const B extends string,
>(
  type: T,
  id: Schema.brand<Schema.String, B>,
) => ({
  id: Model.UuidV7Insert(id),
  type: Schema.Literal(type),
  ownerId: UserId,
  householdId: HouseholdId,
  color: Schema.NullOr(Schema.String),
  createdAt: TimestampUtc,
  updatedAt: TimestampUtc,
  version: Schema.Int,
  deletedAt: Schema.NullOr(TimestampUtc),
})

// ── Service contract building blocks ──────────────────────────────────────
//
// Every aggregate's service contract (tickets #36, #39, #40, #57, #59, #60,
// #63, #64) is the same three envelopes plus the same four typed-error shapes.
// They are declared once here so a wire shape cannot drift between aggregates:
// the fields, their order and their optionality are fixed in one place.

/**
 * The replay/idempotency key every mutation carries: the write path dedupes on
 * it (`applied_mutations`), so an RPC retry after a lost response is
 * exactly-once.
 */
export const ClientMutationId = Schema.String
export type ClientMutationId = Schema.Schema.Type<typeof ClientMutationId>

/** `{ id, clientMutationId }` — delete / start / complete / undo / restore. */
export const mutationEnvelope = <const Id extends Schema.Top>(id: Id) =>
  Schema.Struct({ id, clientMutationId: ClientMutationId })

/**
 * `{ id, clientMutationId, baseVersion?, patch }` — every update.
 *
 * `baseVersion` is the version the client last saw; it is informational for the
 * service's compare-and-set, which re-reads and retries on a lost race.
 */
export const updateEnvelope = <
  const Id extends Schema.Top,
  const Patch extends Schema.Top,
>(
  id: Id,
  patch: Patch,
) =>
  Schema.Struct({
    id,
    clientMutationId: ClientMutationId,
    baseVersion: Schema.optional(Schema.Int),
    patch,
  })

/**
 * `{ id?, clientMutationId, ...fields }` — every create.
 *
 * `id` is optional because a client may mint the UUID v7 offline; the server
 * mints one otherwise. `fields` never contains `id`/`clientMutationId`.
 */
export const createEnvelope = <
  const Id extends Schema.Top,
  const Fields extends Schema.Struct.Fields,
>(
  id: Id,
  fields: Fields,
) =>
  Schema.Struct({
    id: Schema.optional(id),
    clientMutationId: ClientMutationId,
    ...fields,
  })

/** One field-level validation complaint. */
export const ValidationIssue = Schema.Struct({
  field: Schema.String,
  message: Schema.String,
})

/** `{ issues }` — the shape of every `*ValidationError`. */
export const validationFields = {
  issues: Schema.Array(ValidationIssue),
}

/** Why a row is invisible to the viewer (`docs/error-model-draft.md` §2). */
export const ForbiddenReason = Schema.Literals([
  'private',
  'household',
  'noHousehold',
])
export type ForbiddenReason = Schema.Schema.Type<typeof ForbiddenReason>

/**
 * `{ id, reason }` — the shape of every `*Forbidden`. `id` is nullable because
 * a refusal can happen before an id is known (a forbidden household, say).
 */
export const forbiddenFields = {
  id: Schema.NullOr(Schema.String),
  reason: ForbiddenReason,
}

/** `{ id }` — the shape of every version-CAS `*Conflict`. */
export const conflictFields = { id: Schema.String }

/** `{ id }` — the shape of every `*NotFound`, keeping the caller's id brand. */
export const notFoundFields = <const Id extends Schema.Top>(id: Id) => ({
  id,
})
