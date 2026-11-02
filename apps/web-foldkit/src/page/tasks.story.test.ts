import { Option } from 'effect'
import {
  Command,
  expectNoOutMessage,
  expectOutMessage,
  given,
  message,
  model,
  story,
} from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import { taskKey } from '../mirror'
import { TODAY_NOW, USER_ID } from '../test-fixtures'
import * as Tasks from './tasks'
import type { Inputs } from './tasks'
import {
  DEFAULT_TASK_FILTERS,
  DEFAULT_TASK_SORT,
  ProjectFilter,
  TaskFilters,
  TaskSort,
  TaskViewSettings,
} from './tasks-model'
import {
  baseModel,
  defaultInputs,
  inboxTask,
  laterTask,
  projectId,
  tagId,
  tasks,
  todayTask,
  withEditor,
} from './tasks-test-fixtures'

const inputWith = (overrides: Partial<Inputs> = {}) => defaultInputs(overrides)

const update = (today: Tasks.Model, message: Tasks.Message) =>
  Tasks.update(today, message, inputWith())

const settingsFor = (
  filters: Partial<typeof DEFAULT_TASK_FILTERS> = {},
  sort: Partial<typeof DEFAULT_TASK_SORT> = {},
): TaskViewSettings =>
  TaskViewSettings.make({
    filters: TaskFilters.make({ ...DEFAULT_TASK_FILTERS, ...filters }),
    sort: TaskSort.make({ ...DEFAULT_TASK_SORT, ...sort }),
  })

const withToast = (model: Tasks.Model, task = laterTask): Tasks.Model =>
  modifyFields(model, {
    toastGeneration: () => 1,
    maybeToast: () =>
      Option.some(
        Tasks.TaskToast.make({
          generation: 1,
          taskId: task.id,
          title: task.title,
          maybeStartedAt: Option.fromNullishOr(task.startedAt),
        }),
      ),
  })

