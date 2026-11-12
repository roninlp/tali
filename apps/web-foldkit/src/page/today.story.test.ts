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

import { emptyMirrorSnapshot } from '../mirror'
import {
  Preferences as PreferencesRow,
  defaultPreferences,
} from '../preferences-model'
import { DISPLAY, TODAY_NOW, USER_ID } from '../test-fixtures'
import * as Today from './today'
import type { Inputs } from './today'
import { TodayFetchState, boundsFor } from './today-model'
import {
  habit,
  habitEntry,
  readModel,
  secondTask,
  task,
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

const update = (today: Today.Model, message: Today.Message) =>
  Today.update(today, message, inputs())

const savedPreferences = (order: ReadonlyArray<string>) =>
  PreferencesRow.make({
    ...defaultPreferences(USER_ID),
    dashboardSectionOrder: order,
  })

const withServer = (): Today.Model =>
  modifyFields(Today.initialModel(TODAY_NOW), {
    maybeServer: () => Option.some(readModel({ tasks: [task, secondTask] })),
    fetchState: () => TodayFetchState.Ready(),
  })

describe('Today read model', () => {
  test('entering the screen fetches once without an ETag', () => {
    story(
      update,
      given(Today.initialModel(TODAY_NOW)),
      message(Today.Message.EnteredToday()),
      Command.expectExact(
        Today.FetchToday({
          generation: 1,
          maybeEtag: Option.none(),
          dirtyAtRequest: [],
        }),
      ),
      Command.resolve(
        Today.FetchToday,
        Today.Message.UnchangedFetchToday({
          generation: 1,
          maybeEtag: Option.none(),
        }),
      ),
    )
  })

  test('a pending outbox defers the read model', () => {
    story(
      (today: Today.Model, message: Today.Message) =>
        Today.update(today, message, inputs({ pending: 1 })),
      given(Today.initialModel(TODAY_NOW)),
      message(Today.Message.EnteredToday()),
      Command.expectNone(),
    )
  })

  test('a successful read stores the server model and its ETag', () => {
    story(
      update,
      given(Today.initialModel(TODAY_NOW)),
      message(Today.Message.EnteredToday()),
      Command.resolve(
        Today.FetchToday,
        Today.Message.SucceededFetchToday({
          generation: 1,
          model: readModel({ tasks: [task, secondTask] }),
          maybeEtag: Option.some('"today-v1"'),
          dirtyAtRequest: [],
        }),
      ),
      model(next => {
        expect(next.fetchState).toStrictEqual(TodayFetchState.Ready())
        expect(next.maybeEtag).toStrictEqual(Option.some('"today-v1"'))
        expect(Option.isSome(next.maybeServer)).toBe(true)
      }),
      message(Today.Message.EnteredToday()),
      Command.expectExact(
        Today.FetchToday({
          generation: 2,
          maybeEtag: Option.some('"today-v1"'),
          dirtyAtRequest: [],
        }),
      ),
      Command.resolve(
        Today.FetchToday,
        Today.Message.UnchangedFetchToday({
          generation: 2,
          maybeEtag: Option.some('"today-v1"'),
        }),
      ),
    )
  })

  test('a 304 keeps the model on screen and only refreshes the ETag', () => {
    story(
      update,
      given(withServer()),
      message(Today.Message.EnteredToday()),
      Command.resolve(
        Today.FetchToday,
        Today.Message.UnchangedFetchToday({
          generation: 1,
          maybeEtag: Option.some('"today-v2"'),
        }),
      ),
      model(next => {
        expect(Option.isSome(next.maybeServer)).toBe(true)
        expect(next.fetchState).toStrictEqual(TodayFetchState.Ready())
      }),
    )
  })

  test('a network failure falls back to the mirror', () => {
    story(
      update,
      given(withServer()),
      message(Today.Message.EnteredToday()),
      Command.resolve(
        Today.FetchToday,
        Today.Message.FailedFetchToday({
          generation: 1,
          failure: { code: 'Network', retryable: true },
        }),
      ),
      model(next => {
        expect(next.fetchState).toStrictEqual(TodayFetchState.Offline())
        expect(next.maybeServer).toStrictEqual(Option.none())
      }),
    )
  })

  test('a late response from an older generation is ignored', () => {
    story(
      update,
      given(
        modifyFields(Today.initialModel(TODAY_NOW), {
          refreshGeneration: () => 2,
          isFetching: () => true,
        }),
      ),
      message(
        Today.Message.FailedFetchToday({
          generation: 1,
          failure: { code: 'Network', retryable: true },
        }),
      ),
      model(next => {
        expect(next.fetchState).toStrictEqual(TodayFetchState.Idle())
        expect(next.isFetching).toBe(true)
      }),
    )
  })
})

describe('Today quick add', () => {
  test('an empty draft never creates a task', () => {
    story(
      update,
      given(Today.initialModel(TODAY_NOW)),
      message(Today.Message.UpdatedQuickAddDraft({ value: '   ' })),
      message(Today.Message.SubmittedQuickAdd()),
      expectNoOutMessage(),
      Command.expectNone(),
    )
  })

  test('submitting a title writes it locally and clears the draft', () => {
    story(
      update,
      given(Today.initialModel(TODAY_NOW)),
      message(Today.Message.UpdatedQuickAddDraft({ value: 'نان' })),
      message(Today.Message.SubmittedQuickAdd()),
      Command.expectExact(
        Today.CreateTask({ title: 'نان', timeZone: 'Asia/Tehran' }),
      ),
      expectNoOutMessage(),
      Command.resolve(
        Today.CreateTask,
        Today.Message.CompletedCreateTask({
          taskId: '0192f0a0-0000-7000-8000-000000000010',
          title: 'نان',
        }),
      ),
      model(next => {
        expect(next.draft).toBe('')
        expect(next.isAdding).toBe(false)
      }),
      expectOutMessage(Today.OutMessage.WroteLocalData()),
    )
  })

  test('the form waits for the local store', () => {
    story(
      (today: Today.Model, message: Today.Message) =>
        Today.update(today, message, inputs({ isStoreReady: false })),
      given(Today.initialModel(TODAY_NOW)),
      message(Today.Message.UpdatedQuickAddDraft({ value: 'نان' })),
      message(Today.Message.SubmittedQuickAdd()),
      Command.expectNone(),
    )
  })

  test('completing a task is a local write and an announcement', () => {
    story(
      update,
      given(withServer()),
      message(
        Today.Message.ClickedCompleteTask({
          taskId: task.id,
          title: task.title,
        }),
      ),
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
      model(next => {
        expect(next.announcement).toBe(`انجام شد: ${task.title}`)
      }),
      expectOutMessage(Today.OutMessage.WroteLocalData()),
    )
  })

  test('moving to tomorrow carries the household zone and date', () => {
    const bounds = boundsFor('Asia/Tehran', TODAY_NOW)

    story(
      update,
      given(withServer()),
      message(
        Today.Message.ClickedMoveToTomorrow({
          taskId: task.id,
          title: task.title,
        }),
      ),
      Command.expectExact(
        Today.MoveToTomorrow({
          taskId: task.id,
          title: task.title,
          tomorrow: bounds.tomorrow,
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Today.MoveToTomorrow,
        Today.Message.CompletedMoveToTomorrow({
          taskId: task.id,
          title: task.title,
        }),
      ),
      expectOutMessage(Today.OutMessage.WroteLocalData()),
    )
  })
})

describe('Today section order', () => {
  test('moving a section saves the whole permutation', () => {
    const order = ['tasks', 'events', 'reminders', 'notes', 'habits']

    story(
      update,
      given(Today.initialModel(TODAY_NOW)),
      message(Today.Message.ClickedToggleOrderPanel()),
      model(next => {
        expect(next.orderOpen).toBe(true)
      }),
      message(
        Today.Message.ClickedMoveSection({
          section: 'notes',
          direction: 'up',
        }),
      ),
      Command.expectExact(Today.SaveSectionOrder({ section: 'notes', order })),
      model(next => {
        expect(next.orderBusy).toBe(true)
      }),
      Command.resolve(
        Today.SaveSectionOrder,
        Today.Message.SucceededSaveSectionOrder({
          section: 'notes',
          preferences: savedPreferences(order),
        }),
      ),
      model(next => {
        expect(next.orderBusy).toBe(false)
        expect(next.announcement).toBe(
          'ترتیب بخش‌ها به‌روز شد: یادداشت‌های پین‌شده',
        )
      }),
      expectOutMessage(
        Today.OutMessage.SavedSectionOrder({
          preferences: savedPreferences(order),
        }),
      ),
    )
  })

  test('an impossible move changes nothing', () => {
    story(
      update,
      given(Today.initialModel(TODAY_NOW)),
      message(
        Today.Message.ClickedMoveSection({
          section: 'tasks',
          direction: 'up',
        }),
      ),
      Command.expectNone(),
    )
  })

  test('a failed save surfaces the retryable copy', () => {
    story(
      update,
      given(Today.initialModel(TODAY_NOW)),
      message(
        Today.Message.ClickedMoveSection({
          section: 'notes',
          direction: 'up',
        }),
      ),
      Command.resolve(
        Today.SaveSectionOrder,
        Today.Message.FailedSaveSectionOrder({
          section: 'notes',
          failure: { code: 'Network', retryable: true },
        }),
      ),
      model(next => {
        expect(next.orderBusy).toBe(false)
        expect(next.orderError).toStrictEqual(
          Option.some(
            'ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی کنید.',
          ),
        )
      }),
    )
  })
})

describe('Today habits lane', () => {
  const habitInputs = (): Inputs =>
    inputs({
      mirror: {
        ...emptyMirrorSnapshot(),
        habits: [habit],
        habitEntries: [habitEntry],
      },
    })

  test('a tap records the day and announces the new state', () => {
    story(
      (today: Today.Model, message: Today.Message) =>
        Today.update(today, message, habitInputs()),
      given(Today.initialModel(TODAY_NOW)),
      message(
        Today.Message.ClickedHabit({
          habitId: habit.id,
          title: habit.title,
        }),
      ),
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
          status: 'done',
        }),
      ),
      model(next => {
        expect(next.habitBusyId).toStrictEqual(Option.none())
        expect(next.habitAnnouncement).toBe(`${habit.title}: انجام شد`)
      }),
      expectOutMessage(Today.OutMessage.WroteLocalData()),
    )
  })
})

describe('Today keyboard cursor', () => {
  test('arrows move the cursor and Enter completes the focused row', () => {
    story(
      update,
      given(withServer()),
      message(Today.Message.PressedCursorDown()),
      model(next => {
        expect(next.cursor).toBe(0)
        expect(next.cursorActive).toBe(true)
      }),
      message(Today.Message.PressedCursorDown()),
      model(next => {
        expect(next.cursor).toBe(1)
      }),
      message(Today.Message.PressedCursorUp()),
      model(next => {
        expect(next.cursor).toBe(0)
      }),
      message(Today.Message.PressedCursorComplete()),
      Command.expectExact(
        Today.CompleteTask({
          taskId: secondTask.id,
          title: secondTask.title,
        }),
      ),
      Command.resolve(
        Today.CompleteTask,
        Today.Message.CompletedCompleteTask({
          taskId: secondTask.id,
          title: secondTask.title,
        }),
      ),
      expectOutMessage(Today.OutMessage.WroteLocalData()),
    )
  })
})
