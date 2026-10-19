import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { PushSubscription, UserId } from "@tali/domain"

/**
 * D1-backed repository for `PushSubscription` (ticket #20).
 *
 * The endpoint is the natural key: a browser that rotates its subscription
 * creates a new endpoint, while a repeated registration of the same endpoint
 * refreshes the encryption keys atomically. The real dispatch gateway (later
 * slice) reads these rows by user.
 */
export class PushSubscriptionRepo extends Context.Service<PushSubscriptionRepo>()(
  "PushSubscriptionRepo",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const upsert = SqlSchema.findOne({
        Request: PushSubscription.insert,
        Result: PushSubscription,
        execute: (subscription) => sql`
          INSERT INTO push_subscriptions
            (id, user_id, endpoint, p256dh, auth, expiration_time, user_agent, created_at, updated_at)
          VALUES
            (${subscription.id}, ${subscription.userId}, ${subscription.endpoint},
             ${subscription.p256dh}, ${subscription.auth}, ${subscription.expirationTime},
             ${subscription.userAgent}, ${subscription.createdAt}, ${subscription.updatedAt})
          ON CONFLICT (endpoint) DO UPDATE SET
            user_id = excluded.user_id,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            expiration_time = excluded.expiration_time,
            user_agent = excluded.user_agent,
            updated_at = excluded.updated_at
          RETURNING *
        `
      })

      const listByUser = SqlSchema.findAll({
        Request: UserId,
        Result: PushSubscription,
        execute: (userId) => sql`
          SELECT * FROM push_subscriptions
          WHERE user_id = ${userId}
          ORDER BY created_at ASC
        `
      })

      return { upsert, listByUser } as const
    })
  }
) {}

export const PushSubscriptionRepoLive = Layer.effect(
  PushSubscriptionRepo,
  PushSubscriptionRepo.make
)
