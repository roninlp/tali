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

import { Animation, Dialog, Toast as UiToast } from '@foldkit/ui'
import { test as toastTest } from '@foldkit/ui/toast'

import { HABIT_COLORS, HABIT_ICONS, HabitFrequency } from '../habits-model'
import { USER_ID } from '../test-fixtures'
import * as Habits from './habits'
import type { Inputs, Model } from './habits'
import {
  HABIT_ID,
  SECOND_HABIT_ID,
  habitRow,
  habitsInputs,
  habitsModel,
  mirrorWith,
  weeklyHabit,
} from './habits-test-fixtures'

const update = (inputs: Inputs) => (habits: Model, message: Habits.Message) =>
  Habits.update(habits, message, inputs)

const defaultUpdate = update(habitsInputs())

const withHabits = (overrides: Partial<Inputs> = {}): Inputs =>
  habitsInputs({
    mirror: mirrorWith([habitRow(), weeklyHabit()], []),
    ...overrides,
  })

const editingModel = (): Model =>
  Habits.update(
    habitsModel(),
    Habits.Message.ClickedEditHabit({ habitId: SECOND_HABIT_ID }),
    withHabits(),
  ).model

const withHeat = (): Model =>
  modifyFields(habitsModel(), {
    maybeHeat: () =>
      Option.some({
        habitId: SECOND_HABIT_ID,
        month: { year: 1405, month: 8 },
      }),
  })

