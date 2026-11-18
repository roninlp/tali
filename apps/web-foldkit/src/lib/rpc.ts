import { Effect } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { type ApiClient, makeApiClient } from '@tali/rpc'

import { API_URL } from './config'

/**
 * The typed client for the api Worker's RPC contract.
 *
 * Ported from `apps/web/src/lib/rpc.ts` minus the Promise wrappers: Foldkit
 * Commands should return `Effect`s and carry their results back as Messages,
 * so callers compose inside `Command.execute` rather than awaiting a Promise.
 *
 * The client is built per call and its scope closed, matching the legacy app:
 * a browser RPC call owns its fetch resources for exactly one request. The
 * construction itself lives in `@tali/rpc` (`makeApiClient`), shared with the
 * conflict lab.
 */
export const withRpcClient = <A, E>(
  f: (client: ApiClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E, never> =>
  makeApiClient(`${API_URL}/rpc`)(f).pipe(
    // The auth endpoints set the session cookie; RPC calls must carry it.
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: 'include',
    }),
  )
