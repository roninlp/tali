import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlModel, SqlSchema } from "effect/sql"
import { User } from "@tali/domain"

/**
 * D1-backed repository for `User` (ticket #15).
 *
 * CRUD comes from `SqlModel.makeRepository`; lookups outside the derived set
 * (`findByEmail`) are hand-written `SqlSchema` queries. Rows are selected with
 * `SELECT *`, so column naming relies on the `SqlClient` layer being configured
 * with `transformResultNames`/`transformQueryNames` (snake_case columns ↔
 * camelCase fields) — see `apps/api/src/index.ts`.
 */
export class UserRepo extends Context.Service<UserRepo>()("UserRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const base = yield* SqlModel.makeRepository(User, {
      tableName: "users",
      spanPrefix: "Users",
      idColumn: "id"
    })

    const findByEmail = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: User,
      execute: (email) => sql`SELECT * FROM users WHERE email = ${email}`
    })

    return {
      insert: base.insert,
      findById: base.findById,
      update: base.update,
      findByEmail
    } as const
  })
}) {}

export const UserRepoLive = Layer.effect(UserRepo, UserRepo.make)
