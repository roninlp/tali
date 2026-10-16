import { Schema } from "effect"
import { Rpc, RpcClient, RpcGroup } from "effect/rpc"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import { ListItem, ListItemId, ListItemInsert, ListItemNotFound } from "@tali/domain"

/**
 * The single RPC contract shared by `apps/api` (serves it via
 * `RpcServer.layerHttp`) and `apps/web` (calls it via a derived `RpcClient`).
 *
 * Adding a procedure here updates the handler type AND the client type in the
 * same edit — drift is a compile error, not a runtime concern.
 */

class CreateListItem extends Rpc.make("CreateListItem", {
  payload: ListItemInsert,
  success: ListItem,
  error: ListItemNotFound
}) {}

class ListListItems extends Rpc.make("ListListItems", {
  success: Schema.Array(ListItem)
}) {}

class ToggleListItem extends Rpc.make("ToggleListItem", {
  payload: Schema.Struct({ id: ListItemId, checked: Schema.Boolean }),
  success: ListItem,
  error: ListItemNotFound
}) {}

export const ApiRpcs = RpcGroup.make(CreateListItem, ListListItems, ToggleListItem)

/** The derived, shared client type the web app imports. */
export type ApiClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ApiRpcs>, RpcClientError>
