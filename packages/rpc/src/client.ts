import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { RpcClient, RpcSerialization } from 'effect/rpc'

import { type ApiClient, ApiRpcs } from './api'

/**
 * Build the per-call, typed client helper for the api Worker's RPC contract,
 * pointed at `url` (the full RPC endpoint, e.g. `${origin}/rpc`).
 *
 * The returned helper is the shape `apps/web-foldkit/src/lib/rpc.ts` has
 * always exposed: it builds a fresh client and closes its scope per call, so
 * one RPC request owns its fetch resources for exactly one request. Both the
 * web app (with its `API_URL` config, plus the browser cookie-jar
 * `RequestInit`) and the conflict lab (pointed at its test Worker) consume
 * this instead of the app owning the construction.
 */
export const makeApiClient = (
  url: string,
): (<A, E>(
  f: (client: ApiClient) => Effect.Effect<A, E>,
) => Effect.Effect<A, E, never>) => {
  const call = <A, E>(
    f: (client: ApiClient) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E, never> => {
    // `layerProtocolHttp` needs the serialization and fetch layers, so
    // provide them into it rather than merging all three in parallel.
    const TransportLive = RpcClient.layerProtocolHttp({ url }).pipe(
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(FetchHttpClient.layer),
    )

    return Effect.gen(function* () {
      const client = yield* RpcClient.make(ApiRpcs)

      return yield* f(client)
    }).pipe(Effect.provide(TransportLive), Effect.scoped)
  }

  return call
}
