import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { RpcClient, RpcSerialization } from 'effect/rpc'

import { type ApiClient, ApiRpcs } from '@tali/rpc'

import { API_URL } from './config'

/**
 * The typed client for the api Worker's RPC contract.
 *
 * Ported from `apps/web/src/lib/rpc.ts` minus the Promise wrappers: Foldkit
 * Commands should return `Effect`s and carry their results back as Messages,
 * so callers compose inside `Command.execute` rather than awaiting a Promise.
 *
 * The client is built per call and its scope closed, matching the legacy app:
 * a browser RPC call owns its fetch resources for exactly one request.
 */
export const withRpcClient = <A, E>(
  f: (client: ApiClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E, never> => {
  // `layerProtocolHttp` needs the serialization and fetch layers, so provide
  // them into it rather than merging all three in parallel.
  const TransportLive = RpcClient.layerProtocolHttp({
    url: `${API_URL}/rpc`,
  }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(FetchHttpClient.layer),
  )

  return Effect.gen(function* () {
    const client = yield* RpcClient.make(ApiRpcs)
    return yield* f(client)
  }).pipe(
    Effect.provide(TransportLive),
    // The auth endpoints set the session cookie; RPC calls must carry it.
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: 'include',
    }),
    Effect.scoped,
  )
}
