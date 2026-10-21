import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema, Statement } from "effect/sql"
import { PushSubscription, UserId } from "@tali/domain"

/**
 * D1-backed repository for `PushSubscription` (tickets #20, #61).
 *
 * The endpoint is the natural key: a browser that rotates its subscription
 * creates a new endpoint, while a repeated registration of the same endpoint
 * refreshes the encryption keys atomically. The sweep reads these rows by
 * owner and deletes one when a push service answers `404`/`410` (ADR-0005
 * §Consequences) — that deletion is the only write here besides registration.
 */

/** Matches `MAX_IN_PARAMS` in the sync repo: D1 allows 100 bound parameters. */
const MAX_IN_PARAMS = 90

const chunked = <A>(values: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const chunks: Array<ReadonlyArray<A>> = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

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

      /**
       * Every device of every owner in one tick (ADR-0005 §9: one fixed read,
       * never a query per reminder). Chunked for D1's bound-parameter ceiling.
       */
      const listByUsers = (userIds: ReadonlyArray<UserId>) =>
        Effect.gen(function*() {
          const unique = [...new Set(userIds)]
          const rows: Array<PushSubscription> = []
          for (const chunk of chunked(unique, MAX_IN_PARAMS)) {
            const page = yield* SqlSchema.findAll({
              Request: Schema.Array(UserId),
              Result: PushSubscription,
              execute: (ids) => sql`
                SELECT * FROM push_subscriptions
                WHERE ${sql.in("user_id", ids)}
                ORDER BY created_at ASC
              `
            })(chunk)
            rows.push(...page)
          }
          return rows
        })

      /**
       * Dead endpoints (404/410) are removed in the outcome batch.
       *
       * One statement for the whole tick, not one per row: every statement in a
       * D1 batch counts toward the Free plan's 50-queries-per-invocation limit
       * (ADR-0005 §9). Callers must only append it when `ids` is non-empty.
       */
      const deleteManyStatement = (ids: ReadonlyArray<string>): Statement.Statement<unknown> =>
        sql`DELETE FROM push_subscriptions WHERE ${sql.in("id", ids)}`

      return { upsert, listByUser, listByUsers, deleteManyStatement } as const
    })
  }
) {}

export const PushSubscriptionRepoLive = Layer.effect(
  PushSubscriptionRepo,
  PushSubscriptionRepo.make
)
