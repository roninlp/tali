import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlModel, SqlSchema } from "effect/sql"
import { Session } from "@tali/domain"

/** D1-backed repository for `Session` (ticket #15). */
export class SessionRepo extends Context.Service<SessionRepo>()("SessionRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const base = yield* SqlModel.makeRepository(Session, {
      tableName: "sessions",
      spanPrefix: "Sessions",
      idColumn: "id"
    })

    /** The cookie carries the raw token; only its SHA-256 hash is stored. */
    const findByTokenHash = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Session,
      execute: (tokenHash) => sql`SELECT * FROM sessions WHERE token_hash = ${tokenHash}`
    })

    const deleteByTokenHash = SqlSchema.void({
      Request: Schema.String,
      execute: (tokenHash) => sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`
    })

    return {
      insert: base.insert,
      findByTokenHash,
      deleteByTokenHash
    } as const
  })
}) {}

export const SessionRepoLive = Layer.effect(SessionRepo, SessionRepo.make)