describe('habit create', () => {
  test('submits the trimmed title with the form choices', () => {
    story(
      defaultUpdate,
      given(
        habitsModel({
          title: '  کتاب خواندن  ',
          description: ' هر شب ',
          reminderTime: '21:30',
          frequencyMode: 'weekly',
          timesPerWeek: 3,
          icon: '📚',
          color: HABIT_COLORS[2]?.value ?? '',
        }),
      ),
      message(Habits.Message.SubmittedHabitForm()),
      Command.expectExact(
        Habits.CreateHabit({
          title: 'کتاب خواندن',
          description: Option.some('هر شب'),
          reminderTime: Option.some('21:30'),
          frequency: HabitFrequency.weekly({ times: 3 }),
          icon: '📚',
          color: HABIT_COLORS[2]?.value ?? '',
          timeZone: 'Asia/Tehran',
        }),
      ),
      model(next => {
        expect(next.isSaving).toBe(true)
      }),
      Command.resolve(
        Habits.CreateHabit,
        Habits.Message.CompletedCreateHabit({
          habitId: HABIT_ID,
          title: 'کتاب خواندن',
        }),
      ),
      model(next => {
        expect(next.isSaving).toBe(false)
        expect(next.title).toBe('')
        expect(next.description).toBe('')
        expect(next.reminderTime).toBe('')
        expect(next.frequencyMode).toBe('daily')
        expect(next.icon).toBe('🌱')
        expect(next.maybeEditingId).toStrictEqual(Option.none())
        expect(next.announcement).toBe('عادت تازه: کتاب خواندن')
      }),
      expectOutMessage(Habits.OutMessage.WroteLocalData()),
    )
  })

  test('an empty title creates nothing', () => {
    story(
      defaultUpdate,
      given(modifyFields(habitsModel(), { title: () => '   ' })),
      message(Habits.Message.SubmittedHabitForm()),
      Command.expectNone(),
    )
  })

  test('a closed store creates nothing', () => {
    story(
      update(habitsInputs({ isStoreReady: false })),
      given(habitsModel({ title: 'کتاب' })),
      message(Habits.Message.SubmittedHabitForm()),
      Command.expectNone(),
    )
  })

  test('a create failure keeps the draft for a retry', () => {
    story(
      defaultUpdate,
      given(habitsModel({ title: 'کتاب' })),
      message(Habits.Message.SubmittedHabitForm()),
      Command.resolve(
        Habits.CreateHabit,
        Habits.Message.FailedCreateHabit({ message: 'حافظه پر است' }),
      ),
      model(next => {
        expect(next.isSaving).toBe(false)
        expect(next.title).toBe('کتاب')
        expect(next.maybeFormError).toStrictEqual(Option.some('حافظه پر است'))
      }),
      expectNoOutMessage(),
    )
  })

  test('weekdays keep at least one day and submit sorted', () => {
    story(
      defaultUpdate,
      given(
        habitsModel({
          title: 'پیاده‌روی',
          frequencyMode: 'weekdays',
          weekdays: [6, 1, 3],
        }),
      ),
      message(Habits.Message.ToggledWeekday({ day: 3 })),
      message(Habits.Message.ToggledWeekday({ day: 1 })),
      message(Habits.Message.ToggledWeekday({ day: 6 })),
      message(Habits.Message.ToggledWeekday({ day: 5 })),
      model(next => {
        expect(next.weekdays).toEqual([6, 5])
      }),
      message(Habits.Message.SubmittedHabitForm()),
      Command.expectExact(
        Habits.CreateHabit({
          title: 'پیاده‌روی',
          description: Option.none(),
          reminderTime: Option.none(),
          frequency: HabitFrequency.weekdays({ days: [5, 6] }),
          icon: '🌱',
          color: HABIT_COLORS[0]?.value ?? '',
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Habits.CreateHabit,
        Habits.Message.CompletedCreateHabit({
          habitId: HABIT_ID,
          title: 'پیاده‌روی',
        }),
      ),
    )
  })

  test('the weekly stepper stays between one and seven', () => {
    story(
      defaultUpdate,
      given(modifyFields(habitsModel(), { timesPerWeek: () => 1 })),
      message(Habits.Message.PressedDecreaseTimes()),
      model(next => {
        expect(next.timesPerWeek).toBe(1)
      }),
    )

    story(
      defaultUpdate,
      given(modifyFields(habitsModel(), { timesPerWeek: () => 7 })),
      message(Habits.Message.PressedIncreaseTimes()),
      model(next => {
        expect(next.timesPerWeek).toBe(7)
      }),
    )
  })

  test('only the offered icons and colours are accepted', () => {
    story(
      defaultUpdate,
      given(modifyFields(habitsModel(), { icon: () => HABIT_ICONS[0] ?? '' })),
      message(Habits.Message.SelectedHabitIcon({ icon: '🎉' })),
      model(next => {
        expect(next.icon).toBe(HABIT_ICONS[0])
      }),
      message(Habits.Message.SelectedHabitIcon({ icon: HABIT_ICONS[1] ?? '' })),
      model(next => {
        expect(next.icon).toBe(HABIT_ICONS[1])
      }),
      message(Habits.Message.SelectedHabitColor({ color: '#000000' })),
      model(next => {
        expect(next.color).toBe(HABIT_COLORS[0]?.value)
      }),
      message(
        Habits.Message.SelectedHabitColor({
          color: HABIT_COLORS[3]?.value ?? '',
        }),
      ),
      model(next => {
        expect(next.color).toBe(HABIT_COLORS[3]?.value)
      }),
    )
  })

  test('a stored custom icon stays in the picker while editing it', () => {
    const inputs = habitsInputs({
      mirror: mirrorWith([weeklyHabit({ icon: '🪴' })], []),
    })

    const editing = Habits.update(
      habitsModel(),
      Habits.Message.ClickedEditHabit({ habitId: SECOND_HABIT_ID }),
      inputs,
    ).model

    story(
      update(inputs),
      given(editing),
      message(Habits.Message.SelectedHabitIcon({ icon: HABIT_ICONS[0] ?? '' })),
      model(next => {
        expect(next.icon).toBe(HABIT_ICONS[0])
      }),
      message(Habits.Message.SelectedHabitIcon({ icon: '🪴' })),
      model(next => {
        expect(next.icon).toBe('🪴')
      }),
    )
  })
})

describe('habit edit', () => {
  test('clicking edit fills the one form and focuses the title', () => {
    story(
      update(withHabits()),
      given(habitsModel()),
      message(Habits.Message.ClickedEditHabit({ habitId: SECOND_HABIT_ID })),
      Command.expectExact(Habits.FocusHabitTitle()),
      model(next => {
        expect(next.maybeEditingId).toStrictEqual(Option.some(SECOND_HABIT_ID))
        expect(next.title).toBe('ورزش')
        expect(next.description).toBe('هر هفته سه بار')
        expect(next.reminderTime).toBe('07:00')
        expect(next.frequencyMode).toBe('weekly')
        expect(next.timesPerWeek).toBe(3)
        expect(next.icon).toBe('🏃')
        expect(next.color).toBe('#2e9d57')
      }),
      Command.resolve(
        Habits.FocusHabitTitle,
        Habits.Message.CompletedFocusHabitTitle(),
      ),
    )
  })

  test('saving an edit updates the same habit row', () => {
    story(
      update(withHabits()),
      given(editingModel()),
      message(Habits.Message.UpdatedHabitTitle({ value: 'ورزش صبحگاهی' })),
      message(Habits.Message.SubmittedHabitForm()),
      Command.expectExact(
        Habits.UpdateHabit({
          habit: weeklyHabit(),
          title: 'ورزش صبحگاهی',
          description: Option.some('هر هفته سه بار'),
          reminderTime: Option.some('07:00'),
          frequency: HabitFrequency.weekly({ times: 3 }),
          icon: '🏃',
          color: '#2e9d57',
        }),
      ),
      model(next => {
        expect(next.isSaving).toBe(true)
      }),
      Command.resolve(
        Habits.UpdateHabit,
        Habits.Message.CompletedUpdateHabit({
          habitId: SECOND_HABIT_ID,
          title: 'ورزش صبحگاهی',
        }),
      ),
      model(next => {
        expect(next.isSaving).toBe(false)
        expect(next.maybeEditingId).toStrictEqual(Option.none())
        expect(next.title).toBe('')
        expect(next.announcement).toBe('عادت به‌روز شد: ورزش صبحگاهی')
      }),
      expectOutMessage(Habits.OutMessage.WroteLocalData()),
    )
  })

  test('an update failure keeps the edit open with its error', () => {
    story(
      update(withHabits()),
      given(editingModel()),
      message(Habits.Message.SubmittedHabitForm()),
      Command.resolve(
        Habits.UpdateHabit,
        Habits.Message.FailedUpdateHabit({ message: 'نسخه قدیمی است' }),
      ),
      model(next => {
        expect(next.isSaving).toBe(false)
        expect(next.maybeEditingId).toStrictEqual(Option.some(SECOND_HABIT_ID))
        expect(next.maybeFormError).toStrictEqual(Option.some('نسخه قدیمی است'))
      }),
    )
  })

  test('cancel returns to the create form', () => {
    story(
      defaultUpdate,
      given(editingModel()),
      message(Habits.Message.ClickedCancelEdit()),
      model(next => {
        expect(next.maybeEditingId).toStrictEqual(Option.none())
        expect(next.title).toBe('')
        expect(next.frequencyMode).toBe('daily')
      }),
    )
  })
})

describe('habit delete and undo', () => {
  test('delete asks the confirmation dialog first', () => {
    story(
      defaultUpdate,
      given(habitsModel()),
      message(
        Habits.Message.ClickedDeleteHabit({
          habitId: SECOND_HABIT_ID,
          title: 'ورزش',
        }),
      ),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      model(next => {
        expect(next.maybePendingDelete).toEqual(
          Option.some(
            Habits.PendingHabitDelete.make({
              habitId: SECOND_HABIT_ID,
              title: 'ورزش',
            }),
          ),
        )
        expect(next.confirmDialog.isOpen).toBe(true)
      }),
      message(
        Habits.Message.GotConfirmDialogMessage({
          message: Dialog.Message.RequestedClose(),
        }),
      ),
      Command.resolve(
        Dialog.CloseDialog,
        Dialog.Message.CompletedCloseDialog(),
      ),
      model(next => {
        expect(next.maybePendingDelete).toEqual(Option.none())
        expect(next.confirmDialog.isOpen).toBe(false)
      }),
      Command.expectNone(),
    )
  })

  test('a confirmed delete closes the heatmap and opens the undo toast', () => {
    const pendingModel = modifyFields(withHeat(), {
      maybePendingDelete: () =>
        Option.some(
          Habits.PendingHabitDelete.make({
            habitId: SECOND_HABIT_ID,
            title: 'ورزش',
          }),
        ),
      confirmDialog: () => Dialog.boot({ id: 'habits-delete-dialog' }).model,
    })

    story(
      defaultUpdate,
      given(pendingModel),
      message(Habits.Message.ConfirmedDeleteHabit()),
      Command.resolve(
        Dialog.CloseDialog,
        Dialog.Message.CompletedCloseDialog(),
      ),
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
      model(next => {
        expect(next.maybeHeat).toStrictEqual(Option.none())
        expect(next.toast.entries).toHaveLength(1)
        expect(next.toast.entries[0]?.payload.text).toBe('«ورزش» حذف شد.')
        expect(next.toast.entries[0]?.payload.maybeUndo).toStrictEqual({
          kind: 'restoreHabit',
          id: SECOND_HABIT_ID,
          title: 'ورزش',
        })
        expect(next.announcement).toBe('حذف شد: ورزش')
      }),
      expectOutMessage(Habits.OutMessage.WroteLocalData()),
      toastTest.drainEntry({ entryId: 'habits-toast-entry-0' }),
      model(next => {
        expect(next.toast.entries).toHaveLength(0)
      }),
    )
  })

  test('undo restores the same row and announces it', () => {
    story(
      defaultUpdate,
      given(habitsModel()),
      message(
        Habits.Message.ClickedDeleteHabit({
          habitId: SECOND_HABIT_ID,
          title: 'ورزش',
        }),
      ),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      message(Habits.Message.ConfirmedDeleteHabit()),
      Command.resolve(
        Dialog.CloseDialog,
        Dialog.Message.CompletedCloseDialog(),
      ),
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
      message(
        Habits.Message.ClickedUndoDelete({
          entryId: 'habits-toast-entry-0',
          undo: { kind: 'restoreHabit', id: SECOND_HABIT_ID, title: 'ورزش' },
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
      Command.expectExact(
        Habits.RestoreHabit({ habitId: SECOND_HABIT_ID, title: 'ورزش' }),
      ),
      Command.resolve(
        Habits.RestoreHabit,
        Habits.Message.CompletedRestoreHabit({
          habitId: SECOND_HABIT_ID,
          title: 'ورزش',
        }),
      ),
      model(next => {
        expect(next.toast.entries).toHaveLength(0)
        expect(next.announcement).toBe('بازگردانی شد: ورزش')
      }),
      expectOutMessage(Habits.OutMessage.WroteLocalData()),
    )
  })

  test('a failed restore explains itself', () => {
    story(
      defaultUpdate,
      given(habitsModel()),
      message(
        Habits.Message.ClickedDeleteHabit({
          habitId: SECOND_HABIT_ID,
          title: 'ورزش',
        }),
      ),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      message(Habits.Message.ConfirmedDeleteHabit()),
      Command.resolve(
        Dialog.CloseDialog,
        Dialog.Message.CompletedCloseDialog(),
      ),
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
      message(
        Habits.Message.ClickedUndoDelete({
          entryId: 'habits-toast-entry-0',
          undo: { kind: 'restoreHabit', id: SECOND_HABIT_ID, title: 'ورزش' },
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
      Command.resolve(
        Habits.RestoreHabit,
        Habits.Message.FailedRestoreHabit({ message: 'حذف قطعی شده است' }),
      ),
      model(next => {
        expect(next.maybePageError).toStrictEqual(
          Option.some('حذف قطعی شده است'),
        )
      }),
    )
  })
})

describe('habit tap', () => {
  test('a tap logs today in the user zone and announces the new status', () => {
    story(
      defaultUpdate,
      given(habitsModel()),
      message(
        Habits.Message.ClickedTapHabit({
          habitId: HABIT_ID,
          title: 'آب خوردن',
        }),
      ),
      Command.expectExact(
        Habits.TapHabit({
          habitId: HABIT_ID,
          title: 'آب خوردن',
          localDate: '2026-10-30',
          timeZone: 'Asia/Tehran',
        }),
      ),
      model(next => {
        expect(next.maybeBusyId).toStrictEqual(Option.some(HABIT_ID))
      }),
      Command.resolve(
        Habits.TapHabit,
        Habits.Message.CompletedTapHabit({
          habitId: HABIT_ID,
          title: 'آب خوردن',
          status: 'partial',
        }),
      ),
      model(next => {
        expect(next.maybeBusyId).toStrictEqual(Option.none())
        expect(next.announcement).toBe('آب خوردن: نیمه')
      }),
      expectOutMessage(Habits.OutMessage.WroteLocalData()),
    )
  })

  test('a tap is ignored while another one is in flight', () => {
    story(
      defaultUpdate,
      given(
        modifyFields(habitsModel(), {
          maybeBusyId: () => Option.some(HABIT_ID),
        }),
      ),
      message(
        Habits.Message.ClickedTapHabit({
          habitId: SECOND_HABIT_ID,
          title: 'ورزش',
        }),
      ),
      Command.expectNone(),
    )
  })

  test('a tap failure clears the busy flag and shows the error', () => {
    story(
      defaultUpdate,
      given(habitsModel()),
      message(
        Habits.Message.ClickedTapHabit({
          habitId: HABIT_ID,
          title: 'آب خوردن',
        }),
      ),
      Command.resolve(
        Habits.TapHabit,
        Habits.Message.FailedTapHabit({
          message: 'ثبت این روز ممکن نیست',
        }),
      ),
      model(next => {
        expect(next.maybeBusyId).toStrictEqual(Option.none())
        expect(next.maybePageError).toStrictEqual(
          Option.some('ثبت این روز ممکن نیست'),
        )
      }),
    )
  })

  test('the clock tick moves the tap date past midnight', () => {
    story(
      defaultUpdate,
      given(habitsModel({ now: Date.parse('2026-10-30T20:00:00.000Z') })),
      message(
        Habits.Message.TickedClock({
          now: Date.parse('2026-10-30T21:00:00.000Z'),
        }),
      ),
      message(
        Habits.Message.ClickedTapHabit({
          habitId: HABIT_ID,
          title: 'آب خوردن',
        }),
      ),
      Command.expectExact(
        Habits.TapHabit({
          habitId: HABIT_ID,
          title: 'آب خوردن',
          localDate: '2026-10-31',
          timeZone: 'Asia/Tehran',
        }),
      ),
      Command.resolve(
        Habits.TapHabit,
        Habits.Message.CompletedTapHabit({
          habitId: HABIT_ID,
          title: 'آب خوردن',
          status: 'done',
        }),
      ),
    )
  })
})

describe('habit window and heatmap', () => {
  test('the rate window accepts the offered spans', () => {
    story(
      defaultUpdate,
      given(habitsModel()),
      message(Habits.Message.SelectedHabitWindow({ window: 7 })),
      model(next => {
        expect(next.windowDays).toBe(7)
      }),
      message(Habits.Message.SelectedHabitWindow({ window: 90 })),
      model(next => {
        expect(next.windowDays).toBe(90)
      }),
    )
  })

  test('the heatmap opens on the current Jalali month and navigates', () => {
    story(
      defaultUpdate,
      given(habitsModel()),
      message(Habits.Message.ClickedToggleHeat({ habitId: SECOND_HABIT_ID })),
      model(next => {
        expect(next.maybeHeat).toStrictEqual(
          Option.some({
            habitId: SECOND_HABIT_ID,
            month: { year: 1405, month: 8 },
          }),
        )
      }),
      message(Habits.Message.PressedPreviousHeatMonth()),
      model(next => {
        expect(next.maybeHeat).toStrictEqual(
          Option.some({
            habitId: SECOND_HABIT_ID,
            month: { year: 1405, month: 7 },
          }),
        )
      }),
      message(Habits.Message.PressedNextHeatMonth()),
      message(Habits.Message.PressedNextHeatMonth()),
      model(next => {
        expect(next.maybeHeat).toStrictEqual(
          Option.some({
            habitId: SECOND_HABIT_ID,
            month: { year: 1405, month: 9 },
          }),
        )
      }),
      message(Habits.Message.ClickedCurrentHeatMonth()),
      model(next => {
        expect(next.maybeHeat).toStrictEqual(
          Option.some({
            habitId: SECOND_HABIT_ID,
            month: { year: 1405, month: 8 },
          }),
        )
      }),
      message(Habits.Message.ClickedToggleHeat({ habitId: SECOND_HABIT_ID })),
      model(next => {
        expect(next.maybeHeat).toStrictEqual(Option.none())
      }),
    )
  })

  test('month navigation rolls over the Jalali year', () => {
    story(
      defaultUpdate,
      given(
        modifyFields(habitsModel(), {
          maybeHeat: () =>
            Option.some({
              habitId: SECOND_HABIT_ID,
              month: { year: 1405, month: 1 },
            }),
        }),
      ),
      message(Habits.Message.PressedPreviousHeatMonth()),
      model(next => {
        expect(next.maybeHeat).toStrictEqual(
          Option.some({
            habitId: SECOND_HABIT_ID,
            month: { year: 1404, month: 12 },
          }),
        )
      }),
    )
  })
})

describe('habit visibility', () => {
  const ownerHabit = habitRow({
    id: HABIT_ID,
    ownerId: USER_ID,
    visibility: 'private',
  })

  const ownerUpdate = update(
    habitsInputs({
      mirror: mirrorWith([ownerHabit], []),
      maybeUserId: Option.some(USER_ID),
    }),
  )

  test('the owner shares a private habit', () => {
    story(
      ownerUpdate,
      given(habitsModel()),
      message(
        Habits.Message.ClickedToggleHabitVisibility({ habitId: HABIT_ID }),
      ),
      Command.expectExact(
        Habits.SetHabitVisibility({
          habitId: HABIT_ID,
          visibility: 'shared',
        }),
      ),
      Command.resolve(
        Habits.SetHabitVisibility,
        Habits.Message.CompletedSetHabitVisibility({
          habitId: HABIT_ID,
          visibility: 'shared',
        }),
      ),
      expectOutMessage(Habits.OutMessage.WroteLocalData()),
      model(next => {
        expect(next.announcement).toBe('عادت با خانه به اشتراک گذاشته شد')
      }),
    )
  })

  test('a non-owner gets no share command', () => {
    story(
      update(
        habitsInputs({
          mirror: mirrorWith([ownerHabit], []),
          maybeUserId: Option.some('another-user'),
        }),
      ),
      given(habitsModel()),
      message(
        Habits.Message.ClickedToggleHabitVisibility({ habitId: HABIT_ID }),
      ),
      Command.expectNone(),
    )
  })
})
