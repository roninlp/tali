import { Context, Effect, Layer, Option } from "effect"
import { SqlClient, Statement } from "effect/sql"
import {
  Habit,
  type HabitFrequency,
  type HabitFrequencyChange,
  type HabitId,
  type HabitReminderTime,
  type HouseholdId,
  type UserId,
  type Visibility
} from "@tali/domain"

/**
 * D1-backed repository for `Habit` (ticket #63; FR-HAB-01).
 *
 * Pure persistence: ids, version bumps, ownership and conflict rules belong to
 * `HabitService` and the sync registry (#34). D1 has no interactive
 * transactions, so a write that also touches the change feed is assembled by
 * the caller as one `D1Client.batch()`.
 *
 * ## Columns
 *
 * `frequency` and `frequency_history` are JSON text (the structured union and
 * its version log). `reminder_time` is the local `HH:mm`; `time_zone` is the
 * zone that time — and the history's effective dates — are read in.
 *
 * ## Reads
 *
 * `listVisible` is the household/private scope every aggregate shares: the
 * member's own private habits plus the household's shared ones. The habits
 * screen (#66) reads it; the sync path hydrates through the registry instead.
 */
export const HABIT_SELECT =
  `id, type, title, description, icon, ` +
  `owner_id AS ownerId, household_id AS householdId, visibility, color, ` +
  `started_on AS startedOn, frequency, frequency_history AS frequencyHistory, ` +
  `reminder_time AS reminderTime, time_zone AS timeZone, ` +
  `created_at AS createdAt, updated_at AS updatedAt, version, deleted_at AS deletedAt`

export interface HabitRow extends Record<string, unknown> {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly description: string | null
  readonly icon: string | null
  readonly ownerId: string
  readonly householdId: string
  readonly visibility: string
  readonly color: string | null
  /** The owner's local date the habit began (`YYYY-MM-DD`). */
  readonly startedOn: string
  /** JSON text of the frequency union. */
  readonly frequency: string
  /** JSON array text of the frequency versions. */
  readonly frequencyHistory: string
  readonly reminderTime: string | null
  readonly timeZone: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
  readonly deletedAt: string | null
}

const parseJson = (value: string | null): unknown => {
  if (value === null) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const parseArray = (value: string | null): ReadonlyArray<unknown> => {
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? parsed : []
}

/**
 * A row's frequency.
 *
 * The column is NOT NULL with a `daily` default, so the only fallback here is
 * for a hand-edited database cell: a habit that cannot be decoded still maps
 * to a valid aggregate rather than crashing every read.
 */
export const habitFrequencyOf = (value: string | null): HabitFrequency => {
  const parsed = parseJson(value)
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { _tag?: unknown })._tag === "daily"
  ) {
    return { _tag: "daily" }
  }
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as { _tag?: unknown; days?: unknown; times?: unknown }
    if (record._tag === "weekdays" && Array.isArray(record.days)) {
      const days = record.days.filter(
        (day): day is number => typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 7
      )
      // A cell with no usable weekday is not a valid union member; fall back
      // rather than construct an aggregate that cannot decode.
      if (days.length > 0) return { _tag: "weekdays", days: [...new Set(days)].sort() }
    }
    if (
      record._tag === "weekly" &&
      typeof record.times === "number" &&
      Number.isInteger(record.times) &&
      record.times >= 1 &&
      record.times <= 7
    ) {
      return { _tag: "weekly", times: record.times }
    }
  }
  return { _tag: "daily" }
}

/** The model's plain shape, built from a D1 row. */
export const habitPropsOf = (row: HabitRow) => ({
  id: row.id as Habit["id"],
  type: "habit" as const,
  title: row.title,
  description: row.description,
  icon: row.icon,
  startedOn: row.startedOn as Habit["startedOn"],
  frequency: habitFrequencyOf(row.frequency),
  frequencyHistory: parseArray(row.frequencyHistory) as ReadonlyArray<HabitFrequencyChange>,
  reminderTime: row.reminderTime as HabitReminderTime | null,
  timeZone: row.timeZone,
  ownerId: row.ownerId as UserId,
  householdId: row.householdId as HouseholdId,
  visibility: row.visibility as Visibility,
  color: row.color,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: Number(row.version),
  deletedAt: row.deletedAt
})

export const toHabit = (row: HabitRow): Habit => new Habit(habitPropsOf(row))

