import { Context, Effect, Layer, Option, Schema } from 'effect'
import { SqlClient, Statement } from 'effect/sql'
import {
  Habit,
  HabitFrequency,
  HabitFrequencyChange,
  type HabitId,
  type HabitReminderTime,
  type HouseholdId,
  type UserId,
  type Visibility,
  dailyHabitFrequency,
} from '@tali/domain'
import {
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

/**
 * The one place `habits`' columns are declared (#115): the repo's SELECT,
 * INSERT and UPDATE lists below, and the sync registry's projection and
 * statements, are all generated from this descriptor. `started_on` is
 * insert-only — statistics never look before the day the habit began, and no
 * writer may move it.
 */
export const HABIT_TABLE = defineTable('habits', [
  column('id', { updatable: false }),
  column('type', { updatable: false }),
  column('title', { codec: columnCodecs.text }),
  column('description', { codec: columnCodecs.nullableText }),
  column('icon', { codec: columnCodecs.nullableText }),
  column('owner_id', 'ownerId', { updatable: false }),
  column('household_id', 'householdId', { updatable: false }),
  column('visibility'),
  column('color', { codec: columnCodecs.nullableText }),
  column('started_on', 'startedOn', {
    updatable: false,
    codec: columnCodecs.text,
  }),
  column('frequency', { codec: columnCodecs.json }),
  column('frequency_history', 'frequencyHistory', {
    codec: columnCodecs.json,
  }),
  column('reminder_time', 'reminderTime', { codec: columnCodecs.nullableText }),
  column('time_zone', 'timeZone', { codec: columnCodecs.text }),
  column('created_at', 'createdAt', {
    updatable: false,
    codec: columnCodecs.text,
  }),
  column('updated_at', 'updatedAt', { codec: columnCodecs.text }),
  column('version', { codec: columnCodecs.int }),
  column('deleted_at', 'deletedAt', { codec: columnCodecs.nullableText }),
])

/** The trusted column projection, aliased to the camelCase wire names. */
export const HABIT_SELECT = selectList(HABIT_TABLE)

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

const asFrequency = Schema.decodeOption(Schema.fromJsonString(HabitFrequency))

const asHistory = Schema.decodeOption(
  Schema.fromJsonString(Schema.Array(HabitFrequencyChange)),
)

/**
 * A row's frequency.
 *
 * The column is NOT NULL with a `daily` default, so the only fallback here is
 * for a hand-edited database cell: a habit that cannot be decoded still maps
 * to a valid aggregate rather than crashing every read.
 */
export const habitFrequencyOf = (value: string | null): HabitFrequency =>
  value === null
    ? dailyHabitFrequency()
    : Option.getOrElse(asFrequency(value), dailyHabitFrequency)

/** The model's plain shape, built from a D1 row. */
export const habitPropsOf = (row: HabitRow) => ({
  id: row.id as Habit['id'],
  type: 'habit' as const,
  title: row.title,
  description: row.description,
  icon: row.icon,
  startedOn: row.startedOn as Habit['startedOn'],
  frequency: habitFrequencyOf(row.frequency),
  frequencyHistory: Option.getOrElse(asHistory(row.frequencyHistory), () => []),
  reminderTime: row.reminderTime as HabitReminderTime | null,
  timeZone: row.timeZone,
  ownerId: row.ownerId as UserId,
  householdId: row.householdId as HouseholdId,
  visibility: row.visibility as Visibility,
  color: row.color,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: Number(row.version),
  deletedAt: row.deletedAt,
})

export const toHabit = (row: HabitRow): Habit => new Habit(habitPropsOf(row))

/** The model's column values; the descriptor's codecs do the encoding. */
const habitValues = (habit: Habit): ColumnValues<typeof HABIT_TABLE> => ({
  id: habit.id,
  type: habit.type,
  title: habit.title,
  description: habit.description,
  icon: habit.icon,
  ownerId: habit.ownerId,
  householdId: habit.householdId,
  visibility: habit.visibility,
  color: habit.color,
  startedOn: habit.startedOn,
  frequency: habit.frequency,
  frequencyHistory: habit.frequencyHistory,
  reminderTime: habit.reminderTime,
  timeZone: habit.timeZone,
  createdAt: habit.createdAt,
  updatedAt: habit.updatedAt,
  version: habit.version,
  deletedAt: habit.deletedAt,
})

export class HabitRepo extends Context.Service<HabitRepo>()('HabitRepo', {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    /** ADR-0011: the visibility filter every habit read shares. */
    const visibleScope = (input: {
      readonly householdId: string
      readonly userId: UserId
    }): Statement.Fragment => visibleScopeSql(sql, input)

    const findById = (id: HabitId) =>
      Effect.map(
        sql<HabitRow>`SELECT ${sql.literal(HABIT_SELECT)} FROM habits WHERE id = ${id}`,
        rows => Option.map(Option.fromUndefinedOr(rows[0]), toHabit),
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
        rows => rows.map(toHabit),
      )

    const insert = (habit: Habit) =>
      Effect.map(
        insertStatement<HabitRow>(sql, HABIT_TABLE, {
          values: habitValues(habit),
          returning: HABIT_SELECT,
        }),
        rows => toHabit(rows[0]!),
      )

    /**
     * Full-row update. The caller owns the version CAS (`WHERE id AND
     * version = base`) in the sync path; this primitive is for service writes
     * that already hold the row.
     */
    const update = (habit: Habit) =>
      Effect.map(
        updateStatement<HabitRow>(sql, HABIT_TABLE, {
          id: habit.id,
          values: habitValues(habit),
          returning: HABIT_SELECT,
        }),
        rows => Option.map(Option.fromUndefinedOr(rows[0]), toHabit),
      )

    /** Statement form so the sync engine can put the write in one batch. */
    const insertStatementFor = (habit: Habit) =>
      insertStatement(sql, HABIT_TABLE, {
        values: habitValues(habit),
        onConflict: true,
      })

    return {
      findById,
      listVisible,
      insert,
      update,
      insertStatement: insertStatementFor,
    }
  }),
}) {}

export const HabitRepoLive = Layer.effect(HabitRepo, HabitRepo.make)
