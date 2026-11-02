import { Option } from 'effect'
import {
  Command,
  all,
  click,
  expect,
  expectAll,
  given,
  role,
  scene,
  selector,
  submit,
  text,
  type,
  withViewInputs,
  within,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import * as Calendar from './calendar'
import type { Inputs, Model } from './calendar'
import { USER_ID } from '../test-fixtures'
import {
  CALENDAR_TASK_ID,
  EVENT_ID,
  TODAY,
  calendarInputs,
  calendarModel,
  calendarTask,
  eventRow,
  mirrorWith,
  occasionRow,
  timedEventRow,
  weeklyEventRow,
} from './calendar-test-fixtures'

const setup = (overrides: Partial<Inputs> = {}) => {
  const viewInputs = calendarInputs(overrides)

  return {
    update: (calendar: Model, message: Calendar.Message) =>
      Calendar.update(calendar, message, viewInputs),
    view: withViewInputs(Calendar.view, viewInputs)(),
  }
}

const TODAY_LABEL = 'جمعه ۸ آبان ۱۴۰۵'
const WEEK_TITLE = '۲ آبان – ۸ آبان'

const weekWithTasks = () =>
  setup({
    mirror: mirrorWith({ tasks: [calendarTask()] }),
  })

const tab = (name: string) => role('button', { name })

const dayCard = (label: string) => selector(`section[aria-label="${label}"]`)

describe('Calendar week view', () => {
  test('renders seven day cards with the quick add, the event disclosure and the quiet lanes', () => {
    scene(
      weekWithTasks(),
      given(calendarModel()),
      expect(role('heading', { name: 'تقویم' })).toExist(),
      expect(text(WEEK_TITLE)).toExist(),
      expectAll(all.selector('.calendar-day-card')).toHaveCount(7),
      expect(
        role('textbox', { name: `کار تازه برای ${TODAY_LABEL}` }),
      ).toExist(),
      expectAll(all.selector('.calendar-event-add')).toHaveCount(7),
      expect(text('رویداد زمانی — خالی')).toExist(),
      expect(text('یادآوری — خالی')).toExist(),
      expect(text('عادت — خالی')).toExist(),
      expect(dayCard(TODAY_LABEL)).toHaveAttr('data-today', 'true'),
      expect(selector('[aria-current="date"]')).toHaveAttr(
        'aria-label',
        TODAY_LABEL,
      ),
    )
  })

  test('shows a task with its completion and priority affordances', () => {
    scene(
      setup({
        mirror: mirrorWith({
          tasks: [calendarTask({ priority: 'high' })],
        }),
      }),
      given(calendarModel()),
      expect(role('checkbox', { name: 'انجام خرید نان' })).toExist(),
      expect(role('link', { name: 'خرید نان' })).toHaveAttr(
        'href',
        `/tasks#task-${CALENDAR_TASK_ID}`,
      ),
      expect(text('اولویت بالا')).toExist(),
    )
  })

  test('keeps a projected recurrence read-only', () => {
    scene(
      setup({
        mirror: mirrorWith({
          tasks: [
            calendarTask({
              id: '0192f0a0-0000-7000-8000-000000000045',
              title: 'ورزش',
              dueDate: '2026-10-17',
              recurrence: {
                frequency: 'weekly',
                interval: 1,
                byDay: [6],
                end: { _tag: 'never' },
              },
              recurrenceMode: 'onDueDate',
            }),
          ],
        }),
      }),
      given(calendarModel()),
      expect(text('ورزش')).toExist(),
      expect(text('تکرارشونده — فقط نمایش')).toExist(),
      expect(role('checkbox', { name: 'انجام ورزش' })).toBeAbsent(),
    )
  })

  test('paints all-day events as chips and timed events on the time grid', () => {
    scene(
      setup({
        mirror: mirrorWith({
          events: [eventRow(), timedEventRow()],
        }),
      }),
      given(calendarModel()),
      expect(
        selector(`section[aria-label="${TODAY_LABEL}"] .calendar-event-chip`),
      ).toHaveText('سفر'),
      expect(
        selector(`section[aria-label="${TODAY_LABEL}"] .calendar-time-grid`),
      ).toExist(),
      expect(
        selector(`section[aria-label="${TODAY_LABEL}"] .calendar-time-event`),
      ).toHaveAttr('aria-label', '۰۹:۰۰ جلسه'),
    )
  })

  test('opens the week planning panel and prioritises a task', () => {
    scene(
      weekWithTasks(),
      given(calendarModel()),
      expect(tab('برنامه‌ریزی هفته')).toHaveAttr('aria-expanded', 'false'),
      click(tab('برنامه‌ریزی هفته')),
      expect(tab('برنامه‌ریزی هفته')).toHaveAttr('aria-expanded', 'true'),
      expect(role('region', { name: 'برنامه‌ریزی هفته' })).toExist(),
      expect(role('combobox', { name: 'اولویت خرید نان' })).toHaveValue(
        'medium',
      ),
    )
  })

  test('quick-adds a task and clears the field after the write completes', () => {
    scene(
      weekWithTasks(),
      given(calendarModel()),
      type(
        role('textbox', { name: `کار تازه برای ${TODAY_LABEL}` }),
        'خرید شیر',
      ),
      submit(
        within(selector(`section[aria-label="${TODAY_LABEL}"]`), role('form')),
      ),
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
          taskId: '0192f0a0-0000-7000-8000-000000000099',
          title: 'خرید شیر',
          date: TODAY,
        }),
      ),
      expect(
        role('textbox', { name: `کار تازه برای ${TODAY_LABEL}` }),
      ).toHaveValue(''),
    )
  })

  test('announces a completed task and removes it from the grid', () => {
    scene(
      setup({
        mirror: mirrorWith({
          tasks: [calendarTask({ status: 'done' })],
        }),
      }),
      given(calendarModel()),
      expect(text('خرید نان')).toBeAbsent(),
    )
  })
})