describe('Tasks quick add', () => {
  test('an empty draft never creates a task', () => {
    story(
      update,
      given(baseModel()),
      message(Tasks.Message.UpdatedQuickAddTitle({ value: '   ' })),
      message(Tasks.Message.SubmittedQuickAdd()),
      expectNoOutMessage(),
      Command.expectNone(),
    )
  })

  test('submitting dates the task today and carries the chosen chips', () => {
    story(
      update,
      given(baseModel()),
      message(Tasks.Message.UpdatedQuickAddTitle({ value: '  خرید شیر  ' })),
      message(Tasks.Message.SelectedQuickAddPriority({ priority: 'high' })),
      message(
        Tasks.Message.SelectedQuickAddProject({
          maybeProjectId: Option.some(projectId),
        }),
      ),
      message(Tasks.Message.ToggledQuickAddTag({ tagId })),
      message(Tasks.Message.SubmittedQuickAdd()),
      Command.expectExact(
        Tasks.CreateTask({
          title: 'خرید شیر',
          maybeDueDate: Option.some('2026-10-30'),
          priority: 'high',
          maybeProjectId: Option.some(projectId),
          tagIds: [tagId],
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Tasks.CreateTask,
        Tasks.Message.CompletedCreateTask({
          taskId: todayTask.id,
          title: 'خرید شیر',
        }),
      ),
      model(next => {
        expect(next.quickAdd.title).toBe('')
        expect(next.quickAdd.isAdding).toBe(false)
        expect(next.quickAdd.hasSaved).toBe(true)
        expect(next.announcement).toBe('کار تازه: خرید شیر')
      }),
      expectOutMessage(Tasks.OutMessage.WroteLocalData()),
      Command.resolve(
        Tasks.FocusQuickAdd,
        Tasks.Message.CompletedFocusQuickAdd(),
      ),
      Command.resolve(
        Tasks.ClearQuickAddSaved,
        Tasks.Message.CompletedClearQuickAddSaved(),
      ),
    )
  })

  test('the saved line clears after the legacy two-second window', () => {
    story(
      update,
      given(
        modifyFields(baseModel(), {
          quickAdd: () =>
            modifyFields(baseModel().quickAdd, {
              title: () => 'نان',
              hasSaved: () => true,
            }),
        }),
      ),
      message(Tasks.Message.CompletedClearQuickAddSaved()),
      model(next => {
        expect(next.quickAdd.hasSaved).toBe(false)
      }),
    )
  })

  test('an explicit no-date preset survives the submit', () => {
    story(
      update,
      given(baseModel()),
      message(Tasks.Message.UpdatedQuickAddTitle({ value: 'نان' })),
      message(
        Tasks.Message.SelectedQuickAddDuePreset({
          maybeDueDate: Option.none(),
        }),
      ),
      message(Tasks.Message.SubmittedQuickAdd()),
      Command.expectExact(
        Tasks.CreateTask({
          title: 'نان',
          maybeDueDate: Option.none(),
          priority: 'medium',
          maybeProjectId: Option.none(),
          tagIds: [],
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Tasks.CreateTask,
        Tasks.Message.CompletedCreateTask({
          taskId: todayTask.id,
          title: 'نان',
        }),
      ),
      expectOutMessage(Tasks.OutMessage.WroteLocalData()),
      Command.resolve(
        Tasks.FocusQuickAdd,
        Tasks.Message.CompletedFocusQuickAdd(),
      ),
      Command.resolve(
        Tasks.ClearQuickAddSaved,
        Tasks.Message.CompletedClearQuickAddSaved(),
      ),
    )
  })

  test('the form waits for the local store', () => {
    story(
      (today: Tasks.Model, message: Tasks.Message) =>
        Tasks.update(today, message, inputWith({ isStoreReady: false })),
      given(baseModel()),
      message(Tasks.Message.UpdatedQuickAddTitle({ value: 'نان' })),
      message(Tasks.Message.SubmittedQuickAdd()),
      Command.expectNone(),
    )
  })

  test('creating a project from quick add selects it', () => {
    story(
      update,
      given(baseModel()),
      message(Tasks.Message.SubmittedQuickAddProject({ title: 'خانه' })),
      Command.expectExact(
        Tasks.CreateProject({ source: 'quickAdd', title: 'خانه' }),
      ),
      Command.resolve(
        Tasks.CreateProject,
        Tasks.Message.CompletedCreateProject({
          source: 'quickAdd',
          projectId,
          title: 'خانه',
        }),
      ),
      model(next => {
        expect(next.quickAdd.maybeProjectId).toStrictEqual(
          Option.some(projectId),
        )
        expect(next.announcement).toBe('پروژه ساخته شد: خانه')
      }),
      expectOutMessage(Tasks.OutMessage.WroteLocalData()),
    )
  })

  test('creating a tag from quick add adds it to the draft', () => {
    story(
      update,
      given(baseModel()),
      message(Tasks.Message.SubmittedQuickAddTag({ name: 'فوری' })),
      Command.expectExact(
        Tasks.CreateTag({ source: 'quickAdd', name: 'فوری' }),
      ),
      Command.resolve(
        Tasks.CreateTag,
        Tasks.Message.CompletedCreateTag({
          source: 'quickAdd',
          tagId,
          name: 'فوری',
        }),
      ),
      model(next => {
        expect(next.quickAdd.tagIds).toStrictEqual([tagId])
      }),
      expectOutMessage(Tasks.OutMessage.WroteLocalData()),
    )
  })

  test('creating from the filter panel does not touch the quick add', () => {
    story(
      update,
      given(baseModel()),
      message(Tasks.Message.SubmittedFilterTag({ name: 'فوری' })),
      Command.expectExact(Tasks.CreateTag({ source: 'filters', name: 'فوری' })),
      Command.resolve(
        Tasks.CreateTag,
        Tasks.Message.CompletedCreateTag({
          source: 'filters',
          tagId,
          name: 'فوری',
        }),
      ),
      model(next => {
        expect(next.quickAdd.tagIds).toStrictEqual([])
        expect(next.newTagName).toBe('')
      }),
      expectOutMessage(Tasks.OutMessage.WroteLocalData()),
    )
  })
})

describe('Tasks filter view', () => {
  test('a filter change persists the whole view for this account', () => {
    story(
      update,
      given(baseModel()),
      message(Tasks.Message.SelectedPriorityFilter({ priority: 'high' })),
      model(next => {
        expect(next.settings.filters.priority).toBe('high')
      }),
      Command.expectExact(
        Tasks.CacheTaskView({
          userId: USER_ID,
          settings: settingsFor({ priority: 'high' }),
        }),
      ),
      Command.resolve(
        Tasks.CacheTaskView,
        Tasks.Message.CompletedCacheTaskView(),
      ),
      expectNoOutMessage(),
    )
  })

  test('a signed-out model has no cache key and emits no command', () => {
    story(
      (today: Tasks.Model, message: Tasks.Message) =>
        Tasks.update(today, message, inputWith()),
      given(modifyFields(baseModel(), { maybeUserId: () => Option.none() })),
      message(
        Tasks.Message.SelectedProjectFilter({ project: ProjectFilter.None() }),
      ),
      Command.expectNone(),
    )
  })

  test('clearing filters restores the default view', () => {
    story(
      update,
      given(
        modifyFields(baseModel(), {
          settings: () =>
            settingsFor({ priority: 'high', date: 'today', tagIds: [tagId] }),
        }),
      ),
      message(Tasks.Message.ClickedClearFilters()),
      model(next => {
        expect(next.settings.filters).toStrictEqual(DEFAULT_TASK_FILTERS)
      }),
      Command.expectExact(
        Tasks.CacheTaskView({
          userId: USER_ID,
          settings: settingsFor(),
        }),
      ),
      Command.resolve(
        Tasks.CacheTaskView,
        Tasks.Message.CompletedCacheTaskView(),
      ),
    )
  })

  test('the sort field and direction are stored', () => {
    story(
      update,
      given(baseModel()),
      message(Tasks.Message.SelectedSortField({ by: 'title' })),
      Command.expectExact(
        Tasks.CacheTaskView({
          userId: USER_ID,
          settings: settingsFor({}, { by: 'title' }),
        }),
      ),
      Command.resolve(
        Tasks.CacheTaskView,
        Tasks.Message.CompletedCacheTaskView(),
      ),
      message(Tasks.Message.ToggledSortDirection()),
      model(next => {
        expect(next.settings.sort).toStrictEqual(
          TaskSort.make({ by: 'title', direction: 'desc' }),
        )
      }),
      Command.expectExact(
        Tasks.CacheTaskView({
          userId: USER_ID,
          settings: settingsFor({}, { by: 'title', direction: 'desc' }),
        }),
      ),
      Command.resolve(
        Tasks.CacheTaskView,
        Tasks.Message.CompletedCacheTaskView(),
      ),
    )
  })

  test('a different account reloads its saved view', () => {
    const next = Tasks.applySession(
      baseModel(),
      Option.some('0192f0a0-0000-7000-8000-000000000099'),
    )
    const command = next.commands?.[0]

    expect(command?.name).toBe('ReadCachedTaskView')
  })
})

describe('Tasks inline editing', () => {
  test('a title keystroke debounces one patch and reports saving then saved', () => {
    story(
      update,
      given(withEditor(baseModel())),
      message(
        Tasks.Message.UpdatedTaskTitle({
          taskId: todayTask.id,
          value: 'نان سنگک',
        }),
      ),
      model(next => {
        const editor = next.editors[0]
        expect(editor?.saveState).toBe('saving')
        expect(editor?.generation).toBe(1)
      }),
      Command.expectExact(
        Tasks.SaveTaskFields({
          taskId: todayTask.id,
          patch: { title: 'نان سنگک' },
          generation: 1,
          delayMs: 450,
        }),
      ),
      Command.resolve(
        Tasks.SaveTaskFields,
        Tasks.Message.CompletedSaveTaskFields({
          taskId: todayTask.id,
          generation: 1,
        }),
      ),
      model(next => {
        expect(next.editors[0]?.saveState).toBe('saved')
      }),
      expectOutMessage(Tasks.OutMessage.WroteLocalData()),
      Command.resolve(
        Tasks.ClearTaskSaveState,
        Tasks.Message.CompletedClearTaskSaveState({
          taskId: todayTask.id,
          generation: 1,
        }),
      ),
      model(next => {
        expect(next.editors[0]?.saveState).toBe('idle')
      }),
    )
  })

  test('a stale save completion cannot mark newer text saved', () => {
    story(
      update,
      given(
        modifyFields(withEditor(baseModel()), {
          editors: () => [
            {
              ...Tasks.taskEditorFor(todayTask),
              title: 'نان سنگک تازه',
              tagIds: [],
              saveState: 'saving',
              hasPendingSave: true,
              generation: 2,
            },
          ],
        }),
      ),
      message(
        Tasks.Message.CompletedSaveTaskFields({
          taskId: todayTask.id,
          generation: 1,
        }),
      ),
      model(next => {
        expect(next.editors[0]?.generation).toBe(2)
        expect(next.editors[0]?.saveState).toBe('saving')
      }),
      expectOutMessage(Tasks.OutMessage.WroteLocalData()),
    )
  })

  test('a blank title is never written and resets the indicator', () => {
    story(
      update,
      given(withEditor(baseModel())),
      message(
        Tasks.Message.UpdatedTaskTitle({
          taskId: todayTask.id,
          value: '   ',
        }),
      ),
      Command.expectNone(),
      model(next => {
        expect(next.editors[0]?.saveState).toBe('idle')
      }),
    )
  })

  test('reverting a pending title writes the original back', () => {
    story(
      update,
      given(
        modifyFields(withEditor(baseModel()), {
          editors: () => [
            {
              ...Tasks.taskEditorFor(todayTask),
              title: 'نان سنگک',
              tagIds: [],
              saveState: 'saving',
              hasPendingSave: true,
              generation: 1,
            },
          ],
        }),
      ),
      message(
        Tasks.Message.UpdatedTaskTitle({
          taskId: todayTask.id,
          value: todayTask.title,
        }),
      ),
      Command.expectExact(
        Tasks.SaveTaskFields({
          taskId: todayTask.id,
          patch: { title: todayTask.title },
          generation: 2,
          delayMs: 0,
        }),
      ),
      Command.resolve(
        Tasks.SaveTaskFields,
        Tasks.Message.FailedSaveTaskFields({
          taskId: todayTask.id,
          generation: 2,
          message: 'ذخیره نشد',
        }),
      ),
    )
  })

  test('clearing the description writes null', () => {
    const described = { ...todayTask, description: 'سنگک' }
    const describedInputs = inputWith({
      mirror: { ...defaultInputs().mirror, tasks: [described] },
    })

    story(
      (today: Tasks.Model, message: Tasks.Message) =>
        Tasks.update(today, message, describedInputs),
      given(withEditor(baseModel(), described)),
      message(
        Tasks.Message.UpdatedTaskDescription({
          taskId: todayTask.id,
          value: '',
        }),
      ),
      Command.expectExact(
        Tasks.SaveTaskFields({
          taskId: todayTask.id,
          patch: { description: null },
          generation: 1,
          delayMs: 450,
        }),
      ),
      Command.resolve(
        Tasks.SaveTaskFields,
        Tasks.Message.FailedSaveTaskFields({
          taskId: todayTask.id,
          generation: 1,
          message: 'ذخیره نشد',
        }),
      ),
    )
  })

  test('a due date, priority and status patch immediately', () => {
    story(
      update,
      given(withEditor(baseModel())),
      message(
        Tasks.Message.UpdatedTaskDueDate({
          taskId: todayTask.id,
          value: '2026-11-01',
        }),
      ),
      Command.expectExact(
        Tasks.SaveTaskFields({
          taskId: todayTask.id,
          patch: { dueDate: '2026-11-01' },
          generation: 1,
          delayMs: 0,
        }),
      ),
      Command.resolve(
        Tasks.SaveTaskFields,
        Tasks.Message.CompletedSaveTaskFields({
          taskId: todayTask.id,
          generation: 1,
        }),
      ),
      Command.resolve(
        Tasks.ClearTaskSaveState,
        Tasks.Message.CompletedClearTaskSaveState({
          taskId: todayTask.id,
          generation: 1,
        }),
      ),
      message(
        Tasks.Message.SelectedTaskPriority({
          taskId: todayTask.id,
          priority: 'high',
        }),
      ),
      Command.expectExact(
        Tasks.SaveTaskFields({
          taskId: todayTask.id,
          patch: { priority: 'high' },
          generation: 2,
          delayMs: 0,
        }),
      ),
      Command.resolve(
        Tasks.SaveTaskFields,
        Tasks.Message.CompletedSaveTaskFields({
          taskId: todayTask.id,
          generation: 2,
        }),
      ),
      Command.resolve(
        Tasks.ClearTaskSaveState,
        Tasks.Message.CompletedClearTaskSaveState({
          taskId: todayTask.id,
          generation: 2,
        }),
      ),
      message(
        Tasks.Message.SelectedTaskStatus({
          taskId: todayTask.id,
          status: 'doing',
        }),
      ),
      Command.expectExact(
        Tasks.SaveTaskFields({
          taskId: todayTask.id,
          patch: { status: 'doing' },
          generation: 3,
          delayMs: 0,
        }),
      ),
      Command.resolve(
        Tasks.SaveTaskFields,
        Tasks.Message.CompletedSaveTaskFields({
          taskId: todayTask.id,
          generation: 3,
        }),
      ),
      Command.resolve(
        Tasks.ClearTaskSaveState,
        Tasks.Message.CompletedClearTaskSaveState({
          taskId: todayTask.id,
          generation: 3,
        }),
      ),
    )
  })

  test('project and tag edits patch the row fields', () => {
    story(
      update,
      given(withEditor(baseModel())),
      message(
        Tasks.Message.SelectedTaskProject({
          taskId: todayTask.id,
          maybeProjectId: Option.some(projectId),
        }),
      ),
      Command.expectExact(
        Tasks.SaveTaskFields({
          taskId: todayTask.id,
          patch: { projectId },
          generation: 1,
          delayMs: 0,
        }),
      ),
      Command.resolve(
        Tasks.SaveTaskFields,
        Tasks.Message.CompletedSaveTaskFields({
          taskId: todayTask.id,
          generation: 1,
        }),
      ),
      Command.resolve(
        Tasks.ClearTaskSaveState,
        Tasks.Message.CompletedClearTaskSaveState({
          taskId: todayTask.id,
          generation: 1,
        }),
      ),
      message(Tasks.Message.ToggledTaskTag({ taskId: todayTask.id, tagId })),
      Command.expectExact(
        Tasks.SaveTaskFields({
          taskId: todayTask.id,
          patch: { tagIds: [tagId] },
          generation: 2,
          delayMs: 0,
        }),
      ),
      Command.resolve(
        Tasks.SaveTaskFields,
        Tasks.Message.CompletedSaveTaskFields({
          taskId: todayTask.id,
          generation: 2,
        }),
      ),
      Command.resolve(
        Tasks.ClearTaskSaveState,
        Tasks.Message.CompletedClearTaskSaveState({
          taskId: todayTask.id,
          generation: 2,
        }),
      ),
    )
  })

  test('a failed save shows the retry copy on the card', () => {
    story(
      update,
      given(withEditor(baseModel())),
      message(
        Tasks.Message.UpdatedTaskTitle({
          taskId: todayTask.id,
          value: 'نان سنگک',
        }),
      ),
      Command.resolve(
        Tasks.SaveTaskFields,
        Tasks.Message.FailedSaveTaskFields({
          taskId: todayTask.id,
          generation: 1,
          message: 'ذخیره نشد',
        }),
      ),
      model(next => {
        expect(next.editors[0]?.saveState).toBe('error')
      }),
    )
  })

  test('opening a card seeds its draft from the mirror row', () => {
    story(
      update,
      given(baseModel()),
      message(Tasks.Message.ClickedTaskTitle({ taskId: laterTask.id })),
      model(next => {
        expect(next.editors[0]).toStrictEqual(Tasks.taskEditorFor(laterTask))
      }),
      message(Tasks.Message.ClickedCloseTaskEditor({ taskId: laterTask.id })),
      model(next => {
        expect(next.editors).toStrictEqual([])
      }),
    )
  })
})

describe('Tasks completion', () => {
  test('completing opens the undo toast and writes locally', () => {
    story(
      update,
      given(baseModel()),
      message(
        Tasks.Message.ClickedCompleteTask({
          taskId: todayTask.id,
          title: todayTask.title,
          maybeStartedAt: Option.none(),
        }),
      ),
      model(next => {
        expect(next.maybeToast._tag).toBe('Some')
      }),
      Command.expectExact(
        Tasks.CompleteTask({ taskId: todayTask.id, title: todayTask.title }),
      ),
      Command.resolve(
        Tasks.CompleteTask,
        Tasks.Message.CompletedCompleteTask({
          taskId: todayTask.id,
          title: todayTask.title,
        }),
      ),
      model(next => {
        expect(next.announcement).toBe(`انجام شد: ${todayTask.title}`)
      }),
      expectOutMessage(Tasks.OutMessage.WroteLocalData()),
      Command.resolve(
        Tasks.DismissTaskToast,
        Tasks.Message.CompletedDismissTaskToast({ generation: 1 }),
      ),
      model(next => {
        expect(next.maybeToast).toStrictEqual(Option.none())
      }),
    )
  })

  test('undo from the toast restores the prior status', () => {
    story(
      update,
      given(withToast(baseModel())),
      message(Tasks.Message.ClickedUndoToast({ generation: 1 })),
      Command.expectExact(
        Tasks.UndoTask({
          taskId: laterTask.id,
          title: laterTask.title,
          maybeStartedAt: Option.some(laterTask.startedAt ?? ''),
        }),
      ),
      Command.resolve(
        Tasks.UndoTask,
        Tasks.Message.CompletedUndoTask({
          taskId: laterTask.id,
          title: laterTask.title,
        }),
      ),
      model(next => {
        expect(next.maybeToast).toStrictEqual(Option.none())
        expect(next.announcement).toBe(`بازگردانده شد: ${laterTask.title}`)
      }),
      expectOutMessage(Tasks.OutMessage.WroteLocalData()),
    )
  })

  test('restoring from the seven-day history writes the same undo', () => {
    story(
      update,
      given(baseModel()),
      message(
        Tasks.Message.ClickedRestoreCompletion({
          taskId: laterTask.id,
          title: laterTask.title,
          maybeStartedAt: Option.some(laterTask.startedAt ?? ''),
        }),
      ),
      Command.expectExact(
        Tasks.UndoTask({
          taskId: laterTask.id,
          title: laterTask.title,
          maybeStartedAt: Option.some(laterTask.startedAt ?? ''),
        }),
      ),
      Command.resolve(
        Tasks.UndoTask,
        Tasks.Message.CompletedUndoTask({
          taskId: laterTask.id,
          title: laterTask.title,
        }),
      ),
      expectOutMessage(Tasks.OutMessage.WroteLocalData()),
    )
  })

  test('a stale dismiss timer leaves a newer toast alone', () => {
    story(
      update,
      given(withToast(baseModel(), todayTask)),
      message(Tasks.Message.CompletedDismissTaskToast({ generation: 99 })),
      model(next => {
        expect(next.maybeToast._tag).toBe('Some')
      }),
    )
  })
})

describe('Tasks moves', () => {
  test('a move command carries the target day and the household zone', () => {
    story(
      update,
      given(baseModel()),
      message(
        Tasks.Message.ClickedMoveTask({
          taskId: todayTask.id,
          title: todayTask.title,
          maybeDueDate: Option.some('2026-10-31'),
        }),
      ),
      Command.expectExact(
        Tasks.MoveTask({
          taskId: todayTask.id,
          title: todayTask.title,
          maybeDueDate: Option.some('2026-10-31'),
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Tasks.MoveTask,
        Tasks.Message.CompletedMoveTask({
          taskId: todayTask.id,
          title: todayTask.title,
        }),
      ),
      expectOutMessage(Tasks.OutMessage.WroteLocalData()),
    )
  })

  test('dropping on upcoming and inbox maps to tomorrow and no date', () => {
    story(
      update,
      given(baseModel()),
      message(Tasks.Message.StartedTaskDrag({ taskId: inboxTask.id })),
      message(Tasks.Message.DraggedOverBoard({ board: 'upcoming' })),
      message(Tasks.Message.DroppedOnBoard({ board: 'upcoming' })),
      model(next => {
        expect(next.maybeDraggingId).toStrictEqual(Option.none())
        expect(next.maybeDragOverBoard).toStrictEqual(Option.none())
      }),
      Command.expectExact(
        Tasks.MoveTask({
          taskId: inboxTask.id,
          title: inboxTask.title,
          maybeDueDate: Option.some('2026-10-31'),
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Tasks.MoveTask,
        Tasks.Message.CompletedMoveTask({
          taskId: inboxTask.id,
          title: inboxTask.title,
        }),
      ),
      message(Tasks.Message.StartedTaskDrag({ taskId: todayTask.id })),
      message(Tasks.Message.DroppedOnBoard({ board: 'inbox' })),
      Command.expectExact(
        Tasks.MoveTask({
          taskId: todayTask.id,
          title: todayTask.title,
          maybeDueDate: Option.none(),
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Tasks.MoveTask,
        Tasks.Message.CompletedMoveTask({
          taskId: todayTask.id,
          title: todayTask.title,
        }),
      ),
    )
  })
})

describe('Tasks clock and entry', () => {
  test('the minute tick refreshes the board day', () => {
    story(
      update,
      given(baseModel()),
      message(Tasks.Message.TickedClock({ now: TODAY_NOW + 60_000 })),
      model(next => {
        expect(next.now).toBe(TODAY_NOW + 60_000)
      }),
    )
  })

  test('the entry capability scrolls to a task anchor', () => {
    const result = Tasks.entered(baseModel())

    expect(result.commands?.[0]?.name).toBe('ScrollToTaskAnchor')
  })

  test('the store snapshot feeds the pending badge keys', () => {
    expect(taskKey(todayTask.id)).toBe(`task\u0000${todayTask.id}`)
    expect(tasks).toContain(todayTask)
  })
})

describe('task visibility', () => {
  const ownerTask = {
    ...todayTask,
    ownerId: USER_ID,
    visibility: 'private' as const,
  }
  const ownerInputs = inputWith({
    mirror: { ...defaultInputs().mirror, tasks: [ownerTask] },
  })
  const ownerUpdate = (tasks: Tasks.Model, message: Tasks.Message) =>
    Tasks.update(tasks, message, ownerInputs)

  test('the owner shares a private task', () => {
    story(
      ownerUpdate,
      given(withEditor(baseModel(), ownerTask)),
      message(
        Tasks.Message.ClickedToggleTaskVisibility({ taskId: ownerTask.id }),
      ),
      Command.expectExact(
        Tasks.SetTaskVisibility({
          taskId: ownerTask.id,
          visibility: 'shared',
        }),
      ),
      Command.resolve(
        Tasks.SetTaskVisibility,
        Tasks.Message.CompletedSetTaskVisibility({
          taskId: ownerTask.id,
          visibility: 'shared',
        }),
      ),
      expectOutMessage(Tasks.OutMessage.WroteLocalData()),
      model(next => {
        expect(next.announcement).toBe('کار با خانه به اشتراک گذاشته شد')
      }),
    )
  })

  test('a non-owner gets no share command', () => {
    const nonOwner = Tasks.initialModel({
      now: TODAY_NOW,
      maybeUserId: Option.some('another-user'),
      maybeSettings: Option.none(),
    })

    story(
      ownerUpdate,
      given(withEditor(nonOwner, ownerTask)),
      message(
        Tasks.Message.ClickedToggleTaskVisibility({ taskId: ownerTask.id }),
      ),
      Command.expectNone(),
    )
  })
})
