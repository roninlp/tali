import { Schema } from "effect"
import { Rpc, RpcClient, RpcGroup } from "effect/rpc"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import {
  List,
  ListCreateInput,
  ListId,
  ListItemCheckInput,
  ListItemCreateInput,
  ListItemMutationInput,
  ListItemUpdateInput,
  ListItemsAppendInput,
  ListItemsQuery,
  ListMutationInput,
  ListReorderInput,
  ListServiceError,
  ListUpdateInput,
  Note,
  NoteCreateInput,
  NoteFlagInput,
  NoteId,
  NoteListInput,
  NoteMutationInput,
  NoteSaveInput,
  NoteServiceError,
  NoteTagInput,
  NoteUpdateInput,
  PlanningListItem,
  Project,
  ProjectCreateInput,
  ProjectRenameInput,
  Tag,
  TagCreateInput,
  TagRenameInput,
  Task,
  TaskBuckets,
  TaskCreateInput,
  TaskId,
  TaskListInput,
  TaskMoveInput,
  TaskMutationInput,
  TaskServiceError,
  TaskUpdateInput,
  Unauthorized
} from "@tali/domain"

/**
 * The single RPC contract shared by `apps/api` (serves it via
 * `RpcServer.layerHttp`) and `apps/web` (calls it via a derived `RpcClient`).
 *
 * Adding a procedure here updates the handler type AND the client type in the
 * same edit — drift is a compile error, not a runtime concern.
 *
 * Task/project/tag procedures carry the full `TaskServiceError` union (plus
 * `Unauthorized`), so the client is forced to handle not-found, forbidden,
 * invalid-transition and validation outcomes by tag.
 */

// ── Lists / ListItems (ticket #39; FR-LIST-01/02/03) ─────────────────────

const ListRpcError = Schema.Union([ListServiceError, Unauthorized])

class CreateList extends Rpc.make("CreateList", {
  payload: ListCreateInput,
  success: List,
  error: ListRpcError
}) {}

class GetList extends Rpc.make("GetList", {
  payload: Schema.Struct({ id: ListId }),
  success: List,
  error: ListRpcError
}) {}

class UpdateList extends Rpc.make("UpdateList", {
  payload: ListUpdateInput,
  success: List,
  error: ListRpcError
}) {}

class DeleteList extends Rpc.make("DeleteList", {
  payload: ListMutationInput,
  success: List,
  error: ListRpcError
}) {}

class ListLists extends Rpc.make("ListLists", {
  success: Schema.Array(List),
  error: ListRpcError
}) {}

class CreateListItem extends Rpc.make("CreateListItem", {
  payload: ListItemCreateInput,
  success: PlanningListItem,
  error: ListRpcError
}) {}

class AppendListItems extends Rpc.make("AppendListItems", {
  payload: ListItemsAppendInput,
  success: Schema.Array(PlanningListItem),
  error: ListRpcError
}) {}

class ListListItems extends Rpc.make("ListListItems", {
  payload: ListItemsQuery,
  success: Schema.Array(PlanningListItem),
  error: ListRpcError
}) {}

class UpdateListItem extends Rpc.make("UpdateListItem", {
  payload: ListItemUpdateInput,
  success: PlanningListItem,
  error: ListRpcError
}) {}

class SetListItemChecked extends Rpc.make("SetListItemChecked", {
  payload: ListItemCheckInput,
  success: PlanningListItem,
  error: ListRpcError
}) {}

class DeleteListItem extends Rpc.make("DeleteListItem", {
  payload: ListItemMutationInput,
  success: PlanningListItem,
  error: ListRpcError
}) {}

class ReorderListItems extends Rpc.make("ReorderListItems", {
  payload: ListReorderInput,
  success: Schema.Array(PlanningListItem),
  error: ListRpcError
}) {}

const TaskRpcError = Schema.Union([TaskServiceError, Unauthorized])

class CreateTask extends Rpc.make("CreateTask", {
  payload: TaskCreateInput,
  success: Task,
  error: TaskRpcError
}) {}

class GetTask extends Rpc.make("GetTask", {
  payload: Schema.Struct({ id: TaskId }),
  success: Task,
  error: TaskRpcError
}) {}

class UpdateTask extends Rpc.make("UpdateTask", {
  payload: TaskUpdateInput,
  success: Task,
  error: TaskRpcError
}) {}

class MoveTask extends Rpc.make("MoveTask", {
  payload: TaskMoveInput,
  success: Task,
  error: TaskRpcError
}) {}

class StartTask extends Rpc.make("StartTask", {
  payload: TaskMutationInput,
  success: Task,
  error: TaskRpcError
}) {}

