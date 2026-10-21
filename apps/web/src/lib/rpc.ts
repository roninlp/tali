import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { ApiRpcs, type ApiClient } from "@tali/rpc"
import type {
  HabitEntry,
  HabitEntryLogInput,
  HabitEntryRangeInput,
  List,
  ListCreateInput,
  ListItemCheckInput,
  ListItemCreateInput,
  ListItemMutationInput,
  ListItemUpdateInput,
  ListItemsAppendInput,
  ListMutationInput,
  ListReorderInput,
  ListUpdateInput,
  Note,
  NoteCreateInput,
  NoteFlagInput,
  NoteListInput,
  NoteSaveInput,
  NoteTagInput,
  NoteUpdateInput,
  Occasion,
  OccasionAdvanceReminder,
  OccasionCreateInput,
  OccasionDetail,
  OccasionMutationInput,
  OccasionOccurrence,
  OccasionOccurrenceQuery,
  OccasionPrepareInput,
  OccasionPreparation,
  OccasionUpdateInput,
  PlanningListItem,
  Reminder,
  ReminderCreateInput,
  ReminderListInput,
  ReminderMutationInput,
  ReminderUpdateInput
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
  // ── Lists (#39) ────────────────────────────────────────────────────────
  // The screens render from the local mirror; these are the online/RPC
  // equivalents used by tests and any future server-backed view.

  createList: (input: ListCreateInput): Promise<List> =>
    Effect.runPromise(withClient((client) => client.CreateList(input))),

  getList: (id: string): Promise<List> =>
    Effect.runPromise(withClient((client) => client.GetList({ id: id as List["id"] }))),

  updateList: (input: ListUpdateInput): Promise<List> =>
    Effect.runPromise(withClient((client) => client.UpdateList(input))),

  deleteList: (input: ListMutationInput): Promise<List> =>
    Effect.runPromise(withClient((client) => client.DeleteList(input))),

  listLists: (): Promise<ReadonlyArray<List>> =>
    Effect.runPromise(withClient((client) => client.ListLists())),

  listListItems: (listId: string): Promise<ReadonlyArray<PlanningListItem>> =>
    Effect.runPromise(
      withClient((client) => client.ListListItems({ listId: listId as List["id"] }))
    ),

  createListItem: (input: ListItemCreateInput): Promise<PlanningListItem> =>
    Effect.runPromise(withClient((client) => client.CreateListItem(input))),

  appendListItems: (input: ListItemsAppendInput): Promise<ReadonlyArray<PlanningListItem>> =>
    Effect.runPromise(withClient((client) => client.AppendListItems(input))),

  updateListItem: (input: ListItemUpdateInput): Promise<PlanningListItem> =>
    Effect.runPromise(withClient((client) => client.UpdateListItem(input))),

  setListItemChecked: (input: ListItemCheckInput): Promise<PlanningListItem> =>
    Effect.runPromise(withClient((client) => client.SetListItemChecked(input))),

  deleteListItem: (input: ListItemMutationInput): Promise<PlanningListItem> =>
    Effect.runPromise(withClient((client) => client.DeleteListItem(input))),

  reorderListItems: (input: ListReorderInput): Promise<ReadonlyArray<PlanningListItem>> =>
    Effect.runPromise(withClient((client) => client.ReorderListItems(input))),

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
    Effect.runPromise(withClient((client) => client.ListTrashNotes())),

  // ── Habit entries (#64) ────────────────────────────────────────────────
  // The tap writes the mirror first (`lib/habits/log.ts`); this is the server
  // path the sync engine calls to revive a day whose generic push met a
  // tombstone, plus the range read Today/statistics use.

  logHabitEntry: (input: HabitEntryLogInput): Promise<HabitEntry> =>
    Effect.runPromise(withClient((client) => client.LogHabitEntry(input))),

  listHabitEntries: (input: HabitEntryRangeInput): Promise<ReadonlyArray<HabitEntry>> =>
    Effect.runPromise(withClient((client) => client.ListHabitEntries(input))),

  // ── Reminders (#60) ────────────────────────────────────────────────────
  // The reminder screens write through the local mirror; these are the
  // online/RPC equivalents used for linked-reminder creation and hydration.
  // The inbox/response log deliberately rides plain HTTP (`lib/reminders/api`).

  createReminder: (input: ReminderCreateInput): Promise<Reminder> =>
    Effect.runPromise(withClient((client) => client.CreateReminder(input))),

  getReminder: (id: string): Promise<Reminder> =>
    Effect.runPromise(withClient((client) => client.GetReminder({ id: id as Reminder["id"] }))),

  updateReminder: (input: ReminderUpdateInput): Promise<Reminder> =>
    Effect.runPromise(withClient((client) => client.UpdateReminder(input))),

  deleteReminder: (input: ReminderMutationInput): Promise<Reminder> =>
    Effect.runPromise(withClient((client) => client.DeleteReminder(input))),

  listReminders: (input: ReminderListInput = {}): Promise<ReadonlyArray<Reminder>> =>
    Effect.runPromise(withClient((client) => client.ListReminders(input))),

  // ── Occasions (#59) ────────────────────────────────────────────────────
  // The calendar panel writes through the local mirror; these are the online
  // RPC equivalents (server-authoritative create/update, detail projection and
  // the one-batch preparation task).

  createOccasion: (input: OccasionCreateInput): Promise<Occasion> =>
    Effect.runPromise(withClient((client) => client.CreateOccasion(input))),

  getOccasion: (id: string): Promise<OccasionDetail> =>
    Effect.runPromise(
      withClient((client) => client.GetOccasion({ id: id as Occasion["id"] }))
    ),

  updateOccasion: (input: OccasionUpdateInput): Promise<Occasion> =>
    Effect.runPromise(withClient((client) => client.UpdateOccasion(input))),

  deleteOccasion: (input: OccasionMutationInput): Promise<Occasion> =>
    Effect.runPromise(withClient((client) => client.DeleteOccasion(input))),

  listOccasions: (): Promise<ReadonlyArray<Occasion>> =>
    Effect.runPromise(withClient((client) => client.ListOccasions())),

  listOccasionOccurrences: (
    input: OccasionOccurrenceQuery
  ): Promise<ReadonlyArray<OccasionOccurrence>> =>
    Effect.runPromise(withClient((client) => client.ListOccasionOccurrences(input))),

  listOccasionReminders: (
    input: OccasionOccurrenceQuery
  ): Promise<ReadonlyArray<OccasionAdvanceReminder>> =>
    Effect.runPromise(withClient((client) => client.ListOccasionReminders(input))),

  materialiseOccasionReminders: (
    input: OccasionOccurrenceQuery
  ): Promise<ReadonlyArray<Reminder>> =>
    Effect.runPromise(withClient((client) => client.MaterialiseOccasionReminders(input))),

  prepareOccasionTask: (input: OccasionPrepareInput): Promise<OccasionPreparation> =>
    Effect.runPromise(withClient((client) => client.PrepareOccasionTask(input)))
}
