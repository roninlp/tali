import { Array, Option, String } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { localizeDigits } from '@tali/domain'
import type { StreakResult } from '@tali/domain'

import {
  DEFAULT_HABIT_COLOR,
  HABIT_COLORS,
  HABIT_WINDOW_DAYS,
  type HabitRow,
  habitBadgeLabel,
  habitBestLabel,
  habitCountingPeriodLabel,
  habitEntryOn,
  habitFrequencyLabel,
  habitRateCopy,
  habitStatsFor,
  habitStatusIcon,
  habitStatusLabel,
  habitToday,
  pendingHabitIds,
} from '../habits-model'
import { confirmDialogView } from '../ui/confirm'
import { toastStackView } from '../ui/toast'
import {
  Message,
  confirmSpec,
  iconChoicesFor,
  restoreRefusalMessage,
} from './habits'
import type { Model, ViewInputs } from './habits'
import { habitHeatmapView } from './habits-heatmap-view'

/**
 * `/habits`, ported from
 * `apps/web/src/components/habits/habits-screen.tsx` (ticket #66;
 * FR-HAB-01/02/03).
 *
 * One form creates and edits the habit, the list cycles today's status on a
 * tap and shows the streak badge and the window's rate copy, and each card can
 * open its monthly Jalali heatmap. Everything renders from the mirror, so the
 * screen is complete offline; layout uses logical properties only and every
 * colour resolves from the active daisyUI theme.
 */

const findHabit = (
  inputs: ViewInputs,
  habitId: string,
): Option.Option<HabitRow> =>
  Array.findFirst(inputs.mirror.habits, habit => habit.id === habitId)

const sourceText = (
  inputs: ViewInputs,
  digits: ViewInputs['display']['digits'],
): string => {
  if (!inputs.isOnline) {
    return 'آفلاین — نمایش از حافظهٔ محلی'
  }

  return inputs.pending > 0
    ? `${localizeDigits(inputs.pending, digits)} تغییر در انتظار همگام‌سازی`
    : 'همه‌چیز روی این دستگاه ذخیره شده است'
}

const pageErrorView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeError = Option.match(model.maybePageError, {
    onNone: () => restoreRefusalMessage(inputs.maybeSyncError),
    onSome: message => Option.some(message),
  })

  return Option.match(maybeError, {
    onNone: () => h.empty,
    onSome: message =>
      h.p([h.Role('alert'), h.Class('habits-alert')], [message]),
  })
}

const fieldLabel = (text: string, h: HtmlBuilder<Message>): Html =>
  h.span([h.Class('habits-label')], [text])

const titleFieldView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.label(
    [h.Class('habits-field')],
    [
      fieldLabel('عنوان', h),
      h.input([
        h.Id('habit-title'),
        h.Type('text'),
        h.Class('habits-input'),
        h.AriaLabel('عنوان عادت'),
        h.Placeholder('مثلاً کتاب خواندن'),
        h.Value(model.title),
        h.Disabled(!inputs.isStoreReady || model.isSaving),
        h.OnInput(value => Message.UpdatedHabitTitle({ value })),
      ]),
    ],
  )

const descriptionFieldView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.label(
    [h.Class('habits-field')],
    [
      fieldLabel('توضیح (اختیاری)', h),
      h.textarea([
        h.Class('habits-input'),
        h.AriaLabel('توضیح عادت'),
        h.Rows(2),
        h.Value(model.description),
        h.Disabled(!inputs.isStoreReady || model.isSaving),
        h.OnInput(value => Message.UpdatedHabitDescription({ value })),
      ]),
    ],
  )

const frequencyModeButton = (
  label: string,
  mode: Model['frequencyMode'],
  model: Model,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.AriaPressed(model.frequencyMode === mode ? 'true' : 'false'),
      h.OnClick(Message.SelectedFrequencyMode({ mode })),
    ],
    [label],
  )

