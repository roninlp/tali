import { Option } from 'effect'
import {
  Command,
  expectOutMessage,
  given,
  message,
  model,
  story,
} from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import * as Reminders from './reminders'
import {
  DISPATCH_ID,
  SECOND_DISPATCH_ID,
  answeredDoneItem,
  choreItem,
  medicationItem,
  remindersModel,
} from './reminders-test-fixtures'

const update = (reminders: Reminders.Model, message: Reminders.Message) =>
  Reminders.update(reminders, message)

describe('reminders entry and reads', () => {
  test('entering the screen drains the queue and reads the inbox', () => {
    const result = Reminders.entered(Reminders.initialModel())

    expect(result.model.isLoading).toBe(true)
    expect(result.model.fetchGeneration).toBe(1)
    expect(result.commands?.[0]?.name).toBe('DrainQueueAndFetchInbox')
  })

  test('a fresh mount resets the history toggle', () => {
    const result = Reminders.entered(
      remindersModel({ isHistory: true, items: [answeredDoneItem()] }),
    )

    expect(result.model.isHistory).toBe(false)
    expect(result.model.items).toStrictEqual([])
  })

  test('becoming visible drains the queue then reads the inbox', () => {
    story(
      update,
      given(Reminders.initialModel()),
      message(Reminders.Message.ChangedVisibility({ isVisible: true })),
      model(next => {
        expect(next.isLoading).toBe(true)
      }),
      Command.expectExact(
        Reminders.DrainQueueAndFetchInbox({
          generation: 1,
          history: false,
        }),
      ),
      Command.resolve(
        Reminders.DrainQueueAndFetchInbox,
        Reminders.Message.CompletedDrainQueueAndFetchInbox({
          generation: 1,
          items: [],
        }),
      ),
    )
  })

  test('a hidden tab reads nothing', () => {
    story(
      update,
      given(Reminders.initialModel()),
      message(Reminders.Message.ChangedVisibility({ isVisible: false })),
      Command.expectNone(),
    )
  })

  test('a queued notification tap re-drains and re-reads the ledger', () => {
    story(
      update,
      given(Reminders.initialModel()),
      message(Reminders.Message.ReceivedReminderAction()),
      Command.expectExact(
        Reminders.DrainQueueAndFetchInbox({
          generation: 1,
          history: false,
        }),
      ),
      Command.resolve(
        Reminders.DrainQueueAndFetchInbox,
        Reminders.Message.CompletedDrainQueueAndFetchInbox({
          generation: 1,
          items: [],
        }),
      ),
    )
  })

  test('a completed drain stores the ledger rows', () => {
    story(
      update,
      given(Reminders.initialModel()),
      message(Reminders.Message.ChangedVisibility({ isVisible: true })),
      Command.resolve(
        Reminders.DrainQueueAndFetchInbox,
        Reminders.Message.CompletedDrainQueueAndFetchInbox({
          generation: 1,
          items: [medicationItem(), choreItem()],
        }),
      ),
      model(next => {
        expect(next.isLoading).toBe(false)
        expect(next.items).toStrictEqual([medicationItem(), choreItem()])
        expect(next.maybeError).toStrictEqual(Option.none())
      }),
    )
  })

  test('a late response from an older generation is ignored', () => {
    story(
      update,
      given(
        remindersModel({
          fetchGeneration: 2,
          isLoading: true,
          items: [medicationItem()],
        }),
      ),
      message(
        Reminders.Message.CompletedFetchInbox({
          generation: 1,
          items: [],
        }),
      ),
      model(next => {
        expect(next.isLoading).toBe(true)
        expect(next.items).toStrictEqual([medicationItem()])
      }),
    )
  })

  test('the history toggle reads the history page', () => {
    story(
      update,
      given(remindersModel({ fetchGeneration: 1 })),
      message(Reminders.Message.ClickedToggleHistory()),
      model(next => {
        expect(next.isHistory).toBe(true)
      }),
      Command.expectExact(
        Reminders.FetchInbox({ generation: 2, history: true }),
      ),
      Command.resolve(
        Reminders.FetchInbox,
        Reminders.Message.CompletedFetchInbox({
          generation: 2,
          items: [],
        }),
      ),
    )
  })

  test('a failed read keeps the previous rows and shows the legacy copy', () => {
    story(
      update,
      given(
        remindersModel({
          fetchGeneration: 1,
          isLoading: true,
          items: [medicationItem()],
        }),
      ),
      message(
        Reminders.Message.FailedFetchInbox({
          generation: 1,
          failure: { code: 'Network', retryable: true },
        }),
      ),
      model(next => {
        expect(next.isLoading).toBe(false)
        expect(next.items).toStrictEqual([medicationItem()])
        expect(next.maybeError).toStrictEqual(
          Option.some(
            'ارتباط با سرور برقرار نشد؛ پاسخ پس از اتصال دوباره فرستاده می‌شود.',
          ),
        )
      }),
    )
  })

  test('an unauthorized read uses the sign-in copy', () => {
    story(
      update,
      given(remindersModel({ fetchGeneration: 1, isLoading: true })),
      message(
        Reminders.Message.FailedDrainQueueAndFetchInbox({
          generation: 1,
          failure: { code: 'Unauthorized', retryable: false },
        }),
      ),
      model(next => {
        expect(next.maybeError).toStrictEqual(
          Option.some('برای پاسخ به یادآوری باید وارد شوید.'),
        )
      }),
    )
  })

  test('a missing dispatch uses the ledger-gone copy', () => {
    story(
      update,
      given(remindersModel({ fetchGeneration: 1, isLoading: true })),
      message(
        Reminders.Message.FailedFetchInbox({
          generation: 1,
          failure: { code: 'NotFound', retryable: false },
        }),
      ),
      model(next => {
        expect(next.maybeError).toStrictEqual(
          Option.some('این یادآوری دیگر در دفتر ارسال نیست.'),
        )
      }),
    )
  })

  test('every other failure uses the retry copy', () => {
    story(
      update,
      given(remindersModel({ fetchGeneration: 1, isLoading: true })),
      message(
        Reminders.Message.FailedFetchInbox({
          generation: 1,
          failure: { code: 'InternalError', retryable: true },
        }),
      ),
      model(next => {
        expect(next.maybeError).toStrictEqual(
          Option.some('ثبت پاسخ ناموفق بود؛ دوباره تلاش کنید.'),
        )
      }),
    )
  })
})

