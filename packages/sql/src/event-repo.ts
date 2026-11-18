import { Context, Effect, Layer, Option, Schema } from 'effect'
import { SqlClient, Statement } from 'effect/sql'
import {
  Event,
  EventException,
  type EventId,
  EventTiming,
  type HouseholdId,
  LocalDate,
  type OccasionId,
  RecurrenceRule,
  TimestampUtc,
  type UserId,
  type Visibility,
  allDayEventTiming,
  timedEventTiming,
} from '@tali/domain'
import {
  type ColumnCodec,
  type ColumnValues,
  column,
  columnCodecs,
  defineTable,
  insertStatement,
  selectList,
  updateStatement,
} from './columns'
import { visibleScopeSql } from './scope'

/**
 * D1-backed repository for `Event` (ticket #57; FR-CAL-01).
 *
 * Pure persistence: ids, version bumps, ownership and conflict rules belong
 * to `EventService` and the sync registry (#34). D1 has no interactive
 * transactions, so a write that also touches the change feed is assembled by
 * the caller as one `D1Client.batch()`.
 *
 * ## Columns
 *
 * The row is the flat form of the model's `timing` union: `start_at`/`end_at`
 * for a timed event, `all_day_date` for an all-day one, plus the event's
 * `time_zone`. `recurrence` and `exceptions` are JSON text (the structured
 * rule and the per-occurrence deviation list).
 *
 * ## Reading by a date range
 *
 * A local date range is a range of *instants* for a timed event and a range
 * of *dates* for an all-day one, so the caller computes both bounds in the
 * viewer's zone (the same way `TaskService` does for tasks) and the query
 * ORs the two shapes. SQLite has no time-zone database, so the local date of
 * a timed event cannot be derived in SQL — it is derived from the instant
 * range instead.
 */

const asTiming = Schema.decodeUnknownOption(EventTiming)

/** The timing union, decoded defensively; malformed input reads as absent. */
const timingOf = (value: unknown): EventTiming | null =>
  Option.getOrNull(asTiming(value))

/**
 * The timing union's three physical columns, as per-column codecs on the one
 * `timing` field (#115): a timed row carries the two instants, an all-day
 * row the local date — never both, exactly like the hand-written statements.
 */
const timingStartAt: ColumnCodec = value => {
  const timing = timingOf(value)
  return timing !== null && timing._tag === 'timed' ? timing.start : null
}
const timingEndAt: ColumnCodec = value => {
  const timing = timingOf(value)
  return timing !== null && timing._tag === 'timed' ? timing.end : null
}
const timingAllDayDate: ColumnCodec = value => {
  const timing = timingOf(value)
  return timing !== null && timing._tag === 'allDay' ? timing.date : null
}

/**
 * The one place `events`' columns are declared (#115): the repo's SELECT,
 * INSERT and UPDATE lists below, and the sync registry's projection and
 * statements, are all generated from this descriptor.
 */
export const EVENT_TABLE = defineTable('events', [
  column('id', { updatable: false }),
  column('type', { updatable: false }),
  column('title', { codec: columnCodecs.text }),
  column('description', { codec: columnCodecs.nullableText }),
  column('location', { codec: columnCodecs.nullableText }),
  column('category', { codec: columnCodecs.nullableText }),
  column('people', { codec: columnCodecs.json }),
  column('owner_id', 'ownerId', { updatable: false }),
  column('household_id', 'householdId', { updatable: false }),
  column('visibility'),
  column('color', { codec: columnCodecs.nullableText }),
  column('start_at', 'timing', {
    as: 'startAt',
    codec: timingStartAt,
    mirrors: [
      { column: 'end_at', as: 'endAt', codec: timingEndAt },
      { column: 'all_day_date', as: 'allDayDate', codec: timingAllDayDate },
    ],
  }),
  column('time_zone', 'timeZone', { codec: columnCodecs.text }),
  column('recurrence', { codec: columnCodecs.jsonOrNull }),
  column('exceptions', { codec: columnCodecs.json }),
  column('occasion_id', 'occasionId', { codec: columnCodecs.nullableText }),
  column('created_at', 'createdAt', {
    updatable: false,
    codec: columnCodecs.text,
  }),
  column('updated_at', 'updatedAt', { codec: columnCodecs.text }),
  column('version', { codec: columnCodecs.int }),
  column('deleted_at', 'deletedAt', { codec: columnCodecs.nullableText }),
])

/** The trusted column projection, aliased to the camelCase wire names. */
export const EVENT_SELECT = selectList(EVENT_TABLE)

