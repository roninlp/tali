import { Option } from 'effect'
import {
  Command,
  click,
  expect,
  given,
  label,
  role,
  scene,
  text,
  type,
  withViewInputs,
  within,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import { emptyMirrorSnapshot, taskKey } from '../mirror'
import type { Inputs } from './tasks'
import * as Tasks from './tasks'
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
  doneTask,
  inboxTask,
  laterTask,
  overdueTask,
  tag,
  tagId,
  todayTask,
  tomorrowTask,
} from './tasks-test-fixtures'

const sceneWith = (model: Tasks.Model, overrides: Partial<Inputs> = {}) => {
  const viewInputs = defaultInputs(overrides)

  return {
    update: (today: Tasks.Model, message: Tasks.Message) =>
      Tasks.update(today, message, viewInputs),
    view: withViewInputs(Tasks.view, viewInputs)(),
  }
}

const settings = (
  filters: Partial<typeof DEFAULT_TASK_FILTERS> = {},
  sort: Partial<typeof DEFAULT_TASK_SORT> = {},
): TaskViewSettings =>
  TaskViewSettings.make({
    filters: TaskFilters.make({ ...DEFAULT_TASK_FILTERS, ...filters }),
    sort: TaskSort.make({ ...DEFAULT_TASK_SORT, ...sort }),
  })

