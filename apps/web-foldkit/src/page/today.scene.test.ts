import { Option } from 'effect'
import {
  Command,
  all,
  click,
  expect,
  expectAll,
  expectOutMessage,
  given,
  label,
  nth,
  role,
  scene,
  submit,
  text,
  type,
  withViewInputs,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { expect as assert, describe, test } from 'vitest'

import { emptyMirrorSnapshot } from '../mirror'
import { DISPLAY, TODAY_NOW } from '../test-fixtures'
import * as Today from './today'
import type { Inputs } from './today'
import { TodayFetchState, todayView } from './today-model'
import {
  habit,
  habitEntry,
  note,
  readModel,
  secondTask,
  task,
  tomorrowTask,
} from './today-test-fixtures'

const inputs = (overrides: Partial<Inputs> = {}): Inputs => ({
  display: DISPLAY,
  sectionOrder: ['tasks', 'events', 'reminders', 'habits', 'notes'],
  isStoreReady: true,
  isOnline: true,
  pending: 0,
  mirror: emptyMirrorSnapshot(),
  pendingKeys: [],
  ...overrides,
})

const sceneWith = (model: Today.Model, overrides: Partial<Inputs> = {}) => {
  const viewInputs = inputs(overrides)

  return {
    update: (today: Today.Model, message: Today.Message) =>
      Today.update(today, message, viewInputs),
    view: withViewInputs(Today.view, viewInputs)(),
  }
}

const withServer = (): Today.Model =>
  modifyFields(Today.initialModel(TODAY_NOW), {
    maybeServer: () => Option.some(readModel({ tasks: [task, secondTask] })),
    fetchState: () => TodayFetchState.Ready(),
  })

describe('Today screen', () => {
  test('renders the server read model with tasks and pinned notes', () => {
    const model = modifyFields(withServer(), {
      maybeServer: () =>
        Option.some(readModel({ tasks: [task, secondTask], notes: [note] })),
    })

    scene(
      sceneWith(model),
      given(model),
      expect(role('heading', { name: 'امروز' })).toExist(),
      expect(text(task.title)).toExist(),
      expect(text(secondTask.title)).toExist(),
      expect(text(note.title)).toExist(),
      expect(text('برخط')).toExist(),
    )
  })

  test('the clickable fallback is a mirror aggregate, not a blank screen', () => {
    scene(
      sceneWith(Today.initialModel(TODAY_NOW), {
        isOnline: false,
        mirror: {
          ...emptyMirrorSnapshot(),
          tasks: [task, tomorrowTask],
          notes: [note],
        },
      }),
      given(Today.initialModel(TODAY_NOW)),
      expect(text(task.title)).toExist(),
      expect(text(note.title)).toExist(),
      expect(text(tomorrowTask.title)).toBeAbsent(),
      expect(text(/آفلاین — نمایش از حافظهٔ محلی/)).toExist(),
    )
  })

  test('an empty day offers one small next action per lane', () => {
    scene(
      sceneWith(Today.initialModel(TODAY_NOW)),
      given(Today.initialModel(TODAY_NOW)),
      expect(text(/امروز خالی است/)).toExist(),
      expect(role('button', { name: 'افزودن اولین کار' })).toExist(),
      expect(text(/یادداشتی پین نشده است/)).toExist(),
      expect(text(/هنوز عادتی نساخته‌اید/)).toExist(),
      expect(text('امروز رویدادی نیست؛ تقویم در گام بعدی می‌آید.')).toExist(),
      expect(text('یادآوری‌ای برای امروز نیست.')).toExist(),
    )
  })

  test('the order panel starts at the bounds and toggles open', () => {
    const viewInputs = inputs()

    scene(
      sceneWith(Today.initialModel(TODAY_NOW)),
      given(Today.initialModel(TODAY_NOW)),
      expect(role('region', { name: 'ترتیب بخش‌ها' })).toBeAbsent(),
      click(role('button', { name: 'ترتیب بخش‌ها' })),
      expect(role('region', { name: 'ترتیب بخش‌ها' })).toExist(),
      expect(
        role('button', { name: 'انتقال کارهای امروز به بالا' }),
      ).toBeDisabled(),
      expect(
        role('button', { name: 'انتقال یادداشت‌های پین‌شده به پایین' }),
      ).toBeDisabled(),
    )

    assert(viewInputs.sectionOrder).toStrictEqual([
      'tasks',
      'events',
      'reminders',
      'habits',
      'notes',
    ])
  })

  test('the saved order decides which section heading comes first', () => {
    scene(
      sceneWith(Today.initialModel(TODAY_NOW), {
        sectionOrder: ['notes', 'tasks', 'events', 'reminders', 'habits'],
      }),
      given(Today.initialModel(TODAY_NOW)),
      expectAll(all.role('heading')).toHaveCount(6),
      expect(nth(all.role('heading'), 1)).toHaveText('یادداشت‌های پین‌شده'),
      expect(nth(all.role('heading'), 2)).toHaveText('کارهای امروز'),
    )
  })

  test('quick-add submits the trimmed title and focuses the field', () => {
    scene(
      sceneWith(Today.initialModel(TODAY_NOW)),
      given(Today.initialModel(TODAY_NOW)),
      expect(label('کار تازه برای امروز')).toBeEnabled(),
      type(label('کار تازه برای امروز'), 'نان'),
      submit(role('form')),
      Command.expectExact(
        Today.CreateTask({ title: 'نان', timeZone: 'Asia/Tehran' }),
      ),
      Command.resolve(
        Today.CreateTask,
        Today.Message.CompletedCreateTask({
          taskId: task.id,
          title: 'نان',
        }),
      ),
      expectOutMessage(Today.OutMessage.WroteLocalData()),
      expect(label('کار تازه برای امروز')).toHaveValue(''),
    )
  })

  test('completing a row hits the local mirror', () => {
    scene(
      sceneWith(withServer()),
      given(withServer()),
      click(role('checkbox', { name: `انجام ${task.title}` })),
      Command.expectExact(
        Today.CompleteTask({ taskId: task.id, title: task.title }),
      ),
      Command.resolve(
        Today.CompleteTask,
        Today.Message.CompletedCompleteTask({
          taskId: task.id,
          title: task.title,
        }),
      ),
      expectOutMessage(Today.OutMessage.WroteLocalData()),
    )
  })

  test('the habits lane reports its streak copy and taps locally', () => {
    scene(
      sceneWith(Today.initialModel(TODAY_NOW), {
        mirror: {
          ...emptyMirrorSnapshot(),
          habits: [habit],
          habitEntries: [habitEntry],
        },
      }),
      given(Today.initialModel(TODAY_NOW)),
      expect(text(habit.title)).toExist(),
      expect(text('هر روز')).toExist(),
      click(role('button', { name: `تغییر وضعیت ${habit.title}` })),
      Command.expectExact(
        Today.TapHabit({
          habitId: habit.id,
          title: habit.title,
          localDate: '2026-10-30',
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Today.TapHabit,
        Today.Message.CompletedTapHabit({
          habitId: habit.id,
          title: habit.title,
          status: 'partial',
        }),
      ),
      expectOutMessage(Today.OutMessage.WroteLocalData()),
    )
  })

  test('a task moved past today is not in the view', () => {
    const view = todayView({
      maybeServer: Option.none(),
      mirror: {
        ...emptyMirrorSnapshot(),
        tasks: [task, tomorrowTask],
      },
      pendingKeys: [],
      dirtyKeys: [],
      isOnline: true,
      timeZone: 'Asia/Tehran',
      now: TODAY_NOW,
    })

    assert(view.tasks.map(entry => entry.id)).toStrictEqual([task.id])
  })
})