export interface EventRow extends Record<string, unknown> {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly description: string | null
  readonly location: string | null
  readonly category: string | null
  /** JSON array text. */
  readonly people: string
  readonly ownerId: string
  readonly householdId: string
  readonly visibility: string
  readonly color: string | null
  readonly startAt: string | null
  readonly endAt: string | null
  readonly allDayDate: string | null
  readonly timeZone: string
  /** JSON text of the structured rule; `null` for a one-off event. */
  readonly recurrence: string | null
  /** JSON array text of the per-occurrence exceptions. */
  readonly exceptions: string
  readonly occasionId: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
  readonly deletedAt: string | null
}

const asPeople = Schema.decodeOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
)

const asRecurrence = Schema.decodeOption(
  Schema.fromJsonString(Schema.NullOr(RecurrenceRule)),
)

const asExceptions = Schema.decodeOption(
  Schema.fromJsonString(Schema.Array(EventException)),
)

/**
 * The row's timing union.
 *
 * An all-day row carries its date; a timed row carries its two instants. A
 * row with neither (only possible in a hand-edited database) falls back to the
 * creation instant so the row still maps to a valid aggregate.
 */
export const eventTimingOf = (row: {
  readonly startAt: string | null
  readonly endAt: string | null
  readonly allDayDate: string | null
  readonly createdAt: string
}): EventTiming => {
  if (row.allDayDate !== null) {
    return allDayEventTiming(LocalDate.make(row.allDayDate))
  }
  const start = row.startAt ?? row.createdAt
  return timedEventTiming(
    TimestampUtc.make(start),
    TimestampUtc.make(row.endAt ?? start),
  )
}

/** The model's plain shape, built from a D1 row. */
export const eventPropsOf = (row: EventRow) => ({
  id: row.id as Event['id'],
  type: 'event' as const,
  title: row.title,
  description: row.description,
  location: row.location,
  category: row.category,
  people: Option.getOrElse(asPeople(row.people), () => []),
  timing: eventTimingOf(row),
  timeZone: row.timeZone,
  recurrence:
    row.recurrence === null
      ? null
      : Option.getOrElse(asRecurrence(row.recurrence), () => null),
  exceptions: Option.getOrElse(asExceptions(row.exceptions), () => []),
  occasionId: row.occasionId as OccasionId | null,
  ownerId: row.ownerId as UserId,
  householdId: row.householdId as HouseholdId,
  visibility: row.visibility as Visibility,
  color: row.color,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: Number(row.version),
  deletedAt: row.deletedAt,
})

export const toEvent = (row: EventRow): Event => new Event(eventPropsOf(row))

/** The model's column values; the descriptor's codecs do the encoding. */
const eventValues = (event: Event): ColumnValues<typeof EVENT_TABLE> => ({
  id: event.id,
  type: event.type,
  title: event.title,
  description: event.description,
  location: event.location,
  category: event.category,
  people: event.people,
  ownerId: event.ownerId,
  householdId: event.householdId,
  visibility: event.visibility,
  color: event.color,
  timing: event.timing,
  timeZone: event.timeZone,
  recurrence: event.recurrence,
  exceptions: event.exceptions,
  occasionId: event.occasionId,
  createdAt: event.createdAt,
  updatedAt: event.updatedAt,
  version: event.version,
  deletedAt: event.deletedAt,
})

export interface EventQuery {
  readonly householdId: string
  readonly userId: UserId
  /** Inclusive local-date lower bound for all-day rows. */
  readonly dateFrom?: string
  /** Exclusive local-date upper bound for all-day rows. */
  readonly dateBefore?: string
  /** Inclusive instant lower bound for timed rows. */
  readonly instantFrom?: string
  /** Exclusive instant upper bound for timed rows. */
  readonly instantBefore?: string
}

