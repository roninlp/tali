import { Option, Schema } from "effect"
import {
  Household,
  SessionContext,
  UserProfile,
  type CreateHouseholdInput,
  type JoinHouseholdInput,
  type LoginInput,
  type RegisterInput
} from "@tali/domain"
import { API_URL } from "./config"

/**
 * The plain-HTTP auth client (ticket #15 endpoints, consumed by the web shell).
 *
 * Auth rides plain HTTP rather than Effect RPC because the session cookie is
 * set/cleared by the raw response. Every call sends `credentials: "include"`
 * so the `tali_session` cookie travels across the dev origin boundary.
 *
 * Failures are values, not exceptions: the API answers non-2xx with a
 * `{ code, ... }` envelope, which becomes an {@link AuthFailure} the UI maps to
 * Persian copy. A transport failure is the `Network` code.
 */

const SessionResponse = Schema.Struct({ user: UserProfile })
const HouseholdResponse = Schema.Struct({ household: Household })
const OkResponse = Schema.Struct({ ok: Schema.Boolean })

export type AuthFailureCode =
  | "EmailAlreadyRegistered"
  | "InvalidCredentials"
  | "Unauthorized"
  | "AlreadyInHousehold"
  | "HouseholdFull"
  | "InviteInvalid"
  | "BadRequest"
  | "InternalError"
  | "Network"

export interface AuthFailure {
  readonly code: AuthFailureCode
  readonly status: number
}

export type ApiResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: AuthFailure }

const KNOWN_CODES: ReadonlySet<string> = new Set<AuthFailureCode>([
  "EmailAlreadyRegistered",
  "InvalidCredentials",
  "Unauthorized",
  "AlreadyInHousehold",
  "HouseholdFull",
  "InviteInvalid"
])

/** Read the stable code from the API envelope (`{ code }`, or the drafted `{ error: { code } }`). */
const readCode = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined
  const direct = (body as { code?: unknown }).code
  if (typeof direct === "string") return direct
  const nested = (body as { error?: { code?: unknown } }).error?.code
  return typeof nested === "string" ? nested : undefined
}

const classify = (status: number, body: unknown): AuthFailureCode => {
  const code = readCode(body)
  if (code !== undefined && KNOWN_CODES.has(code)) return code as AuthFailureCode
  if (status === 401) return "Unauthorized"
  if (status === 400 || status === 422) return "BadRequest"
  if (status >= 500) return "InternalError"
  return "InternalError"
}

const send = async <A>(
  method: "GET" | "POST",
  path: string,
  schema: Schema.ConstraintDecoder<A>,
  body?: unknown
): Promise<ApiResult<A>> => {
  let response: Response
  try {
    const init: RequestInit = { method, credentials: "include" }
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" }
      init.body = JSON.stringify(body)
    }
    response = await fetch(`${API_URL}${path}`, init)
  } catch {
    return { ok: false, error: { code: "Network", status: 0 } }
  }

  const json: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    return { ok: false, error: { code: classify(response.status, json), status: response.status } }
  }

  const decoded = Schema.decodeUnknownOption(schema)(json)
  return Option.isSome(decoded)
    ? { ok: true, value: decoded.value }
    : { ok: false, error: { code: "InternalError", status: response.status } }
}

export const authApi = {
  me: (): Promise<ApiResult<SessionContext>> => send("GET", "/auth/me", SessionContext),

  register: (input: RegisterInput): Promise<ApiResult<{ user: UserProfile }>> =>
    send("POST", "/auth/register", SessionResponse, input),

  login: (input: LoginInput): Promise<ApiResult<{ user: UserProfile }>> =>
    send("POST", "/auth/login", SessionResponse, input),

  logout: (): Promise<ApiResult<{ ok: boolean }>> => send("POST", "/auth/logout", OkResponse),

  createHousehold: (input: CreateHouseholdInput): Promise<ApiResult<{ household: Household }>> =>
    send("POST", "/household", HouseholdResponse, input),

  joinHousehold: (input: JoinHouseholdInput): Promise<ApiResult<{ household: Household }>> =>
    send("POST", "/household/join", HouseholdResponse, input)
}