describe('Calendar month view', () => {
  test('switches to the month grid and counts the lanes on each day', () => {
    scene(
      setup({
        isOnline: false,
        mirror: mirrorWith({
          tasks: [calendarTask()],
          events: [eventRow()],
          occasions: [occasionRow({ color: '#9f1239' })],
        }),
      }),
      given(calendarModel()),
      click(tab('ماه')),
      expect(role('list', { name: 'آبان ۱۴۰۵' })).toExist(),
      expect(tab('جمعه ۸ آبان ۱۴۰۵ — ۱ کار — ۱ رویداد — ۱ مناسبت')).toExist(),
      expectAll(
        all.selector(
          '.calendar-month-day[data-today="true"] .calendar-month-dot',
        ),
      ).toHaveCount(2),
      expect(selector('.calendar-event-chip-month')).toHaveText('سفر'),
      expect(
        within(
          selector('.calendar-month-day[data-today="true"]'),
          selector('.calendar-occasion-chip'),
        ),
      ).toHaveText('تولد مامان'),
    )
  })

  test('opens the day drill-down and closes it again', () => {
    scene(
      setup({
        isOnline: false,
        mirror: mirrorWith({
          tasks: [calendarTask()],
          events: [eventRow()],
          occasions: [occasionRow()],
        }),
      }),
      given(calendarModel()),
      click(tab('ماه')),
      click(tab('جمعه ۸ آبان ۱۴۰۵ — ۱ کار — ۱ رویداد — ۱ مناسبت')),
      expect(role('region', { name: 'جزئیات روز' })).toExist(),
      expect(
        within(role('region', { name: 'جزئیات روز' }), text('تولد مامان')),
      ).toExist(),
      expect(
        within(role('region', { name: 'جزئیات روز' }), text('سفر')),
      ).toExist(),
      click(
        within(
          role('region', { name: 'جزئیات روز' }),
          role('button', { name: 'بستن جزئیات روز' }),
        ),
      ),
      expect(role('region', { name: 'جزئیات روز' })).toBeAbsent(),
    )
  })

  test('renders the reserved habit trend strip', () => {
    scene(
      setup({ isOnline: false }),
      given(calendarModel()),
      click(tab('ماه')),
      expect(role('region', { name: 'روند عادت‌ها' })).toExist(),
      expect(
        text('نمودار ماهانهٔ عادت‌ها در گام عادت‌ها این‌جا نمایش داده می‌شود.'),
      ).toExist(),
    )
  })
})

