import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { type DashboardSection, UserPreferences, type UserId } from "@tali/domain"

/**
 * D1-backed repository for `UserPreferences` (ticket #35).
 *
 * One row per user (`user_id` is the primary key); `findByUser` returns
 * `Option.none` when the user has never saved settings, which the service
 * turns into the Persian-first defaults. `dashboard_section_order` is a
 * denormalized JSON array, parsed here so the domain keeps an ordered list.
 */

const PREFERENCE_COLUMNS =
  `user_id AS userId, time_zone AS timeZone, week_start AS weekStart, ` +
  `digits, dashboard_section_order AS dashboardSectionOrder, ` +
  `checked_item_placement AS checkedItemPlacement, ` +
  `created_at AS createdAt, updated_at AS updatedAt`

interface PreferencesRow extends Omit<UserPreferences, "dashboardSectionOrder"> {
  readonly dashboardSectionOrder: string
}

const toPreferences = (row: PreferencesRow): UserPreferences =>
  new UserPreferences({
    ...row,
    dashboardSectionOrder: JSON.parse(row.dashboardSectionOrder) as ReadonlyArray<DashboardSection>
  })

const encodeSectionOrder = (sections: ReadonlyArray<DashboardSection>): string =>
  JSON.stringify(sections)

export class UserPreferencesRepo extends Context.Service<UserPreferencesRepo>()(
  "UserPreferencesRepo",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const findByUser = (userId: UserId) =>
        Effect.map(
          sql<PreferencesRow>`
            SELECT ${sql.literal(PREFERENCE_COLUMNS)}
            FROM user_preferences
            WHERE user_id = ${userId}
          `,
          (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toPreferences)
        )

      /**
       * Insert the first save or replace every stored field. The service has
       * already merged the patch with the current row, so a full upsert keeps
       * the write to one statement (D1 has no interactive transactions).
       */
      const upsert = (preferences: UserPreferences) =>
        Effect.map(
          sql<PreferencesRow>`
            INSERT INTO user_preferences
              (user_id, time_zone, week_start, digits, dashboard_section_order,
               checked_item_placement, created_at, updated_at)
            VALUES
              (${preferences.userId}, ${preferences.timeZone},
               ${preferences.weekStart}, ${preferences.digits},
               ${encodeSectionOrder(preferences.dashboardSectionOrder)},
               ${preferences.checkedItemPlacement}, ${preferences.createdAt},
               ${preferences.updatedAt})
            ON CONFLICT (user_id) DO UPDATE SET
              time_zone = excluded.time_zone,
              week_start = excluded.week_start,
              digits = excluded.digits,
              dashboard_section_order = excluded.dashboard_section_order,
              checked_item_placement = excluded.checked_item_placement,
              updated_at = excluded.updated_at
            RETURNING ${sql.literal(PREFERENCE_COLUMNS)}
          `,
          (rows) => toPreferences(rows[0]!)
        )

      return { findByUser, upsert } as const
    })
  }
) {}

export const UserPreferencesRepoLive = Layer.effect(
  UserPreferencesRepo,
  UserPreferencesRepo.make
)
