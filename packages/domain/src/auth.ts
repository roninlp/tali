import { Schema } from "effect"
import { Model } from "effect/schema"
import {
  Digits,
  Email,
  HouseholdId,
  InviteCode,
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
  email: Email,
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
  inviteCode: InviteCode,
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
  email: Email,
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

// --- Plain-HTTP response bodies -----------------------------------------
//
// Shared so the web client decodes exactly the shape the Worker sends; the
// auth routes and `apps/web` both import these instead of hand-mirroring them.

export const SessionResponse = SessionContext
export type SessionResponse = SessionContext

export const HouseholdResponse = Schema.Struct({ household: Household })
export type HouseholdResponse = Schema.Schema.Type<typeof HouseholdResponse>

export const OkResponse = Schema.Struct({ ok: Schema.Boolean })
export type OkResponse = Schema.Schema.Type<typeof OkResponse>

/**
 * Stable client-facing codes for auth failures carried by the plain-HTTP
 * `ErrorEnvelope` (see `error.ts`). `Network` is client-only (transport never
 * reached the Worker) and is added at the edge, not here.
 */
export const AUTH_ERROR_CODES = [
  "EmailAlreadyRegistered",
  "InvalidCredentials",
  "Unauthorized",
  "AlreadyInHousehold",
  "HouseholdFull",
  "InviteInvalid",
  "BadRequest",
  "InternalError"
] as const
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number]

// --- Inputs -------------------------------------------------------------

const PASSWORD_MIN_LENGTH = 8

/** Real IANA time-zone identifiers only (validated by the platform's `Intl`). */
const isIanaTimeZone = Schema.makeFilter<string>((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return "must be a valid IANA time zone identifier"
  }
})

export const RegisterInput = Schema.Struct({
  email: Email,
  password: Schema.String.check(Schema.isMinLength(PASSWORD_MIN_LENGTH)),
  displayName: Schema.String.check(Schema.isMinLength(1)),
  timeZone: Schema.String.check(isIanaTimeZone)
})
export type RegisterInput = Schema.Schema.Type<typeof RegisterInput>

export const LoginInput = Schema.Struct({
  email: Email,
  password: Schema.String
})
export type LoginInput = Schema.Schema.Type<typeof LoginInput>

export const CreateHouseholdInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1))
})
export type CreateHouseholdInput = Schema.Schema.Type<typeof CreateHouseholdInput>

export const JoinHouseholdInput = Schema.Struct({
  inviteCode: InviteCode
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

export class HouseholdFull extends Schema.TaggedError<HouseholdFull>()("HouseholdFull", {}) {}

export class InviteInvalid extends Schema.TaggedError<InviteInvalid>()("InviteInvalid", {
  inviteCode: Schema.String
}) {}
