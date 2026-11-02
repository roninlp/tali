import { Clock, Duration, Effect, Option, Schema, Stream } from 'effect'
import { Command, Dom, Submodel, Subscription, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { uuidV7 } from '@tali/domain'
import { createTaskInMirror } from '@tali/sync-client'

import {
  TaskEditPatch,
  completeTaskInMirror,
  createProjectInMirror,
  createTagInMirror,
  moveTaskInMirror,
  undoTaskInMirror,
  updateTaskInMirror,
} from '../lib/task-writes'
import type { MirrorSnapshot, TaskRow } from '../mirror'
import type { DisplayFields } from '../preferences-model'
import { LocalStoreResource } from '../sync/local-store'
import type { LocalStoreService } from '../sync/local-store'
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
})
export type TaskEditor = typeof TaskEditor.Type

export const TaskToast = Schema.Struct({
  generation: Schema.Int,
  taskId: Schema.String,
  title: Schema.String,
  maybeStartedAt: Schema.Option(Schema.String),
})
export type TaskToast = typeof TaskToast.Type

export const CreateSource = Schema.Literals(['quickAdd', 'filters'])
export type CreateSource = typeof CreateSource.Type

export const Model = Schema.Struct({
  now: Schema.Number,
  maybeUserId: Schema.Option(Schema.String),
  settings: TaskViewSettings,
  isFiltersOpen: Schema.Boolean,
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
  TickedClock: { now: Schema.Number },
  CompletedScrollToTaskAnchor: {},

  ClickedToggleFilters: {},

  SelectedProjectFilter: { project: ProjectFilter },
  SelectedPriorityFilter: { priority: TaskPriorityFilter },
  SelectedStatusFilter: { status: TaskStatusFilter },
  SelectedDateFilter: { date: TaskDateFilter },
  ToggledFilterTag: { tagId: Schema.String },
  SelectedSortField: { by: TaskSortField },
  ToggledSortDirection: {},
  ClickedClearFilters: {},

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

const storeFailureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'ذخیره در حافظه‌ی محلی ناموفق بود'

const currentIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

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
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () => completeTaskInMirror(store, taskId, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedCompleteTask({ taskId, title })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCompleteTask({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

export const UndoTask = Command.define('UndoTask', {
  args: {
    taskId: Schema.String,
    title: Schema.String,
    maybeStartedAt: Schema.Option(Schema.String),
  },
  messages: [Message.CompletedUndoTask, Message.FailedUndoTask],
  execute: ({ taskId, title, maybeStartedAt }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () =>
          undoTaskInMirror(
            store,
            { id: taskId, startedAt: Option.getOrNull(maybeStartedAt) },
            now,
          ),
        catch: storeFailureMessage,
      })

      return Message.CompletedUndoTask({ taskId, title })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedUndoTask({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
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
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () =>
          moveTaskInMirror(
            store,
            taskId,
            Option.getOrNull(maybeDueDate),
            validTimeZone(timeZone),
            now,
          ),
        catch: storeFailureMessage,
      })

      return Message.CompletedMoveTask({ taskId, title })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedMoveTask({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
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
const editorFor = (task: TaskRow): TaskEditor =>
  TaskEditor.make({
    taskId: task.id,
    title: task.title,
    description: task.description ?? '',
    dueDate: task.dueDate ?? '',
    tagIds: [...task.tagIds],
    saveState: 'idle',
    hasPendingSave: false,
    generation: 0,
  })

const toggleEditor = (model: Model, taskId: string, inputs: Inputs): Model => {
  if (findEditor(model, taskId) !== undefined) {
    return removeEditor(model, taskId)
  }

  const task = findTask(inputs, taskId)

  return task === undefined
    ? model
    : modifyFields(model, {
        editors: () => [...model.editors, editorFor(task)],
      })
}

export const update = (
  model: Model,
  message: Message,
  inputs: Inputs,
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    TickedClock: ({ now }) => ({
      model: modifyFields(model, { now: () => now }),
    }),

    CompletedScrollToTaskAnchor: () => ({ model }),

    ClickedToggleFilters: () => ({
      model: modifyFields(model, { isFiltersOpen: () => !model.isFiltersOpen }),
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

      return {
        model: next,
        ...(isCurrent
          ? { commands: [ClearTaskSaveState({ taskId, generation })] }
          : {}),
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
  })

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

const clockTick = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis

  return Message.TickedClock({ now })
})

const clockEvents = Subscription.persistentEntry(
  Stream.concat(
    Stream.fromEffect(clockTick),
    Stream.fromEffectRepeat(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.seconds(60))
        return yield* clockTick
      }),
    ),
  ),
)

export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  tasksClock: clockEvents,
}))

// VIEW

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => tasksPageView(model, inputs, h),
)
