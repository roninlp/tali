import { Context, Effect, Layer, Option } from "effect"
import { SqlClient, Statement } from "effect/sql"
import {
  HabitEntry,
  type HabitEntryStatus,
  type HabitId,
  type LocalDate,
  type UserId
} from "@tali/domain"

/**
 * D1-backed repository for `HabitEntry` (ticket #63; FR-HAB-02).
 *
 * The log of a habit: one row per `(habitId, localDate)`, enforced by the
 * `idx_habit_entries_habit_date` UNIQUE index. Entries travel on the same
 * version/feed path as every other aggregate; this module is the persistence
 * seam #64 (the daily tap and the ≤ 7-day backdating window) builds on.
 *
 * ## Why the upsert resolves first
 *
 * Because the unique key is `(habitId, localDate)` — not the row id — a tap on
 * an already-logged day must **not** insert a second row. `findForDate` is the
 * lookup #64 uses: if the day already has a row (live or tombstoned), the tap
 * updates that row's status (reviving it when `deletedAt` is set) and CASes on
 * its version; only a genuinely new day inserts. Two devices logging the same
 * day concurrently therefore race on one row's version rather than on a
 * duplicate insert that `ON CONFLICT DO NOTHING` would silently drop.
 *
 * ## Reads
 *
 * `listInRange` is the one query the Today lane, the streak windows and the
 * heatmap all need: a member's entries between two local dates. `listForHabit`
 * is the same range for one habit (the detail/heatmap view). Both are indexed
 * on `(owner_id, local_date)` / `(habit_id, local_date)`.
 */
export const HABIT_ENTRY_SELECT =
  `id, habit_id AS habitId, owner_id AS ownerId, household_id AS householdId, ` +
  `visibility, local_date AS localDate, time_zone AS timeZone, status, ` +
  `created_at AS createdAt, updated_at AS updatedAt, version, deleted_at AS deletedAt`

export interface HabitEntryRow extends Record<string, unknown> {
  readonly id: string
  readonly habitId: string
  readonly ownerId: string
  readonly householdId: string
  readonly visibility: string
  readonly localDate: string
  readonly timeZone: string
  readonly status: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
  readonly deletedAt: string | null
}

/** The model's plain shape, built from a D1 row. */
export const habitEntryPropsOf = (row: HabitEntryRow) => ({
  id: row.id as HabitEntry["id"],
  habitId: row.habitId as HabitId,
  ownerId: row.ownerId as UserId,
  householdId: row.householdId as HabitEntry["householdId"],
  visibility: row.visibility as HabitEntry["visibility"],
  localDate: row.localDate as LocalDate,
  timeZone: row.timeZone,
  status: row.status as HabitEntryStatus,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: Number(row.version),
  deletedAt: row.deletedAt
})

export const toHabitEntry = (row: HabitEntryRow): HabitEntry =>
  new HabitEntry(habitEntryPropsOf(row))

export interface HabitEntryQuery {
  readonly householdId: string
  readonly userId: UserId
  /** Inclusive local-date lower bound (`YYYY-MM-DD`). */
  readonly from: string
  /** Exclusive local-date upper bound (`YYYY-MM-DD`). */
  readonly before: string
  /** Narrow to one habit (the detail/heatmap read). */
  readonly habitId?: HabitId
}

