import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlModel, SqlSchema } from "effect/sql"
import { Household, Membership, UserId } from "@tali/domain"

/** D1-backed repository for `Household` (ticket #15). */
export class HouseholdRepo extends Context.Service<HouseholdRepo>()("HouseholdRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const base = yield* SqlModel.makeRepository(Household, {
      tableName: "households",
      spanPrefix: "Households",
      idColumn: "id"
    })

    const findByInviteCode = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Household,
      execute: (inviteCode) => sql`SELECT * FROM households WHERE invite_code = ${inviteCode}`
    })

    return {
      insert: base.insert,
      findById: base.findById,
      findByInviteCode
    } as const
  })
}) {}

export const HouseholdRepoLive = Layer.effect(HouseholdRepo, HouseholdRepo.make)

/** D1-backed repository for `Membership` (ticket #15). */
export class MembershipRepo extends Context.Service<MembershipRepo>()("MembershipRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const base = yield* SqlModel.makeRepository(Membership, {
      tableName: "memberships",
      spanPrefix: "Memberships",
      idColumn: "id"
    })

    /** A user belongs to at most one household (unique index on `user_id`). */
    const findByUserId = SqlSchema.findOneOption({
      Request: UserId,
      Result: Membership,
      execute: (userId) => sql`SELECT * FROM memberships WHERE user_id = ${userId}`
    })

    return {
      insert: base.insert,
      findByUserId
    } as const
  })
}) {}

export const MembershipRepoLive = Layer.effect(MembershipRepo, MembershipRepo.make)
