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
import { describe, expect, test } from 'vitest'

import type { CalendarEventOccurrence } from '../lib/calendar-data'
import { HOUSEHOLD_ID, TODAY_NOW, USER_ID } from '../test-fixtures'
import * as Calendar from './calendar'
import type { Inputs, Model } from './calendar'
import { CalendarFetchState } from './calendar-model'
import {
  CALENDAR_TASK_ID,
  EVENT_ID,
  OCCASION_ID,
  RECURRING_EVENT_ID,
  TODAY,
  WEEK_START,
  calendarInputs,
  calendarModel,
  calendarTask,
  eventRow,
  mirrorWith,
  occasionRow,
  weekPayload,
  weeklyEventRow,
} from './calendar-test-fixtures'

const update =
  (inputs: Inputs) => (calendar: Model, message: Calendar.Message) =>
    Calendar.update(calendar, message, inputs)

const defaultUpdate = update(calendarInputs())

const inputsWith = (overrides: Partial<Inputs> = {}) =>
  calendarInputs(overrides)

const weekInputs = (overrides: Partial<Inputs> = {}) =>
  inputsWith({
    mirror: mirrorWith({
      tasks: [calendarTask()],
      events: [eventRow()],
      occasions: [occasionRow()],
    }),
    ...overrides,
  })

const oneOffOccurrence: CalendarEventOccurrence = {
  key: EVENT_ID,
  id: EVENT_ID,
  instanceId: TODAY,
  date: TODAY,
  title: 'سفر',
  description: null,
  location: null,
  category: null,
  color: null,
  people: [],
  timing: { _tag: 'allDay', date: TODAY },
  timeZone: 'Asia/Tehran',
  projected: false,
  recurring: false,
  overridden: false,
  exceptionId: null,
}

const recurringOccurrence: CalendarEventOccurrence = {
  ...oneOffOccurrence,
  key: `${RECURRING_EVENT_ID}@${TODAY}`,
  id: RECURRING_EVENT_ID,
  instanceId: TODAY,
  title: 'جلسهٔ هفتگی',
  projected: true,
  recurring: true,
}

const scopeIds = {
  exceptionId: '0192f0a0-0000-7000-8000-000000000050',
  followingId: '0192f0a0-0000-7000-8000-000000000051',
  clientMutationId: '0192f0a0-0000-7000-8000-000000000052',
  followingMutationId: '0192f0a0-0000-7000-8000-000000000053',
}