describe('Calendar occasions panel', () => {
  test('lists the occasions with both calendars and the actions', () => {
    scene(
      setup({ mirror: mirrorWith({ occasions: [occasionRow()] }) }),
      given(calendarModel()),
      expect(role('region', { name: 'مناسبت‌ها' })).toExist(),
      expect(text('۱ مناسبت ثبت شده')).toExist(),
      expect(selector('[data-occasion-id]')).toContainText('·'),
      expect(role('button', { name: 'آماده‌سازی تولد مامان' })).toBeEnabled(),
      expect(role('button', { name: 'ویرایش تولد مامان' })).toExist(),
      expect(role('button', { name: 'حذف تولد مامان' })).toExist(),
    )
  })

  test('the empty panel explains what occasions are for', () => {
    scene(
      setup(),
      given(calendarModel()),
      expect(
        text(
          'هنوز مناسبت‌ی ثبت نشده است. تولدها و سالگردها را این‌جا اضافه کنید تا هر سال خودشان در تقویم بیایند.',
        ),
      ).toExist(),
    )
  })

  test('editing fills the one form and cancelling clears it', () => {
    scene(
      setup({ mirror: mirrorWith({ occasions: [occasionRow()] }) }),
      given(calendarModel()),
      click(role('button', { name: 'ویرایش تولد مامان' })),
      expect(role('textbox', { name: 'عنوان مناسبت' })).toHaveValue(
        'تولد مامان',
      ),
      expect(role('button', { name: 'ذخیرهٔ ویرایش' })).toExist(),
      click(role('button', { name: 'انصراف' })),
      expect(role('button', { name: 'افزودن مناسبت' })).toExist(),
      expect(role('textbox', { name: 'عنوان مناسبت' })).toHaveValue(''),
    )
  })

  test('a page error appears as an alert', () => {
    scene(
      setup(),
      given(
        modifyFields(calendarModel(), {
          maybePageError: () => Option.some('ذخیره در حافظه‌ی محلی ناموفق بود'),
        }),
      ),
      expect(role('alert')).toHaveText('ذخیره در حافظه‌ی محلی ناموفق بود'),
    )
  })
})

