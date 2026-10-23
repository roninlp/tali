import { env, exports } from "cloudflare:workers"
import { uuidV7 } from "@tali/domain"

/**
 * Shared plumbing for the boundary suite: real HTTP requests into the Worker
 * module, plus the minimum seed data the plain-HTTP routes need.
 *
 * Everything here runs inside workerd. `exports.default.fetch()` is the
 * deployed Worker's own `fetch` handler, so these requests cross routing,
 * middleware, CORS and cookie handling exactly as the browser's do.
 */

/** The web dev origin the test Worker config allows (CORS-with-credentials). */
export const WEB_ORIGIN = "http://localhost:3000"

/** The session cookie name, pinned here so a rename fails the suite. */
export const SESSION_COOKIE = "tali_session"

/** A syntactically valid browser-derived login key (32 bytes, base64url). */
export const LOGIN_KEY = "a".repeat(43)

export interface Session {
  readonly cookie: string
  readonly userId: string
  readonly email: string
}

export const workerFetch = (
  path: string,
  init?: RequestInit
): Promise<Response> => exports.default.fetch(`http://localhost${path}`, init)

export const jsonRequest = (
  method: string,
  cookie?: string,
  body?: unknown
): RequestInit => ({
  method,
  headers: {
    "content-type": "application/json",
    ...(cookie === undefined ? {} : { cookie })
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
})

/** First `Set-Cookie` value for the session, or `undefined` if none. */
export const sessionCookieOf = (response: Response): string | undefined => {
  const setCookie = response.headers.getSetCookie()
  const header = setCookie.find((value) => value.startsWith(`${SESSION_COOKIE}=`))
  return header?.split(";")[0]
}

export const register = async (
  email = `boundary-${crypto.randomUUID()}@example.com`,
  displayName = "کاربر مرزی"
): Promise<Session> => {
  const response = await workerFetch(
    "/auth/register",
    jsonRequest("POST", undefined, {
      email,
      loginKey: LOGIN_KEY,
      displayName,
      timeZone: "Asia/Tehran"
    })
  )
  if (response.status !== 201) {
    throw new Error(`register failed: ${response.status} ${await response.text()}`)
  }
  const cookie = sessionCookieOf(response)
  if (cookie === undefined) throw new Error("register did not mint a session cookie")
  const body = await response.json() as { readonly user: { readonly id: string } }
  return { cookie, userId: body.user.id, email }
}

export interface Household {
  readonly id: string
  readonly inviteCode: string
}

/** Create the household the sync/reminder boundary routes scope to. */
export const createHousehold = async (
  session: Session,
  name = "خانهٔ مرزی"
): Promise<Household> => {
  const response = await workerFetch(
    "/household",
    jsonRequest("POST", session.cookie, { name })
  )
  if (response.status !== 201) {
    throw new Error(`household failed: ${response.status} ${await response.text()}`)
  }
  const body = await response.json() as { readonly household: Household }
  return body.household
}

/** A registered user with a household — the state every non-auth route needs. */
export const sessionWithHousehold = async (): Promise<{
  readonly session: Session
  readonly household: Household
}> => {
  const session = await register()
  const household = await createHousehold(session)
  return { session, household }
}

const pastTimes = (): {
  readonly scheduledFor: string
  readonly fireAt: string
  readonly createdAt: string
} => {
  const now = Date.now()
  return {
    // Inside the inbox's 24-hour window, already due.
    scheduledFor: new Date(now - 5 * 60 * 1000).toISOString(),
    fireAt: new Date(now - 60 * 60 * 1000).toISOString(),
    createdAt: new Date(now - 60 * 60 * 1000).toISOString()
  }
}

/**
 * Insert one unanswered dispatch (and its reminder) directly, as the per-minute
 * sweep would. The boundary under test is the respond/history route, not the
 * sweep itself — that already has its own suite.
 */
export const seedDispatch = async (
  userId: string,
  householdId: string
): Promise<{ readonly reminderId: string; readonly dispatchId: string }> => {
  const reminderId = uuidV7()
  const dispatchId = uuidV7()
  const { scheduledFor, fireAt, createdAt } = pastTimes()

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO reminders
        (id, title, owner_id, household_id, visibility, kind, tier, repeat,
         fire_at, time_zone, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, 'shared', 'medication', 'critical', ?, ?, 'Asia/Tehran', ?, ?, 1)`
    ).bind(
      reminderId,
      "داروی روزانه",
      userId,
      householdId,
      JSON.stringify({ _tag: "once" }),
      fireAt,
      createdAt,
      createdAt
    ),
    env.DB.prepare(
      `INSERT INTO reminder_dispatches
        (id, reminder_id, user_id, scheduled_for, deliver_at, root_scheduled_for, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(dispatchId, reminderId, userId, scheduledFor, scheduledFor, scheduledFor, createdAt)
  ])

  return { reminderId, dispatchId }
}
