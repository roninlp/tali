import { Option, Schema } from "effect"
import {
  AUTH_ERROR_CODES,
  ErrorEnvelope,
  HouseholdResponse,
  OkResponse,
  SessionContext,
  type AuthErrorCode,
  type ChangePasswordInput,
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
 * Failures are values, not exceptions: the API answers non-2xx with the shared
 * `ErrorEnvelope`, which is decoded to an {@link AuthFailure} the UI maps to
 * Persian copy. A transport failure (or a request that times out) is `Network`.
 */

/** No request may hang the boot splash or disable a form forever. */
const REQUEST_TIMEOUT_MS = 15_000

export type AuthFailureCode = AuthErrorCode | "Network"

export interface AuthFailure {
  readonly code: AuthFailureCode
  /** Whether the same request is worth retrying (5xx, network, timeout). */
  readonly retryable: boolean
}

export type ApiResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: AuthFailure }

const KNOWN_CODES: ReadonlySet<string> = new Set(AUTH_ERROR_CODES)

/** Decode the shared envelope. Anything malformed falls back to the status. */
const classify = (status: number, body: unknown): AuthFailure => {
  const envelope = Schema.decodeUnknownOption(ErrorEnvelope)(body)
  if (Option.isSome(envelope)) {
    const { code, retryable } = envelope.value.error
    if (KNOWN_CODES.has(code)) {
      return { code: code as AuthErrorCode, retryable }
    }
  }
  if (status === 401) return { code: "Unauthorized", retryable: false }
  if (status === 400 || status === 422) return { code: "BadRequest", retryable: false }
  return { code: "InternalError", retryable: true }
}

const send = async <A>(
  method: "GET" | "POST",
  path: string,
  schema: Schema.ConstraintDecoder<A>,
  body?: unknown
): Promise<ApiResult<A>> => {
  let response: Response
  try {
    const init: RequestInit = {
      method,
      credentials: "include",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" }
      init.body = JSON.stringify(body)
    }
    response = await fetch(`${API_URL}${path}`, init)
  } catch {
    return { ok: false, error: { code: "Network", retryable: true } }
  }

  const json: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    return { ok: false, error: classify(response.status, json) }
  }

  const decoded = Schema.decodeUnknownOption(schema)(json)
  return Option.isSome(decoded)
    ? { ok: true, value: decoded.value }
    : { ok: false, error: { code: "InternalError", retryable: false } }
}

export const authApi = {
  me: (): Promise<ApiResult<SessionContext>> => send("GET", "/auth/me", SessionContext),

  register: (input: RegisterInput): Promise<ApiResult<SessionContext>> =>
    send("POST", "/auth/register", SessionContext, input),

  login: (input: LoginInput): Promise<ApiResult<SessionContext>> =>
    send("POST", "/auth/login", SessionContext, input),

  changePassword: (input: ChangePasswordInput): Promise<ApiResult<{ ok: boolean }>> =>
    send("POST", "/auth/change-password", OkResponse, input),

  logout: (): Promise<ApiResult<{ ok: boolean }>> => send("POST", "/auth/logout", OkResponse),

  createHousehold: (input: CreateHouseholdInput): Promise<ApiResult<HouseholdResponse>> =>
    send("POST", "/household", HouseholdResponse, input),

  joinHousehold: (input: JoinHouseholdInput): Promise<ApiResult<HouseholdResponse>> =>
    send("POST", "/household/join", HouseholdResponse, input)
}
