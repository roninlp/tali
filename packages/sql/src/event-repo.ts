import { Context, Effect, Layer, Option } from "effect"
import { SqlClient, Statement } from "effect/sql"
import {
  Event,
  type EventException,
  type EventId,
  type EventTiming,
  type HouseholdId,
  type OccasionId,
  type RecurrenceRule,
  type UserId,
  type Visibility
} from "@tali/domain"

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

/** The trusted column projection, aliased to the camelCase wire names. */
export const EVENT_SELECT =
  `id, type, title, description, location, category, people, ` +
  `owner_id AS ownerId, household_id AS householdId, visibility, color, ` +
  `start_at AS startAt, end_at AS endAt, all_day_date AS allDayDate, ` +
  `time_zone AS timeZone, recurrence, exceptions, occasion_id AS occasionId, ` +
  `created_at AS createdAt, updated_at AS updatedAt, version, deleted_at AS deletedAt`

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

/** Parse a JSON array column; a malformed cell is an empty list, not a crash. */
const parseArray = (value: string | null): ReadonlyArray<unknown> => {
  if (value === null) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const parseJson = (value: string | null): unknown => {
  if (value === null) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

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
}): EventTiming =>
  row.allDayDate !== null
    ? { _tag: "allDay", date: row.allDayDate }
    : {
      _tag: "timed",
      start: row.startAt ?? row.createdAt,
      end: row.endAt ?? row.startAt ?? row.createdAt
    }

/** The model's plain shape, built from a D1 row. */
export const eventPropsOf = (row: EventRow) => ({
  id: row.id as Event["id"],
  type: "event" as const,
  title: row.title,
  description: row.description,
  location: row.location,
  category: row.category,
  people: parseArray(row.people).filter((entry): entry is string => typeof entry === "string"),
  timing: eventTimingOf(row),
  timeZone: row.timeZone,
  recurrence: parseJson(row.recurrence) as RecurrenceRule | null,
  exceptions: parseArray(row.exceptions) as ReadonlyArray<EventException>,
  occasionId: row.occasionId as OccasionId | null,
  ownerId: row.ownerId as UserId,
  householdId: row.householdId as HouseholdId,
  visibility: row.visibility as Visibility,
  color: row.color,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: Number(row.version),
  deletedAt: row.deletedAt
})

export const toEvent = (row: EventRow): Event => new Event(eventPropsOf(row))

const encodePeople = (people: ReadonlyArray<string>): string => JSON.stringify(people)

const encodeRecurrence = (rule: RecurrenceRule | null): string | null =>
  rule === null ? null : JSON.stringify(rule)

const encodeExceptions = (exceptions: ReadonlyArray<EventException>): string =>
  JSON.stringify(exceptions)

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