const frequencyFieldView = (
  model: Model,
  digits: ViewInputs['display']['digits'],
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('habits-field')],
    [
      h.span(
        [h.Id('habit-frequency-label'), h.Class('habits-label')],
        ['فراوانی'],
      ),
      h.div(
        [
          h.Class('habits-seg'),
          h.Role('group'),
          h.AriaLabelledBy('habit-frequency-label'),
        ],
        [
          frequencyModeButton('هر روز', 'daily', model, h),
          frequencyModeButton('روزهای هفته', 'weekdays', model, h),
          frequencyModeButton(
            `${localizeDigits(model.timesPerWeek, digits)} بار در هفته`,
            'weekly',
            model,
            h,
          ),
        ],
      ),
    ],
  )

const weekdayLabel = (
  day: number,
  digits: ViewInputs['display']['digits'],
): string => habitFrequencyLabel({ _tag: 'weekdays', days: [day] }, digits)

const weekdaysFieldView = (
  model: Model,
  digits: ViewInputs['display']['digits'],
  h: HtmlBuilder<Message>,
): Html => {
  if (model.frequencyMode !== 'weekdays') {
    return h.empty
  }

  return h.div(
    [h.Class('habits-field')],
    [
      fieldLabel('روزها', h),
      h.div(
        [h.Class('habits-days'), h.Role('group'), h.AriaLabel('روزهای هفته')],
        Array.map([6, 7, 1, 2, 3, 4, 5], day =>
          h.button(
            [
              h.Type('button'),
              h.Class('habits-day'),
              h.AriaLabel(weekdayLabel(day, 'latin')),
              h.AriaPressed(
                Array.contains(model.weekdays, day) ? 'true' : 'false',
              ),
              h.OnClick(Message.ToggledWeekday({ day })),
            ],
            [String.takeLeft(weekdayLabel(day, digits), 1)],
          ),
        ),
      ),
    ],
  )
}

const timesFieldView = (
  model: Model,
  digits: ViewInputs['display']['digits'],
  h: HtmlBuilder<Message>,
): Html => {
  if (model.frequencyMode !== 'weekly') {
    return h.empty
  }

  return h.div(
    [h.Class('habits-field')],
    [
      fieldLabel('تعداد در هفته', h),
      h.div(
        [
          h.Class('habits-times'),
          h.Role('group'),
          h.AriaLabel('تعداد در هفته'),
        ],
        [
          h.button(
            [
              h.Type('button'),
              h.AriaLabel('کاهش تعداد'),
              h.Disabled(model.timesPerWeek <= 1),
              h.OnClick(Message.PressedDecreaseTimes()),
            ],
            ['−'],
          ),
          h.output(
            [h.AriaLive('polite')],
            [localizeDigits(model.timesPerWeek, digits)],
          ),
          h.button(
            [
              h.Type('button'),
              h.AriaLabel('افزایش تعداد'),
              h.Disabled(model.timesPerWeek >= 7),
              h.OnClick(Message.PressedIncreaseTimes()),
            ],
            ['+'],
          ),
        ],
      ),
    ],
  )
}

const reminderFieldView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.label(
    [h.Class('habits-field')],
    [
      fieldLabel('زمان یادآوری (اختیاری)', h),
      h.div(
        [
          h.Style({
            display: 'flex',
            gap: '6px',
            'align-items': 'center',
            'flex-wrap': 'wrap',
          }),
        ],
        [
          h.input([
            h.Class('habits-input'),
            h.Type('time'),
            h.AriaLabel('زمان یادآوری عادت'),
            h.Style({ 'max-width': '160px' }),
            h.Value(model.reminderTime),
            h.Disabled(!inputs.isStoreReady || model.isSaving),
            h.OnInput(value => Message.UpdatedHabitReminderTime({ value })),
          ]),
          ...(model.reminderTime === ''
            ? []
            : [
                h.button(
                  [
                    h.Type('button'),
                    h.Class('habit-action'),
                    h.OnClick(Message.ClickedClearReminder()),
                  ],
                  ['حذف یادآور'],
                ),
              ]),
        ],
      ),
    ],
  )

