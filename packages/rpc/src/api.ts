import { Schema } from "effect"
import { Rpc, RpcClient, RpcGroup } from "effect/rpc"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import {
  ListItem,
  ListItemId,
  ListItemInsert,
  ListItemNotFound,
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

export const ApiRpcs = RpcGroup.make(
  CreateListItem,
  ListListItems,
  ToggleListItem,
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
  ListTags
)

/** The derived, shared client type the web app imports. */
export type ApiClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ApiRpcs>, RpcClientError>
