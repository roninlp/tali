import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { ApiRpcs, type ApiClient } from "@tali/rpc"
import type { ListItem, ListItemInsert } from "@tali/domain"
import { API_URL } from "./config"

/**
 * Client-only RPC: the browser calls the derived `RpcClient` for `ApiRpcs`
 * directly over plain HTTP (no SolidStart server functions, no SSR). This is
 * the same contract `apps/api` serves via `RpcServer.layerHttp` — drift between
 * the two is a compile error, not a runtime concern.
 *
 * The api Worker is reached at `VITE_API_URL` (defaults to the local
 * `wrangler dev` port). In production it is reverse-proxied at `/rpc`.
 */

/** Build the typed client, run `f`, and tear the scope down per call. */
function withClient<A, E>(
  f: (client: ApiClient) => Effect.Effect<A, E>
): Effect.Effect<A, E, never> {
  return Effect.gen(function*() {
    const client = yield* RpcClient.make(ApiRpcs)
    return yield* f(client)
  }).pipe(
    Effect.provide(RpcClient.layerProtocolHttp({ url: `${API_URL}/rpc` })),
    Effect.provide(RpcSerialization.layerNdjson),
    Effect.provide(FetchHttpClient.layer),
    // Cookies are set by the auth endpoints; RPC calls carry the session too
    // (the RPC authorization middleware lands with the first protected aggregate).
    Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }),
    Effect.scoped
  )
}

/** Promise-returning wrappers for use from Solid components. */
export const api = {
  listListItems: (): Promise<ReadonlyArray<ListItem>> =>
    Effect.runPromise(withClient((client) => client.ListListItems())),

  createListItem: (input: ListItemInsert): Promise<ListItem> =>
    Effect.runPromise(withClient((client) => client.CreateListItem(input))),

  toggleListItem: (id: string, checked: boolean): Promise<ListItem> =>
    Effect.runPromise(withClient((client) => client.ToggleListItem({ id, checked })))
}