const iconFieldView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('habits-field')],
    [
      fieldLabel('نشان', h),
      h.div(
        [h.Class('habits-icons'), h.Role('group'), h.AriaLabel('نشان عادت')],
        Array.map(iconChoicesFor(model, inputs), choice =>
          h.button(
            [
              h.Type('button'),
              h.Class('habits-icon'),
              h.AriaLabel(`نشان ${choice}`),
              h.AriaPressed(model.icon === choice ? 'true' : 'false'),
              h.OnClick(Message.SelectedHabitIcon({ icon: choice })),
            ],
            [choice],
          ),
        ),
      ),
    ],
  )

const colorFieldView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('habits-field')],
    [
      fieldLabel('رنگ', h),
      h.div(
        [h.Class('habits-swatches'), h.Role('group'), h.AriaLabel('رنگ عادت')],
        Array.map(HABIT_COLORS, entry =>
          h.button([
            h.Type('button'),
            h.Class('habits-swatch'),
            h.AriaLabel(`رنگ ${entry.label}`),
            h.AriaPressed(model.color === entry.value ? 'true' : 'false'),
            h.Style({ background: entry.value }),
            h.OnClick(Message.SelectedHabitColor({ color: entry.value })),
          ]),
        ),
      ),
    ],
  )

const formView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits
  const maybeEditing = Option.flatMap(model.maybeEditingId, habitId =>
    findHabit(inputs, habitId),
  )
  const heading = Option.match(model.maybeEditingId, {
    onNone: () => 'عادت تازه',
    onSome: () =>
      Option.match(maybeEditing, {
        onNone: () => `ویرایش «${model.title}»`,
        onSome: habit => `ویرایش «${habit.title}»`,
      }),
  })
  const isDisabled = !inputs.isStoreReady || model.isSaving

  return h.form(
    [
      h.Class('habits-form'),
      h.AriaLabel('فرم عادت'),
      h.OnSubmit(Message.SubmittedHabitForm()),
    ],
    [
      h.h2([], [heading]),
      titleFieldView(model, inputs, h),
      descriptionFieldView(model, inputs, h),
      frequencyFieldView(model, digits, h),
      weekdaysFieldView(model, digits, h),
      timesFieldView(model, digits, h),
      reminderFieldView(model, inputs, h),
      iconFieldView(model, inputs, h),
      colorFieldView(model, h),
      Option.match(model.maybeFormError, {
        onNone: () => h.empty,
        onSome: message =>
          h.p([h.Role('alert'), h.Class('habits-alert')], [message]),
      }),
      h.div(
        [h.Class('habits-form-actions')],
        [
          h.button(
            [
              h.Type('submit'),
              h.Class('habits-primary'),
              h.Disabled(isDisabled || model.title.trim() === ''),
            ],
            [
              Option.isSome(model.maybeEditingId)
                ? 'ذخیرهٔ عادت'
                : 'افزودن عادت',
            ],
          ),
          ...(Option.isSome(model.maybeEditingId)
            ? [
                h.button(
                  [
                    h.Type('button'),
                    h.Class('habits-ghost'),
                    h.OnClick(Message.ClickedCancelEdit()),
                  ],
                  ['انصراف'],
                ),
              ]
            : []),
        ],
      ),
    ],
  )
}

const habitMetaView = (
  habit: HabitRow,
  stats: StreakResult,
  digits: ViewInputs['display']['digits'],
  h: HtmlBuilder<Message>,
): Html => {
  const period = habitCountingPeriodLabel(stats, digits)

  return h.p(
    [h.Class('habit-meta')],
    [
      `${habitFrequencyLabel(habit.frequency, digits)} · ${habitBestLabel(stats, digits)}`,
      ...(period === null ? [] : [` · دورهٔ شمارش: ${period}`]),
      ...(habit.reminderTime === null
        ? []
        : [` · یادآور ${localizeDigits(habit.reminderTime, digits)}`]),
    ],
  )
}

