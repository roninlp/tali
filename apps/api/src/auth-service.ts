import { Context, Effect, Layer, Option } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  AlreadyInHousehold,
  ChangePasswordInput,
  CreateHouseholdInput,
  EmailAlreadyRegistered,
  Household,
  HouseholdFull,
  InvalidCredentials,
  InviteInvalid,
  JoinHouseholdInput,
  LoginInput,
  Membership,
  normalizeEmail,
  RateLimited,
  RegisterInput,
  Session,
  toUserProfile,
  Unauthorized,
  User,
  type InviteCode,
  type SessionContext,
  type UserId
} from "@tali/domain"
import {
  HouseholdRepo,
  HouseholdRepoLive,
  MembershipRepo,
  MembershipRepoLive,
  SessionRepo,
  SessionRepoLive,
  UserRepo,
  UserRepoLive
} from "@tali/sql"
import { CredentialVerifier, CredentialVerifierLive } from "./credential-verifier.js"
import { LoginRateLimiter, LoginRateLimiterLive } from "./login-rate-limiter.js"
import { randomToken, sha256Hex } from "./bytes.js"

/** 30 days — long enough for a two-person household, short enough to re-auth. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Invite codes are short-lived secrets handed over out-of-band. */
const INVITE_CODE_BYTES = 8

/** Rate-limit bucket identity: one email+IP pair shares a fixed window. */
const limitKey = (email: string, clientIp: string): string => `${email}|${clientIp}`

const uniqueViolationOn = (
  error: { readonly message: string; readonly cause: unknown },
  column: string
): boolean => {
  const reason = error.cause as { readonly cause?: unknown }
  return `${error.message} ${String(reason)} ${String(reason.cause)}`.includes(
    `UNIQUE constraint failed: ${column}`
  )
}

/**
 * The auth & shared-space service (Slice 1 / ticket #15).
 *
 * Owns ids, timestamps and session minting; repositories are pure SQL. Only the
 * domain errors (bad credentials, taken email, …) live in the error channel —
 * repository `SqlError`/`SchemaError` are unexpected and surface as defects.
 *
 * Multi-row writes (register, create-household) go through `D1Client.batch`,
 * because D1 has no interactive transactions (domain-model-draft §1.3).
 */