const encodeFrequency = (frequency: HabitFrequency): string => JSON.stringify(frequency)

const encodeHistory = (history: ReadonlyArray<HabitFrequencyChange>): string =>
  JSON.stringify(history)

export class HabitRepo extends Context.Service<HabitRepo>()("HabitRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    /** The visibility filter every habit read shares (private owner-only). */
    const visibleScope = (input: {
      readonly householdId: string
      readonly userId: UserId
    }): Statement.Fragment =>
      sql`
        household_id = ${input.householdId}
        AND deleted_at IS NULL
        AND (owner_id = ${input.userId} OR visibility = 'shared')
      `

    const findById = (id: HabitId) =>
      Effect.map(
        sql<HabitRow>`SELECT ${sql.literal(HABIT_SELECT)} FROM habits WHERE id = ${id}`,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toHabit)
      )

    /**
     * Live habits visible to one member: shared habits plus their own private
     * ones. Ordered by creation so the habits list is stable across devices
     * (`id` is a UUID v7, so it is the creation order).
     */
    const listVisible = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<HabitRow>`
          SELECT ${sql.literal(HABIT_SELECT)} FROM habits
          WHERE ${visibleScope(input)}
          ORDER BY created_at ASC, id ASC
        `,
        (rows) => rows.map(toHabit)
      )

    const insert = (habit: Habit) =>
      Effect.map(
        sql<HabitRow>`
          INSERT INTO habits
            (id, type, title, description, icon, owner_id, household_id, visibility,
             color, started_on, frequency, frequency_history, reminder_time, time_zone,
             created_at, updated_at, version, deleted_at)
          VALUES
            (${habit.id}, ${habit.type}, ${habit.title}, ${habit.description},
             ${habit.icon}, ${habit.ownerId}, ${habit.householdId}, ${habit.visibility},
             ${habit.color}, ${habit.startedOn}, ${encodeFrequency(habit.frequency)},
             ${encodeHistory(habit.frequencyHistory)}, ${habit.reminderTime},
             ${habit.timeZone}, ${habit.createdAt}, ${habit.updatedAt},
             ${habit.version}, ${habit.deletedAt})
          RETURNING ${sql.literal(HABIT_SELECT)}
        `,
        (rows) => toHabit(rows[0]!)
      )

    /**
     * Full-row update. The caller owns the version CAS (`WHERE id AND
     * version = base`) in the sync path; this primitive is for service writes
     * that already hold the row.
     */
    const update = (habit: Habit) =>
      Effect.map(
        sql<HabitRow>`
          UPDATE habits SET
            title = ${habit.title},
            description = ${habit.description},
            icon = ${habit.icon},
            visibility = ${habit.visibility},
            color = ${habit.color},
            frequency = ${encodeFrequency(habit.frequency)},
            frequency_history = ${encodeHistory(habit.frequencyHistory)},
            reminder_time = ${habit.reminderTime},
            time_zone = ${habit.timeZone},
            updated_at = ${habit.updatedAt},
            version = ${habit.version},
            deleted_at = ${habit.deletedAt}
          WHERE id = ${habit.id}
          RETURNING ${sql.literal(HABIT_SELECT)}
        `,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toHabit)
      )

    /** Statement form so the sync engine can put the write in one batch. */
    const insertStatement = (habit: Habit) => sql`
      INSERT INTO habits
        (id, type, title, description, icon, owner_id, household_id, visibility,
         color, started_on, frequency, frequency_history, reminder_time, time_zone,
         created_at, updated_at, version, deleted_at)
      VALUES
        (${habit.id}, ${habit.type}, ${habit.title}, ${habit.description},
         ${habit.icon}, ${habit.ownerId}, ${habit.householdId}, ${habit.visibility},
         ${habit.color}, ${habit.startedOn}, ${encodeFrequency(habit.frequency)},
         ${encodeHistory(habit.frequencyHistory)}, ${habit.reminderTime},
         ${habit.timeZone}, ${habit.createdAt}, ${habit.updatedAt},
         ${habit.version}, ${habit.deletedAt})
      ON CONFLICT DO NOTHING
    `

    return {
      findById,
      listVisible,
      insert,
      update,
      insertStatement
    } as const
  })
}) {}

export const HabitRepoLive = Layer.effect(HabitRepo, HabitRepo.make)
