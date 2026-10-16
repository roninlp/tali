import { Context, Effect, Layer, Option } from "effect"
import {
  AlreadyInHousehold,
  CreateHouseholdInput,
  EmailAlreadyRegistered,
  Household,
  InvalidCredentials,
  InviteInvalid,
  JoinHouseholdInput,
  LoginInput,
  Membership,
  RegisterInput,
  Session,
  toUserProfile,
  Unauthorized,
  User,
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
import { PasswordHasher, PasswordHasherLive } from "./password-hasher.js"

/** 30 days — long enough for a two-person household, short enough to re-auth. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

const randomToken = (bytes: number): string =>
  toHex(crypto.getRandomValues(new Uint8Array(bytes)))

const sha256Hex = (value: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    return toHex(new Uint8Array(digest))
  })

/**
 * The auth & shared-space service (Slice 1 / ticket #15).
 *
 * Owns ids, timestamps and session minting; repositories are pure SQL. Only the
 * domain errors (bad credentials, taken email, …) live in the error channel —
 * repository `SqlError`/`SchemaError` are unexpected and surface as defects.
 */
export class AuthService extends Context.Service<AuthService>()("AuthService", {
  make: Effect.gen(function*() {
    const users = yield* UserRepo
    const households = yield* HouseholdRepo
    const memberships = yield* MembershipRepo
    const sessions = yield* SessionRepo
    const hasher = yield* PasswordHasher

    const mintSession = (userId: UserId): Effect.Effect<string> =>
      Effect.gen(function*() {
        const token = randomToken(32)
        const tokenHash = yield* sha256Hex(token)
        const now = new Date()
        yield* sessions
          .insert(
            Session.insert.make({
              userId,
              tokenHash,
              expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
              createdAt: now.toISOString()
            })
          )
          .pipe(Effect.orDie)
        return token
      })

    const register = (input: RegisterInput) =>
      Effect.gen(function*() {
        const email = input.email.trim().toLowerCase()
        const existing = yield* users.findByEmail(email).pipe(Effect.orDie)
        if (Option.isSome(existing)) {
          return yield* Effect.fail(new EmailAlreadyRegistered({ email }))
        }
        const passwordHash = yield* hasher.hash(input.password)
        const now = new Date().toISOString()
        const user = yield* users
          .insert(
            User.insert.make({
              email,
              passwordHash,
              displayName: input.displayName,
              timeZone: input.timeZone,
              weekStart: "saturday",
              digits: "persian",
              createdAt: now,
              updatedAt: now
            })
          )
          .pipe(Effect.orDie)
        const token = yield* mintSession(user.id)
        return { user, token }
      })

    const login = (input: LoginInput) =>
      Effect.gen(function*() {
        const email = input.email.trim().toLowerCase()
        const found = yield* users.findByEmail(email).pipe(Effect.orDie)
        if (Option.isNone(found)) {
          return yield* Effect.fail(new InvalidCredentials())
        }
        const user = found.value
        const ok = yield* hasher.verify(input.password, user.passwordHash)
        if (!ok) {
          return yield* Effect.fail(new InvalidCredentials())
        }
        const token = yield* mintSession(user.id)
        return { user, token }
      })

    const logout = (token: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const tokenHash = yield* sha256Hex(token)
        yield* sessions.deleteByTokenHash(tokenHash).pipe(Effect.orDie)
      })

    const authorize = (token: string) =>
      Effect.gen(function*() {
        const tokenHash = yield* sha256Hex(token)
        const found = yield* sessions.findByTokenHash(tokenHash).pipe(Effect.orDie)
        if (Option.isNone(found)) {
          return yield* Effect.fail(new Unauthorized())
        }
        const session = found.value
        if (Date.parse(session.expiresAt) <= Date.now()) {
          yield* sessions.deleteByTokenHash(tokenHash).pipe(Effect.orDie)
          return yield* Effect.fail(new Unauthorized())
        }
        return yield* users.findById(session.userId).pipe(Effect.orDie)
      })

    /** Resolve the authenticated principal plus its household (if any). */
    const contextFor = (token: string): Effect.Effect<SessionContext, Unauthorized> =>
      Effect.gen(function*() {
        const user = yield* authorize(token)
        const membership = yield* memberships.findByUserId(user.id).pipe(Effect.orDie)
        return {
          user: toUserProfile(user),
          householdId: Option.isSome(membership) ? membership.value.householdId : null
        }
      })

    const me = (token: string): Effect.Effect<SessionContext, Unauthorized> => contextFor(token)

    const createHousehold = (userId: UserId, input: CreateHouseholdInput) =>
      Effect.gen(function*() {
        const existing = yield* memberships.findByUserId(userId).pipe(Effect.orDie)
        if (Option.isSome(existing)) {
          return yield* Effect.fail(new AlreadyInHousehold())
        }
        const now = new Date().toISOString()
        const household = yield* households
          .insert(
            Household.insert.make({
              name: input.name,
              inviteCode: randomToken(8),
              createdBy: userId,
              createdAt: now
            })
          )
          .pipe(Effect.orDie)
        yield* memberships
          .insert(
            Membership.insert.make({
              householdId: household.id,
              userId,
              role: "owner",
              joinedAt: now
            })
          )
          .pipe(Effect.orDie)
        return household
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
        yield* memberships
          .insert(
            Membership.insert.make({
              householdId: household.id,
              userId,
              role: "member",
              joinedAt: new Date().toISOString()
            })
          )
          .pipe(Effect.orDie)
        return household
      })

    return { register, login, logout, me, contextFor, createHousehold, joinHousehold } as const
  })
}) {}

/** Provides `AuthService`, wiring the repositories and the password hasher. */
export const AuthServiceLive = Layer.effect(AuthService, AuthService.make).pipe(
  Layer.provide(UserRepoLive),
  Layer.provide(HouseholdRepoLive),
  Layer.provide(MembershipRepoLive),
  Layer.provide(SessionRepoLive),
  Layer.provide(PasswordHasherLive)
)