export class EventRepo extends Context.Service<EventRepo>()("EventRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    /** The visibility filter every event read shares (private owner-only). */
    const visibleScope = (input: {
      readonly householdId: string
      readonly userId: UserId
    }): Statement.Fragment =>
      sql`
        household_id = ${input.householdId}
        AND deleted_at IS NULL
        AND (owner_id = ${input.userId} OR visibility = 'shared')
      `

    const findById = (id: EventId) =>
      Effect.map(
        sql<EventRow>`SELECT ${sql.literal(EVENT_SELECT)} FROM events WHERE id = ${id}`,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toEvent)
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
        (rows) => rows.map(toEvent)
      )

    /**
     * The events of a date range, in the viewer's zone.
     *
     * An all-day row is inside the range when its local date is; a timed row
     * is inside when its start instant is. The two shapes are alternatives, so
     * they are OR'ed — a row is never both.
     */
    const listInRange = (input: EventQuery) =>
      Effect.gen(function*() {
        const ranges: Array<Statement.Fragment> = []
        if (input.dateFrom !== undefined || input.dateBefore !== undefined) {
          const parts: Array<Statement.Fragment> = [
            sql`all_day_date IS NOT NULL`
          ]
          if (input.dateFrom !== undefined) parts.push(sql`all_day_date >= ${input.dateFrom}`)
          if (input.dateBefore !== undefined) parts.push(sql`all_day_date < ${input.dateBefore}`)
          ranges.push(sql`(${sql.and(parts)})`)
        }
        if (input.instantFrom !== undefined || input.instantBefore !== undefined) {
          const parts: Array<Statement.Fragment> = [sql`start_at IS NOT NULL`]
          if (input.instantFrom !== undefined) parts.push(sql`start_at >= ${input.instantFrom}`)
          if (input.instantBefore !== undefined) parts.push(sql`start_at < ${input.instantBefore}`)
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
        (rows) => rows.map(toEvent)
      )

    const insert = (event: Event) =>
      Effect.map(
        sql<EventRow>`
          INSERT INTO events
            (id, type, title, description, location, category, people,
             owner_id, household_id, visibility, color, start_at, end_at,
             all_day_date, time_zone, recurrence, exceptions, occasion_id,
             created_at, updated_at, version, deleted_at)
          VALUES
            (${event.id}, ${event.type}, ${event.title}, ${event.description},
             ${event.location}, ${event.category}, ${encodePeople(event.people)},
             ${event.ownerId}, ${event.householdId}, ${event.visibility},
             ${event.color},
             ${event.timing._tag === "timed" ? event.timing.start : null},
             ${event.timing._tag === "timed" ? event.timing.end : null},
             ${event.timing._tag === "allDay" ? event.timing.date : null},
             ${event.timeZone}, ${encodeRecurrence(event.recurrence)},
             ${encodeExceptions(event.exceptions)}, ${event.occasionId},
             ${event.createdAt}, ${event.updatedAt}, ${event.version}, ${event.deletedAt})
          RETURNING ${sql.literal(EVENT_SELECT)}
        `,
        (rows) => toEvent(rows[0]!)
      )

    /**
     * Full-row update. The caller owns the version CAS (`WHERE id AND
     * version = base`) in the sync path; this primitive is for service writes
     * that already hold the row.
     */
    const update = (event: Event) =>
      Effect.map(
        sql<EventRow>`
          UPDATE events SET
            title = ${event.title},
            description = ${event.description},
            location = ${event.location},
            category = ${event.category},
            people = ${encodePeople(event.people)},
            visibility = ${event.visibility},
            color = ${event.color},
            start_at = ${event.timing._tag === "timed" ? event.timing.start : null},
            end_at = ${event.timing._tag === "timed" ? event.timing.end : null},
            all_day_date = ${event.timing._tag === "allDay" ? event.timing.date : null},
            time_zone = ${event.timeZone},
            recurrence = ${encodeRecurrence(event.recurrence)},
            exceptions = ${encodeExceptions(event.exceptions)},
            occasion_id = ${event.occasionId},
            updated_at = ${event.updatedAt},
            version = ${event.version},
            deleted_at = ${event.deletedAt}
          WHERE id = ${event.id}
          RETURNING ${sql.literal(EVENT_SELECT)}
        `,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toEvent)
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
    const insertEvent = (event: Event, gate: Statement.Fragment) => sql`
      INSERT INTO events
        (id, type, title, description, location, category, people,
         owner_id, household_id, visibility, color, start_at, end_at,
         all_day_date, time_zone, recurrence, exceptions, occasion_id,
         created_at, updated_at, version, deleted_at)
      SELECT
        ${event.id}, ${event.type}, ${event.title}, ${event.description},
        ${event.location}, ${event.category}, ${encodePeople(event.people)},
        ${event.ownerId}, ${event.householdId}, ${event.visibility},
        ${event.color},
        ${event.timing._tag === "timed" ? event.timing.start : null},
        ${event.timing._tag === "timed" ? event.timing.end : null},
        ${event.timing._tag === "allDay" ? event.timing.date : null},
        ${event.timeZone}, ${encodeRecurrence(event.recurrence)},
        ${encodeExceptions(event.exceptions)}, ${event.occasionId},
        ${event.createdAt}, ${event.updatedAt}, ${event.version}, ${event.deletedAt}
      WHERE ${gate}
      ON CONFLICT DO NOTHING
    `

    const insertStatement = (event: Event) => insertEvent(event, sql`1 = 1`)

    const insertStatementGated = (
      event: Event,
      gate: Pick<Event, "id" | "version" | "updatedAt" | "recurrence">
    ) =>
      insertEvent(
        event,
        sql`EXISTS (
          SELECT 1 FROM events
          WHERE id = ${gate.id}
            AND version = ${gate.version}
            AND updated_at = ${gate.updatedAt}
            AND recurrence IS ${encodeRecurrence(gate.recurrence)}
            AND deleted_at IS NULL
        )`
      )

    return {
      findById,
      listVisible,
      listInRange,
      listRecurringLive,
      insert,
      update,
      insertStatement,
      insertStatementGated
    } as const
  })
}) {}

export const EventRepoLive = Layer.effect(EventRepo, EventRepo.make)
