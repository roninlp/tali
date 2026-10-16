import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { ApiRpcs } from "@tali/rpc"
import type { ListItem, ListItemInsert } from "@tali/domain"

// In a real deployment this comes from env/CF_PAGES binding; the api Worker is
// reverse-proxied at /rpc (or reached over the internal URL). Hardcoded for the
// scaffold.
const API_URL = "http://localhost:8787"

/**
 * `"use server"` functions are the thin, typed adapters over the *same* RPC
 * contract that `apps/api` serves. They build a derived `RpcClient` (no codegen)
 * and call the api over plain HTTP; argument/return types come from the shared
 * `@tali/domain` schemas via `@tali/rpc`.
 */
export async function createListItem(input: ListItemInsert): Promise<ListItem> {
  "use server"
  return Effect.runPromise(
    Effect.gen(function*() {
      const client = yield* RpcClient.make(ApiRpcs)
      return yield* client.CreateListItem(input)
    }).pipe(
      Effect.provide(RpcClient.layerProtocolHttp({ url: `${API_URL}/rpc` })),
      Effect.provide(RpcSerialization.layerNdjson),
      Effect.provide(FetchHttpClient.layer),
      Effect.scoped
    )
  )
}

export async function listListItems(): Promise<ReadonlyArray<ListItem>> {
  "use server"
  return Effect.runPromise(
    Effect.gen(function*() {
      const client = yield* RpcClient.make(ApiRpcs)
      return yield* client.ListListItems()
    }).pipe(
      Effect.provide(RpcClient.layerProtocolHttp({ url: `${API_URL}/rpc` })),
      Effect.provide(RpcSerialization.layerNdjson),
      Effect.provide(FetchHttpClient.layer),
      Effect.scoped
    )
  )
}
