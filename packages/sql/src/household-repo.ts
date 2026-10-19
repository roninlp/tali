import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlModel, SqlSchema, Statement } from "effect/sql"
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

    /** Raw statement so household + owner membership insert atomically. */
    const insertStatement = (household: Household): Statement.Statement<Household> =>
      sql<Household>`INSERT INTO households ${sql.insert(household as unknown as Record<string, unknown>)} RETURNING *`

    return {
      insert: base.insert,
      findByInviteCode,
      insertStatement
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

    /** Raw statement so household + owner membership insert atomically. */
    const insertStatement = (membership: Membership): Statement.Statement<Membership> =>
      sql<Membership>`INSERT INTO memberships ${sql.insert(membership as unknown as Record<string, unknown>)} RETURNING *`

    /**
     * Adds a member only while the household has fewer than two memberships.
     * The count and insert run as one statement, so concurrent joins cannot
     * both pass a cap check (a household holds exactly two users — CC-01).
     * Yields `None` when the household is already full.
     */
    const insertIfRoom = SqlSchema.findOneOption({
      Request: Membership.insert,
      Result: Membership,
      execute: (membership) => sql`
        INSERT INTO memberships (id, household_id, user_id, role, joined_at)
        SELECT ${membership.id}, ${membership.householdId}, ${membership.userId}, ${membership.role}, ${membership.joinedAt}
        WHERE (SELECT COUNT(*) FROM memberships WHERE household_id = ${membership.householdId}) < 2
        RETURNING *
      `
    })

    return {
      insert: base.insert,
      findByUserId,
      insertStatement,
      insertIfRoom
    } as const
  })
}) {}

export const MembershipRepoLive = Layer.effect(MembershipRepo, MembershipRepo.make)
