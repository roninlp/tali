import type { PushSubscriptionInput } from "@tali/domain"
import { API_URL } from "../config"

/**
 * `POST /push/register` (ticket #20).
 *
 * Returns failures as values rather than throwing: the permission panel shows a
 * calm message and the subscription stays usable locally (a later boot retries
 * the registration), exactly like the auth client.
 */

export type PushRegistrationFailure = "Unauthorized" | "BadRequest" | "Network" | "InternalError"

export type PushRegistrationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: PushRegistrationFailure; readonly retryable: boolean }

const REQUEST_TIMEOUT_MS = 15_000

export const registerPushSubscription = async (
  subscription: PushSubscriptionInput
): Promise<PushRegistrationResult> => {
  let response: Response
  try {
    response = await fetch(`${API_URL}/push/register`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscription),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch {
    return { ok: false, code: "Network", retryable: true }
  }

  if (response.ok) return { ok: true }
  if (response.status === 401) return { ok: false, code: "Unauthorized", retryable: false }
  if (response.status === 400 || response.status === 422) {
    return { ok: false, code: "BadRequest", retryable: false }
  }
  return { ok: false, code: "InternalError", retryable: true }
}