export class AuthService extends Context.Service<AuthService>()("AuthService", {
  make: Effect.gen(function*() {
    const d1 = yield* D1Client.D1Client
    const users = yield* UserRepo
    const households = yield* HouseholdRepo
    const memberships = yield* MembershipRepo
    const sessions = yield* SessionRepo
    const verifier = yield* CredentialVerifier
    const limiter = yield* LoginRateLimiter

    /** Build a session row + its raw cookie token (no I/O). */
    const mintSession = (userId: UserId): Effect.Effect<{ token: string; session: Session }> =>
      Effect.gen(function*() {
        const token = randomToken(32)
        const tokenHash = yield* sha256Hex(token)
        const now = new Date()
        return {
          token,
          session: Session.insert.make({
            userId,
            tokenHash,
            expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
            createdAt: now.toISOString()
          })
        }
      })

    const register = (input: RegisterInput) =>
      Effect.gen(function*() {
        const email = normalizeEmail(input.email)
        const existing = yield* users.findByEmail(email).pipe(Effect.orDie)
        if (Option.isSome(existing)) {
          return yield* Effect.fail(new EmailAlreadyRegistered({ email }))
        }
        const credential = yield* verifier.enroll(input.loginKey)
        const now = new Date().toISOString()
        const user = User.insert.make({
          email,
          ...credential,
          displayName: input.displayName,
          timeZone: input.timeZone,
          weekStart: "saturday",
          digits: "persian",
          createdAt: now,
          updatedAt: now
        })
        const { token, session } = yield* mintSession(user.id)
        // Atomic: a user without its first session cannot be logged into.
        const [userRows] = yield* d1
          .batch([users.insertStatement(user), sessions.insertStatement(session)])
          .pipe(
            Effect.catchTag("SqlError", (error) =>
              uniqueViolationOn(error, "users.email")
                ? Effect.fail(new EmailAlreadyRegistered({ email }))
                : Effect.die(error)
            )
          )
        return { user: userRows[0], token }
      })

    /**
     * Login carries a browser-derived login key, never a password. The limiter
     * is checked before any credential work, and unknown emails burn a dummy
     * comparison so failure timing and the error envelope stay flat.
     */
    const login = (input: LoginInput, clientIp: string) =>
      Effect.gen(function*() {
        const email = normalizeEmail(input.email)
        const key = limitKey(email, clientIp)
        const limit = yield* limiter.status(key)
        if (limit.limited) {
          return yield* Effect.fail(new RateLimited({ retryAfterSeconds: limit.retryAfterSeconds }))
        }

        const found = yield* users.findByEmail(email).pipe(Effect.orDie)
        if (Option.isNone(found)) {
          yield* verifier.verifyDummy(input.loginKey)
          yield* limiter.recordFailure(key)
          return yield* Effect.fail(new InvalidCredentials())
        }

        const user = found.value
        const ok = yield* verifier.verify(input.loginKey, user)
        if (!ok) {
          yield* limiter.recordFailure(key)
          return yield* Effect.fail(new InvalidCredentials())
        }

        yield* limiter.clear(key)
        const { token, session } = yield* mintSession(user.id)
        yield* sessions.insert(session).pipe(Effect.orDie)
        // Same context `/auth/me` would report, so login needs no second round trip.
        const membership = yield* memberships.findByUserId(user.id).pipe(Effect.orDie)
        return {
          user,
          token,
          householdId: Option.isSome(membership) ? membership.value.householdId : null
        }
      })

    /**
     * Swap the stored verifier after proving the current login key. Re-deriving
     * happens in the browser; this endpoint only ever handles keys.
     */
    const changePassword = (userId: UserId, input: ChangePasswordInput, clientIp: string) =>
      Effect.gen(function*() {
        const user = yield* users.findById(userId).pipe(Effect.orDie)
        const key = limitKey(user.email, clientIp)
        const limit = yield* limiter.status(key)
        if (limit.limited) {
          return yield* Effect.fail(new RateLimited({ retryAfterSeconds: limit.retryAfterSeconds }))
        }

        const ok = yield* verifier.verify(input.currentLoginKey, user)
        if (!ok) {
          yield* limiter.recordFailure(key)
          return yield* Effect.fail(new InvalidCredentials())
        }

        const credential = yield* verifier.enroll(input.newLoginKey)
        yield* users
          .update({
            ...user,
            ...credential,
            updatedAt: new Date().toISOString()
          })
          .pipe(Effect.orDie)
        yield* limiter.clear(key)
      })

    const logout = (token: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const tokenHash = yield* sha256Hex(token)
        yield* sessions.deleteByTokenHash(tokenHash).pipe(Effect.orDie)
      })

    /**
     * Resolve the authenticated principal plus its household (if any), renewing
     * the session's expiry so an active household never has to re-login.
     */
    const me = (token: string): Effect.Effect<SessionContext, Unauthorized> =>
      Effect.gen(function*() {
        const tokenHash = yield* sha256Hex(token)
        const found = yield* sessions.findByTokenHash(tokenHash).pipe(Effect.orDie)
        if (Option.isNone(found)) {
          return yield* Effect.fail(new Unauthorized())
        }
        const session = found.value
        const now = Date.now()
        if (Date.parse(session.expiresAt) <= now) {
          yield* sessions.deleteByTokenHash(tokenHash).pipe(Effect.orDie)
          return yield* Effect.fail(new Unauthorized())
        }
        yield* sessions
          .extend({ tokenHash, expiresAt: new Date(now + SESSION_TTL_MS).toISOString() })
          .pipe(Effect.orDie)
        const user = yield* users.findById(session.userId).pipe(Effect.orDie)
        const membership = yield* memberships.findByUserId(user.id).pipe(Effect.orDie)
        return {
          user: toUserProfile(user),
          householdId: Option.isSome(membership) ? membership.value.householdId : null
        }
      })

    const createHousehold = (userId: UserId, input: CreateHouseholdInput) =>
      Effect.gen(function*() {
        const existing = yield* memberships.findByUserId(userId).pipe(Effect.orDie)
        if (Option.isSome(existing)) {
          return yield* Effect.fail(new AlreadyInHousehold())
        }
        const now = new Date().toISOString()
        const household = Household.insert.make({
          name: input.name,
          inviteCode: randomToken(INVITE_CODE_BYTES) as InviteCode,
          createdBy: userId,
          createdAt: now
        })
        const membership = Membership.insert.make({
          householdId: household.id,
          userId,
          role: "owner",
          joinedAt: now
        })
        // Atomic: a household without its owner membership would be unreachable.
        const [householdRows] = yield* d1
          .batch([households.insertStatement(household), memberships.insertStatement(membership)])
          .pipe(
            Effect.catchTag("SqlError", (error) =>
              uniqueViolationOn(error, "memberships.user_id")
                ? Effect.fail(new AlreadyInHousehold())
                : Effect.die(error)
            )
          )
        return householdRows[0]
      })

    const joinHousehold = (userId: UserId, input: JoinHouseholdInput) =>
      Effect.gen(function*() {
        const existing = yield* memberships.findByUserId(userId).pipe(Effect.orDie)
        if (Option.isSome(existing)) {
          return yield* Effect.fail(new AlreadyInHousehold())
        }
        const inviteCode = input.inviteCode.trim()
        const found = yield* households.findByInviteCode(inviteCode).pipe(Effect.orDie)
        if (Option.isNone(found)) {
          return yield* Effect.fail(new InviteInvalid({ inviteCode }))
        }
        const household = found.value
        const membership = Membership.insert.make({
          householdId: household.id,
          userId,
          role: "member",
          joinedAt: new Date().toISOString()
        })
        // The cap is enforced inside the insert, so two concurrent joins cannot
        // both occupy the second slot (CC-01: two memberships).
        const inserted = yield* memberships.insertIfRoom(membership).pipe(
          Effect.catchTag("SqlError", (error) =>
            uniqueViolationOn(error, "memberships.user_id")
              ? Effect.fail(new AlreadyInHousehold())
              : Effect.die(error)
          ),
          Effect.catchTag("SchemaError", Effect.die)
        )
        if (Option.isNone(inserted)) {
          return yield* Effect.fail(new HouseholdFull())
        }
        return household
      })

    return { register, login, changePassword, logout, me, createHousehold, joinHousehold } as const
  })
}) {}

/** Provides `AuthService`, wiring the repositories, D1 batch and credential verifier. */
export const AuthServiceLive = Layer.effect(AuthService, AuthService.make).pipe(
  Layer.provide(UserRepoLive),
  Layer.provide(HouseholdRepoLive),
  Layer.provide(MembershipRepoLive),
  Layer.provide(SessionRepoLive),
  Layer.provide(CredentialVerifierLive),
  Layer.provide(LoginRateLimiterLive)
)
