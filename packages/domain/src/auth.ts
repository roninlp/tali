import { Schema } from "effect"
import { Model } from "effect/schema"
import {
  Digits,
  HouseholdId,
  MembershipId,
  MembershipRole,
  SessionId,
  UserId,
  WeekStart
} from "./common.js"

/**
 * Auth & shared-space aggregates (see `docs/domain-model-draft.md` §3.1).
 *
 * These are **not** "common items": they change rarely and are fetched whole,
 * so they carry no `version`/`tags`/`deletedAt` sync contract.
 *
 * Timestamps are ISO-8601 UTC **strings** (the D1 column shape) rather than
 * `Model.DateTime*` variants: D1 returns TEXT, not `Date`, so the string
 * helpers keep the row shape identical to the wire shape.
 */

export class User extends Model.Class<User>("User")({
  id: Model.UuidV7Insert(UserId),
  email: Schema.String,
  passwordHash: Model.Sensitive(Schema.String),
  displayName: Schema.String,
  timeZone: Schema.String,
  weekStart: WeekStart,
  digits: Digits,
  createdAt: Schema.String,
  updatedAt: Schema.String
}) {}

export class Household extends Model.Class<Household>("Household")({
  id: Model.UuidV7Insert(HouseholdId),
  name: Schema.String,
  /** Shared secret the second user presents to join (the "invite"). */
  inviteCode: Schema.String,
  createdBy: UserId,
  createdAt: Schema.String
}) {}

export class Membership extends Model.Class<Membership>("Membership")({
  id: Model.UuidV7Insert(MembershipId),
  householdId: HouseholdId,
  userId: UserId,
  role: MembershipRole,
  joinedAt: Schema.String
}) {}

export class Session extends Model.Class<Session>("Session")({
  id: Model.UuidV7Insert(SessionId),
  userId: UserId,
  /** SHA-256 of the opaque session token; the raw token lives only in the cookie. */
  tokenHash: Schema.String,
  expiresAt: Schema.String,
  createdAt: Schema.String
}) {}

/** The public user projection returned over the wire (`passwordHash` never leaves the server). */
export const UserProfile = Schema.Struct({
  id: UserId,
  email: Schema.String,
  displayName: Schema.String,
  timeZone: Schema.String,
  weekStart: WeekStart,
  digits: Digits
})
export type UserProfile = Schema.Schema.Type<typeof UserProfile>

export const toUserProfile = (user: User): UserProfile => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  timeZone: user.timeZone,
  weekStart: user.weekStart,
  digits: user.digits
})

/** Authenticated principal resolved from a session cookie. */
export const SessionContext = Schema.Struct({
  user: UserProfile,
  householdId: Schema.NullOr(HouseholdId)
})
export type SessionContext = Schema.Schema.Type<typeof SessionContext>

// --- Inputs -------------------------------------------------------------

export const RegisterInput = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
  displayName: Schema.String,
  timeZone: Schema.String
})
export type RegisterInput = Schema.Schema.Type<typeof RegisterInput>

export const LoginInput = Schema.Struct({
  email: Schema.String,
  password: Schema.String
})
export type LoginInput = Schema.Schema.Type<typeof LoginInput>

export const CreateHouseholdInput = Schema.Struct({
  name: Schema.String
})
export type CreateHouseholdInput = Schema.Schema.Type<typeof CreateHouseholdInput>

export const JoinHouseholdInput = Schema.Struct({
  inviteCode: Schema.String
})
export type JoinHouseholdInput = Schema.Schema.Type<typeof JoinHouseholdInput>

// --- Typed errors -------------------------------------------------------

export class EmailAlreadyRegistered extends Schema.TaggedError<EmailAlreadyRegistered>()(
  "EmailAlreadyRegistered",
  { email: Schema.String }
) {}

export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "InvalidCredentials",
  {}
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

export class AlreadyInHousehold extends Schema.TaggedError<AlreadyInHousehold>()(
  "AlreadyInHousehold",
  {}
) {}

export class InviteInvalid extends Schema.TaggedError<InviteInvalid>()("InviteInvalid", {
  inviteCode: Schema.String
}) {}