const habitCardView = (
  model: Model,
  inputs: ViewInputs,
  habit: HabitRow,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits
  const today = habitToday(model.now, inputs.display.timeZone)
  const entries = inputs.mirror.habitEntries
  const entry = habitEntryOn(entries, habit.id, today)
  const stats = habitStatsFor(habit, entries, today, model.windowDays)
  const rate = habitRateCopy(stats, digits)
  const status = entry?.status ?? null
  const isPending = Array.contains(
    pendingHabitIds(inputs.pendingKeys),
    habit.id,
  )
  const maybeHeat = Option.filter(
    model.maybeHeat,
    heat => heat.habitId === habit.id,
  )

  return h.keyed('li')(
    habit.id,
    [
      h.Class('habit-card'),
      h.Style({
        'border-inline-start-color': habit.color ?? DEFAULT_HABIT_COLOR,
      }),
    ],
    [
      h.div(
        [h.Class('habit-card-head')],
        [
          h.span(
            [h.Class('habit-mark'), h.AriaHidden(true)],
            [habit.icon ?? '•'],
          ),
          h.h3([], [habit.title]),
          h.span(
            [
              h.Class('habit-badge'),
              h.AriaLabel(`زنجیره: ${habitBadgeLabel(stats, digits)}`),
            ],
            [
              h.span([h.AriaHidden(true)], ['🔥']),
              habitBadgeLabel(stats, digits),
            ],
          ),
          ...(isPending
            ? [
                h.span(
                  [h.Class('habit-action'), h.AriaLabel('در انتظار همگام‌سازی')],
                  ['در انتظار'],
                ),
              ]
            : []),
          ...(habit.hasSyncError
            ? [
                h.span(
                  [h.Class('badge badge-error badge-sm')],
                  ['خطا در همگام‌سازی'],
                ),
              ]
            : []),
        ],
      ),
      ...(habit.description === null
        ? []
        : [h.p([h.Class('habit-meta')], [habit.description])]),
      habitMetaView(habit, stats, digits, h),
      h.div(
        [h.Class('habit-actions')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class('habit-tap'),
              h.DataAttribute('status', status ?? 'blank'),
              h.AriaLabel(`تغییر وضعیت امروز ${habit.title}`),
              h.Title('هر ضربه: انجام شد → نیمه → از دست رفت'),
              h.Disabled(
                !inputs.isStoreReady || Option.isSome(model.maybeBusyId),
              ),
              h.OnClick(
                Message.ClickedTapHabit({
                  habitId: habit.id,
                  title: habit.title,
                }),
              ),
            ],
            [
              h.span([h.AriaHidden(true)], [habitStatusIcon(status)]),
              habitStatusLabel(status),
            ],
          ),
          h.div(
            [h.Class('habit-stat')],
            [
              h.span(
                [h.Class('habit-stat-label')],
                [`نرخ ${localizeDigits(model.windowDays, digits)} روزه`],
              ),
              h.span(
                [
                  h.Class('habit-stat-value'),
                  h.DataAttribute('kind', rate.kind),
                ],
                [rate.label],
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class('habit-actions')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class('habit-action'),
              h.AriaLabel(`ویرایش ${habit.title}`),
              h.OnClick(Message.ClickedEditHabit({ habitId: habit.id })),
            ],
            ['ویرایش'],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class('habit-action'),
              h.AriaLabel(`نقشه ماه ${habit.title}`),
              h.AriaPressed(Option.isSome(maybeHeat) ? 'true' : 'false'),
              h.OnClick(Message.ClickedToggleHeat({ habitId: habit.id })),
            ],
            ['نقشهٔ ماه'],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class('habit-action habit-action--danger'),
              h.AriaLabel(`حذف ${habit.title}`),
              h.OnClick(
                Message.ClickedDeleteHabit({
                  habitId: habit.id,
                  title: habit.title,
                }),
              ),
            ],
            ['حذف'],
          ),
        ],
      ),
      Option.match(maybeHeat, {
        onNone: () => h.empty,
        onSome: heat => habitHeatmapView(habit, heat, today, inputs, h),
      }),
    ],
  )
}

