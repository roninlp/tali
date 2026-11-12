import { Schema } from 'effect'
import { vi } from 'vitest'

/**
 * The one way a test hands `fetch` back a canned answer.
 *
 * The status comes first in `jsonResponse`, matching `fetch`/`Response` and the
 * `status` a test reads out loud; the reversed `(body, status)` form one client
 * test used to keep is exactly the trap this module removes.
 */

export const jsonResponse = (
  status: number,
  body: Schema.Json,
  etag?: string,
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers:
      etag === undefined
        ? { 'content-type': 'application/json' }
        : { 'content-type': 'application/json', etag },
  })

/** Stub `fetch` with one response (or a thrown error) and return the mock. */
export const stubFetch = (response: Response | Error) => {
  const fetchMock = vi.fn(
    async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (response instanceof Error) {
        throw response
      }

      return response
    },
  )

  vi.stubGlobal('fetch', fetchMock)

  return fetchMock
}
