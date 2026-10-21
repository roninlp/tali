import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { ApiRpcs, type ApiClient } from "@tali/rpc"
import type {
  ListItem,
  ListItemInsert,
  Note,
  NoteCreateInput,
  NoteFlagInput,
  NoteListInput,
  NoteSaveInput,
  NoteTagInput,
  NoteUpdateInput
} from "@tali/domain"
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
    Effect.runPromise(withClient((client) => client.ToggleListItem({ id, checked }))),

  // ── Notes (#40) ────────────────────────────────────────────────────────
  // The editor writes through the local mirror; these are the server paths
  // the screens use for hydration, the dashboard seam and online-only restore.

  createNote: (input: NoteCreateInput): Promise<Note> =>
    Effect.runPromise(withClient((client) => client.CreateNote(input))),

  getNote: (id: string): Promise<Note> =>
    Effect.runPromise(withClient((client) => client.GetNote({ id: id as Note["id"] }))),

  saveNote: (input: NoteSaveInput): Promise<Note> =>
    Effect.runPromise(withClient((client) => client.SaveNote(input))),

  updateNote: (input: NoteUpdateInput): Promise<Note> =>
    Effect.runPromise(withClient((client) => client.UpdateNote(input))),

  setNotePinned: (input: NoteFlagInput): Promise<Note> =>
    Effect.runPromise(withClient((client) => client.SetNotePinned(input))),

  setNoteArchived: (input: NoteFlagInput): Promise<Note> =>
    Effect.runPromise(withClient((client) => client.SetNoteArchived(input))),

  setNoteTags: (input: NoteTagInput): Promise<Note> =>
    Effect.runPromise(withClient((client) => client.SetNoteTags(input))),

  trashNote: (id: string, clientMutationId: string): Promise<Note> =>
    Effect.runPromise(
      withClient((client) =>
        client.TrashNote({ id: id as Note["id"], clientMutationId })
      )
    ),

  restoreNote: (id: string, clientMutationId: string): Promise<Note> =>
    Effect.runPromise(
      withClient((client) =>
        client.RestoreNote({ id: id as Note["id"], clientMutationId })
      )
    ),

  listNotes: (input: NoteListInput = {}): Promise<ReadonlyArray<Note>> =>
    Effect.runPromise(withClient((client) => client.ListNotes(input))),

  /** The #42 dashboard seam. */
  listPinnedNotes: (): Promise<ReadonlyArray<Note>> =>
    Effect.runPromise(withClient((client) => client.ListPinnedNotes())),

  listTrashNotes: (): Promise<ReadonlyArray<Note>> =>
    Effect.runPromise(withClient((client) => client.ListTrashNotes()))
}
