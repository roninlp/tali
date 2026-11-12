import { Clock, Duration, Effect, Option, Schema } from 'effect'
import { Command, Dom, Submodel, Subscription, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { Listbox } from '@foldkit/ui'
import { uuidV7 } from '@tali/domain'
import { createTaskInMirror } from '@tali/sync-client'

import { TimestampMillis } from '../lib/schema-primitives'
import {
  TaskEditPatch,
  completeTaskInMirror,
  createProjectInMirror,
  createTagInMirror,
  moveTaskInMirror,
  undoTaskInMirror,
  updateTaskInMirror,
} from '../lib/task-writes'
import { setVisibilityInMirror } from '../lib/visibility-writes'
import type { MirrorSnapshot, TaskRow } from '../mirror'
import type { DisplayFields } from '../preferences-model'
import { LocalStoreResource } from '../sync/local-store'
import type { LocalStoreService } from '../sync/local-store'
import { clockEvents } from '../ui/dom-stream'
import { listboxOutMessageFold } from '../ui/fold'
import * as Picker from '../ui/picker'
import { currentIso, localWrite, storeFailureMessage } from './local-write'
import {
  DEFAULT_TASK_VIEW,
  ProjectFilter,
  TaskBoardKey,
  TaskDateFilter,
  TaskPriority,
  TaskPriorityFilter,
  TaskSortField,
  TaskStatusFilter,
  TaskStatusOption,
  TaskViewSettings,
  boundsFor,
  validTimeZone,
} from './tasks-model'
import { tasksPageView } from './tasks-view'
import { cacheTaskViewSettings, readTaskViewSettings } from './tasks-view-cache'

/**
 * The Tasks screen Submodel, ported from
 * `apps/web/src/components/tasks/tasks-screen.tsx`.
 *
 * The Model owns the saved filter/sort view, the quick-add draft, the open
 * editors, the drag state and the completion toast. The mirror rows and
 * connectivity live in the sync Submodel and arrive as update/view inputs;
 * every write goes through the store first, then the root asks sync to re-read
 * the mirror. No command here calls RPC, which is why an offline reload cannot
 * blank the board.
 */

// MODEL

export const QuickAddPanel = Schema.Literals([
  'due',
  'priority',
  'tags',
  'project',
])

export type QuickAddPanel = typeof QuickAddPanel.Type

export const QuickAddDraft = Schema.Struct({
  title: Schema.String,
  /** Until the user picks a day, the form follows the live "today". */
  dueTouched: Schema.Boolean,
  maybeDueDate: Schema.Option(Schema.String),
  priority: TaskPriority,
  maybeProjectId: Schema.Option(Schema.String),
  tagIds: Schema.Array(Schema.String),
  maybePanel: Schema.Option(QuickAddPanel),
  newProjectTitle: Schema.String,
  newTagName: Schema.String,
  isAdding: Schema.Boolean,
  hasSaved: Schema.Boolean,
  maybeError: Schema.Option(Schema.String),
})

export type QuickAddDraft = typeof QuickAddDraft.Type

export const TaskSaveState = Schema.Literals([
  'idle',
  'saving',
  'saved',
  'error',
])

export type TaskSaveState = typeof TaskSaveState.Type

export const TaskEditor = Schema.Struct({
  taskId: Schema.String,
  title: Schema.String,
  description: Schema.String,
  dueDate: Schema.String,
  tagIds: Schema.Array(Schema.String),
  saveState: TaskSaveState,
  hasPendingSave: Schema.Boolean,
  generation: Schema.Int,
  priorityListbox: Listbox.Model,
  statusListbox: Listbox.Model,
  projectListbox: Listbox.Model,
})

export type TaskEditor = typeof TaskEditor.Type

export const TaskToast = Schema.Struct({
  generation: Schema.Int,
  taskId: Schema.String,
  title: Schema.String,
  maybeStartedAt: Schema.Option(Schema.String),
})

export type TaskToast = typeof TaskToast.Type

export type PriorityFilterOption = Readonly<{
  value: TaskPriorityFilter
  label: string
}>

export type StatusFilterOption = Readonly<{
  value: TaskStatusFilter
  label: string
}>

export type DateFilterOption = Readonly<{
  value: TaskDateFilter
  label: string
}>

export type SortFieldOption = Readonly<{
  value: TaskSortField
  label: string
}>

export type ProjectOption = Readonly<{
  value: string
  label: string
}>

export type TaskPriorityEditorOption = Readonly<{
  value: TaskPriority
  label: string
}>

export type TaskStatusEditorOption = Readonly<{
  value: TaskStatusOption
  label: string
}>

export type TaskProjectEditorOption = Readonly<{
  value: string
  label: string
}>

export const PriorityListbox = Listbox.create<
  PriorityFilterOption,
  TaskPriorityFilter
>()

export const StatusListbox = Listbox.create<
  StatusFilterOption,
  TaskStatusFilter
>()

export const DateListbox = Listbox.create<DateFilterOption, TaskDateFilter>()
export const SortListbox = Listbox.create<SortFieldOption, TaskSortField>()
export const QuickAddProjectListbox = Listbox.create<ProjectOption, string>()

export const TaskPriorityListbox = Listbox.create<
  TaskPriorityEditorOption,
  TaskPriority
>()

export const TaskStatusListbox = Listbox.create<
  TaskStatusEditorOption,
  TaskStatusOption
>()

export const TaskProjectListbox = Listbox.create<
  TaskProjectEditorOption,
  string
>()

export const CreateSource = Schema.Literals(['quickAdd', 'filters'])

export type CreateSource = typeof CreateSource.Type

export const Model = Schema.Struct({
  now: TimestampMillis,
  maybeUserId: Schema.Option(Schema.String),
  settings: TaskViewSettings,
  isFiltersOpen: Schema.Boolean,
  isHistoryOpen: Schema.Boolean,
  newProjectTitle: Schema.String,
  newTagName: Schema.String,
  quickAdd: QuickAddDraft,
  editors: Schema.Array(TaskEditor),
  maybeDraggingId: Schema.Option(Schema.String),
  maybeDragOverBoard: Schema.Option(TaskBoardKey),
  toastGeneration: Schema.Int,
  maybeToast: Schema.Option(TaskToast),
  maybeError: Schema.Option(Schema.String),
  announcement: Schema.String,
  priorityListbox: Listbox.Model,
  statusListbox: Listbox.Model,
  dateListbox: Listbox.Model,
  sortListbox: Listbox.Model,
  quickAddProjectListbox: Listbox.Model,
  picker: Picker.Model,
})

export type Model = typeof Model.Type

export type InitOptions = Readonly<{
  now: number
  maybeUserId: Option.Option<string>
  maybeSettings: Option.Option<TaskViewSettings>
}>

export const initialQuickAdd = (): QuickAddDraft =>
  QuickAddDraft.make({
    title: '',
    dueTouched: false,
    maybeDueDate: Option.none(),
    priority: 'medium',
    maybeProjectId: Option.none(),
    tagIds: [],
    maybePanel: Option.none(),
    newProjectTitle: '',
    newTagName: '',
    isAdding: false,
    hasSaved: false,
    maybeError: Option.none(),
  })

export const initialModel = (options: InitOptions): Model =>
  Model.make({
    now: options.now,
    maybeUserId: options.maybeUserId,
    settings: Option.getOrElse(options.maybeSettings, () => DEFAULT_TASK_VIEW),
    isFiltersOpen: false,
    isHistoryOpen: false,
    newProjectTitle: '',
    newTagName: '',
    quickAdd: initialQuickAdd(),
    editors: [],
    maybeDraggingId: Option.none(),
    maybeDragOverBoard: Option.none(),
    toastGeneration: 0,
    maybeToast: Option.none(),
    maybeError: Option.none(),
    announcement: '',
    priorityListbox: Listbox.init({ id: 'tasks-priority-listbox' }),
    statusListbox: Listbox.init({ id: 'tasks-status-listbox' }),
    dateListbox: Listbox.init({ id: 'tasks-date-listbox' }),
    sortListbox: Listbox.init({ id: 'tasks-sort-listbox' }),
    quickAddProjectListbox: Listbox.init({
      id: 'tasks-quick-add-project-listbox',
    }),
    picker: Picker.init({ id: 'tasks-picker' }),
  })

/** Everything the page reads from its siblings on each dispatch. */
export type Inputs = Readonly<{
  display: DisplayFields
  isStoreReady: boolean
  isOnline: boolean
  pending: number
  mirror: MirrorSnapshot
  pendingKeys: ReadonlyArray<string>
}>

export type ViewInputs = Inputs

// MESSAGE

export const Message = defineMessageUnion({
  TickedClock: { now: TimestampMillis },
  CompletedScrollToTaskAnchor: {},
  GotPickerMessage: { message: Picker.Message },

  ClickedToggleFilters: {},
  ClickedToggleHistory: {},

  SelectedProjectFilter: { project: ProjectFilter },
  SelectedPriorityFilter: { priority: TaskPriorityFilter },
  SelectedStatusFilter: { status: TaskStatusFilter },
  SelectedDateFilter: { date: TaskDateFilter },
  ToggledFilterTag: { tagId: Schema.String },
  SelectedSortField: { by: TaskSortField },
  ToggledSortDirection: {},
  ClickedClearFilters: {},
  GotPriorityListboxMessage: { message: Listbox.Message },
  GotStatusListboxMessage: { message: Listbox.Message },
  GotDateListboxMessage: { message: Listbox.Message },
  GotSortListboxMessage: { message: Listbox.Message },
  GotQuickAddProjectListboxMessage: { message: Listbox.Message },
  GotTaskPriorityListboxMessage: {
    taskId: Schema.String,
    message: Listbox.Message,
  },
  GotTaskStatusListboxMessage: {
    taskId: Schema.String,
    message: Listbox.Message,
  },
  GotTaskProjectListboxMessage: {
    taskId: Schema.String,
    message: Listbox.Message,
  },

  UpdatedNewProjectTitle: { value: Schema.String },
  UpdatedNewTagName: { value: Schema.String },
  SubmittedFilterProject: { title: Schema.String },
  SubmittedFilterTag: { name: Schema.String },
  CompletedCreateProject: {
    source: CreateSource,
    projectId: Schema.String,
    title: Schema.String,
  },
  FailedCreateProject: { source: CreateSource, message: Schema.String },
  CompletedCreateTag: {
    source: CreateSource,
    tagId: Schema.String,
    name: Schema.String,
  },
  FailedCreateTag: { source: CreateSource, message: Schema.String },

  UpdatedQuickAddTitle: { value: Schema.String },
  ClickedToggleQuickAddPanel: { panel: QuickAddPanel },
  SelectedQuickAddDuePreset: {
    maybeDueDate: Schema.Option(Schema.String),
  },
  UpdatedQuickAddDueDate: { value: Schema.String },
  SelectedQuickAddPriority: { priority: TaskPriority },
  SelectedQuickAddProject: {
    maybeProjectId: Schema.Option(Schema.String),
  },
  ToggledQuickAddTag: { tagId: Schema.String },
  UpdatedQuickAddNewProject: { value: Schema.String },
  UpdatedQuickAddNewTag: { value: Schema.String },
  SubmittedQuickAdd: {},
  SubmittedQuickAddProject: { title: Schema.String },
  SubmittedQuickAddTag: { name: Schema.String },
  CompletedCreateTask: { taskId: Schema.String, title: Schema.String },
  FailedCreateTask: { message: Schema.String },
  CompletedFocusQuickAdd: {},
  CompletedClearQuickAddSaved: {},

  ClickedTaskTitle: { taskId: Schema.String },
  UpdatedTaskTitle: { taskId: Schema.String, value: Schema.String },
  UpdatedTaskDescription: { taskId: Schema.String, value: Schema.String },
  UpdatedTaskDueDate: { taskId: Schema.String, value: Schema.String },
  SelectedTaskPriority: {
    taskId: Schema.String,
    priority: TaskPriority,
  },
  SelectedTaskStatus: {
    taskId: Schema.String,
    status: TaskStatusOption,
  },
  SelectedTaskProject: {
    taskId: Schema.String,
    maybeProjectId: Schema.Option(Schema.String),
  },
  ToggledTaskTag: { taskId: Schema.String, tagId: Schema.String },
  ClickedCloseTaskEditor: { taskId: Schema.String },
  ClickedToggleTaskVisibility: { taskId: Schema.String },
  CompletedSetTaskVisibility: {
    taskId: Schema.String,
    visibility: Schema.Literals(['private', 'shared']),
  },
  FailedSetTaskVisibility: { message: Schema.String },
  CompletedSaveTaskFields: { taskId: Schema.String, generation: Schema.Int },
  FailedSaveTaskFields: {
    taskId: Schema.String,
    generation: Schema.Int,
    message: Schema.String,
  },
  CompletedClearTaskSaveState: {
    taskId: Schema.String,
    generation: Schema.Int,
  },

  ClickedCompleteTask: {
    taskId: Schema.String,
    title: Schema.String,
    maybeStartedAt: Schema.Option(Schema.String),
  },
  CompletedCompleteTask: { taskId: Schema.String, title: Schema.String },
  FailedCompleteTask: { message: Schema.String },
  ClickedUndoToast: { generation: Schema.Int },
  ClickedRestoreCompletion: {
    taskId: Schema.String,
    title: Schema.String,
    maybeStartedAt: Schema.Option(Schema.String),
  },
  CompletedUndoTask: { taskId: Schema.String, title: Schema.String },
  FailedUndoTask: { message: Schema.String },
  CompletedDismissTaskToast: { generation: Schema.Int },

  ClickedMoveTask: {
    taskId: Schema.String,
    title: Schema.String,
    maybeDueDate: Schema.Option(Schema.String),
  },
  CompletedMoveTask: { taskId: Schema.String, title: Schema.String },
  FailedMoveTask: { message: Schema.String },

  StartedTaskDrag: { taskId: Schema.String },
  DraggedOverBoard: { board: TaskBoardKey },
  LeftBoardDropZone: {},
  DroppedOnBoard: { board: TaskBoardKey },
  EndedTaskDrag: {},

  CompletedReadCachedTaskView: {
    userId: Schema.String,
    maybeSettings: Schema.Option(TaskViewSettings),
  },
  CompletedCacheTaskView: {},
})

export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  WroteLocalData: {},
})

