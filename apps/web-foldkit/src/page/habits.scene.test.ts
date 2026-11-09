import { Option } from 'effect'
import {
  Command,
  Mount,
  click,
  expect,
  expectOutMessage,
  given,
  role,
  scene,
  selector,
  submit,
  text,
  type,
  withViewInputs,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import { Animation, Dialog, Toast as UiToast } from '@foldkit/ui'

import { HABIT_COLORS } from '../habits-model'
import { entityKey } from '../mirror'
import { USER_ID } from '../test-fixtures'
import * as Habits from './habits'
import type { Inputs, Model } from './habits'
import {
  HABIT_ID,
  SECOND_HABIT_ID,
  habitEntryRow,
  habitRow,
  habitsInputs,
  habitsModel,
  mirrorWith,
  weeklyHabit,
} from './habits-test-fixtures'

const setup = (overrides: Partial<Inputs> = {}) => {
  const viewInputs = habitsInputs(overrides)

  return {
    update: (habits: Model, message: Habits.Message) =>
      Habits.update(habits, message, viewInputs),
    view: withViewInputs(Habits.view, viewInputs)(),
  }
}

const withWeekly = (overrides: Partial<Inputs> = {}): Inputs =>
  habitsInputs({
    mirror: mirrorWith([weeklyHabit()], []),
    ...overrides,
  })

const todayEntryScene = () =>
  setup({
    mirror: mirrorWith(
      [habitRow()],
      [
        habitEntryRow({
          localDate: '2026-10-30',
          status: 'done',
          updatedAt: '2026-10-30T08:00:00.000Z',
        }),
      ],
    ),
  })

describe('Habits screen', () => {
  test('an empty screen explains the one form and hides the list', () => {
    scene(
      setup({ mirror: mirrorWith() }),
      given(habitsModel()),
      expect(role('heading', { name: 'عادت‌ها' })).toExist(),
      expect(
        text(
          'یک عادت، یک تعریف و یک ثبت روزانه. آمار از ثبت‌ها ساخته می‌شود، نه از حافظه.',
        ),
      ).toExist(),
      expect(text('همه‌چیز روی این دستگاه ذخیره شده است')).toExist(),
      expect(role('heading', { name: 'عادت تازه' })).toExist(),
      expect(role('textbox', { name: 'عنوان عادت' })).toBeEnabled(),
      expect(role('textbox', { name: 'توضیح عادت' })).toExist(),
      expect(role('button', { name: 'افزودن عادت' })).toBeDisabled(),
      expect(
        text(
          'هنوز عادتی ندارید. عنوان را بنویسید و «افزودن عادت» را بزنید؛ همین یک فرم کافی است.',
        ),
      ).toExist(),
      expect(role('button', { name: '۳۰ روز' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      expect(role('button', { name: '۷ روز' })).toHaveAttr(
        'aria-pressed',
        'false',
      ),
    )
  })

  test('the create form submits the typed title and chosen weekdays', () => {
    scene(
      setup({ mirror: mirrorWith() }),
      given(habitsModel()),
      type(role('textbox', { name: 'عنوان عادت' }), 'کتاب خواندن'),
      click(role('button', { name: 'روزهای هفته' })),
      click(role('button', { name: 'سه‌شنبه' })),
      submit(role('form')),
      Command.expectExact(
        Habits.CreateHabit({
          title: 'کتاب خواندن',
          description: Option.none(),
          reminderTime: Option.none(),
          frequency: { _tag: 'weekdays', days: [1, 2, 3, 6] },
          icon: '🌱',
          color: HABIT_COLORS[0]?.value ?? '',
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Habits.CreateHabit,
        Habits.Message.CompletedCreateHabit({
          habitId: HABIT_ID,
          title: 'کتاب خواندن',
        }),
      ),
      expectOutMessage(Habits.OutMessage.WroteLocalData()),
      expect(role('textbox', { name: 'عنوان عادت' })).toHaveValue(''),
    )
  })

  test('a card shows the streak badge, the rate copy and the reminder', () => {
    scene(
      setup(withWeekly()),
      given(habitsModel()),
      expect(role('heading', { name: 'ورزش' })).toExist(),
      expect(role('list', { name: 'عادت‌ها' })).toExist(),
      expect(text('بدون زنجیره · ۰ از ۳ این هفته')).toExist(),
      expect(text('۳ بار در هفته · بهترین: —')).toExist(),
      expect(text(/دورهٔ شمارش: ۲ آبان – ۸ آبان/)).toExist(),
      expect(text(/یادآور ۰۷:۰۰/)).toExist(),
      expect(text('نرخ ۳۰ روزه')).toExist(),
      expect(text('۰ از ۳ این هفته')).toExist(),
      expect(role('button', { name: 'تغییر وضعیت امروز ورزش' })).toHaveAttr(
        'data-status',
        'blank',
      ),
    )
  })

  test("today's logged answer paints the tap button", () => {
    scene(
      todayEntryScene(),
      given(habitsModel()),
      expect(role('button', { name: 'تغییر وضعیت امروز آب خوردن' })).toHaveAttr(
        'data-status',
        'done',
      ),
      expect(text('۱ روز پیاپی')).toExist(),
      expect(text('۳٪')).toExist(),
    )
  })

  test('a tap logs today and announces the new status', () => {
    scene(
      todayEntryScene(),
      given(habitsModel()),
      click(role('button', { name: 'تغییر وضعیت امروز آب خوردن' })),
      Command.expectExact(
        Habits.TapHabit({
          habitId: HABIT_ID,
          title: 'آب خوردن',
          localDate: '2026-10-30',
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Habits.TapHabit,
        Habits.Message.CompletedTapHabit({
          habitId: HABIT_ID,
          title: 'آب خوردن',
          status: 'partial',
        }),
      ),
      expectOutMessage(Habits.OutMessage.WroteLocalData()),
      expect(text('آب خوردن: نیمه')).toExist(),
    )
  })

  test('the edit form swaps the same form to save and cancel', () => {
    scene(
      setup(withWeekly()),
      given(habitsModel()),
      click(role('button', { name: 'ویرایش ورزش' })),
      Command.expectExact(Habits.FocusHabitTitle()),
      Command.resolve(
        Habits.FocusHabitTitle,
        Habits.Message.CompletedFocusHabitTitle(),
      ),
      expect(role('heading', { name: 'ویرایش «ورزش»' })).toExist(),
      expect(role('textbox', { name: 'عنوان عادت' })).toHaveValue('ورزش'),
      expect(role('button', { name: 'ذخیرهٔ عادت' })).toBeEnabled(),
      click(role('button', { name: 'انصراف' })),
      expect(role('heading', { name: 'عادت تازه' })).toExist(),
    )
  })

  test('delete asks for confirmation, then offers the undo toast', () => {
    scene(
      setup(withWeekly()),
      given(habitsModel()),
      click(role('button', { name: 'حذف ورزش' })),
      Mount.resolve(
        Dialog.AcquireResources,
        Dialog.Message.SucceededAcquireResources(),
      ),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      expect(text('عادت «ورزش» حذف شود؟')).toExist(),
      click(role('button', { name: 'حذف' })),
      Command.resolve(
        Dialog.CloseDialog,
        Dialog.Message.CompletedCloseDialog(),
      ),
      Mount.expectEnded(Dialog.AcquireResources),
      Command.expectExact(
        Habits.DeleteHabit({ habitId: SECOND_HABIT_ID, title: 'ورزش' }),
      ),
      Command.resolve(
        Habits.DeleteHabit,
        Habits.Message.CompletedDeleteHabit({
          habitId: SECOND_HABIT_ID,
          title: 'ورزش',
        }),
      ),
      expectOutMessage(Habits.OutMessage.WroteLocalData()),
      expect(text('«ورزش» حذف شد.')).toExist(),
      expect(role('button', { name: 'بازگردانی' })).toExist(),
      Command.resolve(
        Animation.WaitForPaint,
        Animation.Message.CompletedWaitForPaint({ generation: 1 }),
      ),
      Command.resolve(
        Animation.WaitForAnimationSettled,
        Animation.Message.EndedAnimation({ generation: 1 }),
      ),
      Command.resolve(
        UiToast.WaitBeforeDismissal,
        UiToast.Message.CompletedWaitBeforeDismissal({
          entryId: 'habits-toast-entry-0',
          version: 0,
        }),
      ),
      Command.resolve(
        Animation.WaitForPaint,
        Animation.Message.CompletedWaitForPaint({ generation: 2 }),
      ),
      Command.resolve(
        Animation.WaitForAnimationSettled,
        Animation.Message.EndedAnimation({ generation: 2 }),
      ),
      expect(text('«ورزش» حذف شد.')).toBeAbsent(),
    )
  })

  test('the undo toast restores the same row', () => {
    scene(
      setup(withWeekly()),
      given(habitsModel()),
      click(role('button', { name: 'حذف ورزش' })),
      Mount.resolve(
        Dialog.AcquireResources,
        Dialog.Message.SucceededAcquireResources(),
      ),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      click(role('button', { name: 'حذف' })),
      Command.resolve(
        Dialog.CloseDialog,
        Dialog.Message.CompletedCloseDialog(),
      ),
      Mount.expectEnded(Dialog.AcquireResources),
      Command.resolve(
        Habits.DeleteHabit,
        Habits.Message.CompletedDeleteHabit({
          habitId: SECOND_HABIT_ID,
          title: 'ورزش',
        }),
      ),
      Command.resolve(
        Animation.WaitForPaint,
        Animation.Message.CompletedWaitForPaint({ generation: 1 }),
      ),
      Command.resolve(
        Animation.WaitForAnimationSettled,
        Animation.Message.EndedAnimation({ generation: 1 }),
      ),
      Command.resolve(
        UiToast.WaitBeforeDismissal,
        UiToast.Message.CompletedWaitBeforeDismissal({
          entryId: 'habits-toast-entry-0',
          version: 1,
        }),
      ),
      click(role('button', { name: 'بازگردانی' })),
      Command.expectHas(
        Habits.RestoreHabit({ habitId: SECOND_HABIT_ID, title: 'ورزش' }),
      ),
      Command.resolve(
        Animation.WaitForPaint,
        Animation.Message.CompletedWaitForPaint({ generation: 2 }),
      ),
      Command.resolve(
        Animation.WaitForAnimationSettled,
        Animation.Message.EndedAnimation({ generation: 2 }),
      ),
      Command.resolve(
        Habits.RestoreHabit,
        Habits.Message.CompletedRestoreHabit({
          habitId: SECOND_HABIT_ID,
          title: 'ورزش',
        }),
      ),
      expectOutMessage(Habits.OutMessage.WroteLocalData()),
      expect(text('بازگردانی شد: ورزش')).toExist(),
    )
  })

  test('the heatmap opens on the current Jalali month and navigates', () => {
    scene(
      setup(withWeekly()),
      given(habitsModel()),
      click(role('button', { name: 'نقشه ماه ورزش' })),
      expect(role('grid', { name: 'روزهای ۱ آبان ۱۴۰۵' })).toExist(),
      expect(role('columnheader', { name: 'شنبه' })).toExist(),
      expect(selector('[aria-current="date"]')).toHaveAttr(
        'aria-label',
        '۸ آبان ۱۴۰۵: بدون ثبت',
      ),
      expect(text('انجام شد')).toExist(),
      expect(text('بدون ثبت')).toExist(),
      click(role('button', { name: 'ماه قبل' })),
      expect(text('۱ مهر ۱۴۰۵')).toExist(),
      click(role('button', { name: 'بازگشت به ماه جاری' })),
      expect(text('۱ آبان ۱۴۰۵')).toExist(),
      click(role('button', { name: 'ماه بعد' })),
      expect(text('۱ آذر ۱۴۰۵')).toExist(),
      expect(text('بازگشت به ماه جاری')).toExist(),
    )
  })

  test('the pending and sync-error badges mark a failing row', () => {
    scene(
      setup({
        mirror: mirrorWith([habitRow({ hasSyncError: true })], []),
        pendingKeys: [entityKey('habit', HABIT_ID)],
      }),
      given(habitsModel()),
      expect(text('در انتظار')).toExist(),
      expect(text('خطا در همگام‌سازی')).toExist(),
    )
  })

  test('a closed store disables the form and the tap', () => {
    scene(
      setup({
        mirror: mirrorWith([habitRow()], []),
        isStoreReady: false,
      }),
      given(habitsModel()),
      expect(role('textbox', { name: 'عنوان عادت' })).toBeDisabled(),
      expect(role('button', { name: 'افزودن عادت' })).toBeDisabled(),
      expect(
        role('button', { name: 'تغییر وضعیت امروز آب خوردن' }),
      ).toBeDisabled(),
    )
  })

  test('the page error appears as an alert', () => {
    scene(
      setup(),
      given(
        modifyFields(habitsModel(), {
          maybePageError: () => Option.some('ذخیرهٔ عادت ناموفق بود'),
        }),
      ),
      expect(role('alert')).toHaveText('ذخیرهٔ عادت ناموفق بود'),
    )
  })

  test('a refused restore from sync shows the legacy notice', () => {
    scene(
      setup({ maybeSyncError: Option.some('habit-restore-refused:purged') }),
      given(habitsModel()),
      expect(role('alert')).toHaveText(
        'بازگردانی عادت انجام نشد؛ ممکن است حذف آن قطعی شده باشد.',
      ),
    )
  })

  test('the window selector re-renders the rate label', () => {
    scene(
      todayEntryScene(),
      given(habitsModel()),
      click(role('button', { name: '۷ روز' })),
      expect(text('نرخ ۷ روزه')).toExist(),
      expect(role('button', { name: '۷ روز' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
    )
  })
})

describe('habit visibility action', () => {
  const privateHabit = habitRow({
    ownerId: USER_ID,
    visibility: 'private',
  })

  test('the owner sees the share action', () => {
    scene(
      setup({
        mirror: mirrorWith([privateHabit], []),
        maybeUserId: Option.some(USER_ID),
      }),
      given(habitsModel()),
      expect(role('button', { name: 'اشتراک آب خوردن با خانه' })).toExist(),
    )
  })

  test('the partner does not see the share action', () => {
    scene(
      setup({
        mirror: mirrorWith([privateHabit], []),
        maybeUserId: Option.some('another-user'),
      }),
      given(habitsModel()),
      expect(role('button', { name: 'اشتراک آب خوردن با خانه' })).toBeAbsent(),
    )
  })
})
