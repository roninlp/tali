import { Context, Effect, Layer, Option } from "effect"
import {
  defaultPreferences,
  UserPreferences,
  type PreferenceDefaults,
  type PreferencesPatch,
  type UserId
} from "@tali/domain"
import { UserPreferencesRepo, UserPreferencesRepoLive } from "@tali/sql"

/**
 * Per-user preferences service (ticket #35).
 *
 * The repository is the source of truth; a missing row is not an error but the
 * Persian-first defaults, seeded from the account's registered profile (time
 * zone, week start, digits) so the first settings visit never changes what the
 * user already sees. A patch is merged with the current values and written as
 * one upsert — never through the sync outbox (ADR-0002).
 */
export class PreferencesService extends Context.Service<PreferencesService>()(
  "PreferencesService",
  {
    make: Effect.gen(function*() {
      const repo = yield* UserPreferencesRepo

      const get = (userId: UserId, defaults: PreferenceDefaults = {}) =>
        Effect.map(
          repo.findByUser(userId).pipe(Effect.orDie),
          Option.getOrElse(() => defaultPreferences(userId, defaults))
        )

      const update = (
        userId: UserId,
        patch: PreferencesPatch,
        defaults: PreferenceDefaults = {}
      ) =>
        Effect.gen(function*() {
          const current = yield* get(userId, defaults)
          const next = new UserPreferences({
            userId,
            timeZone: patch.timeZone ?? current.timeZone,
            weekStart: patch.weekStart ?? current.weekStart,
            digits: patch.digits ?? current.digits,
            dashboardSectionOrder:
              patch.dashboardSectionOrder ?? current.dashboardSectionOrder,
            checkedItemPlacement:
              patch.checkedItemPlacement ?? current.checkedItemPlacement,
            createdAt: current.createdAt,
            updatedAt: new Date().toISOString()
          })
          return yield* repo.upsert(next).pipe(Effect.orDie)
        })

      return { get, update } as const
    })
  }
) {}

export const PreferencesServiceLive = Layer.effect(
  PreferencesService,
  PreferencesService.make
).pipe(Layer.provide(UserPreferencesRepoLive))
