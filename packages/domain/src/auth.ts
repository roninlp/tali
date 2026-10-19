import { Schema } from "effect"
import { Model } from "effect/schema"
import {
  Digits,
  Email,
  HouseholdId,
  InviteCode,
  MembershipId,
  MembershipRole,
  normalizeEmail,
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
  /**
   * `SHA-256(credentialSalt || loginKey)` — the server never stores the login
   * key itself, and the client never sends the password (ADR-0001).
   */
  credentialVerifier: Model.Sensitive(Schema.String),
  /** Per-user random salt mixed into the verifier (16 bytes, hex). */
  credentialSalt: Schema.String,
  /** Which client-side KDF produced the login key; currently always 1. */
  kdfVersion: Schema.Int,
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

/** The public user projection returned over the wire (credentials never leave the server). */
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
  "RateLimited",
  "Unauthorized",
  "AlreadyInHousehold",
  "HouseholdFull",
  "InviteInvalid",
  "BadRequest",
  "InternalError"
] as const
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number]

// --- Client-side credential derivation (ADR-0001) -----------------------
//
// The password never leaves the browser. It is stretched into a 32-byte
// **login key** with argon2id, and only that key is sent to the API. The KDF
// salt is deterministic so login needs no pre-flight request (which would
// reveal whether an email exists).

/** argon2id cost, in the browser (m = 19 MiB, t = 2, p = 1, dkLen = 32). */
export const KDF_PARAMS = {
  m: 19_456,
  t: 2,
  p: 1,
  dkLen: 32
} as const

/** Bumped only if `KDF_PARAMS`/the salt recipe changes (re-enrols both users). */
export const KDF_VERSION = 1

/** Domain separator for the deterministic salt: `SHA-256(prefix + email)`. */
export const KDF_SALT_PREFIX = "tali:kdf:v1:"

/** Passwords are a browser-only secret; the UI enforces this, the API cannot. */
export const PASSWORD_MIN_LENGTH = 12

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** Unpadded base64url, the wire form of the 32-byte login key. */
export const base64UrlEncode = (bytes: Uint8Array): string => {
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += BASE64URL_ALPHABET[a >> 2]
    out += BASE64URL_ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)]
    if (b !== undefined) out += BASE64URL_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]
    if (c !== undefined) out += BASE64URL_ALPHABET[c & 0x3f]
  }
  return out
}

/**
 * The deterministic KDF salt: `SHA-256("tali:kdf:v1:" + normalizeEmail(email))`.
 * Both the browser (when deriving) and any future client use this one recipe.
 */
export const deriveKdfSalt = (email: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(`${KDF_SALT_PREFIX}${normalizeEmail(email)}`))
    .then((digest) => new Uint8Array(digest))

/**
 * A base64url argon2id output (32 bytes ⇒ 43 characters). It is
 * password-equivalent in transit, so it only ever travels over TLS and is
 * never logged.
 */
export const LoginKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)).pipe(
  Schema.brand("LoginKey")
)
export type LoginKey = Schema.Schema.Type<typeof LoginKey>

// --- Inputs -------------------------------------------------------------

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
  /** The browser-derived credential; no password is ever sent. */
  loginKey: LoginKey,
  displayName: Schema.String.check(Schema.isMinLength(1)),
  timeZone: Schema.String.check(isIanaTimeZone)
})
export type RegisterInput = Schema.Schema.Type<typeof RegisterInput>

export const LoginInput = Schema.Struct({
  email: Email,
  loginKey: LoginKey
})
export type LoginInput = Schema.Schema.Type<typeof LoginInput>

/** Changing the credential re-derives the key in the browser; the API only swaps verifiers. */
export const ChangePasswordInput = Schema.Struct({
  currentLoginKey: LoginKey,
  newLoginKey: LoginKey
})
export type ChangePasswordInput = Schema.Schema.Type<typeof ChangePasswordInput>

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

/** Too many failed logins for this email+IP inside the fixed 15-minute window. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  retryAfterSeconds: Schema.Int
}) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

export class AlreadyInHousehold extends Schema.TaggedError<AlreadyInHousehold>()(
  "AlreadyInHousehold",
  {}
) {}

export class HouseholdFull extends Schema.TaggedError<HouseholdFull>()("HouseholdFull", {}) {}

export class InviteInvalid extends Schema.TaggedError<InviteInvalid>()("InviteInvalid", {
  inviteCode: Schema.String
}) {}
