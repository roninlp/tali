import { Option, Schema } from "effect"
import {
  ReminderInboxResponse,
  ReminderResponseResult,
  type DispatchResponse,
  type ReminderInboxItem,
  type ReminderResponseResult as ReminderResponseResultType
} from "@tali/domain"
import { API_URL } from "../config"

/**
 * The reminder ledger client (ticket #60; ADR-0005).
 *
 * Aggregate CRUD rides RPC (`lib/rpc`), but the inbox and the Done/Snooze/
 * Dismiss answer ride **plain HTTP** because they are not aggregate mutations:
 * the dispatch ledger is server-written, and the same two routes are what the
 * service worker's action queue and the in-app inbox both call (#61). Keeping
 * them here gives that slice one typed seam instead of duplicating fetch code.
 *
 * Failures are values (the note-search pattern): a stable code the UI can
 * localize, plus a transport-only `Network` case.
 */

const REQUEST_TIMEOUT_MS = 15_000

export type ReminderApiFailureCode =
  | "Unauthorized"
  | "Forbidden"
  | "BadRequest"
  | "NotFound"
  | "Conflict"
  | "Network"
  | "InternalError"

export interface ReminderApiFailure {
  readonly code: ReminderApiFailureCode
  readonly retryable: boolean
}

export type ReminderApiResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: ReminderApiFailure }

const classify = (status: number): ReminderApiFailure => {
  if (status === 401) return { code: "Unauthorized", retryable: false }
  if (status === 403) return { code: "Forbidden", retryable: false }
  if (status === 404) return { code: "NotFound", retryable: false }
  if (status === 409) return { code: "Conflict", retryable: true }
  if (status === 400 || status === 422) return { code: "BadRequest", retryable: false }
  return { code: "InternalError", retryable: true }
}

const request = async (
  path: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<Response | ReminderApiFailure> => {
  try {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    return await fetch(`${API_URL}${path}`, {
      credentials: "include",
      ...init,
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    })
  } catch {
    return { code: "Network", retryable: true }
  }
}

const isFailure = (value: Response | ReminderApiFailure): value is ReminderApiFailure =>
  !(value instanceof Response)

/** `GET /reminders/inbox` — the missed-reminder view (or its history page). */
export const fetchReminderInbox = async (
  options: {
    readonly history?: boolean
    readonly limit?: number
    readonly signal?: AbortSignal
  } = {}
): Promise<ReminderApiResult<ReadonlyArray<ReminderInboxItem>>> => {
  const params = new URLSearchParams()
  if (options.history === true) params.set("history", "1")
  if (options.limit !== undefined) params.set("limit", String(options.limit))
  const query = params.size === 0 ? "" : `?${params.toString()}`
  const response = await request(`/reminders/inbox${query}`, { method: "GET" }, options.signal)
  if (isFailure(response)) return { ok: false, error: response }

  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) return { ok: false, error: classify(response.status) }
  const decoded = Schema.decodeUnknownOption(ReminderInboxResponse)(body)
  return Option.isSome(decoded)
    ? { ok: true, value: decoded.value.items }
    : { ok: false, error: { code: "InternalError", retryable: false } }
}

/**
 * `POST /reminders/dispatches/:id/respond` — the same call the service worker
 * action eventually makes. A double tap returns the stored answer (200), so
 * callers can treat a repeated tap as success.
 */
export const respondToReminder = async (input: {
  readonly dispatchId: string
  readonly response: DispatchResponse
  readonly snoozeMinutes?: number
  readonly signal?: AbortSignal
}): Promise<ReminderApiResult<ReminderResponseResultType>> => {
  const response = await request(
    `/reminders/dispatches/${encodeURIComponent(input.dispatchId)}/respond`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        input.snoozeMinutes === undefined
          ? { response: input.response }
          : { response: input.response, snoozeMinutes: input.snoozeMinutes }
      )
    },
    input.signal
  )
  if (isFailure(response)) return { ok: false, error: response }

  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) return { ok: false, error: classify(response.status) }
  const decoded = Schema.decodeUnknownOption(ReminderResponseResult)(body)
  return Option.isSome(decoded)
    ? { ok: true, value: decoded.value }
    : { ok: false, error: { code: "InternalError", retryable: false } }
}