export type OutMessage = typeof OutMessage.Type

// COMMAND

const TASK_ANCHOR = /^#task-[\w-]+$/

export const ScrollToTaskAnchor = Command.define('ScrollToTaskAnchor', {
  messages: [Message.CompletedScrollToTaskAnchor],
  execute: Effect.gen(function* () {
    const hash = window.location.hash

    if (TASK_ANCHOR.test(hash)) {
      yield* Dom.scrollIntoViewAfterPaint(hash, { block: 'start' }).pipe(
        Effect.ignore,
      )
    }

    return Message.CompletedScrollToTaskAnchor()
  }),
})

export const FocusQuickAdd = Command.define('FocusQuickAdd', {
  messages: [Message.CompletedFocusQuickAdd],
  execute: Dom.focus('#tasks-quick-add', { preventScroll: true }).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusQuickAdd()),
  ),
})

export const CreateTask = Command.define('CreateTask', {
  args: {
    title: Schema.String,
    maybeDueDate: Schema.Option(Schema.String),
    priority: TaskPriority,
    maybeProjectId: Schema.Option(Schema.String),
    tagIds: Schema.Array(Schema.String),
    timeZone: Schema.String,
  },
  messages: [Message.CompletedCreateTask, Message.FailedCreateTask],
  execute: ({
    title,
    maybeDueDate,
    priority,
    maybeProjectId,
    tagIds,
    timeZone,
  }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* Clock.currentTimeMillis
      const instant = new Date(now).toISOString()
      const taskId = uuidV7(now)

      yield* Effect.tryPromise({
        try: () =>
          createTaskInMirror(
            store,
            {
              title,
              dueDate: Option.getOrNull(maybeDueDate),
              priority,
              projectId: Option.getOrNull(maybeProjectId),
              tagIds,
              timeZone: validTimeZone(timeZone),
            },
            taskId,
            instant,
          ),
        catch: storeFailureMessage,
      })

      return Message.CompletedCreateTask({ taskId, title })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCreateTask({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

export const CreateProject = Command.define('CreateProject', {
  args: { source: CreateSource, title: Schema.String },
  messages: [Message.CompletedCreateProject, Message.FailedCreateProject],
  execute: ({ source, title }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* Clock.currentTimeMillis
      const projectId = uuidV7(now)

      yield* Effect.tryPromise({
        try: () =>
          createProjectInMirror(store, {
            id: projectId,
            title,
            now: new Date(now).toISOString(),
          }),
        catch: storeFailureMessage,
      })

      return Message.CompletedCreateProject({
        source,
        projectId,
        title: title.trim(),
      })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCreateProject({
            source,
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const CreateTag = Command.define('CreateTag', {
  args: { source: CreateSource, name: Schema.String },
  messages: [Message.CompletedCreateTag, Message.FailedCreateTag],
  execute: ({ source, name }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* Clock.currentTimeMillis
      const tagId = uuidV7(now)

      yield* Effect.tryPromise({
        try: () =>
          createTagInMirror(store, {
            id: tagId,
            name,
            now: new Date(now).toISOString(),
          }),
        catch: storeFailureMessage,
      })

      return Message.CompletedCreateTag({ source, tagId, name: name.trim() })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCreateTag({
            source,
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const SetTaskVisibility = Command.define('SetTaskVisibility', {
  args: {
    taskId: Schema.String,
    visibility: Schema.Literals(['private', 'shared']),
  },
  messages: [
    Message.CompletedSetTaskVisibility,
    Message.FailedSetTaskVisibility,
  ],
  execute: ({ taskId, visibility }) =>
    localWrite({
      run: (store, now) =>
        setVisibilityInMirror(store, 'task', taskId, visibility, now),
      onSuccess: () =>
        Message.CompletedSetTaskVisibility({ taskId, visibility }),
      onFailure: message => Message.FailedSetTaskVisibility({ message }),
    }),
})

export const SaveTaskFields = Command.define('SaveTaskFields', {
  args: {
    taskId: Schema.String,
    patch: TaskEditPatch,
    generation: Schema.Int,
    delayMs: Schema.Int,
  },
  messages: [Message.CompletedSaveTaskFields, Message.FailedSaveTaskFields],
  execute: ({ taskId, patch, generation, delayMs }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get

      if (delayMs > 0) {
        yield* Effect.sleep(Duration.millis(delayMs))
      }

      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () => updateTaskInMirror(store, taskId, patch, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedSaveTaskFields({ taskId, generation })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSaveTaskFields({
            taskId,
            generation,
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const ClearTaskSaveState = Command.define('ClearTaskSaveState', {
  args: { taskId: Schema.String, generation: Schema.Int },
  messages: [Message.CompletedClearTaskSaveState],
  execute: ({ taskId, generation }) =>
    Effect.sleep(Duration.millis(1500)).pipe(
      Effect.as(Message.CompletedClearTaskSaveState({ taskId, generation })),
    ),
})

export const CompleteTask = Command.define('CompleteTask', {
  args: { taskId: Schema.String, title: Schema.String },
  messages: [Message.CompletedCompleteTask, Message.FailedCompleteTask],
  execute: ({ taskId, title }) =>
    localWrite({
      run: (store, now) => completeTaskInMirror(store, taskId, now),
      onSuccess: () => Message.CompletedCompleteTask({ taskId, title }),
      onFailure: message => Message.FailedCompleteTask({ message }),
    }),
})

export const UndoTask = Command.define('UndoTask', {
  args: {
    taskId: Schema.String,
    title: Schema.String,
    maybeStartedAt: Schema.Option(Schema.String),
  },
  messages: [Message.CompletedUndoTask, Message.FailedUndoTask],
  execute: ({ taskId, title, maybeStartedAt }) =>
    localWrite({
      run: (store, now) =>
        undoTaskInMirror(
          store,
          { id: taskId, startedAt: Option.getOrNull(maybeStartedAt) },
          now,
        ),
      onSuccess: () => Message.CompletedUndoTask({ taskId, title }),
      onFailure: message => Message.FailedUndoTask({ message }),
    }),
})

export const MoveTask = Command.define('MoveTask', {
  args: {
    taskId: Schema.String,
    title: Schema.String,
    maybeDueDate: Schema.Option(Schema.String),
    timeZone: Schema.String,
  },
  messages: [Message.CompletedMoveTask, Message.FailedMoveTask],
  execute: ({ taskId, title, maybeDueDate, timeZone }) =>
    localWrite({
      run: (store, now) =>
        moveTaskInMirror(
          store,
          taskId,
          Option.getOrNull(maybeDueDate),
          validTimeZone(timeZone),
          now,
        ),
      onSuccess: () => Message.CompletedMoveTask({ taskId, title }),
      onFailure: message => Message.FailedMoveTask({ message }),
    }),
})

export const ClearQuickAddSaved = Command.define('ClearQuickAddSaved', {
  messages: [Message.CompletedClearQuickAddSaved],
  execute: Effect.sleep(Duration.millis(2000)).pipe(
    Effect.as(Message.CompletedClearQuickAddSaved()),
  ),
})

export const DismissTaskToast = Command.define('DismissTaskToast', {
  args: { generation: Schema.Int },
  messages: [Message.CompletedDismissTaskToast],
  execute: ({ generation }) =>
    Effect.sleep(Duration.millis(6000)).pipe(
      Effect.as(Message.CompletedDismissTaskToast({ generation })),
    ),
})

export const ReadCachedTaskView = Command.define('ReadCachedTaskView', {
  args: { userId: Schema.String },
  messages: [Message.CompletedReadCachedTaskView],
  execute: ({ userId }) =>
    Effect.sync(() =>
      Message.CompletedReadCachedTaskView({
        userId,
        maybeSettings: readTaskViewSettings(userId),
      }),
    ),
})

export const CacheTaskView = Command.define('CacheTaskView', {
  args: { userId: Schema.String, settings: TaskViewSettings },
  messages: [Message.CompletedCacheTaskView],
  execute: ({ userId, settings }) =>
    Effect.sync(() => {
      cacheTaskViewSettings(userId, settings)

      return Message.CompletedCacheTaskView()
    }),
})

// INIT

export const init = (options: InitOptions): Update.Return<Model, Message> => ({
  model: initialModel(options),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  LocalStoreService
>

type CommandReturn = Update.Return<Model, Message, LocalStoreService>

const boundsOf = (model: Model, inputs: Inputs) =>
  boundsFor(inputs.display.timeZone, model.now)

const findTask = (inputs: Inputs, taskId: string): TaskRow | undefined =>
  inputs.mirror.tasks.find(task => task.id === taskId)

const findEditor = (model: Model, taskId: string): TaskEditor | undefined =>
  model.editors.find(editor => editor.taskId === taskId)

const updateEditor = (
  model: Model,
  taskId: string,
  update: (editor: TaskEditor) => TaskEditor,
): Model =>
  modifyFields(model, {
    editors: () =>
      model.editors.map(editor =>
        editor.taskId === taskId ? update(editor) : editor,
      ),
  })

const removeEditor = (model: Model, taskId: string): Model =>
  modifyFields(model, {
    editors: () => model.editors.filter(editor => editor.taskId !== taskId),
  })

const updateQuickAdd = (
  model: Model,
  update: (draft: QuickAddDraft) => QuickAddDraft,
): Model => modifyFields(model, { quickAdd: () => update(model.quickAdd) })

const cacheSettingsCommand = (
  model: Model,
): ReadonlyArray<Command.Command<Message>> =>
  Option.match(model.maybeUserId, {
    onNone: () => [],
    onSome: userId => [CacheTaskView({ userId, settings: model.settings })],
  })

const withSettings = (
  model: Model,
  settings: TaskViewSettings,
): UpdateReturn => {
  const next = modifyFields(model, { settings: () => settings })

  return { model: next, commands: cacheSettingsCommand(next) }
}

const withoutError = (model: Model): Model =>
  modifyFields(model, { maybeError: () => Option.none() })

const saveTaskPatch = (
  model: Model,
  taskId: string,
  patch: TaskEditPatch,
  delayMs: number,
): CommandReturn => {
  const editor = findEditor(model, taskId)

  if (editor === undefined) {
    return { model }
  }

  const generation = editor.generation + 1

  const next = updateEditor(withoutError(model), taskId, current =>
    modifyFields(current, {
      generation: () => generation,
      saveState: () => 'saving' as const,
      hasPendingSave: () => true,
    }),
  )

  return {
    model: next,
    commands: [SaveTaskFields({ taskId, patch, generation, delayMs })],
  }
}

const isCurrentEditorSave = (
  editor: TaskEditor | undefined,
  taskId: string,
  generation: number,
): boolean =>
  editor !== undefined &&
  editor.taskId === taskId &&
  editor.generation === generation

const invalidateEditorSave = (model: Model, taskId: string): Model =>
  updateEditor(model, taskId, current =>
    modifyFields(current, {
      generation: () => current.generation + 1,
      saveState: () => 'idle' as const,
      hasPendingSave: () => false,
    }),
  )

/** The quick-add due day: the live today until the user picks one. */
export const quickAddDue = (
  model: Model,
  inputs: Inputs,
): Option.Option<string> =>
  model.quickAdd.dueTouched
    ? model.quickAdd.maybeDueDate
    : Option.some(boundsOf(model, inputs).today)

const completeTask = (
  model: Model,
  inputs: Inputs,
  taskId: string,
  title: string,
  maybeStartedAt: Option.Option<string>,
): UpdateReturn => {
  const generation = model.toastGeneration + 1

  return {
    model: modifyFields(removeEditor(withoutError(model), taskId), {
      toastGeneration: () => generation,
      maybeToast: () =>
        Option.some(
          TaskToast.make({
            generation,
            taskId,
            title,
            maybeStartedAt,
          }),
        ),
    }),
    commands: [CompleteTask({ taskId, title })],
  }
}

const undoTask = (
  model: Model,
  taskId: string,
  title: string,
  maybeStartedAt: Option.Option<string>,
): UpdateReturn => ({
  model: modifyFields(withoutError(model), {
    maybeToast: () => Option.none(),
  }),
  commands: [UndoTask({ taskId, title, maybeStartedAt })],
})

const moveTask = (
  model: Model,
  inputs: Inputs,
  taskId: string,
  title: string,
  maybeDueDate: Option.Option<string>,
): UpdateReturn => ({
  model: modifyFields(withoutError(model), {
    maybeDraggingId: () => Option.none(),
    maybeDragOverBoard: () => Option.none(),
  }),
  commands: [
    MoveTask({
      taskId,
      title,
      maybeDueDate,
      timeZone: inputs.display.timeZone,
    }),
  ],
})

const boardDueDate = (
  board: TaskBoardKey,
  model: Model,
  inputs: Inputs,
): Option.Option<string> => {
  const bounds = boundsOf(model, inputs)

  if (board === 'inbox') {
    return Option.none()
  }

  return Option.some(board === 'upcoming' ? bounds.tomorrow : bounds.today)
}

const foldPriorityListboxOutMessage = (inputs: Inputs) =>
  listboxOutMessageFold<
    Model,
    Message,
    OutMessage,
    LocalStoreService,
    TaskPriorityFilter
  >({
    handleUpdate: (model, message) => update(model, message, inputs),
    toMessage: (_model, value) =>
      Message.SelectedPriorityFilter({ priority: value }),
  })

const foldStatusListboxOutMessage = (inputs: Inputs) =>
  listboxOutMessageFold<
    Model,
    Message,
    OutMessage,
    LocalStoreService,
    TaskStatusFilter
  >({
    handleUpdate: (model, message) => update(model, message, inputs),
    toMessage: (_model, value) =>
      Message.SelectedStatusFilter({ status: value }),
  })

const foldDateListboxOutMessage = (inputs: Inputs) =>
  listboxOutMessageFold<
    Model,
    Message,
    OutMessage,
    LocalStoreService,
    TaskDateFilter
  >({
    handleUpdate: (model, message) => update(model, message, inputs),
    toMessage: (_model, value) => Message.SelectedDateFilter({ date: value }),
  })

const foldSortListboxOutMessage = (inputs: Inputs) =>
  listboxOutMessageFold<
    Model,
    Message,
    OutMessage,
    LocalStoreService,
    TaskSortField
  >({
    handleUpdate: (model, message) => update(model, message, inputs),
    toMessage: (_model, value) => Message.SelectedSortField({ by: value }),
  })

const foldQuickAddProjectListboxOutMessage = (inputs: Inputs) =>
  listboxOutMessageFold<Model, Message, OutMessage, LocalStoreService>({
    handleUpdate: (model, message) => update(model, message, inputs),
    toMessage: (_model, value) =>
      Message.SelectedQuickAddProject({
        maybeProjectId: value === '' ? Option.none() : Option.some(value),
      }),
  })

const foldTaskPriorityListboxOutMessage = (taskId: string, inputs: Inputs) =>
  listboxOutMessageFold<
    Model,
    Message,
    OutMessage,
    LocalStoreService,
    TaskPriority
  >({
    handleUpdate: (model, message) => update(model, message, inputs),
    toMessage: (_model, value) =>
      Message.SelectedTaskPriority({ taskId, priority: value }),
  })

const foldTaskStatusListboxOutMessage = (taskId: string, inputs: Inputs) =>
  listboxOutMessageFold<
    Model,
    Message,
    OutMessage,
    LocalStoreService,
    TaskStatusOption
  >({
    handleUpdate: (model, message) => update(model, message, inputs),
    toMessage: (_model, value) =>
      Message.SelectedTaskStatus({ taskId, status: value }),
  })

const foldTaskProjectListboxOutMessage = (taskId: string, inputs: Inputs) =>
  listboxOutMessageFold<Model, Message, OutMessage, LocalStoreService>({
    handleUpdate: (model, message) => update(model, message, inputs),
    toMessage: (_model, value) =>
      Message.SelectedTaskProject({
        taskId,
        maybeProjectId: value === '' ? Option.none() : Option.some(value),
      }),
  })

const dropOnBoard = (
  model: Model,
  inputs: Inputs,
  board: TaskBoardKey,
): UpdateReturn => {
  const taskId = Option.getOrNull(model.maybeDraggingId)
  const task = taskId === null ? undefined : findTask(inputs, taskId)

  if (task === undefined) {
    return {
      model: modifyFields(model, {
        maybeDraggingId: () => Option.none(),
        maybeDragOverBoard: () => Option.none(),
      }),
    }
  }

  return moveTask(
    model,
    inputs,
    task.id,
    task.title,
    boardDueDate(board, model, inputs),
  )
}

/** Attach the editor from a task row without clobbering an open draft. */
export const taskEditorFor = (task: TaskRow): TaskEditor =>
  TaskEditor.make({
    taskId: task.id,
    title: task.title,
    description: task.description ?? '',
    dueDate: task.dueDate ?? '',
    tagIds: [...task.tagIds],
    saveState: 'idle',
    hasPendingSave: false,
    generation: 0,
    priorityListbox: Listbox.init({
      id: `task-${task.id}-priority-listbox`,
    }),
    statusListbox: Listbox.init({ id: `task-${task.id}-status-listbox` }),
    projectListbox: Listbox.init({ id: `task-${task.id}-project-listbox` }),
  })

const toggleEditor = (model: Model, taskId: string, inputs: Inputs): Model => {
  if (findEditor(model, taskId) !== undefined) {
    return removeEditor(model, taskId)
  }

  const task = findTask(inputs, taskId)

  return task === undefined
    ? model
    : modifyFields(model, {
        editors: () => [...model.editors, taskEditorFor(task)],
      })
}

const setQuickAddDueDate = (model: Model, value: string): Model =>
  updateQuickAdd(model, draft =>
    modifyFields(draft, {
      dueTouched: () => true,
      maybeDueDate: () => (value === '' ? Option.none() : Option.some(value)),
      hasSaved: () => false,
    }),
  )

const setEditorDueDate = (model: Model, taskId: string, value: string): Model =>
  modifyFields(model, {
    editors: () =>
      model.editors.map(editor =>
        editor.taskId === taskId
          ? modifyFields(editor, { dueDate: () => value })
          : editor,
      ),
  })

const applyPickerValue = (
  model: Model,
  target: string,
  value: string,
): Model => {
  if (target === 'quickAdd:due') {
    return setQuickAddDueDate(model, value)
  }

  if (target.startsWith('task:') && target.endsWith(':due')) {
    const taskId = target.slice('task:'.length, -':due'.length)

    return setEditorDueDate(model, taskId, value)
  }

  return model
}

const foldPicker = Picker.pickerFieldFold<Model, Message>({
  field: model => model.picker,
  setField: (model, nextPicker) =>
    modifyFields(model, { picker: () => nextPicker }),
  toParentMessage: message => Message.GotPickerMessage({ message }),
  applyValue: applyPickerValue,
})

export const update = (
  model: Model,
  message: Message,
  inputs: Inputs,
): UpdateReturn => {
  const foldPriorityListbox = Update.foldChild({
    update: PriorityListbox.update,
    read: (model: Model) => Option.some(model.priorityListbox),
    write: (model, nextListbox) =>
      modifyFields(model, { priorityListbox: () => nextListbox }),
    toParentMessage: message => Message.GotPriorityListboxMessage({ message }),
    foldOutMessage: foldPriorityListboxOutMessage(inputs),
  })

  const foldStatusListbox = Update.foldChild({
    update: StatusListbox.update,
    read: (model: Model) => Option.some(model.statusListbox),
    write: (model, nextListbox) =>
      modifyFields(model, { statusListbox: () => nextListbox }),
    toParentMessage: message => Message.GotStatusListboxMessage({ message }),
    foldOutMessage: foldStatusListboxOutMessage(inputs),
  })

  const foldDateListbox = Update.foldChild({
    update: DateListbox.update,
    read: (model: Model) => Option.some(model.dateListbox),
    write: (model, nextListbox) =>
      modifyFields(model, { dateListbox: () => nextListbox }),
    toParentMessage: message => Message.GotDateListboxMessage({ message }),
    foldOutMessage: foldDateListboxOutMessage(inputs),
  })

  const foldSortListbox = Update.foldChild({
    update: SortListbox.update,
    read: (model: Model) => Option.some(model.sortListbox),
    write: (model, nextListbox) =>
      modifyFields(model, { sortListbox: () => nextListbox }),
    toParentMessage: message => Message.GotSortListboxMessage({ message }),
    foldOutMessage: foldSortListboxOutMessage(inputs),
  })

  const foldQuickAddProjectListbox = Update.foldChild({
    update: QuickAddProjectListbox.update,
    read: (model: Model) => Option.some(model.quickAddProjectListbox),
    write: (model: Model, nextListbox: Listbox.Model) =>
      modifyFields(model, { quickAddProjectListbox: () => nextListbox }),
    toParentMessage: message =>
      Message.GotQuickAddProjectListboxMessage({ message }),
    foldOutMessage: foldQuickAddProjectListboxOutMessage(inputs),
  })

  const foldTaskPriorityListbox = Update.foldChildAt({
    update: TaskPriorityListbox.update,
    readAt: (model: Model, taskId: string) => {
      const editor = findEditor(model, taskId)

      return editor === undefined
        ? Option.none()
        : Option.some(editor.priorityListbox)
    },
    writeAt: (model, taskId, nextListbox) =>
      updateEditor(model, taskId, editor =>
        modifyFields(editor, { priorityListbox: () => nextListbox }),
      ),
    toParentMessage: (taskId, message) =>
      Message.GotTaskPriorityListboxMessage({ taskId, message }),
    foldOutMessage: taskId => foldTaskPriorityListboxOutMessage(taskId, inputs),
  })

  const foldTaskStatusListbox = Update.foldChildAt({
    update: TaskStatusListbox.update,
    readAt: (model: Model, taskId: string) => {
      const editor = findEditor(model, taskId)

      return editor === undefined
        ? Option.none()
        : Option.some(editor.statusListbox)
    },
    writeAt: (model, taskId, nextListbox) =>
      updateEditor(model, taskId, editor =>
        modifyFields(editor, { statusListbox: () => nextListbox }),
      ),
    toParentMessage: (taskId, message) =>
      Message.GotTaskStatusListboxMessage({ taskId, message }),
    foldOutMessage: taskId => foldTaskStatusListboxOutMessage(taskId, inputs),
  })

  const foldTaskProjectListbox = Update.foldChildAt({
    update: TaskProjectListbox.update,
    readAt: (model: Model, taskId: string) => {
      const editor = findEditor(model, taskId)

      return editor === undefined
        ? Option.none()
        : Option.some(editor.projectListbox)
    },
    writeAt: (model, taskId, nextListbox) =>
      updateEditor(model, taskId, editor =>
        modifyFields(editor, { projectListbox: () => nextListbox }),
      ),
    toParentMessage: (taskId, message) =>
      Message.GotTaskProjectListboxMessage({ taskId, message }),
    foldOutMessage: taskId => foldTaskProjectListboxOutMessage(taskId, inputs),
  })

  return Message.match<UpdateReturn>(message, {
    GotPickerMessage: ({ message: pickerMessage }) =>
      foldPicker(model, pickerMessage),

    TickedClock: ({ now }) => ({
      model: modifyFields(model, { now: () => now }),
    }),

    CompletedScrollToTaskAnchor: () => ({ model }),

    ClickedToggleFilters: () => ({
      model: modifyFields(model, { isFiltersOpen: () => !model.isFiltersOpen }),
    }),

    ClickedToggleHistory: () => ({
      model: modifyFields(model, {
        isHistoryOpen: () => !model.isHistoryOpen,
      }),
    }),

    SelectedProjectFilter: ({ project }) =>
      withSettings(model, {
        filters: modifyFields(model.settings.filters, {
          project: () => project,
        }),
        sort: model.settings.sort,
      }),

    SelectedPriorityFilter: ({ priority }) =>
      withSettings(model, {
        filters: modifyFields(model.settings.filters, {
          priority: () => priority,
        }),
        sort: model.settings.sort,
      }),

    SelectedStatusFilter: ({ status }) =>
      withSettings(model, {
        filters: modifyFields(model.settings.filters, { status: () => status }),
        sort: model.settings.sort,
      }),

    SelectedDateFilter: ({ date }) =>
      withSettings(model, {
        filters: modifyFields(model.settings.filters, { date: () => date }),
        sort: model.settings.sort,
      }),

    ToggledFilterTag: ({ tagId }) =>
      withSettings(model, {
        filters: modifyFields(model.settings.filters, {
          tagIds: () =>
            model.settings.filters.tagIds.includes(tagId)
              ? model.settings.filters.tagIds.filter(id => id !== tagId)
              : [...model.settings.filters.tagIds, tagId],
        }),
        sort: model.settings.sort,
      }),

    SelectedSortField: ({ by }) =>
      withSettings(model, {
        filters: model.settings.filters,
        sort: modifyFields(model.settings.sort, { by: () => by }),
      }),

    ToggledSortDirection: () =>
      withSettings(model, {
        filters: model.settings.filters,
        sort: modifyFields(model.settings.sort, {
          direction: () =>
            model.settings.sort.direction === 'asc' ? 'desc' : 'asc',
        }),
      }),

    ClickedClearFilters: () =>
      withSettings(
        model,
        modifyFields(model.settings, {
          filters: () => DEFAULT_TASK_VIEW.filters,
        }),
      ),

    UpdatedNewProjectTitle: ({ value }) => ({
      model: modifyFields(model, { newProjectTitle: () => value }),
    }),

    UpdatedNewTagName: ({ value }) => ({
      model: modifyFields(model, { newTagName: () => value }),
    }),

    SubmittedFilterProject: ({ title }) => {
      const trimmed = title.trim()

      if (!inputs.isStoreReady || trimmed === '') {
        return { model }
      }

      return {
        model: withoutError(model),
        commands: [CreateProject({ source: 'filters', title: trimmed })],
      }
    },

    SubmittedFilterTag: ({ name }) => {
      const trimmed = name.trim()

      if (!inputs.isStoreReady || trimmed === '') {
        return { model }
      }

      return {
        model: withoutError(model),
        commands: [CreateTag({ source: 'filters', name: trimmed })],
      }
    },

    CompletedCreateProject: ({ source, projectId, title }) => {
      const next =
        source === 'quickAdd'
          ? updateQuickAdd(model, draft =>
              modifyFields(draft, {
                newProjectTitle: () => '',
                maybeProjectId: () => Option.some(projectId),
                hasSaved: () => false,
              }),
            )
          : modifyFields(model, { newProjectTitle: () => '' })

      return {
        model: modifyFields(next, {
          announcement: () => `پروژه ساخته شد: ${title}`,
        }),
        outMessage: OutMessage.WroteLocalData(),
      }
    },

    FailedCreateProject: ({ message }) => ({
      model: modifyFields(model, {
        maybeError: () => Option.some(message),
      }),
    }),

    CompletedCreateTag: ({ source, tagId, name }) => {
      const next =
        source === 'quickAdd'
          ? updateQuickAdd(model, draft =>
              modifyFields(draft, {
                newTagName: () => '',
                tagIds: () =>
                  draft.tagIds.includes(tagId)
                    ? draft.tagIds
                    : [...draft.tagIds, tagId],
                hasSaved: () => false,
              }),
            )
          : modifyFields(model, { newTagName: () => '' })

      return {
        model: modifyFields(next, {
          announcement: () => `برچسب ساخته شد: ${name}`,
        }),
        outMessage: OutMessage.WroteLocalData(),
      }
    },

    FailedCreateTag: ({ message }) => ({
      model: modifyFields(model, {
        maybeError: () => Option.some(message),
      }),
    }),

    UpdatedQuickAddTitle: ({ value }) => ({
      model: updateQuickAdd(model, draft =>
        modifyFields(draft, {
          title: () => value,
          hasSaved: () => false,
          maybeError: () => Option.none(),
        }),
      ),
    }),

    ClickedToggleQuickAddPanel: ({ panel }) => ({
      model: updateQuickAdd(model, draft =>
        modifyFields(draft, {
          maybePanel: () =>
            Option.contains(draft.maybePanel, panel)
              ? Option.none()
              : Option.some(panel),
          hasSaved: () => false,
        }),
      ),
    }),

    SelectedQuickAddDuePreset: ({ maybeDueDate }) => ({
      model: updateQuickAdd(model, draft =>
        modifyFields(draft, {
          dueTouched: () => true,
          maybeDueDate: () => maybeDueDate,
          hasSaved: () => false,
        }),
      ),
    }),

    UpdatedQuickAddDueDate: ({ value }) => ({
      model: updateQuickAdd(model, draft =>
        modifyFields(draft, {
          dueTouched: () => true,
          maybeDueDate: () =>
            value === '' ? Option.none() : Option.some(value),
          hasSaved: () => false,
        }),
      ),
    }),

    SelectedQuickAddPriority: ({ priority }) => ({
      model: updateQuickAdd(model, draft =>
        modifyFields(draft, {
          priority: () => priority,
          hasSaved: () => false,
        }),
      ),
    }),

    SelectedQuickAddProject: ({ maybeProjectId }) => ({
      model: updateQuickAdd(model, draft =>
        modifyFields(draft, {
          maybeProjectId: () => maybeProjectId,
          hasSaved: () => false,
        }),
      ),
    }),

    ToggledQuickAddTag: ({ tagId }) => ({
      model: updateQuickAdd(model, draft =>
        modifyFields(draft, {
          tagIds: () =>
            draft.tagIds.includes(tagId)
              ? draft.tagIds.filter(id => id !== tagId)
              : [...draft.tagIds, tagId],
          hasSaved: () => false,
        }),
      ),
    }),

    UpdatedQuickAddNewProject: ({ value }) => ({
      model: updateQuickAdd(model, draft =>
        modifyFields(draft, { newProjectTitle: () => value }),
      ),
    }),

    UpdatedQuickAddNewTag: ({ value }) => ({
      model: updateQuickAdd(model, draft =>
        modifyFields(draft, { newTagName: () => value }),
      ),
    }),

    SubmittedQuickAdd: () => {
      const title = model.quickAdd.title.trim()

      if (!inputs.isStoreReady || title === '' || model.quickAdd.isAdding) {
        return { model }
      }

      return {
        model: updateQuickAdd(withoutError(model), draft =>
          modifyFields(draft, {
            isAdding: () => true,
            hasSaved: () => false,
            maybeError: () => Option.none(),
          }),
        ),
        commands: [
          CreateTask({
            title,
            maybeDueDate: quickAddDue(model, inputs),
            priority: model.quickAdd.priority,
            maybeProjectId: model.quickAdd.maybeProjectId,
            tagIds: model.quickAdd.tagIds,
            timeZone: inputs.display.timeZone,
          }),
        ],
      }
    },

    SubmittedQuickAddProject: ({ title }) => {
      const trimmed = title.trim()

      if (!inputs.isStoreReady || trimmed === '') {
        return { model }
      }

      return {
        model: withoutError(model),
        commands: [CreateProject({ source: 'quickAdd', title: trimmed })],
      }
    },

    SubmittedQuickAddTag: ({ name }) => {
      const trimmed = name.trim()

      if (!inputs.isStoreReady || trimmed === '') {
        return { model }
      }

      return {
        model: withoutError(model),
        commands: [CreateTag({ source: 'quickAdd', name: trimmed })],
      }
    },

    CompletedCreateTask: ({ title }) => ({
      model: modifyFields(
        updateQuickAdd(model, draft =>
          modifyFields(draft, {
            title: () => '',
            isAdding: () => false,
            hasSaved: () => true,
            maybeError: () => Option.none(),
          }),
        ),
        { announcement: () => `کار تازه: ${title}` },
      ),
      commands: [FocusQuickAdd(), ClearQuickAddSaved()],
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedCreateTask: ({ message }) => ({
      model: updateQuickAdd(model, draft =>
        modifyFields(draft, {
          isAdding: () => false,
          hasSaved: () => false,
          maybeError: () => Option.some(message),
        }),
      ),
    }),

    CompletedFocusQuickAdd: () => ({ model }),

    CompletedClearQuickAddSaved: () => ({
      model: updateQuickAdd(model, draft =>
        modifyFields(draft, { hasSaved: () => false }),
      ),
    }),

    ClickedTaskTitle: ({ taskId }) => ({
      model: toggleEditor(model, taskId, inputs),
    }),

    UpdatedTaskTitle: ({ taskId, value }) => {
      const editor = findEditor(model, taskId)

      if (editor === undefined) {
        return { model }
      }

      const task = findTask(inputs, taskId)

      const next = updateEditor(model, taskId, current =>
        modifyFields(current, { title: () => value }),
      )

      if (value.trim() !== '' && value !== task?.title) {
        return saveTaskPatch(next, taskId, { title: value }, 450)
      }

      if (editor.hasPendingSave && task !== undefined) {
        const corrected = updateEditor(next, taskId, current =>
          modifyFields(current, { title: () => task.title }),
        )

        return saveTaskPatch(corrected, taskId, { title: task.title }, 0)
      }

      return { model: invalidateEditorSave(next, taskId) }
    },

    UpdatedTaskDescription: ({ taskId, value }) => {
      const editor = findEditor(model, taskId)

      if (editor === undefined) {
        return { model }
      }

      const task = findTask(inputs, taskId)
      const unchanged = value === (task?.description ?? '')

      const next = updateEditor(model, taskId, current =>
        modifyFields(current, { description: () => value }),
      )

      if (!unchanged) {
        return saveTaskPatch(
          next,
          taskId,
          { description: value === '' ? null : value },
          450,
        )
      }

      if (editor.hasPendingSave && task !== undefined) {
        const original = task.description ?? ''

        const corrected = updateEditor(next, taskId, current =>
          modifyFields(current, { description: () => original }),
        )

        return saveTaskPatch(
          corrected,
          taskId,
          { description: original === '' ? null : original },
          0,
        )
      }

      return { model: invalidateEditorSave(next, taskId) }
    },

    UpdatedTaskDueDate: ({ taskId, value }) => {
      if (findEditor(model, taskId) === undefined) {
        return { model }
      }

      const next = updateEditor(model, taskId, editor =>
        modifyFields(editor, { dueDate: () => value }),
      )

      return saveTaskPatch(
        next,
        taskId,
        { dueDate: value === '' ? null : value },
        0,
      )
    },

    SelectedTaskPriority: ({ taskId, priority }) => {
      if (findEditor(model, taskId) === undefined) {
        return { model }
      }

      return saveTaskPatch(model, taskId, { priority }, 0)
    },

    SelectedTaskStatus: ({ taskId, status }) => {
      if (findEditor(model, taskId) === undefined) {
        return { model }
      }

      return saveTaskPatch(model, taskId, { status }, 0)
    },

    SelectedTaskProject: ({ taskId, maybeProjectId }) => {
      if (findEditor(model, taskId) === undefined) {
        return { model }
      }

      return saveTaskPatch(
        model,
        taskId,
        { projectId: Option.getOrNull(maybeProjectId) },
        0,
      )
    },

    ToggledTaskTag: ({ taskId, tagId }) => {
      const editor = findEditor(model, taskId)

      if (editor === undefined) {
        return { model }
      }

      const tagIds = editor.tagIds.includes(tagId)
        ? editor.tagIds.filter(id => id !== tagId)
        : [...editor.tagIds, tagId]

      const next = updateEditor(model, taskId, current =>
        modifyFields(current, { tagIds: () => tagIds }),
      )

      return saveTaskPatch(next, taskId, { tagIds }, 0)
    },

    ClickedCloseTaskEditor: ({ taskId }) => ({
      model: removeEditor(model, taskId),
    }),

    ClickedToggleTaskVisibility: ({ taskId }) => {
      const task = findTask(inputs, taskId)

      if (
        task === undefined ||
        !Option.exists(model.maybeUserId, userId => userId === task.ownerId)
      ) {
        return { model }
      }

      return {
        model: withoutError(model),
        commands: [
          SetTaskVisibility({
            taskId,
            visibility: task.visibility === 'shared' ? 'private' : 'shared',
          }),
        ],
      }
    },

    CompletedSetTaskVisibility: ({ visibility }) => ({
      model: modifyFields(model, {
        announcement: () =>
          visibility === 'shared'
            ? 'کار با خانه به اشتراک گذاشته شد'
            : 'کار خصوصی شد',
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedSetTaskVisibility: ({ message }) => ({
      model: modifyFields(model, {
        maybeError: () => Option.some(message),
      }),
    }),

    CompletedSaveTaskFields: ({ taskId, generation }) => {
      const editor = findEditor(model, taskId)
      const isCurrent = isCurrentEditorSave(editor, taskId, generation)

      const next = isCurrent
        ? updateEditor(
            modifyFields(model, { maybeError: () => Option.none() }),
            taskId,
            current =>
              modifyFields(current, {
                saveState: () => 'saved' as const,
                hasPendingSave: () => false,
              }),
          )
        : modifyFields(model, { maybeError: () => Option.none() })

      if (!isCurrent) {
        return { model: next, outMessage: OutMessage.WroteLocalData() }
      }

      return {
        model: next,
        commands: [ClearTaskSaveState({ taskId, generation })],
        outMessage: OutMessage.WroteLocalData(),
      }
    },

    FailedSaveTaskFields: ({ taskId, generation }) => {
      const editor = findEditor(model, taskId)

      return isCurrentEditorSave(editor, taskId, generation)
        ? {
            model: updateEditor(model, taskId, current =>
              modifyFields(current, {
                saveState: () => 'error' as const,
                hasPendingSave: () => false,
              }),
            ),
          }
        : { model }
    },

    CompletedClearTaskSaveState: ({ taskId, generation }) => {
      const editor = findEditor(model, taskId)

      return editor !== undefined &&
        isCurrentEditorSave(editor, taskId, generation) &&
        editor.saveState === 'saved'
        ? {
            model: updateEditor(model, taskId, current =>
              modifyFields(current, { saveState: () => 'idle' as const }),
            ),
          }
        : { model }
    },

    ClickedCompleteTask: ({ taskId, title, maybeStartedAt }) =>
      completeTask(model, inputs, taskId, title, maybeStartedAt),

    CompletedCompleteTask: ({ title }) => ({
      model: modifyFields(model, {
        maybeError: () => Option.none(),
        announcement: () => `انجام شد: ${title}`,
      }),
      commands: [DismissTaskToast({ generation: model.toastGeneration })],
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedCompleteTask: ({ message }) => ({
      model: modifyFields(model, {
        maybeToast: () => Option.none(),
        maybeError: () => Option.some(message),
      }),
    }),

    ClickedUndoToast: ({ generation }) =>
      Option.match(model.maybeToast, {
        onNone: () => ({ model }),
        onSome: toast =>
          toast.generation === generation
            ? {
                model: modifyFields(model, { maybeToast: () => Option.none() }),
                commands: [
                  UndoTask({
                    taskId: toast.taskId,
                    title: toast.title,
                    maybeStartedAt: toast.maybeStartedAt,
                  }),
                ],
              }
            : { model },
      }),

    ClickedRestoreCompletion: ({ taskId, title, maybeStartedAt }) =>
      undoTask(model, taskId, title, maybeStartedAt),

    CompletedUndoTask: ({ title }) => ({
      model: modifyFields(model, {
        maybeError: () => Option.none(),
        maybeToast: () => Option.none(),
        announcement: () => `بازگردانده شد: ${title}`,
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedUndoTask: ({ message }) => ({
      model: modifyFields(model, { maybeError: () => Option.some(message) }),
    }),

    CompletedDismissTaskToast: ({ generation }) =>
      Option.exists(model.maybeToast, toast => toast.generation === generation)
        ? { model: modifyFields(model, { maybeToast: () => Option.none() }) }
        : { model },

    ClickedMoveTask: ({ taskId, title, maybeDueDate }) =>
      moveTask(model, inputs, taskId, title, maybeDueDate),

    CompletedMoveTask: ({ title }) => ({
      model: modifyFields(model, {
        maybeError: () => Option.none(),
        announcement: () => `جابه‌جا شد: ${title}`,
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedMoveTask: ({ message }) => ({
      model: modifyFields(model, { maybeError: () => Option.some(message) }),
    }),

    StartedTaskDrag: ({ taskId }) => ({
      model: modifyFields(model, {
        maybeDraggingId: () => Option.some(taskId),
      }),
    }),

    DraggedOverBoard: ({ board }) => ({
      model: modifyFields(model, {
        maybeDragOverBoard: () => Option.some(board),
      }),
    }),

    LeftBoardDropZone: () => ({
      model: modifyFields(model, { maybeDragOverBoard: () => Option.none() }),
    }),

    DroppedOnBoard: ({ board }) => dropOnBoard(model, inputs, board),

    EndedTaskDrag: () => ({
      model: modifyFields(model, {
        maybeDraggingId: () => Option.none(),
        maybeDragOverBoard: () => Option.none(),
      }),
    }),

    CompletedReadCachedTaskView: ({ userId, maybeSettings }) =>
      Option.contains(model.maybeUserId, userId)
        ? {
            model: modifyFields(model, {
              settings: () =>
                Option.getOrElse(maybeSettings, () => DEFAULT_TASK_VIEW),
            }),
          }
        : { model },

    CompletedCacheTaskView: () => ({ model }),

    GotPriorityListboxMessage: ({ message }) =>
      foldPriorityListbox(model, message),

    GotStatusListboxMessage: ({ message }) => foldStatusListbox(model, message),

    GotDateListboxMessage: ({ message }) => foldDateListbox(model, message),

    GotSortListboxMessage: ({ message }) => foldSortListbox(model, message),

    GotQuickAddProjectListboxMessage: ({ message }) =>
      foldQuickAddProjectListbox(model, message),

    GotTaskPriorityListboxMessage: ({ taskId, message }) =>
      foldTaskPriorityListbox(model, taskId, message),

    GotTaskStatusListboxMessage: ({ taskId, message }) =>
      foldTaskStatusListbox(model, taskId, message),

    GotTaskProjectListboxMessage: ({ taskId, message }) =>
      foldTaskProjectListbox(model, taskId, message),
  })
}

// CAPABILITIES

/** Entry capability the root folds instead of constructing a child Message. */
export const entered = (model: Model): CommandReturn => ({
  model: modifyFields(model, {
    isFiltersOpen: () => false,
    quickAdd: () => initialQuickAdd(),
    editors: () => [],
    maybeDraggingId: () => Option.none(),
    maybeDragOverBoard: () => Option.none(),
    maybeToast: () => Option.none(),
    maybeError: () => Option.none(),
    priorityListbox: () => Listbox.init({ id: 'tasks-priority-listbox' }),
    statusListbox: () => Listbox.init({ id: 'tasks-status-listbox' }),
    dateListbox: () => Listbox.init({ id: 'tasks-date-listbox' }),
    sortListbox: () => Listbox.init({ id: 'tasks-sort-listbox' }),
    quickAddProjectListbox: () =>
      Listbox.init({ id: 'tasks-quick-add-project-listbox' }),
  }),
  commands: [ScrollToTaskAnchor()],
})

/** Adopt the signed-in account's saved board view (or drop it on sign-out). */
export const applySession = (
  model: Model,
  maybeUserId: Option.Option<string>,
): Update.Return<Model, Message> => {
  if (Option.getOrNull(model.maybeUserId) === Option.getOrNull(maybeUserId)) {
    return { model }
  }

  return Option.match(maybeUserId, {
    onNone: () => ({
      model: initialModel({
        now: model.now,
        maybeUserId: Option.none(),
        maybeSettings: Option.none(),
      }),
    }),
    onSome: userId => ({
      model: modifyFields(model, {
        maybeUserId: () => Option.some(userId),
        settings: () => DEFAULT_TASK_VIEW,
        editors: () => [],
        maybeToast: () => Option.none(),
      }),
      commands: [ReadCachedTaskView({ userId })],
    }),
  })
}

// SUBSCRIPTION

const clockSubscription = Subscription.persistentEntry(
  clockEvents(now => Message.TickedClock({ now })),
)

export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  tasksClock: clockSubscription,
}))

// VIEW

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => tasksPageView(model, inputs, h),
)