export class HabitEntryRepo extends Context.Service<HabitEntryRepo>()("HabitEntryRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    /** The visibility filter every entry read shares (a private habit's log is private). */
    const visibleScope = (input: {
      readonly householdId: string
      readonly userId: UserId
    }): Statement.Fragment =>
      sql`
        household_id = ${input.householdId}
        AND deleted_at IS NULL
        AND (owner_id = ${input.userId} OR visibility = 'shared')
      `

    /**
     * The entry's *habit* must be visible to the viewer right now.
     *
     * The entry's own `visibility` is the habit's visibility **at write time**
     * (ADR-0006), so it goes stale the moment a habit is flipped to private or
     * trashed: a day logged while the habit was shared would otherwise keep
     * leaking through a read after the owner made the habit private. Resolving
     * the parent here — the same own-or-shared rule and the same
     * `deleted_at IS NULL` the habit list uses — is the read-side half of the
     * #63 parent rule ("the entry inherits the habit's visibility"); the write
     * path already forces the column on every tap.
     */
    const visibleParent = (input: {
      readonly householdId: string
      readonly userId: UserId
    }): Statement.Fragment =>
      sql`
        habit_id IN (
          SELECT id FROM habits
          WHERE household_id = ${input.householdId}
            AND deleted_at IS NULL
            AND (owner_id = ${input.userId} OR visibility = 'shared')
        )
      `

    const findById = (id: HabitEntry["id"]) =>
      Effect.map(
        sql<HabitEntryRow>`
          SELECT ${sql.literal(HABIT_ENTRY_SELECT)} FROM habit_entries WHERE id = ${id}
        `,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toHabitEntry)
      )

    /**
     * The row for one habit and one local day — **including** a tombstone.
     *
     * This is the #64 tap's lookup: the unique key is the day, so an existing
     * (possibly soft-deleted) row is updated in place rather than a second row
     * being inserted. The caller applies its own scope rules.
     */
    const findForDate = (input: { readonly habitId: HabitId; readonly localDate: string }) =>
      Effect.map(
        sql<HabitEntryRow>`
          SELECT ${sql.literal(HABIT_ENTRY_SELECT)} FROM habit_entries
          WHERE habit_id = ${input.habitId} AND local_date = ${input.localDate}
        `,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toHabitEntry)
      )

    /**
     * A member's entries in `[from, before)`.
     *
     * One query serves the Today lane, the streak windows and the heatmap; the
     * caller passes the habit filter when it wants one habit only. Both the
     * entry's own scope columns and the **habit's current** scope are applied,
     * so a day logged while a habit was shared stops leaking once the habit is
     * made private or trashed (see `visibleParent`).
     */
    const listInRange = (input: HabitEntryQuery) =>
      Effect.gen(function*() {
        const conditions: Array<Statement.Fragment> = [
          visibleScope(input),
          visibleParent(input),
          sql`local_date >= ${input.from}`,
          sql`local_date < ${input.before}`
        ]
        if (input.habitId !== undefined) conditions.push(sql`habit_id = ${input.habitId}`)
        const rows = yield* sql<HabitEntryRow>`
          SELECT ${sql.literal(HABIT_ENTRY_SELECT)} FROM habit_entries
          WHERE ${sql.and(conditions)}
          ORDER BY local_date ASC, habit_id ASC
        `
        return rows.map(toHabitEntry)
      })

    const insert = (entry: HabitEntry) =>
      Effect.map(
        sql<HabitEntryRow>`
          INSERT INTO habit_entries
            (id, habit_id, owner_id, household_id, visibility, local_date,
             time_zone, status, created_at, updated_at, version, deleted_at)
          VALUES
            (${entry.id}, ${entry.habitId}, ${entry.ownerId}, ${entry.householdId},
             ${entry.visibility}, ${entry.localDate}, ${entry.timeZone},
             ${entry.status}, ${entry.createdAt}, ${entry.updatedAt},
             ${entry.version}, ${entry.deletedAt})
          RETURNING ${sql.literal(HABIT_ENTRY_SELECT)}
        `,
        (rows) => toHabitEntry(rows[0]!)
      )

    /** Full-row update; the caller owns the version CAS (see `findForDate`). */
    const update = (entry: HabitEntry) =>
      Effect.map(
        sql<HabitEntryRow>`
          UPDATE habit_entries SET
            visibility = ${entry.visibility},
            time_zone = ${entry.timeZone},
            status = ${entry.status},
            updated_at = ${entry.updatedAt},
            version = ${entry.version},
            deleted_at = ${entry.deletedAt}
          WHERE id = ${entry.id}
          RETURNING ${sql.literal(HABIT_ENTRY_SELECT)}
        `,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toHabitEntry)
      )

    /** Statement form so the sync engine can put the write in one batch. */
    const insertStatement = (entry: HabitEntry) => sql`
      INSERT INTO habit_entries
        (id, habit_id, owner_id, household_id, visibility, local_date,
         time_zone, status, created_at, updated_at, version, deleted_at)
      VALUES
        (${entry.id}, ${entry.habitId}, ${entry.ownerId}, ${entry.householdId},
         ${entry.visibility}, ${entry.localDate}, ${entry.timeZone},
         ${entry.status}, ${entry.createdAt}, ${entry.updatedAt},
         ${entry.version}, ${entry.deletedAt})
      ON CONFLICT DO NOTHING
    `

    return {
      findById,
      findForDate,
      listInRange,
      insert,
      update,
      insertStatement
    } as const
  })
}) {}

export const HabitEntryRepoLive = Layer.effect(HabitEntryRepo, HabitEntryRepo.make)
