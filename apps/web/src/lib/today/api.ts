import { Option, Schema } from "effect"
import {
  AUTH_ERROR_CODES,
  ErrorEnvelope,
  TodayReadModel as TodayReadModelSchema,
  type AuthErrorCode,
  type TodayReadModel
} from "@tali/domain"
import { API_URL } from "../config"

/**
 * The plain-HTTP `GET /today` client (ticket #42).
 *
 * The request carries the session cookie and the last ETag, so revalidation is
 * a real 304 instead of a re-download. Failures are values: the screen keeps
 * rendering the mirror rather than blanking when the API is unavailable.
 * `network` means "could not reach the API", not "the user is signed out".
 */

const REQUEST_TIMEOUT_MS = 15_000
const KNOWN_CODES: ReadonlySet<string> = new Set(AUTH_ERROR_CODES)

export interface TodayFailure {
  readonly code: AuthErrorCode | "Network" | "InternalError" | "Forbidden"
  readonly retryable: boolean
}

export type TodayResult =
  | {
      readonly ok: true
      readonly notModified: false
      readonly model: TodayReadModel
      readonly etag: string | undefined
    }
  | {
      readonly ok: true
      readonly notModified: true
      readonly etag: string | undefined
    }
  | { readonly ok: false; readonly error: TodayFailure }

const classify = (status: number, body: unknown): TodayFailure => {
  const envelope = Schema.decodeUnknownOption(ErrorEnvelope)(body)
  if (Option.isSome(envelope)) {
    const { code, retryable } = envelope.value.error
    if (KNOWN_CODES.has(code)) {
      return { code: code as AuthErrorCode, retryable }
    }
  }
  if (status === 401) return { code: "Unauthorized", retryable: false }
  if (status === 403) return { code: "Forbidden", retryable: false }
  if (status === 400 || status === 422) return { code: "BadRequest", retryable: false }
  return { code: "InternalError", retryable: true }
}

export const fetchToday = async (etag?: string): Promise<TodayResult> => {
  let response: Response
  try {
    const headers: Record<string, string> = {}
    if (etag !== undefined) headers["if-none-match"] = etag
    response = await fetch(`${API_URL}/today`, {
      method: "GET",
      credentials: "include",
      cache: "no-cache",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch {
    return { ok: false, error: { code: "Network", retryable: true } }
  }

  if (response.status === 304) {
    return {
      ok: true,
      notModified: true,
      etag: response.headers.get("etag") ?? etag
    }
  }

  const json: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    return { ok: false, error: classify(response.status, json) }
  }

  const decoded = Schema.decodeUnknownOption(TodayReadModelSchema)(json)
  if (Option.isNone(decoded)) {
    return { ok: false, error: { code: "InternalError", retryable: true } }
  }
  return {
    ok: true,
    notModified: false,
    model: decoded.value,
    etag: response.headers.get("etag") ?? undefined
  }
}