describe('Tasks screen', () => {
  test('renders the three boards from the mirror with counts and chips', () => {
    scene(
      sceneWith(baseModel(), { pendingKeys: [taskKey(overdueTask.id)] }),
      given(baseModel()),
      expect(role('heading', { name: 'کارها' })).toExist(),
      expect(role('region', { name: 'امروز' })).toExist(),
      expect(role('region', { name: 'پیش‌رو' })).toExist(),
      expect(role('region', { name: 'بدون تاریخ' })).toExist(),
      expect(text(overdueTask.title)).toExist(),
      expect(text(todayTask.title)).toExist(),
      expect(text(tomorrowTask.title)).toExist(),
      expect(text(laterTask.title)).toExist(),
      expect(text(inboxTask.title)).toExist(),
      expect(text('در صف')).toExist(),
      expect(text('از قبل مانده')).toExist(),
      expect(text('اولویت: بالا')).toExist(),
      expect(text('در حال انجام')).toExist(),
      expect(text('خانه')).toExist(),
      expect(text(tag.name)).toExist(),
    )
  })

  test('a sync-rejected row says so without losing the card', () => {
    const rejected = { ...todayTask, hasSyncError: true }

    scene(
      sceneWith(baseModel(), {
        mirror: { ...emptyMirrorSnapshot(), tasks: [rejected] },
      }),
      given(baseModel()),
      expect(text(todayTask.title)).toExist(),
      expect(text('خطای همگام‌سازی')).toExist(),
    )
  })

  test('empty boards, history and the quick-add all offer their copy', () => {
    scene(
      sceneWith(baseModel(), { mirror: emptyMirrorSnapshot() }),
      given(baseModel()),
      expect(text('امروز خالی است — یک کار تازه اضافه کنید.')).toExist(),
      expect(text('برای روزهای آینده کاری برنامه‌ریزی نشده است.')).toExist(),
      expect(text('صندوق ورودی خالی است.')).toExist(),
      expect(text('هنوز کاری در این هفته انجام نشده است.')).toExist(),
      expect(text(/هر تغییر اول روی همین دستگاه ذخیره می‌شود/)).toExist(),
    )
  })

  test('an offline device keeps the board and says what still works', () => {
    scene(
      sceneWith(baseModel(), { isOnline: false, pending: 2 }),
      given(baseModel()),
      expect(text(todayTask.title)).toExist(),
      expect(text(/آفلاین هستید/)).toExist(),
      expect(text('۲ تغییر در صف همگام‌سازی است.')).toExist(),
    )
  })

  test('the store opening state replaces the boards with a spinner', () => {
    scene(
      sceneWith(baseModel(), { isStoreReady: false }),
      given(baseModel()),
      expect(text(/در حال آماده‌سازی حافظه‌ی محلی/)).toExist(),
      expect(role('region', { name: 'امروز' })).toBeAbsent(),
      expect(label('عنوان کار تازه')).toBeDisabled(),
    )
  })

  test('quick-add submits and clears, then reports the local save', () => {
    scene(
      sceneWith(baseModel()),
      given(baseModel()),
      type(label('عنوان کار تازه'), 'خرید شیر'),
      click(role('button', { name: 'افزودن' })),
      Command.expectExact(
        Tasks.CreateTask({
          title: 'خرید شیر',
          maybeDueDate: Option.some('2026-10-30'),
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
          title: 'خرید شیر',
        }),
      ),
      Command.resolve(
        Tasks.FocusQuickAdd,
        Tasks.Message.CompletedFocusQuickAdd(),
      ),
      expect(label('عنوان کار تازه')).toHaveValue(''),
      expect(text('ذخیره شد؛ در صف همگام‌سازی.')).toExist(),
      expect(text('کار تازه: خرید شیر')).toExist(),
      Command.resolve(
        Tasks.ClearQuickAddSaved,
        Tasks.Message.CompletedClearQuickAddSaved(),
      ),
    )
  })

  test('quick-add due and priority chips change the created task', () => {
    scene(
      sceneWith(baseModel()),
      given(baseModel()),
      click(role('button', { name: 'موعد: امروز' })),
      click(
        within(
          role('group', { name: 'موعد' }),
          role('button', { name: 'فردا' }),
        ),
      ),
      expect(role('button', { name: 'موعد: امروز' })).toBeAbsent(),
      expect(
        within(
          role('group', { name: 'موعد' }),
          role('button', { name: 'فردا' }),
        ),
      ).toHaveAttr('aria-pressed', 'true'),
      click(role('button', { name: 'اولویت: متوسط' })),
      click(
        within(
          role('group', { name: 'اولویت' }),
          role('button', { name: 'بالا' }),
        ),
      ),
      expect(role('button', { name: 'اولویت: بالا' })).toExist(),
      type(label('عنوان کار تازه'), 'نان'),
      click(role('button', { name: 'افزودن' })),
      Command.expectExact(
        Tasks.CreateTask({
          title: 'نان',
          maybeDueDate: Option.some('2026-10-31'),
          priority: 'high',
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

  test('the filter panel narrows the board and the clear action restores it', () => {
    scene(
      sceneWith(baseModel()),
      given(baseModel()),
      expect(text(todayTask.title)).toExist(),
      click(role('button', { name: 'فیلترها و پروژه‌ها' })),
      expect(role('button', { name: 'فیلترها و پروژه‌ها' })).toHaveAttr(
        'aria-expanded',
        'true',
      ),
      click(role('button', { name: tag.name })),
      Command.expectExact(
        Tasks.CacheTaskView({
          userId: '0192f0a0-0000-7000-8000-000000000001',
          settings: settings({ tagIds: [tagId] }),
        }),
      ),
      Command.resolve(
        Tasks.CacheTaskView,
        Tasks.Message.CompletedCacheTaskView(),
      ),
      expect(role('button', { name: tag.name })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      expect(text(todayTask.title)).toBeAbsent(),
      expect(text(overdueTask.title)).toExist(),
      click(role('button', { name: 'پاک کردن فیلترها (۱)' })),
      Command.resolve(
        Tasks.CacheTaskView,
        Tasks.Message.CompletedCacheTaskView(),
      ),
      expect(text(todayTask.title)).toExist(),
    )
  })

  test('the project index filters by a project and by no project', () => {
    scene(
      sceneWith(baseModel()),
      given(baseModel()),
      click(role('button', { name: /^خانه/ })),
      Command.resolve(
        Tasks.CacheTaskView,
        Tasks.Message.CompletedCacheTaskView(),
      ),
      expect(text(overdueTask.title)).toExist(),
      expect(text(todayTask.title)).toBeAbsent(),
      click(role('button', { name: /^بدون پروژه/ })),
      Command.resolve(
        Tasks.CacheTaskView,
        Tasks.Message.CompletedCacheTaskView(),
      ),
      expect(text(todayTask.title)).toExist(),
      expect(text(overdueTask.title)).toBeAbsent(),
    )
  })

  test('inline editing opens the card and reports saving, saved, then idle', () => {
    scene(
      sceneWith(baseModel()),
      given(baseModel()),
      click(role('button', { name: todayTask.title })),
      expect(label('عنوان')).toHaveValue(todayTask.title),
      expect(label('توضیح')).toHaveValue(''),
      type(label('عنوان'), 'نان سنگک'),
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
      expect(text('ذخیره شد')).toExist(),
      Command.resolve(
        Tasks.ClearTaskSaveState,
        Tasks.Message.CompletedClearTaskSaveState({
          taskId: todayTask.id,
          generation: 1,
        }),
      ),
      expect(label('عنوان')).toHaveValue('نان سنگک'),
      expect(text('ذخیره شد')).toBeAbsent(),
    )
  })

  test('a card move is one action and announces the change', () => {
    scene(
      sceneWith(baseModel()),
      given(baseModel()),
      click(
        within(
          role('group', { name: `جابه‌جایی ${todayTask.title}` }),
          role('button', { name: 'فردا' }),
        ),
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
      expect(text(`جابه‌جا شد: ${todayTask.title}`)).toExist(),
    )
  })

  test('completing shows the toast; undo returns the task', () => {
    scene(
      sceneWith(baseModel()),
      given(baseModel()),
      click(role('button', { name: `انجام دادن: ${todayTask.title}` })),
      Command.resolve(
        Tasks.CompleteTask,
        Tasks.Message.CompletedCompleteTask({
          taskId: todayTask.id,
          title: todayTask.title,
        }),
      ),
      expect(text(`انجام شد: ${todayTask.title}`)).toExist(),
      Command.resolve(
        Tasks.DismissTaskToast,
        Tasks.Message.CompletedDismissTaskToast({ generation: 0 }),
      ),
      click(role('button', { name: 'بازگرداندن' })),
      Command.resolve(
        Tasks.UndoTask,
        Tasks.Message.CompletedUndoTask({
          taskId: todayTask.id,
          title: todayTask.title,
        }),
      ),
      expect(text(`بازگردانده شد: ${todayTask.title}`)).toExist(),
      expect(text(`انجام شد: ${todayTask.title}`)).toBeAbsent(),
    )
  })

  test('the seven-day history restores a completion', () => {
    scene(
      sceneWith(baseModel()),
      given(baseModel()),
      expect(text('تاریخچهٔ انجام')).toExist(),
      expect(text(doneTask.title)).toExist(),
      click(role('button', { name: `بازگرداندن ${doneTask.title}` })),
      Command.expectExact(
        Tasks.UndoTask({
          taskId: doneTask.id,
          title: doneTask.title,
          maybeStartedAt: Option.none(),
        }),
      ),
      Command.resolve(
        Tasks.UndoTask,
        Tasks.Message.CompletedUndoTask({
          taskId: doneTask.id,
          title: doneTask.title,
        }),
      ),
      expect(text(`بازگردانده شد: ${doneTask.title}`)).toExist(),
    )
  })

  test('the active filter bar starts from the saved model view', () => {
    const filtered = modifyFields(baseModel(), {
      settings: () => settings({ project: ProjectFilter.None() }),
    })

    scene(
      sceneWith(filtered),
      given(filtered),
      expect(text('بدون پروژه')).toExist(),
      expect(text(todayTask.title)).toExist(),
      expect(text(overdueTask.title)).toBeAbsent(),
      expect(text(inboxTask.title)).toExist(),
      expect(role('button', { name: /پاک کردن فیلترها/ })).toExist(),
    )
  })

  test('the project and tag chips are keyboard buttons in the filter bar', () => {
    scene(
      sceneWith(baseModel()),
      given(baseModel()),
      expect(role('button', { name: /^همه‌ی کارها/ })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      expect(role('button', { name: /^بدون پروژه/ })).toHaveAttr(
        'aria-pressed',
        'false',
      ),
      expect(role('button', { name: tag.name })).toHaveAttr(
        'aria-pressed',
        'false',
      ),
    )
  })
})
