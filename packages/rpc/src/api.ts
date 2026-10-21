import { Schema } from "effect"
import { Rpc, RpcClient, RpcGroup } from "effect/rpc"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import {
  Event,
  EventCreateInput,
  EventId,
  EventListInput,
  EventMutationInput,
  EventOccurrence,
  EventOccurrenceChange,
  EventOccurrenceDeleteInput,
  EventOccurrenceEditInput,
  EventOccurrenceQuery,
  EventServiceError,
  EventUpdateInput,
  Habit,
  HabitCreateInput,
  HabitEntry,
  HabitEntryLogInput,
  HabitEntryRangeInput,
  HabitId,
  HabitMutationInput,
  HabitServiceError,
  HabitUpdateInput,
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
  Reminder,
  ReminderCreateInput,
  ReminderId,
  ReminderListInput,
  ReminderMutationInput,
  ReminderServiceError,
  ReminderUpdateInput,
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

// ── Events (tickets #57/#58; FR-CAL-01/03) ───────────────────────────────

const EventRpcError = Schema.Union([EventServiceError, Unauthorized])

class CreateEvent extends Rpc.make("CreateEvent", {
  payload: EventCreateInput,
  success: Event,
  error: EventRpcError
}) {}

class GetEvent extends Rpc.make("GetEvent", {
  payload: Schema.Struct({ id: EventId }),
  success: Event,
  error: EventRpcError
}) {}

class UpdateEvent extends Rpc.make("UpdateEvent", {
  payload: EventUpdateInput,
  success: Event,
  error: EventRpcError
}) {}

class DeleteEvent extends Rpc.make("DeleteEvent", {
  payload: EventMutationInput,
  success: Event,
  error: EventRpcError
}) {}

class ListEvents extends Rpc.make("ListEvents", {
  payload: EventListInput,
  success: Schema.Array(Event),
  error: EventRpcError
}) {}

/** Expand every visible series into a window (`before` exclusive). */
class ListEventOccurrences extends Rpc.make("ListEventOccurrences", {
  payload: EventOccurrenceQuery,
  success: Schema.Array(EventOccurrence),
  error: EventRpcError
}) {}

/** "This occurrence" / "this and following" edit. */
class EditEventOccurrence extends Rpc.make("EditEventOccurrence", {
  payload: EventOccurrenceEditInput,
  success: EventOccurrenceChange,
  error: EventRpcError
}) {}

/** "This occurrence" / "this and following" delete. */
class DeleteEventOccurrence extends Rpc.make("DeleteEventOccurrence", {
  payload: EventOccurrenceDeleteInput,
  success: EventOccurrenceChange,
  error: EventRpcError
}) {}

// ── Habits (ticket #63; FR-HAB-01) ───────────────────────────────────────

const HabitRpcError = Schema.Union([HabitServiceError, Unauthorized])

class CreateHabit extends Rpc.make("CreateHabit", {
  payload: HabitCreateInput,
  success: Habit,
  error: HabitRpcError
}) {}

class GetHabit extends Rpc.make("GetHabit", {
  payload: Schema.Struct({ id: HabitId }),
  success: Habit,
  error: HabitRpcError
}) {}

class UpdateHabit extends Rpc.make("UpdateHabit", {
  payload: HabitUpdateInput,
  success: Habit,
  error: HabitRpcError
}) {}

/** Soft delete — the row keeps its history for the undo toast. */
class DeleteHabit extends Rpc.make("DeleteHabit", {
  payload: HabitMutationInput,
  success: Habit,
  error: HabitRpcError
}) {}

/** Undo a soft delete: the same habit comes back, history intact. */
class RestoreHabit extends Rpc.make("RestoreHabit", {
  payload: HabitMutationInput,
  success: Habit,
  error: HabitRpcError
}) {}

class ListHabits extends Rpc.make("ListHabits", {
  success: Schema.Array(Habit),
  error: HabitRpcError
}) {}

/**
 * Log (or re-log) one habit day (#64). The server resolves the day's row —
 * live or tombstoned — and updates it in place, so the status cycles
 * Done → Partial → Missed without ever adding a second row. An old day is a
 * typed `HabitEntryOutOfWindow` failure.
 */
class LogHabitEntry extends Rpc.make("LogHabitEntry", {
  payload: HabitEntryLogInput,
  success: HabitEntry,
  error: HabitRpcError
}) {}

/** The `[from, before)` range read behind Today and the statistics (#66). */
class ListHabitEntries extends Rpc.make("ListHabitEntries", {
  payload: HabitEntryRangeInput,
  success: Schema.Array(HabitEntry),
  error: HabitRpcError
}) {}

// ── Reminders (ticket #60; FR-REM-01/03) ─────────────────────────────────

const ReminderRpcError = Schema.Union([ReminderServiceError, Unauthorized])

class CreateReminder extends Rpc.make("CreateReminder", {
  payload: ReminderCreateInput,
  success: Reminder,
  error: ReminderRpcError
}) {}

class GetReminder extends Rpc.make("GetReminder", {
  payload: Schema.Struct({ id: ReminderId }),
  success: Reminder,
  error: ReminderRpcError
}) {}

class UpdateReminder extends Rpc.make("UpdateReminder", {
  payload: ReminderUpdateInput,
  success: Reminder,
  error: ReminderRpcError
}) {}

class DeleteReminder extends Rpc.make("DeleteReminder", {
  payload: ReminderMutationInput,
  success: Reminder,
  error: ReminderRpcError
}) {}

class ListReminders extends Rpc.make("ListReminders", {
  payload: ReminderListInput,
  success: Schema.Array(Reminder),
  error: ReminderRpcError
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
  ListTrashNotes,
  CreateEvent,
  GetEvent,
  UpdateEvent,
  DeleteEvent,
  ListEvents,
  ListEventOccurrences,
  EditEventOccurrence,
  DeleteEventOccurrence,
  CreateHabit,
  GetHabit,
  UpdateHabit,
  DeleteHabit,
  RestoreHabit,
  ListHabits,
  LogHabitEntry,
  ListHabitEntries,
  CreateReminder,
  GetReminder,
  UpdateReminder,
  DeleteReminder,
  ListReminders
)

/** The derived, shared client type the web app imports. */
export type ApiClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ApiRpcs>, RpcClientError>