describe('Calendar event editor', () => {
  test('opens an occurrence with its draft fields', () => {
    scene(
      setup({
        mirror: mirrorWith({ events: [eventRow()] }),
      }),
      given(calendarModel()),
      click(role('button', { name: 'سفر' })),
      Command.expectExact(Calendar.FocusEventEditor()),
      Command.resolve(
        Calendar.FocusEventEditor,
        Calendar.Message.CompletedFocusEventEditor(),
      ),
      expect(role('dialog', { name: 'رویداد' })).toExist(),
      expect(role('textbox', { name: 'عنوان رویداد' })).toHaveValue('سفر'),
      expect(role('checkbox', { name: 'تمام روز' })).toBeChecked(),
      expect(role('textbox', { name: 'تاریخ رویداد' })).toHaveValue(TODAY),
      expect(role('button', { name: 'ذخیره' })).toBeEnabled(),
      expect(role('button', { name: 'حذف رویداد' })).toBeEnabled(),
    )
  })

  test('a recurring occurrence asks the scope question before writing', () => {
    scene(
      setup({ mirror: mirrorWith({ events: [weeklyEventRow()] }) }),
      given(calendarModel()),
      click(role('button', { name: 'جلسهٔ هفتگی' })),
      Command.expectExact(Calendar.FocusEventEditor()),
      Command.resolve(
        Calendar.FocusEventEditor,
        Calendar.Message.CompletedFocusEventEditor(),
      ),
      submit(within(role('dialog', { name: 'رویداد' }), role('form'))),
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
        Calendar.Message.CompletedGenerateEventScopeIds({
          ids: {
            exceptionId: '0192f0a0-0000-7000-8000-000000000050',
            followingId: '0192f0a0-0000-7000-8000-000000000051',
            clientMutationId: '0192f0a0-0000-7000-8000-000000000052',
            followingMutationId: '0192f0a0-0000-7000-8000-000000000053',
          },
        }),
      ),
      expect(
        role('dialog', {
          name: 'این رویداد یا این رویداد و رویدادهای بعدی؟',
        }),
      ).toExist(),
      expect(role('radio', { name: /فقط این رویداد/ })).toExist(),
      expect(
        role('radio', { name: /این رویداد و رویدادهای بعدی/ }),
      ).toBeEnabled(),
    )
  })

  test('an offline recurring edit offers the split as unavailable', () => {
    scene(
      setup({
        mirror: mirrorWith({ events: [weeklyEventRow()] }),
        isOnline: false,
      }),
      given(calendarModel()),
      click(role('button', { name: 'جلسهٔ هفتگی' })),
      Command.expectExact(Calendar.FocusEventEditor()),
      Command.resolve(
        Calendar.FocusEventEditor,
        Calendar.Message.CompletedFocusEventEditor(),
      ),
      submit(within(role('dialog', { name: 'رویداد' }), role('form'))),
      Command.resolve(
        Calendar.FocusScopePrompt,
        Calendar.Message.CompletedFocusScopePrompt(),
      ),
      Command.resolve(
        Calendar.GenerateEventScopeIds,
        Calendar.Message.CompletedGenerateEventScopeIds({
          ids: {
            exceptionId: '0192f0a0-0000-7000-8000-000000000050',
            followingId: '0192f0a0-0000-7000-8000-000000000051',
            clientMutationId: '0192f0a0-0000-7000-8000-000000000052',
            followingMutationId: '0192f0a0-0000-7000-8000-000000000053',
          },
        }),
      ),
      expect(
        role('radio', { name: /این رویداد و رویدادهای بعدی/ }),
      ).toBeDisabled(),
      expect(text(/به سرور متصل باشید/)).toExist(),
    )
  })

  test('shows the source hint while offline', () => {
    scene(
      setup({ isOnline: false }),
      given(calendarModel()),
      expect(text('آفلاین — نمایش از حافظهٔ محلی')).toExist(),
    )
  })

  test('a closed store disables the quick add', () => {
    scene(
      setup({ isStoreReady: false }),
      given(calendarModel()),
      expect(
        role('textbox', { name: `کار تازه برای ${TODAY_LABEL}` }),
      ).toBeDisabled(),
    )
  })
})

describe('Calendar visibility controls', () => {
  test('the event owner sees the unshare action', () => {
    scene(
      setup({ mirror: mirrorWith({ events: [eventRow()] }) }),
      given(calendarModel()),
      click(role('button', { name: 'سفر' })),
      Command.resolve(
        Calendar.FocusEventEditor,
        Calendar.Message.CompletedFocusEventEditor(),
      ),
      expect(role('button', { name: 'فقط خودم' })).toExist(),
      click(role('button', { name: 'فقط خودم' })),
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
    )
  })

  test('a partner does not see the event share action', () => {
    scene(
      setup({
        mirror: mirrorWith({ events: [eventRow({ ownerId: 'another-user' })] }),
      }),
      given(calendarModel()),
      click(role('button', { name: 'سفر' })),
      Command.resolve(
        Calendar.FocusEventEditor,
        Calendar.Message.CompletedFocusEventEditor(),
      ),
      expect(role('button', { name: 'فقط خودم' })).toBeAbsent(),
    )
  })

  test('the occasion owner sees the share action', () => {
    scene(
      setup({
        mirror: mirrorWith({
          occasions: [occasionRow({ ownerId: USER_ID, visibility: 'private' })],
        }),
      }),
      given(calendarModel()),
      click(role('button', { name: 'ویرایش تولد مامان' })),
      expect(role('button', { name: 'اشتراک با خانه' })).toExist(),
    )
  })

  test('a partner does not see the occasion share action', () => {
    scene(
      setup({ mirror: mirrorWith({ occasions: [occasionRow()] }) }),
      given(calendarModel()),
      click(role('button', { name: 'ویرایش تولد مامان' })),
      expect(role('button', { name: 'اشتراک با خانه' })).toBeAbsent(),
    )
  })
})
