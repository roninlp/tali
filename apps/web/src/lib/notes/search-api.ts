import { Option, Schema } from "effect"
import { NoteSearchResponse, type NoteSearchResponse as NoteSearchResponseType } from "@tali/domain"
import { API_URL } from "../config"

/**
 * The note-search client (ticket #41; FR-NOTE-04).
 *
 * The search is a **read**: it rides plain HTTP with the session cookie (like
 * `/preferences`), because the query is the only input and the answer is a
 * plain list of hits the browser can render as they arrive.
 *
 * Failures are values: the API's error envelope is decoded to a stable code
 * the UI localizes, and a transport failure is `Network`. The search box
 * falls back to the local mirror when the network is gone, so a `Network`
 * failure is a normal state here, not an error to shout about.
 */

const REQUEST_TIMEOUT_MS = 15_000

export type NoteSearchFailureCode = "Unauthorized" | "Forbidden" | "Network" | "InternalError"

export interface NoteSearchFailure {
  readonly code: NoteSearchFailureCode
  readonly retryable: boolean
}

export type NoteSearchResult =
  | { readonly ok: true; readonly value: NoteSearchResponseType }
  | { readonly ok: false; readonly error: NoteSearchFailure }

const classify = (status: number): NoteSearchFailure => {
  if (status === 401) return { code: "Unauthorized", retryable: false }
  if (status === 403) return { code: "Forbidden", retryable: false }
  if (status === 400 || status === 422) return { code: "InternalError", retryable: false }
  return { code: "InternalError", retryable: true }
}

export const searchNotes = async (
  query: string,
  signal?: AbortSignal
): Promise<NoteSearchResult> => {
  let response: Response
  try {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    response = await fetch(
      `${API_URL}/search/notes?q=${encodeURIComponent(query)}`,
      {
        credentials: "include",
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      }
    )
  } catch {
    return { ok: false, error: { code: "Network", retryable: true } }
  }

  const json: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    return { ok: false, error: classify(response.status) }
  }

  const decoded = Schema.decodeUnknownOption(NoteSearchResponse)(json)
  return Option.isSome(decoded)
    ? { ok: true, value: decoded.value }
    : { ok: false, error: { code: "InternalError", retryable: false } }
}