describe('reminders responses', () => {
  test('Done posts without a snooze length and removes the row optimistically', () => {
    story(
      update,
      given(
        remindersModel({
          fetchGeneration: 1,
          items: [medicationItem(), choreItem()],
        }),
      ),
      message(
        Reminders.Message.ClickedRespond({
          dispatchId: DISPATCH_ID,
          response: 'done',
        }),
      ),
      model(next => {
        expect(next.maybeBusyDispatchId).toStrictEqual(Option.some(DISPATCH_ID))
      }),
      Command.expectExact(
        Reminders.RespondToReminder({
          dispatchId: DISPATCH_ID,
          response: 'done',
          maybeSnoozeMinutes: Option.none(),
        }),
      ),
      Command.resolve(
        Reminders.RespondToReminder,
        Reminders.Message.CompletedRespondToReminder({
          dispatchId: DISPATCH_ID,
        }),
      ),
      model(next => {
        expect(next.maybeBusyDispatchId).toStrictEqual(Option.none())
        expect(next.items).toStrictEqual([choreItem()])
        expect(next.isLoading).toBe(true)
      }),
      Command.expectExact(
        Reminders.FetchInbox({ generation: 2, history: false }),
      ),
      Command.resolve(
        Reminders.FetchInbox,
        Reminders.Message.CompletedFetchInbox({
          generation: 2,
          items: [choreItem()],
        }),
      ),
    )
  })

  test('Snooze carries the selected preset', () => {
    story(
      update,
      given(
        remindersModel({
          fetchGeneration: 1,
          items: [medicationItem()],
        }),
      ),
      message(Reminders.Message.ChangedSnoozeMinutes({ minutes: 15 })),
      model(next => {
        expect(next.snoozeMinutes).toBe(15)
      }),
      message(
        Reminders.Message.ClickedRespond({
          dispatchId: DISPATCH_ID,
          response: 'snooze',
        }),
      ),
      Command.expectExact(
        Reminders.RespondToReminder({
          dispatchId: DISPATCH_ID,
          response: 'snooze',
          maybeSnoozeMinutes: Option.some(15),
        }),
      ),
      Command.resolve(
        Reminders.RespondToReminder,
        Reminders.Message.CompletedRespondToReminder({
          dispatchId: DISPATCH_ID,
        }),
      ),
      Command.resolve(
        Reminders.FetchInbox,
        Reminders.Message.CompletedFetchInbox({
          generation: 2,
          items: [medicationItem()],
        }),
      ),
    )
  })

  test('Dismiss posts the answer for the clicked row', () => {
    story(
      update,
      given(
        remindersModel({
          fetchGeneration: 1,
          items: [medicationItem(), choreItem()],
        }),
      ),
      message(
        Reminders.Message.ClickedRespond({
          dispatchId: SECOND_DISPATCH_ID,
          response: 'dismiss',
        }),
      ),
      Command.expectExact(
        Reminders.RespondToReminder({
          dispatchId: SECOND_DISPATCH_ID,
          response: 'dismiss',
          maybeSnoozeMinutes: Option.none(),
        }),
      ),
      Command.resolve(
        Reminders.RespondToReminder,
        Reminders.Message.CompletedRespondToReminder({
          dispatchId: SECOND_DISPATCH_ID,
        }),
      ),
      Command.resolve(
        Reminders.FetchInbox,
        Reminders.Message.CompletedFetchInbox({
          generation: 2,
          items: [medicationItem()],
        }),
      ),
    )
  })

  test('a second tap waits while one answer is in flight', () => {
    const first = Reminders.update(
      remindersModel({
        fetchGeneration: 1,
        items: [medicationItem(), choreItem()],
      }),
      Reminders.Message.ClickedRespond({
        dispatchId: DISPATCH_ID,
        response: 'done',
      }),
    )

    const second = Reminders.update(
      first.model,
      Reminders.Message.ClickedRespond({
        dispatchId: SECOND_DISPATCH_ID,
        response: 'dismiss',
      }),
    )

    expect(second.commands).toBeUndefined()
    expect(second.model.maybeBusyDispatchId).toStrictEqual(
      Option.some(DISPATCH_ID),
    )
  })

  test('a failed answer keeps the row and surfaces the copy', () => {
    story(
      update,
      given(
        remindersModel({
          fetchGeneration: 1,
          items: [medicationItem()],
          maybeBusyDispatchId: Option.some(DISPATCH_ID),
        }),
      ),
      message(
        Reminders.Message.FailedRespondToReminder({
          dispatchId: DISPATCH_ID,
          failure: { code: 'Network', retryable: true },
        }),
      ),
      model(next => {
        expect(next.maybeBusyDispatchId).toStrictEqual(Option.none())
        expect(next.items).toStrictEqual([medicationItem()])
        expect(next.maybeError).toStrictEqual(
          Option.some(
            'ارتباط با سرور برقرار نشد؛ پاسخ پس از اتصال دوباره فرستاده می‌شود.',
          ),
        )
      }),
    )
  })

  test('a snooze length outside the preset set is ignored', () => {
    story(
      update,
      given(Reminders.initialModel()),
      message(Reminders.Message.ChangedSnoozeMinutes({ minutes: 7 })),
      model(next => {
        expect(next.snoozeMinutes).toBe(10)
      }),
    )
  })
})

describe('reminder visibility', () => {
  test('the inbox share action writes the next visibility and updates the row', () => {
    const item = medicationItem()

    story(
      update,
      given(remindersModel({ items: [item] })),
      message(
        Reminders.Message.ClickedToggleReminderVisibility({
          reminderId: item.reminderId,
          visibility: 'shared',
        }),
      ),
      Command.expectExact(
        Reminders.SetReminderVisibility({
          reminderId: item.reminderId,
          visibility: 'shared',
        }),
      ),
      Command.resolve(
        Reminders.SetReminderVisibility,
        Reminders.Message.CompletedSetReminderVisibility({
          reminderId: item.reminderId,
          visibility: 'shared',
        }),
      ),
      expectOutMessage(Reminders.OutMessage.WroteLocalData()),
      model(next => {
        expect(next.items[0]?.visibility).toBe('shared')
      }),
    )
  })
})