class CompleteTask extends Rpc.make("CompleteTask", {
  payload: TaskMutationInput,
  success: Task,
  error: TaskRpcError
}) {}

class UndoTask extends Rpc.make("UndoTask", {
  payload: TaskMutationInput,
  success: Task,
  error: TaskRpcError
}) {}

class ListTasks extends Rpc.make("ListTasks", {
  payload: TaskListInput,
  success: Schema.Array(Task),
  error: TaskRpcError
}) {}

class GetTaskBuckets extends Rpc.make("GetTaskBuckets", {
  success: TaskBuckets,
  error: TaskRpcError
}) {}

class CreateProject extends Rpc.make("CreateProject", {
  payload: ProjectCreateInput,
  success: Project,
  error: TaskRpcError
}) {}

class RenameProject extends Rpc.make("RenameProject", {
  payload: ProjectRenameInput,
  success: Project,
  error: TaskRpcError
}) {}

class ListProjects extends Rpc.make("ListProjects", {
  success: Schema.Array(Project),
  error: TaskRpcError
}) {}

class CreateTag extends Rpc.make("CreateTag", {
  payload: TagCreateInput,
  success: Tag,
  error: TaskRpcError
}) {}

class RenameTag extends Rpc.make("RenameTag", {
  payload: TagRenameInput,
  success: Tag,
  error: TaskRpcError
}) {}

class ListTags extends Rpc.make("ListTags", {
  success: Schema.Array(Tag),
  error: TaskRpcError
}) {}

// ── Notes (ticket #40; FR-NOTE-01/03) ────────────────────────────────────

const NoteRpcError = Schema.Union([NoteServiceError, Unauthorized])

class CreateNote extends Rpc.make("CreateNote", {
  payload: NoteCreateInput,
  success: Note,
  error: NoteRpcError
}) {}

class GetNote extends Rpc.make("GetNote", {
  payload: Schema.Struct({ id: NoteId }),
  success: Note,
  error: NoteRpcError
}) {}

/** Version-keyed autosave; identical text is a no-op, stale text conflicts. */
class SaveNote extends Rpc.make("SaveNote", {
  payload: NoteSaveInput,
  success: Note,
  error: NoteRpcError
}) {}

class UpdateNote extends Rpc.make("UpdateNote", {
  payload: NoteUpdateInput,
  success: Note,
  error: NoteRpcError
}) {}

class SetNotePinned extends Rpc.make("SetNotePinned", {
  payload: NoteFlagInput,
  success: Note,
  error: NoteRpcError
}) {}

class SetNoteArchived extends Rpc.make("SetNoteArchived", {
  payload: NoteFlagInput,
  success: Note,
  error: NoteRpcError
}) {}

class SetNoteTags extends Rpc.make("SetNoteTags", {
  payload: NoteTagInput,
  success: Note,
  error: NoteRpcError
}) {}

class TrashNote extends Rpc.make("TrashNote", {
  payload: NoteMutationInput,
  success: Note,
  error: NoteRpcError
}) {}

class RestoreNote extends Rpc.make("RestoreNote", {
  payload: NoteMutationInput,
  success: Note,
  error: NoteRpcError
}) {}

class ListNotes extends Rpc.make("ListNotes", {
  payload: NoteListInput,
  success: Schema.Array(Note),
  error: NoteRpcError
}) {}

/** The #42 dashboard seam: pinned, live, non-archived notes. */
class ListPinnedNotes extends Rpc.make("ListPinnedNotes", {
  success: Schema.Array(Note),
  error: NoteRpcError
}) {}

class ListTrashNotes extends Rpc.make("ListTrashNotes", {
  success: Schema.Array(Note),
  error: NoteRpcError
}) {}

export const ApiRpcs = RpcGroup.make(
  CreateList,
  GetList,
  UpdateList,
  DeleteList,
  ListLists,
  CreateListItem,
  AppendListItems,
  ListListItems,
  UpdateListItem,
  SetListItemChecked,
  DeleteListItem,
  ReorderListItems,
  CreateTask,
  GetTask,
  UpdateTask,
  MoveTask,
  StartTask,
  CompleteTask,
  UndoTask,
  ListTasks,
  GetTaskBuckets,
  CreateProject,
  RenameProject,
  ListProjects,
  CreateTag,
  RenameTag,
  ListTags,
  CreateNote,
  GetNote,
  SaveNote,
  UpdateNote,
  SetNotePinned,
  SetNoteArchived,
  SetNoteTags,
  TrashNote,
  RestoreNote,
  ListNotes,
  ListPinnedNotes,
  ListTrashNotes
)

/** The derived, shared client type the web app imports. */
export type ApiClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ApiRpcs>, RpcClientError>
