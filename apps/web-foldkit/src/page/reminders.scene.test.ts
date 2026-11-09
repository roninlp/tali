import { Option } from 'effect'
import {
  Command,
  Mount,
  all,
  click,
  expect,
  expectAll,
  given,
  nth,
  role,
  scene,
  text,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { Listbox } from '@foldkit/ui'

import * as Reminders from './reminders'
import {
  formatReminderInstant,
  formatRespondedAt,
  responseCopy,
} from './reminders-model'
import {
  DISPATCH_ID,
  answeredDoneItem,
  answeredSnoozeItem,
  choreItem,
  dismissedItem,
  medicationItem,
  remindersModel,
} from './reminders-test-fixtures'

const inboxScene = () => ({
  update: Reminders.update,
  view: Reminders.view,
})

describe('reminders inbox', () => {
  test('the first read shows the ledger spinner', () => {
    scene(
      inboxScene(),
      given(remindersModel({ isLoading: true })),
      expect(role('heading', { name: 'یادآورهای ازدست‌رفته' })).toExist(),
      expect(role('button', { name: 'تاریخچه' })).toExist(),
      expect(text('در حال خواندن دفتر ارسال…')).toExist(),
    )
  })

  test('an empty inbox explains why a missed reminder lands here', () => {
    scene(
      inboxScene(),
      given(remindersModel()),
      expect(
        text(
          'یادآوری بی‌پاسخی نیست. هر یادآوری که مرورگر آن را ندیده باشد اینجا می‌آید، نه اینکه ناپدید شود.',
        ),
      ).toExist(),
      expect(text(/این فهرست از دفتر ارسال سرور خوانده می‌شود/)).toExist(),
    )
  })

  test('a failed read is a calm alert above the empty copy', () => {
    const failure = 'برای پاسخ به یادآوری باید وارد شوید.'

    scene(
      inboxScene(),
      given(remindersModel({ maybeError: Option.some(failure) })),
      expect(role('alert')).toHaveText(failure),
      expect(text(failure)).toExist(),
    )
  })

  test('a row shows its title, time, kind, medication badge, and note', () => {
    const model = remindersModel({ items: [medicationItem(), choreItem()] })

    scene(
      inboxScene(),
      given(model),
      expect(text('داروی فشار')).toExist(),
      expect(text('آب دادن گلدان‌ها')).toExist(),
      expect(text('یک قرص همراه با غذا')).toExist(),
      expect(text('کار خانه')).toExist(),
      expectAll(all.text('دارو')).toHaveCount(2),
      expect(text(formatReminderInstant('2026-10-20T08:00:00.000Z'))).toExist(),
      expectAll(
        all.role('button', { name: 'مدت به تعویق انداختن' }),
      ).toHaveCount(2),
    )
  })

  test('Done posts the answer and the answered row disappears', () => {
    const model = remindersModel({
      fetchGeneration: 1,
      items: [medicationItem()],
    })

    scene(
      inboxScene(),
      given(model),
      click(role('button', { name: 'انجام شد' })),
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
      Command.expectExact(
        Reminders.FetchInbox({ generation: 2, history: false }),
      ),
      Command.resolve(
        Reminders.FetchInbox,
        Reminders.Message.CompletedFetchInbox({
          generation: 2,
          items: [],
        }),
      ),
      expect(text('داروی فشار')).toBeAbsent(),
      expect(role('button', { name: 'انجام شد' })).toBeAbsent(),
    )
  })

  test('the snooze preset feeds the Snooze answer', () => {
    const model = remindersModel({
      fetchGeneration: 1,
      items: [medicationItem()],
    })

    const snoozeButton = role('button', { name: 'مدت به تعویق انداختن' })

    scene(
      inboxScene(),
      given(model),
      expect(snoozeButton).toHaveText('10 دقیقه'),
      click(snoozeButton),
      Mount.resolve(
        Listbox.AnchorListbox,
        Listbox.Message.CompletedAnchorListbox(),
      ),
      Mount.resolve(
        Listbox.PortalListboxBackdrop,
        Listbox.Message.CompletedPortalListboxBackdrop(),
      ),
      Command.resolve(
        Listbox.FocusItems,
        Listbox.Message.CompletedFocusItems(),
      ),
      click(text('30 دقیقه')),
      Command.resolve(
        Listbox.FocusButton,
        Listbox.Message.CompletedFocusButton(),
      ),
      Mount.expectEnded(Listbox.AnchorListbox),
      Mount.expectEnded(Listbox.PortalListboxBackdrop),
      expect(snoozeButton).toHaveText('30 دقیقه'),
      click(role('button', { name: 'بعداً' })),
      Command.expectExact(
        Reminders.RespondToReminder({
          dispatchId: DISPATCH_ID,
          response: 'snooze',
          maybeSnoozeMinutes: Option.some(30),
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

  test('an in-flight answer disables the other row actions', () => {
    const model = remindersModel({
      items: [medicationItem()],
      maybeBusyDispatchId: Option.some(DISPATCH_ID),
    })

    scene(
      inboxScene(),
      given(model),
      expect(role('button', { name: 'انجام شد' })).toBeDisabled(),
      expect(role('button', { name: 'بعداً' })).toBeDisabled(),
      expect(role('button', { name: 'کنار گذاشتن' })).toBeDisabled(),
      expect(role('button', { name: 'مدت به تعویق انداختن' })).toBeEnabled(),
    )
  })
})

describe('reminders history', () => {
  test('the history page shows the recorded Done answer instead of actions', () => {
    const item = answeredDoneItem()
    const model = remindersModel({ isHistory: true, items: [item] })

    scene(
      inboxScene(),
      given(model),
      expect(role('heading', { name: 'تاریخچه‌ی یادآوری‌ها' })).toExist(),
      expect(role('button', { name: 'بازگشت به صندوق' })).toExist(),
      expect(
        text(
          `${responseCopy('done')} · ${formatRespondedAt(item.dispatch.respondedAt)}`,
        ),
      ).toExist(),
      expect(role('button', { name: 'انجام شد' })).toBeAbsent(),
    )
  })

  test('Snooze and Dismiss answers keep their own words', () => {
    const snoozed = answeredSnoozeItem()
    const dismissed = dismissedItem()

    const model = remindersModel({
      isHistory: true,
      items: [snoozed, dismissed],
    })

    scene(
      inboxScene(),
      given(model),
      expect(text(/به بعد موکول شد/)).toExist(),
      expect(text(/کنار گذاشته شد/)).toExist(),
    )
  })

  test('an empty history page says so', () => {
    scene(
      inboxScene(),
      given(remindersModel({ isHistory: true })),
      expect(text('هنوز یادآوری پاسخ‌داده‌شده‌ای ثبت نشده است.')).toExist(),
    )
  })

  test('the toggle opens history and reads the history page', () => {
    const item = answeredDoneItem()
    const model = remindersModel({ fetchGeneration: 1 })

    scene(
      inboxScene(),
      given(model),
      click(role('button', { name: 'تاریخچه' })),
      expect(role('heading', { name: 'تاریخچه‌ی یادآوری‌ها' })).toExist(),
      Command.expectExact(
        Reminders.FetchInbox({ generation: 2, history: true }),
      ),
      Command.resolve(
        Reminders.FetchInbox,
        Reminders.Message.CompletedFetchInbox({
          generation: 2,
          items: [item],
        }),
      ),
      expect(text(item.title)).toExist(),
      expect(
        text(
          `${responseCopy(item.dispatch.response)} · ${formatRespondedAt(item.dispatch.respondedAt)}`,
        ),
      ).toExist(),
      expect(role('button', { name: 'بازگشت به صندوق' })).toExist(),
    )
  })

  test('the history button returns to the inbox', () => {
    const model = remindersModel({
      isHistory: true,
      fetchGeneration: 2,
      items: [answeredDoneItem()],
    })

    scene(
      inboxScene(),
      given(model),
      click(role('button', { name: 'بازگشت به صندوق' })),
      expect(role('heading', { name: 'یادآورهای ازدست‌رفته' })).toExist(),
      Command.expectExact(
        Reminders.FetchInbox({ generation: 3, history: false }),
      ),
      Command.resolve(
        Reminders.FetchInbox,
        Reminders.Message.CompletedFetchInbox({
          generation: 3,
          items: [medicationItem()],
        }),
      ),
    )
  })

  test('only the clicked row carries the busy state', () => {
    const model = remindersModel({
      items: [medicationItem(), choreItem()],
      maybeBusyDispatchId: Option.some(DISPATCH_ID),
    })

    scene(
      inboxScene(),
      given(model),
      expect(nth(all.role('button', { name: 'انجام شد' }), 0)).toBeDisabled(),
      expect(nth(all.role('button', { name: 'انجام شد' }), 1)).toBeDisabled(),
    )
  })

  test('the inbox offers share/unshare for the reminder', () => {
    const item = medicationItem()

    scene(
      inboxScene(),
      given(remindersModel({ items: [item] })),
      expect(role('button', { name: 'اشتراک با خانه' })).toExist(),
      click(role('button', { name: 'اشتراک با خانه' })),
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
    )
  })
})