describe('Calendar entry and reads', () => {
  test('entering the screen resets the transient state and reads the clock', () => {
    const result = Calendar.entered(
      calendarModel({
        view: 'month',
        maybeSelectedDay: Option.some(TODAY),
        planningOpen: true,
        taskDrafts: [{ date: TODAY, value: 'کار' }],
      }),
      weekInputs(),
    )

    expect(result.model.view).toBe('week')
    expect(result.model.anchor).toBe(TODAY)
    expect(result.model.maybeSelectedDay).toStrictEqual(Option.none())
    expect(result.model.planningOpen).toBe(false)
    expect(result.model.taskDrafts).toStrictEqual([])
    expect(result.model.occasionOriginDate).toBe(TODAY)
    expect(result.commands?.[0]?.name).toBe('ReadCalendarClock')
  })

  test('a tick while online and drained fetches the current week', () => {
    story(
      defaultUpdate,
      given(calendarModel()),
      message(Calendar.Message.TickedCalendar({ now: TODAY_NOW + 60_000 })),
      model(next => {
        expect(next.now).toBe(TODAY_NOW + 60_000)
        expect(next.refreshGeneration).toBe(1)
      }),
      Command.expectExact(
        Calendar.FetchCalendar({
          view: 'week',
          anchor: TODAY,
          maybeDay: Option.none(),
          maybeEtag: Option.none(),
          generation: 1,
          dirtyAtRequest: [],
          dirtyEventsAtRequest: [],
        }),
      ),
      Command.resolve(
        Calendar.FetchCalendar,
        Calendar.Message.SucceededFetchWeek({
          generation: 1,
          model: weekPayload(),
          maybeEtag: Option.some('week-1'),
          dirtyAtRequest: [],
          dirtyEventsAtRequest: [],
        }),
      ),
      model(next => {
        expect(next.fetchState).toStrictEqual(CalendarFetchState.Ready())
        expect(Option.isSome(next.maybeServerWeek)).toBe(true)
        expect(next.maybeServerWeekEtag).toStrictEqual(Option.some('week-1'))
      }),
    )
  })

  test('a tick while pending does not fetch', () => {
    story(
      update(inputsWith({ pending: 1 })),
      given(calendarModel()),
      message(Calendar.Message.TickedCalendar({ now: TODAY_NOW + 60_000 })),
      Command.expectNone(),
    )
  })

  test('going offline drops both server snapshots', () => {
    story(
      defaultUpdate,
      given(
        calendarModel({
          maybeServerWeek: Option.some(weekPayload()),
          maybeServerMonth: Option.some({
            year: 1405,
            month: 8,
            start: WEEK_START,
            end: '2026-11-20',
            timeZone: 'Asia/Tehran',
            weekStart: 'saturday',
            tasks: [],
            events: [],
            occasions: [],
          }),
        }),
      ),
      message(Calendar.Message.WentOffline()),
      model(next => {
        expect(next.maybeServerWeek).toStrictEqual(Option.none())
        expect(next.maybeServerMonth).toStrictEqual(Option.none())
        expect(next.fetchState).toStrictEqual(CalendarFetchState.Offline())
      }),
    )
  })

  test('going back online after a blip re-reads the week', () => {
    story(
      defaultUpdate,
      given(
        calendarModel({
          fetchState: CalendarFetchState.Offline(),
          refreshGeneration: 4,
        }),
      ),
      message(Calendar.Message.WentOnline()),
      model(next => {
        expect(next.fetchState).toStrictEqual(CalendarFetchState.Idle())
      }),
      Command.expectExact(
        Calendar.FetchCalendar({
          view: 'week',
          anchor: TODAY,
          maybeDay: Option.none(),
          maybeEtag: Option.none(),
          generation: 5,
          dirtyAtRequest: [],
          dirtyEventsAtRequest: [],
        }),
      ),
      Command.resolve(
        Calendar.FetchCalendar,
        Calendar.Message.SucceededFetchWeek({
          generation: 5,
          model: weekPayload(),
          maybeEtag: Option.some('week-5'),
          dirtyAtRequest: [],
          dirtyEventsAtRequest: [],
        }),
      ),
      model(next => {
        expect(next.fetchState).toStrictEqual(CalendarFetchState.Ready())
      }),
    )
  })

  test('a failed week read keeps painting from the mirror', () => {
    story(
      defaultUpdate,
      given(calendarModel()),
      message(Calendar.Message.TickedCalendar({ now: TODAY_NOW })),
      Command.resolve(
        Calendar.FetchCalendar,
        Calendar.Message.FailedFetchWeek({
          generation: 1,
          failure: { code: 'Network', retryable: true },
        }),
      ),
      model(next => {
        expect(next.maybeServerWeek).toStrictEqual(Option.none())
        expect(next.fetchState).toStrictEqual(CalendarFetchState.Offline())
      }),
    )
  })

  test('switching to the month reads the current Jalali month', () => {
    story(
      defaultUpdate,
      given(calendarModel()),
      message(Calendar.Message.SelectedCalendarView({ view: 'month' })),
      Command.expectExact(
        Calendar.FetchCalendar({
          view: 'month',
          anchor: TODAY,
          maybeDay: Option.none(),
          maybeEtag: Option.none(),
          generation: 1,
          dirtyAtRequest: [],
          dirtyEventsAtRequest: [],
        }),
      ),
      Command.resolve(
        Calendar.FetchCalendar,
        Calendar.Message.SucceededFetchMonth({
          generation: 1,
          model: {
            year: 1405,
            month: 8,
            start: WEEK_START,
            end: '2026-11-20',
            timeZone: 'Asia/Tehran',
            weekStart: 'saturday',
            tasks: [],
            events: [],
            occasions: [],
          },
          maybeEtag: Option.some('month-1'),
          dirtyAtRequest: [],
          dirtyEventsAtRequest: [],
        }),
      ),
    )
  })

  test('selecting a day carries it to the month read', () => {
    story(
      defaultUpdate,
      given(calendarModel({ view: 'month' })),
      message(Calendar.Message.SelectedCalendarDay({ date: TODAY })),
      model(next => {
        expect(next.maybeSelectedDay).toStrictEqual(Option.some(TODAY))
      }),
      Command.expectExact(
        Calendar.FetchCalendar({
          view: 'month',
          anchor: TODAY,
          maybeDay: Option.some(TODAY),
          maybeEtag: Option.none(),
          generation: 1,
          dirtyAtRequest: [],
          dirtyEventsAtRequest: [],
        }),
      ),
      Command.resolve(
        Calendar.FetchCalendar,
        Calendar.Message.SucceededFetchMonth({
          generation: 1,
          model: {
            year: 1405,
            month: 8,
            start: WEEK_START,
            end: '2026-11-20',
            timeZone: 'Asia/Tehran',
            weekStart: 'saturday',
            tasks: [],
            events: [],
            occasions: [],
          },
          maybeEtag: Option.some('month-2'),
          dirtyAtRequest: [],
          dirtyEventsAtRequest: [],
        }),
      ),
    )
  })

  test('opening a month day in the week view moves the anchor', () => {
    story(
      defaultUpdate,
      given(
        calendarModel({
          view: 'month',
          maybeSelectedDay: Option.some(TODAY),
        }),
      ),
      message(Calendar.Message.OpenedDayInWeek({ date: '2026-10-28' })),
      model(next => {
        expect(next.view).toBe('week')
        expect(next.anchor).toBe('2026-10-28')
        expect(next.maybeSelectedDay).toStrictEqual(Option.none())
      }),
      Command.expectExact(
        Calendar.FetchCalendar({
          view: 'week',
          anchor: '2026-10-28',
          maybeDay: Option.none(),
          maybeEtag: Option.none(),
          generation: 1,
          dirtyAtRequest: [],
          dirtyEventsAtRequest: [],
        }),
      ),
      Command.resolve(
        Calendar.FetchCalendar,
        Calendar.Message.SucceededFetchWeek({
          generation: 1,
          model: weekPayload(),
          maybeEtag: Option.some('week-6'),
          dirtyAtRequest: [],
          dirtyEventsAtRequest: [],
        }),
      ),
    )
  })
})

