import { Effect, Layer } from 'effect'
import { HttpServerRequest } from 'effect/http'
import { describe, expect, it } from 'vitest'
import {
  defaultPreferences,
  Unauthorized,
  UserPreferences,
  type HouseholdId,
  type PreferenceDefaults,
  type SessionContext,
  type UserId,
} from '@tali/domain'
import { AuthService } from '../src/auth-service.js'
import { PreferencesService } from '../src/preferences-service.js'
import {
  principalFromToken,
  principalOf,
  principalResolver,
  profileDefaults,
  sessionFromToken,
  sessionOf,
  sessionResolver,
} from '../src/principal.js'

/**
 * One session → one principal.
 *
 * These run the real resolver against stubbed services: the only thing worth
 * pinning here is the wiring (cookie → token → `auth.me`), the shape of the
 * preferences fallback, and the fact that a missing cookie fails closed. The
 * route-level suites already prove the downstream viewers and status codes.
 */

const USER_ID = 'user-a' as UserId
const HOUSEHOLD = 'household-a' as HouseholdId
const VALID_TOKEN = 'valid-token'
const OTHER_TOKEN = 'other-token'
const NOW = '2026-10-20T09:30:00.000Z'

const CONTEXT: SessionContext = {
  user: {
    id: USER_ID,
    email: 'a@example.com',
    displayName: 'A',
    // Deliberately not the Persian-first defaults, so a fallback is visible.
    timeZone: 'Europe/Berlin',
    weekStart: 'monday',
    digits: 'latin',
  },
  householdId: HOUSEHOLD,
}

/** Every stub method a test never reaches fails loudly instead of silently. */
const unused = (..._args: ReadonlyArray<unknown>): Effect.Effect<never> =>
  Effect.die(new Error('stub method not used in this test'))

const authStub = (context: SessionContext = CONTEXT) => ({
  register: unused,
  login: unused,
  changePassword: unused,
  logout: unused,
  me: (token: string) =>
    token === VALID_TOKEN
      ? Effect.succeed(context)
      : Effect.fail(new Unauthorized()),
  meWithRenewal: unused,
  createHousehold: unused,
  joinHousehold: unused,
})

/**
 * The real service seeds a missing row from the defaults it is handed, so the
 * stub does the same and records what the resolver passed.
 */
const preferencesStub = (
  seen: Array<PreferenceDefaults>,
  stored?: UserPreferences,
) => ({
  get: (userId: UserId, defaults: PreferenceDefaults = {}) => {
    seen.push(defaults)
    return Effect.succeed(stored ?? defaultPreferences(userId, defaults))
  },
  update: unused,
})

const servicesLayer = (seen: Array<PreferenceDefaults> = []) =>
  Layer.merge(
    Layer.succeed(AuthService, authStub()),
    Layer.succeed(PreferencesService, preferencesStub(seen)),
  )

const requestWith = (token?: string) =>
  HttpServerRequest.fromWeb(
    new Request('http://localhost/today', {
      headers: token === undefined ? {} : { cookie: `tali_session=${token}` },
    }),
  )

describe('profileDefaults', () => {
  it('projects exactly the profile values a user has never overridden', () => {
    expect(profileDefaults(CONTEXT)).toEqual({
      timeZone: 'Europe/Berlin',
      weekStart: 'monday',
      digits: 'latin',
    })
    expect(Object.keys(profileDefaults(CONTEXT))).toEqual([
      'timeZone',
      'weekStart',
      'digits',
    ])
  })

  it('follows the profile, including for a user with no household', () => {
    const noHousehold: SessionContext = {
      ...CONTEXT,
      householdId: null,
      user: {
        ...CONTEXT.user,
        timeZone: 'Asia/Tehran',
        weekStart: 'saturday',
        digits: 'persian',
      },
    }
    expect(profileDefaults(noHousehold)).toEqual({
      timeZone: 'Asia/Tehran',
      weekStart: 'saturday',
      digits: 'persian',
    })
  })
})

