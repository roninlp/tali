import { Option, Schema } from "effect"
import {
  AUTH_ERROR_CODES,
  ErrorEnvelope,
  MonthReadModel as MonthReadModelSchema,
  WeekReadModel as WeekReadModelSchema,
  type AuthErrorCode,
  type MonthReadModel,
  type WeekReadModel
} from "@tali/domain"
import { API_URL } from "../config"

/**
 * The plain-HTTP week/month clients (ticket #43).
 *
 * Both reads carry the session cookie and the last ETag, so returning to a
 * window that has not changed is a real `304`. Failures are values: the screen
 * keeps painting the mirror when the API is unreachable, exactly like `/today`
 * (#42). `Network` means "could not reach the API", never "signed out".
 */

const REQUEST_TIMEOUT_MS = 15_000
const KNOWN_CODES: ReadonlySet<string> = new Set(AUTH_ERROR_CODES)

export interface CalendarFailure {
  readonly code: AuthErrorCode | "Network" | "InternalError" | "Forbidden"
  readonly retryable: boolean
}

export type ReadResult<A> =
  | {
      readonly ok: true
      readonly notModified: false
      readonly model: A
      readonly etag: string | undefined
    }
  | {
      readonly ok: true
      readonly notModified: true
      readonly etag: string | undefined
    }
  | { readonly ok: false; readonly error: CalendarFailure }

const classify = (status: number, body: unknown): CalendarFailure => {
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

const read = async <A>(
  schema: Schema.ConstraintDecoder<A>,
  path: string,
  query: Record<string, string | undefined>,
  etag?: string
): Promise<ReadResult<A>> => {
  const url = new URL(`${API_URL}${path}`)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value)
  }

  let response: Response
  try {
    const headers: Record<string, string> = {}
    if (etag !== undefined) headers["if-none-match"] = etag
    response = await fetch(url, {
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

  const decoded = Schema.decodeUnknownOption(schema)(json)
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

export const fetchWeek = (
  anchor: string,
  etag?: string
): Promise<ReadResult<WeekReadModel>> =>
  read(WeekReadModelSchema, "/week", { anchor }, etag)

export const fetchMonth = (
  anchor: string,
  day: string | undefined,
  etag?: string
): Promise<ReadResult<MonthReadModel>> =>
  read(MonthReadModelSchema, "/month", { anchor, day }, etag)
