import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlModel, SqlSchema, Statement } from "effect/sql"
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

    /**
     * Raw statement so `D1Client.batch` can insert the user and its first
     * session atomically (D1 has no interactive transactions).
     */
    const insertStatement = (user: User): Statement.Statement<User> =>
      sql<User>`INSERT INTO users ${sql.insert(user as unknown as Record<string, unknown>)} RETURNING *`

    return {
      insert: base.insert,
      update: base.update,
      findById: base.findById,
      findByEmail,
      insertStatement
    } as const
  })
}) {}

export const UserRepoLive = Layer.effect(UserRepo, UserRepo.make)