const listSectionView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits

  return h.div(
    [h.Class('habits-list-section')],
    [
      h.div(
        [h.Class('habits-head')],
        [
          h.div(
            [],
            [
              h.h2([h.Class('m-0 text-base font-bold')], ['فهرست عادت‌ها']),
              h.p(
                [],
                [
                  'با هر ضربه وضعیت امروز می‌چرخد: انجام شد → نیمه → از دست رفت.',
                ],
              ),
            ],
          ),
          h.div(
            [
              h.Class('habit-lane-windows'),
              h.Role('group'),
              h.AriaLabel('بازهٔ نرخ موفقیت'),
            ],
            Array.map(HABIT_WINDOW_DAYS, days =>
              h.button(
                [
                  h.Type('button'),
                  h.AriaPressed(model.windowDays === days ? 'true' : 'false'),
                  h.OnClick(Message.SelectedHabitWindow({ window: days })),
                ],
                [`${localizeDigits(days, digits)} روز`],
              ),
            ),
          ),
        ],
      ),
      Array.match(inputs.mirror.habits, {
        onEmpty: () =>
          h.div(
            [h.Class('habits-form')],
            [
              h.p(
                [h.Class('habits-label')],
                [
                  'هنوز عادتی ندارید. عنوان را بنویسید و «افزودن عادت» را بزنید؛ همین یک فرم کافی است.',
                ],
              ),
            ],
          ),
        onNonEmpty: habits =>
          h.ul(
            [h.Class('habits-list'), h.AriaLabel('عادت‌ها')],
            Array.map(habits, habit => habitCardView(model, inputs, habit, h)),
          ),
      }),
    ],
  )
}

const habitsConfirmDialogView = (model: Model, h: HtmlBuilder<Message>): Html =>
  confirmDialogView(
    {
      model: model.confirmDialog,
      toParentMessage: message => Message.GotConfirmDialogMessage({ message }),
      onConfirm: Message.ConfirmedDeleteHabit(),
      spec: confirmSpec(model),
    },
    h,
  )

const habitsToastView = (model: Model, h: HtmlBuilder<Message>): Html =>
  toastStackView(
    {
      model: model.toast,
      toParentMessage: message => Message.GotToastMessage({ message }),
      toUndoMessage: (entryId, undo) =>
        Message.ClickedUndoDelete({ entryId, undo }),
    },
    h,
  )

export const habitsPageView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits

  return h.div(
    [h.Class('habits-root'), h.Dir('rtl'), h.Lang('fa')],
    [
      h.div(
        [
          h.Class(
            'habits-screen page-wrap mx-auto grid w-full max-w-4xl gap-2.5',
          ),
        ],
        [
          h.header(
            [h.Class('habits-head')],
            [
              h.div(
                [],
                [
                  h.h1([], ['عادت‌ها']),
                  h.p(
                    [],
                    [
                      'یک عادت، یک تعریف و یک ثبت روزانه. آمار از ثبت‌ها ساخته می‌شود، نه از حافظه.',
                    ],
                  ),
                ],
              ),
              ...(inputs.isStoreReady
                ? [
                    h.p(
                      [h.Class('habits-source'), h.Role('status')],
                      [sourceText(inputs, digits)],
                    ),
                  ]
                : []),
            ],
          ),
          formView(model, inputs, h),
          pageErrorView(model, inputs, h),
          listSectionView(model, inputs, h),
          h.p(
            [h.Class('habits-sr'), h.Role('status'), h.AriaLive('polite')],
            [model.announcement],
          ),
          habitsToastView(model, h),
          habitsConfirmDialogView(model, h),
        ],
      ),
    ],
  )
}