export class EventRepo extends Context.Service<EventRepo>()('EventRepo', {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    /** ADR-0011: the visibility filter every event read shares. */
    const visibleScope = (input: {
      readonly householdId: string
      readonly userId: UserId
    }): Statement.Fragment => visibleScopeSql(sql, input)

    const findById = (id: EventId) =>
      Effect.map(
        sql<EventRow>`SELECT ${sql.literal(EVENT_SELECT)} FROM events WHERE id = ${id}`,
        rows => Option.map(Option.fromUndefinedOr(rows[0]), toEvent),
      )

    /**
     * Live rows visible to one member: shared events plus their own private
     * ones. Mirrors the sync pull filter (`docs/sync-protocol-draft.md` §3.2).
     */
    const listVisible = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<EventRow>`
          SELECT ${sql.literal(EVENT_SELECT)} FROM events
          WHERE ${visibleScope(input)}
          ORDER BY all_day_date IS NULL, all_day_date ASC, start_at ASC, id ASC
        `,
        rows => rows.map(toEvent),
      )

    /**
     * The events of a date range, in the viewer's zone.
     *
     * An all-day row is inside the range when its local date is; a timed row
     * is inside when its start instant is. The two shapes are alternatives, so
     * they are OR'ed — a row is never both.
     */
    const listInRange = (input: EventQuery) =>
      Effect.gen(function* () {
        const ranges: Array<Statement.Fragment> = []
        if (input.dateFrom !== undefined || input.dateBefore !== undefined) {
          const parts: Array<Statement.Fragment> = [
            sql`all_day_date IS NOT NULL`,
          ]
          if (input.dateFrom !== undefined)
            parts.push(sql`all_day_date >= ${input.dateFrom}`)
          if (input.dateBefore !== undefined)
            parts.push(sql`all_day_date < ${input.dateBefore}`)
          ranges.push(sql`(${sql.and(parts)})`)
        }
        if (
          input.instantFrom !== undefined ||
          input.instantBefore !== undefined
        ) {
          const parts: Array<Statement.Fragment> = [sql`start_at IS NOT NULL`]
          if (input.instantFrom !== undefined)
            parts.push(sql`start_at >= ${input.instantFrom}`)
          if (input.instantBefore !== undefined)
            parts.push(sql`start_at < ${input.instantBefore}`)
          ranges.push(sql`(${sql.and(parts)})`)
        }
        const conditions: Array<Statement.Fragment> = [visibleScope(input)]
        if (ranges.length > 0) conditions.push(sql`(${sql.or(ranges)})`)

        const rows = yield* sql<EventRow>`
          SELECT ${sql.literal(EVENT_SELECT)} FROM events
          WHERE ${sql.and(conditions)}
          ORDER BY all_day_date IS NULL, all_day_date ASC, start_at ASC, id ASC
        `
        return rows.map(toEvent)
      })

    /**
     * Every live recurring series visible to one member, regardless of its
     * anchor date.
     *
     * A calendar window reads the rows whose anchor falls inside it, but a
     * series anchored months earlier still has occurrences inside the window —
     * so the expansion (#58) needs the live series once, exactly like the #43
     * task read model. One-off events are not repeated here; the range query
     * already returns them.
     */
    const listRecurringLive = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<EventRow>`
          SELECT ${sql.literal(EVENT_SELECT)} FROM events
          WHERE ${visibleScope(input)} AND recurrence IS NOT NULL
          ORDER BY all_day_date IS NULL, all_day_date ASC, start_at ASC, id ASC
        `,
        rows => rows.map(toEvent),
      )

    const insert = (event: Event) =>
      Effect.map(
        insertStatement<EventRow>(sql, EVENT_TABLE, {
          values: eventValues(event),
          returning: EVENT_SELECT,
        }),
        rows => toEvent(rows[0]!),
      )

    /**
     * Full-row update. The caller owns the version CAS (`WHERE id AND
     * version = base`) in the sync path; this primitive is for service writes
     * that already hold the row.
     */
    const update = (event: Event) =>
      Effect.map(
        updateStatement<EventRow>(sql, EVENT_TABLE, {
          id: event.id,
          values: eventValues(event),
          returning: EVENT_SELECT,
        }),
        rows => Option.map(Option.fromUndefinedOr(rows[0]), toEvent),
      )

    /**
     * Statement form so the sync engine can put the write in one batch.
     *
     * It is an `INSERT … SELECT` so the same row list can carry a gate: a
     * series split inserts the new tail **only if** the old row is exactly the
     * truncated row this batch wrote. Matching the whole shape matters, not
     * just the version: a concurrent writer that bumps the series to the same
     * next version would otherwise open the gate while our truncation lost its
     * compare-and-set, and the two halves would both claim the future. The
     * `notes_fts` index hook uses the same version+`updated_at` gate for the
     * same reason. `1 = 1` is the ungated form.
     */
    const insertGated = (event: Event, gate: Statement.Fragment) =>
      insertStatement(sql, EVENT_TABLE, {
        values: eventValues(event),
        gate,
        onConflict: true,
      })

    const insertStatementFor = (event: Event) => insertGated(event, sql`1 = 1`)

    const insertStatementGated = (
      event: Event,
      gate: Pick<Event, 'id' | 'version' | 'updatedAt' | 'recurrence'>,
    ) =>
      insertGated(
        event,
        sql`EXISTS (
          SELECT 1 FROM events
          WHERE id = ${gate.id}
            AND version = ${gate.version}
            AND updated_at = ${gate.updatedAt}
            AND recurrence IS ${gate.recurrence === null ? null : JSON.stringify(gate.recurrence)}
            AND deleted_at IS NULL
        )`,
      )

    return {
      findById,
      listVisible,
      listInRange,
      listRecurringLive,
      insert,
      update,
      insertStatement: insertStatementFor,
      insertStatementGated,
    }
  }),
}) {}

export const EventRepoLive = Layer.effect(EventRepo, EventRepo.make)