describe('Calendar task lane', () => {
  test('quick add submits the trimmed title and keeps the draft until the write lands', () => {
    story(
      update(weekInputs()),
      given(calendarModel()),
      message(
        Calendar.Message.UpdatedTaskDraft({
          date: TODAY,
          value: '  خرید شیر  ',
        }),
      ),
      message(Calendar.Message.SubmittedTaskQuickAdd({ date: TODAY })),
      model(next => {
        expect(next.maybeBusyKey).toStrictEqual(Option.some(`add:${TODAY}`))
      }),
      Command.expectExact(
        Calendar.CreateCalendarTask({
          title: 'خرید شیر',
          date: TODAY,
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Calendar.CreateCalendarTask,
        Calendar.Message.CompletedCreateCalendarTask({
          taskId: CALENDAR_TASK_ID,
          title: 'خرید شیر',
          date: TODAY,
        }),
      ),
      model(next => {
        expect(next.taskDrafts).toStrictEqual([])
        expect(next.dirtyTaskIds).toContain(CALENDAR_TASK_ID)
        expect(next.announcement).toBe(
          'کار تازه برای جمعه ۸ آبان ۱۴۰۵: خرید شیر',
        )
      }),
      expectOutMessage(Calendar.OutMessage.WroteLocalData()),
    )
  })

  test('an empty quick add creates nothing', () => {
    story(
      defaultUpdate,
      given(calendarModel()),
      message(Calendar.Message.SubmittedTaskQuickAdd({ date: TODAY })),
      Command.expectNone(),
      expectNoOutMessage(),
    )
  })

  test('a projected occurrence never completes', () => {
    story(
      defaultUpdate,
      given(calendarModel()),
      message(
        Calendar.Message.ClickedCompleteCalendarTask({
          taskId: CALENDAR_TASK_ID,
          title: 'کار',
          projected: true,
        }),
      ),
      Command.expectNone(),
    )
  })

  test('completing a real task writes locally and announces it', () => {
    story(
      update(weekInputs()),
      given(calendarModel()),
      message(
        Calendar.Message.ClickedCompleteCalendarTask({
          taskId: CALENDAR_TASK_ID,
          title: 'خرید نان',
          projected: false,
        }),
      ),
      Command.expectExact(
        Calendar.CompleteCalendarTask({
          taskId: CALENDAR_TASK_ID,
          title: 'خرید نان',
        }),
      ),
      Command.resolve(
        Calendar.CompleteCalendarTask,
        Calendar.Message.CompletedCompleteCalendarTask({
          taskId: CALENDAR_TASK_ID,
          title: 'خرید نان',
        }),
      ),
      model(next => {
        expect(next.announcement).toBe('انجام شد: خرید نان')
        expect(next.dirtyTaskIds).toContain(CALENDAR_TASK_ID)
      }),
      expectOutMessage(Calendar.OutMessage.WroteLocalData()),
    )
  })

  test('a priority change writes the chosen value', () => {
    story(
      update(weekInputs()),
      given(calendarModel()),
      message(
        Calendar.Message.ClickedPrioritizeCalendarTask({
          taskId: CALENDAR_TASK_ID,
          title: 'خرید نان',
          priority: 'high',
          currentPriority: 'medium',
          projected: false,
        }),
      ),
      Command.expectExact(
        Calendar.PrioritizeCalendarTask({
          taskId: CALENDAR_TASK_ID,
          title: 'خرید نان',
          priority: 'high',
        }),
      ),
      Command.resolve(
        Calendar.PrioritizeCalendarTask,
        Calendar.Message.CompletedPrioritizeCalendarTask({
          taskId: CALENDAR_TASK_ID,
          title: 'خرید نان',
          priority: 'high',
        }),
      ),
      model(next => {
        expect(next.announcement).toBe('اولویت خرید نان: بالا')
      }),
    )
  })

  test('an unchanged priority is a no-op', () => {
    story(
      defaultUpdate,
      given(calendarModel()),
      message(
        Calendar.Message.ClickedPrioritizeCalendarTask({
          taskId: CALENDAR_TASK_ID,
          title: 'خرید نان',
          priority: 'medium',
          currentPriority: 'medium',
          projected: false,
        }),
      ),
      Command.expectNone(),
    )
  })

  test('moving a task computes the target day', () => {
    story(
      update(weekInputs()),
      given(calendarModel()),
      message(
        Calendar.Message.ClickedMoveCalendarTask({
          taskId: CALENDAR_TASK_ID,
          title: 'خرید نان',
          date: TODAY,
          days: 1,
          projected: false,
        }),
      ),
      Command.expectExact(
        Calendar.MoveCalendarTask({
          taskId: CALENDAR_TASK_ID,
          title: 'خرید نان',
          target: '2026-10-31',
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Calendar.MoveCalendarTask,
        Calendar.Message.CompletedMoveCalendarTask({
          taskId: CALENDAR_TASK_ID,
          title: 'خرید نان',
          target: '2026-10-31',
        }),
      ),
      model(next => {
        expect(next.announcement).toBe('خرید نان به شنبه ۹ آبان ۱۴۰۵ منتقل شد')
      }),
    )
  })
})

describe('Calendar event lane', () => {
  const openedEventQuickAdd = (model: Model): Model =>
    Calendar.update(
      model,
      Calendar.Message.ToggledEventQuickAdd({ date: TODAY, isOpen: true }),
      weekInputs(),
    ).model

  test('the quick add submits the day, all-day flag and times', () => {
    story(
      update(weekInputs()),
      given(openedEventQuickAdd(calendarModel())),
      message(
        Calendar.Message.UpdatedQuickEventTitle({
          date: TODAY,
          value: ' مهمانی ',
        }),
      ),
      message(
        Calendar.Message.ToggledQuickEventAllDay({
          date: TODAY,
          allDay: false,
        }),
      ),
      message(
        Calendar.Message.UpdatedQuickEventStart({
          date: TODAY,
          value: '18:00',
        }),
      ),
      message(
        Calendar.Message.UpdatedQuickEventEnd({ date: TODAY, value: '20:00' }),
      ),
      message(Calendar.Message.SubmittedEventQuickAdd({ date: TODAY })),
      Command.expectExact(
        Calendar.CreateCalendarEvent({
          draft: {
            title: 'مهمانی',
            date: TODAY,
            allDay: false,
            startTime: '18:00',
            endTime: '20:00',
          },
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Calendar.CreateCalendarEvent,
        Calendar.Message.CompletedCreateCalendarEvent({
          eventId: EVENT_ID,
          title: 'مهمانی',
          date: TODAY,
        }),
      ),
      model(next => {
        expect(next.dirtyEventIds).toContain(EVENT_ID)
        expect(next.announcement).toBe(
          'رویداد تازه برای جمعه ۸ آبان ۱۴۰۵: مهمانی',
        )
        expect(next.quickEvents).toStrictEqual([
          {
            date: TODAY,
            title: '',
            allDay: true,
            startTime: '09:00',
            endTime: '10:00',
            open: false,
          },
        ])
      }),
      expectOutMessage(Calendar.OutMessage.WroteLocalData()),
    )
  })

  test('a one-off save goes straight to the mirror write', () => {
    story(
      update(weekInputs()),
      given(calendarModel()),
      message(
        Calendar.Message.OpenedEventEditor({ occurrence: oneOffOccurrence }),
      ),
      Command.resolve(
        Calendar.FocusEventEditor,
        Calendar.Message.CompletedFocusEventEditor(),
      ),
      message(Calendar.Message.UpdatedEventEditorTitle({ value: 'سفر تازه' })),
      message(Calendar.Message.SubmittedEventEditor()),
      Command.expectExact(
        Calendar.CommitCalendarEventScope({
          occurrence: oneOffOccurrence,
          action: 'edit',
          scope: 'thisOccurrence',
          maybeDraft: Option.some({
            title: 'سفر تازه',
            date: TODAY,
            allDay: true,
            startTime: '09:00',
            endTime: '10:00',
          }),
          maybeIds: Option.none(),
          isOnline: true,
          maybeUserId: Option.some(USER_ID),
          maybeHouseholdId: Option.some(HOUSEHOLD_ID),
        }),
      ),
      Command.resolve(
        Calendar.CommitCalendarEventScope,
        Calendar.Message.CompletedCommitEventScope({
          action: 'edit',
          scope: 'thisOccurrence',
          seriesId: EVENT_ID,
          maybeFollowingId: Option.none(),
          title: 'سفر تازه',
        }),
      ),
      model(next => {
        expect(next.maybeEditingEvent).toStrictEqual(Option.none())
        expect(next.announcement).toBe('رویداد ویرایش شد: سفر تازه')
      }),
      expectOutMessage(Calendar.OutMessage.WroteLocalData()),
    )
  })

  test('deleting a one-off event writes the tombstone directly', () => {
    story(
      update(weekInputs()),
      given(calendarModel()),
      message(
        Calendar.Message.OpenedEventEditor({ occurrence: oneOffOccurrence }),
      ),
      Command.resolve(
        Calendar.FocusEventEditor,
        Calendar.Message.CompletedFocusEventEditor(),
      ),
      message(Calendar.Message.ClickedDeleteEvent()),
      Command.expectExact(
        Calendar.CommitCalendarEventScope({
          occurrence: oneOffOccurrence,
          action: 'delete',
          scope: 'thisOccurrence',
          maybeDraft: Option.none(),
          maybeIds: Option.none(),
          isOnline: true,
          maybeUserId: Option.some(USER_ID),
          maybeHouseholdId: Option.some(HOUSEHOLD_ID),
        }),
      ),
      Command.resolve(
        Calendar.CommitCalendarEventScope,
        Calendar.Message.CompletedCommitEventScope({
          action: 'delete',
          scope: 'thisOccurrence',
          seriesId: EVENT_ID,
          maybeFollowingId: Option.none(),
          title: 'سفر',
        }),
      ),
      model(next => {
        expect(next.announcement).toBe('رویداد حذف شد: سفر')
        expect(next.dirtyEventIds).toContain(EVENT_ID)
      }),
      expectOutMessage(Calendar.OutMessage.WroteLocalData()),
    )
  })

  test('a recurring save asks for the scope ids and the choice', () => {
    story(
      update(
        weekInputs({ mirror: mirrorWith({ events: [weeklyEventRow()] }) }),
      ),
      given(calendarModel()),
      message(
        Calendar.Message.OpenedEventEditor({ occurrence: recurringOccurrence }),
      ),
      Command.resolve(
        Calendar.FocusEventEditor,
        Calendar.Message.CompletedFocusEventEditor(),
      ),
      message(Calendar.Message.SubmittedEventEditor()),
      model(next => {
        expect(Option.isSome(next.maybePendingScope)).toBe(true)
        expect(
          Option.contains(
            Option.map(next.maybePendingScope, pending => pending.action),
            'edit',
          ),
        ).toBe(true)
      }),
      Command.expectExact(
        Calendar.GenerateEventScopeIds(),
        Calendar.FocusScopePrompt(),
      ),
      Command.resolve(
        Calendar.FocusScopePrompt,
        Calendar.Message.CompletedFocusScopePrompt(),
      ),
      Command.resolve(
        Calendar.GenerateEventScopeIds,
        Calendar.Message.CompletedGenerateEventScopeIds({ ids: scopeIds }),
      ),
      message(
        Calendar.Message.SelectedEventScope({ scope: 'thisAndFollowing' }),
      ),
      message(Calendar.Message.PressedConfirmEventScope()),
      Command.expectExact(
        Calendar.CommitCalendarEventScope({
          occurrence: recurringOccurrence,
          action: 'edit',
          scope: 'thisAndFollowing',
          maybeDraft: Option.some({
            title: 'جلسهٔ هفتگی',
            date: TODAY,
            allDay: true,
            startTime: '09:00',
            endTime: '10:00',
          }),
          maybeIds: Option.some(scopeIds),
          isOnline: true,
          maybeUserId: Option.some(USER_ID),
          maybeHouseholdId: Option.some(HOUSEHOLD_ID),
        }),
      ),
      Command.resolve(
        Calendar.CommitCalendarEventScope,
        Calendar.Message.CompletedCommitEventScope({
          action: 'edit',
          scope: 'thisAndFollowing',
          seriesId: RECURRING_EVENT_ID,
          maybeFollowingId: Option.some(scopeIds.followingId),
          title: 'جلسهٔ هفتگی',
        }),
      ),
      model(next => {
        expect(next.maybeEditingEvent).toStrictEqual(Option.none())
        expect(next.maybePendingScope).toStrictEqual(Option.none())
        expect(next.announcement).toBe(
          'این رویداد و رویدادهای بعدی ویرایش شد: جلسهٔ هفتگی',
        )
        expect(next.dirtyEventIds).toContain(RECURRING_EVENT_ID)
        expect(next.dirtyEventIds).toContain(scopeIds.followingId)
      }),
      expectOutMessage(Calendar.OutMessage.WroteLocalData()),
    )
  })

  test('escape closes the scope prompt first and leaves the editor open', () => {
    const pending = calendarModel({
      maybeEditingEvent: Option.some({
        occurrence: recurringOccurrence,
        draft: {
          title: 'جلسهٔ هفتگی',
          date: TODAY,
          allDay: true,
          startTime: '09:00',
          endTime: '10:00',
        },
      }),
      maybePendingScope: Option.some({
        action: 'edit',
        occurrence: recurringOccurrence,
        maybeDraft: Option.some({
          title: 'جلسهٔ هفتگی',
          date: TODAY,
          allDay: true,
          startTime: '09:00',
          endTime: '10:00',
        }),
        maybeIds: Option.none(),
      }),
    })

    story(
      defaultUpdate,
      given(pending),
      message(Calendar.Message.PressedEscape()),
      model(next => {
        expect(next.maybePendingScope).toStrictEqual(Option.none())
        expect(Option.isSome(next.maybeEditingEvent)).toBe(true)
      }),
      Command.expectExact(Calendar.FocusEventEditor()),
      Command.resolve(
        Calendar.FocusEventEditor,
        Calendar.Message.CompletedFocusEventEditor(),
      ),
    )
  })
})

describe('Calendar occasions', () => {
  test('creating an occasion submits the form and resets it', () => {
    story(
      update(weekInputs()),
      given(
        calendarModel({
          occasionTitle: ' تولد سارا ',
          occasionOriginDate: TODAY,
          occasionYearly: true,
          occasionAdvance: '7',
        }),
      ),
      message(Calendar.Message.SubmittedOccasion()),
      Command.expectExact(
        Calendar.SaveCalendarOccasion({
          maybeEditingId: Option.none(),
          title: 'تولد سارا',
          originDate: TODAY,
          yearly: true,
          maybeAdvanceDays: Option.some(7),
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Calendar.SaveCalendarOccasion,
        Calendar.Message.CompletedSaveOccasion({
          occasionId: OCCASION_ID,
          title: 'تولد سارا',
          isEdit: false,
        }),
      ),
      model(next => {
        expect(next.occasionTitle).toBe('')
        expect(next.occasionAnnouncement).toBe('مناسبت «تولد سارا» افزوده شد')
        expect(next.maybeOccasionBusy).toStrictEqual(Option.none())
      }),
      expectOutMessage(Calendar.OutMessage.WroteLocalData()),
    )
  })

  test('editing fills the form and saves the same row', () => {
    story(
      update(
        weekInputs({ mirror: mirrorWith({ occasions: [occasionRow()] }) }),
      ),
      given(calendarModel()),
      message(
        Calendar.Message.ClickedEditOccasion({ occasionId: OCCASION_ID }),
      ),
      model(next => {
        expect(next.occasionTitle).toBe('تولد مامان')
        expect(next.occasionOriginDate).toBe(TODAY)
        expect(next.occasionAdvance).toBe('7')
      }),
      message(Calendar.Message.SubmittedOccasion()),
      Command.expectExact(
        Calendar.SaveCalendarOccasion({
          maybeEditingId: Option.some(OCCASION_ID),
          title: 'تولد مامان',
          originDate: TODAY,
          yearly: true,
          maybeAdvanceDays: Option.some(7),
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Calendar.SaveCalendarOccasion,
        Calendar.Message.CompletedSaveOccasion({
          occasionId: OCCASION_ID,
          title: 'تولد مامان',
          isEdit: true,
        }),
      ),
      model(next => {
        expect(next.occasionEditingId).toStrictEqual(Option.none())
        expect(next.occasionAnnouncement).toBe('مناسبت «تولد مامان» ویرایش شد')
      }),
    )
  })

  test('deleting an occasion writes a tombstone', () => {
    story(
      update(
        weekInputs({ mirror: mirrorWith({ occasions: [occasionRow()] }) }),
      ),
      given(calendarModel()),
      message(
        Calendar.Message.ClickedDeleteOccasion({
          occasionId: OCCASION_ID,
          title: 'تولد مامان',
        }),
      ),
      Command.expectExact(
        Calendar.DeleteCalendarOccasion({
          occasionId: OCCASION_ID,
          title: 'تولد مامان',
        }),
      ),
      Command.resolve(
        Calendar.DeleteCalendarOccasion,
        Calendar.Message.CompletedDeleteOccasion({
          occasionId: OCCASION_ID,
          title: 'تولد مامان',
        }),
      ),
      model(next => {
        expect(next.occasionAnnouncement).toBe('مناسبت «تولد مامان» حذف شد')
      }),
      expectOutMessage(Calendar.OutMessage.WroteLocalData()),
    )
  })

  test('preparing a task starts from the row and announces the result', () => {
    story(
      update(
        weekInputs({ mirror: mirrorWith({ occasions: [occasionRow()] }) }),
      ),
      given(calendarModel()),
      message(
        Calendar.Message.ClickedPrepareOccasion({
          occasionId: OCCASION_ID,
          title: 'تولد مامان',
        }),
      ),
      Command.expectExact(
        Calendar.PrepareCalendarOccasionTask({
          occasion: occasionRow(),
          today: TODAY,
        }),
      ),
      Command.resolve(
        Calendar.PrepareCalendarOccasionTask,
        Calendar.Message.CompletedPrepareOccasion({
          title: 'تولد مامان',
          created: true,
        }),
      ),
      model(next => {
        expect(next.occasionAnnouncement).toBe(
          'کار آماده‌سازی برای «تولد مامان» ساخته شد',
        )
      }),
      expectOutMessage(Calendar.OutMessage.WroteLocalData()),
    )
  })

  test('a missing next occurrence shows the legacy error copy', () => {
    story(
      defaultUpdate,
      given(calendarModel()),
      message(
        Calendar.Message.FailedPrepareOccasion({
          noUpcomingOccurrence: true,
          message: 'this occasion has no upcoming occurrence',
        }),
      ),
      model(next => {
        expect(next.maybeOccasionError).toStrictEqual(
          Option.some('برای این مناسبت تاریخ بعدی وجود ندارد'),
        )
      }),
    )
  })
})

describe('Calendar visibility actions', () => {
  test('the event owner toggles the series to private', () => {
    story(
      update(weekInputs()),
      given(calendarModel()),
      message(
        Calendar.Message.OpenedEventEditor({ occurrence: oneOffOccurrence }),
      ),
      Command.resolve(
        Calendar.FocusEventEditor,
        Calendar.Message.CompletedFocusEventEditor(),
      ),
      message(Calendar.Message.ClickedToggleEventVisibility()),
      Command.expectExact(
        Calendar.SetCalendarEventVisibility({
          eventId: EVENT_ID,
          visibility: 'private',
        }),
      ),
      Command.resolve(
        Calendar.SetCalendarEventVisibility,
        Calendar.Message.CompletedSetEventVisibility({
          eventId: EVENT_ID,
          visibility: 'private',
        }),
      ),
      expectOutMessage(Calendar.OutMessage.WroteLocalData()),
      model(next => {
        expect(next.announcement).toBe('رویداد خصوصی شد')
      }),
    )
  })

  test('a partner does not get the event share command', () => {
    story(
      update(
        weekInputs({
          mirror: mirrorWith({
            events: [eventRow({ ownerId: 'another-user' })],
          }),
        }),
      ),
      given(calendarModel()),
      message(
        Calendar.Message.OpenedEventEditor({ occurrence: oneOffOccurrence }),
      ),
      Command.resolve(
        Calendar.FocusEventEditor,
        Calendar.Message.CompletedFocusEventEditor(),
      ),
      message(Calendar.Message.ClickedToggleEventVisibility()),
      Command.expectNone(),
    )
  })

  test('the occasion owner toggles it to shared', () => {
    story(
      update(
        weekInputs({
          mirror: mirrorWith({
            occasions: [
              occasionRow({ ownerId: USER_ID, visibility: 'private' }),
            ],
          }),
        }),
      ),
      given(calendarModel()),
      message(
        Calendar.Message.ClickedEditOccasion({ occasionId: OCCASION_ID }),
      ),
      message(Calendar.Message.ClickedToggleOccasionVisibility()),
      Command.expectExact(
        Calendar.SetCalendarOccasionVisibility({
          occasionId: OCCASION_ID,
          visibility: 'shared',
        }),
      ),
      Command.resolve(
        Calendar.SetCalendarOccasionVisibility,
        Calendar.Message.CompletedSetOccasionVisibility({
          occasionId: OCCASION_ID,
          visibility: 'shared',
        }),
      ),
      expectOutMessage(Calendar.OutMessage.WroteLocalData()),
      model(next => {
        expect(next.occasionAnnouncement).toBe(
          'مناسبت با خانه به اشتراک گذاشته شد',
        )
      }),
    )
  })

  test('a partner does not get the occasion share command', () => {
    story(
      update(weekInputs()),
      given(calendarModel()),
      message(
        Calendar.Message.ClickedEditOccasion({ occasionId: OCCASION_ID }),
      ),
      message(Calendar.Message.ClickedToggleOccasionVisibility()),
      Command.expectNone(),
    )
  })
})