describe('sessionOf', () => {
  it('fails closed with Unauthorized when the cookie is missing', async () => {
    const error = await Effect.runPromise(
      Effect.provide(sessionOf(requestWith()), servicesLayer()).pipe(
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(Unauthorized)
    expect(error._tag).toBe('Unauthorized')
  })

  it('resolves the cookie token into the session context', async () => {
    const context = await Effect.runPromise(
      Effect.provide(sessionOf(requestWith(VALID_TOKEN)), servicesLayer()),
    )
    expect(context).toEqual(CONTEXT)
  })

  it('propagates the auth rejection for an unknown token', async () => {
    const error = await Effect.runPromise(
      Effect.provide(sessionOf(requestWith(OTHER_TOKEN)), servicesLayer()).pipe(
        Effect.flip,
      ),
    )
    expect(error._tag).toBe('Unauthorized')
  })
})

describe('sessionFromToken', () => {
  it('resolves a raw token without a request', async () => {
    const context = await Effect.runPromise(
      Effect.provide(sessionFromToken(VALID_TOKEN), servicesLayer()),
    )
    expect(context).toEqual(CONTEXT)
  })
})

describe('principalOf', () => {
  it('pairs the context with preferences seeded from the profile', async () => {
    const seen: Array<PreferenceDefaults> = []
    const principal = await Effect.runPromise(
      Effect.provide(
        principalOf(requestWith(VALID_TOKEN)),
        servicesLayer(seen),
      ),
    )

    expect(principal.context).toEqual(CONTEXT)
    expect(principal.preferences).toMatchObject({
      userId: USER_ID,
      timeZone: 'Europe/Berlin',
      weekStart: 'monday',
      digits: 'latin',
      checkedItemPlacement: 'bottom',
    })
    // The resolver hands the service exactly the profile defaults.
    expect(seen).toEqual([profileDefaults(CONTEXT)])
  })

  it('serves a stored preferences row over the profile defaults', async () => {
    const stored = new UserPreferences({
      ...defaultPreferences(USER_ID, profileDefaults(CONTEXT)),
      timeZone: 'America/New_York',
      weekStart: 'sunday',
      checkedItemPlacement: 'inPlace',
      createdAt: NOW,
      updatedAt: NOW,
    })
    const principal = await Effect.runPromise(
      Effect.provide(
        principalOf(requestWith(VALID_TOKEN)),
        Layer.merge(
          Layer.succeed(AuthService, authStub()),
          Layer.succeed(PreferencesService, preferencesStub([], stored)),
        ),
      ),
    )

    expect(principal.preferences.timeZone).toBe('America/New_York')
    expect(principal.preferences.weekStart).toBe('sunday')
    expect(principal.preferences.checkedItemPlacement).toBe('inPlace')
  })

  it('fails closed with Unauthorized when the cookie is missing', async () => {
    const error = await Effect.runPromise(
      Effect.provide(principalOf(requestWith()), servicesLayer()).pipe(
        Effect.flip,
      ),
    )
    expect(error._tag).toBe('Unauthorized')
  })
})

describe('principalFromToken', () => {
  it('resolves the raw cookie token the RPC edge extracts', async () => {
    const principal = await Effect.runPromise(
      Effect.provide(principalFromToken(VALID_TOKEN), servicesLayer()),
    )
    expect(principal.context).toEqual(CONTEXT)
    expect(principal.preferences.timeZone).toBe('Europe/Berlin')
  })

  it('rejects an unknown token', async () => {
    const error = await Effect.runPromise(
      Effect.provide(principalFromToken(OTHER_TOKEN), servicesLayer()).pipe(
        Effect.flip,
      ),
    )
    expect(error._tag).toBe('Unauthorized')
  })
})

describe('bound resolvers', () => {
  it('run without a service environment once the route captured them', async () => {
    const resolved = await Effect.runPromise(
      principalResolver(
        authStub(),
        preferencesStub([]),
      )(requestWith(VALID_TOKEN)),
    )
    expect(resolved.context).toEqual(CONTEXT)

    const context = await Effect.runPromise(
      sessionResolver(authStub())(requestWith(VALID_TOKEN)),
    )
    expect(context).toEqual(CONTEXT)
  })
})
