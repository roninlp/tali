import { Option, Schema } from "effect"
import {
  AUTH_ERROR_CODES,
  ErrorEnvelope,
  PreferencesResponse,
  type AuthErrorCode,
  type PreferencesPatch,
  type UserPreferences
} from "@tali/domain"
import { API_URL } from "./config"

/**
 * The plain-HTTP preferences client (ticket #35).
 *
 * `/preferences` rides plain HTTP with the session cookie, like auth/sync/push.
 * Failures are values: the API's `ErrorEnvelope` is decoded to a stable code
 * the UI localizes, and a transport failure is `Network`.
 *
 * This is **not** an offline mutation stream: the server is the source of
 * truth for preferences and the browser only caches the last response
 * (`preferences-cache.ts`). A failed PATCH is surfaced, never queued
 * (ADR-0002) — a queued display preference would conflict with the server's
 * value on the next device for no benefit.
 */

const REQUEST_TIMEOUT_MS = 15_000

export type PreferencesFailureCode = AuthErrorCode | "Network"

export interface PreferencesFailure {
  readonly code: PreferencesFailureCode
  readonly retryable: boolean
}

export type PreferencesResult =
  | { readonly ok: true; readonly value: UserPreferences }
  | { readonly ok: false; readonly error: PreferencesFailure }

const KNOWN_CODES: ReadonlySet<string> = new Set(AUTH_ERROR_CODES)

/** Same envelope classification as the auth client (stable codes, no copy). */
const classify = (status: number, body: unknown): PreferencesFailure => {
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

const send = async (
  method: "GET" | "PATCH",
  body?: PreferencesPatch
): Promise<PreferencesResult> => {
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
    response = await fetch(`${API_URL}/preferences`, init)
  } catch {
    return { ok: false, error: { code: "Network", retryable: true } }
  }

  const json: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    return { ok: false, error: classify(response.status, json) }
  }

  const decoded = Schema.decodeUnknownOption(PreferencesResponse)(json)
  return Option.isSome(decoded)
    ? { ok: true, value: decoded.value.preferences }
    : { ok: false, error: { code: "InternalError", retryable: false } }
}

export const preferencesApi = {
  get: (): Promise<PreferencesResult> => send("GET"),
  patch: (patch: PreferencesPatch): Promise<PreferencesResult> => send("PATCH", patch)
}
