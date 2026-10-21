import { Context, Effect, Layer, Option } from "effect"
import { SqlClient, Statement } from "effect/sql"
import {
  Occasion,
  type HouseholdId,
  type OccasionId,
  type TaskId,
  type UserId,
  type Visibility
} from "@tali/domain"

/**
 * D1-backed repository for `Occasion` (ticket #59; FR-CAL-02).
 *
 * Pure persistence: ids, version bumps, ownership and conflict rules belong to
 * `OccasionService` and the sync registry (#34). D1 has no interactive
 * transactions, so a write that also touches the change feed is assembled by
 * the caller as one `D1Client.batch()`.
 *
 * The table stores the **origin** local date only. There is no occurrence table
 * and no per-year row: `packages/domain/src/planning/occasion-projection.ts`
 * derives the annual dates, so a read of a month is one indexed household scan
 * plus pure date arithmetic (a household has a handful of occasions).
 */

/** The trusted column projection, aliased to the camelCase wire names. */
export const OCCASION_SELECT =
  `id, type, title, origin_date AS originDate, time_zone AS timeZone, yearly, ` +
  `advance_reminder_days AS advanceReminderDays, preparation_task_id AS preparationTaskId, ` +
  `owner_id AS ownerId, household_id AS householdId, visibility, color, ` +
  `created_at AS createdAt, updated_at AS updatedAt, version, deleted_at AS deletedAt`

export interface OccasionRow extends Record<string, unknown> {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly originDate: string
  readonly timeZone: string
  /** SQLite 0/1. */
  readonly yearly: number
  readonly advanceReminderDays: number | null
  readonly preparationTaskId: string | null
  readonly ownerId: string
  readonly householdId: string
  readonly visibility: string
  readonly color: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
  readonly deletedAt: string | null
}

const asNullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null

/** The model's plain shape, built from a D1 row. */
export const occasionPropsOf = (row: OccasionRow) => ({
  id: row.id as Occasion["id"],
  type: "occasion" as const,
  title: row.title,
  originDate: row.originDate as Occasion["originDate"],
  timeZone: row.timeZone,
  yearly: row.yearly === 1,
  advanceReminderDays: asNullableNumber(row.advanceReminderDays),
  preparationTaskId: asNullableString(row.preparationTaskId) as TaskId | null,
  ownerId: row.ownerId as UserId,
  householdId: row.householdId as HouseholdId,
  visibility: row.visibility as Visibility,
  color: row.color,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: Number(row.version),
  deletedAt: row.deletedAt
})

export const toOccasion = (row: OccasionRow): Occasion => new Occasion(occasionPropsOf(row))

export class OccasionRepo extends Context.Service<OccasionRepo>()("OccasionRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    /** The visibility filter every occasion read shares (private owner-only). */
    const visibleScope = (input: {
      readonly householdId: string
      readonly userId: UserId
    }): Statement.Fragment =>
      sql`
        household_id = ${input.householdId}
        AND deleted_at IS NULL
        AND (owner_id = ${input.userId} OR visibility = 'shared')
      `

    const findById = (id: OccasionId) =>
      Effect.map(
        sql<OccasionRow>`SELECT ${sql.literal(OCCASION_SELECT)} FROM occasions WHERE id = ${id}`,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toOccasion)
      )

    /**
     * Live rows visible to one member: shared occasions plus their own private
     * ones. Mirrors the sync pull filter (`docs/sync-protocol-draft.md` §3.2).
     */
    const listVisible = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<OccasionRow>`
          SELECT ${sql.literal(OCCASION_SELECT)} FROM occasions
          WHERE ${visibleScope(input)}
          ORDER BY origin_date ASC, title ASC, id ASC
        `,
        (rows) => rows.map(toOccasion)
      )

    return { findById, listVisible } as const
  })
}) {}

export const OccasionRepoLive = Layer.effect(OccasionRepo, OccasionRepo.make)
