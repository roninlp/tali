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
import { shareActionOf } from '../lib/visibility-writes'
import { confirmDialogView } from '../ui/confirm'
import { inputControlView, textAreaControlView } from '../ui/field'
import { pickerDialogView, pickerTriggerView } from '../ui/picker'
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
 * colour resolves from the active house theme.
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
      h.p([h.Role('alert'), h.Class('notice notice-error')], [message]),
  })
}

const fieldLabel = (text: string, h: HtmlBuilder<Message>): Html =>
  h.span([h.Class('text-[0.76rem] leading-6 text-base-content/55')], [text])

const titleFieldView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('grid min-w-0 gap-1')],
    [
      fieldLabel('عنوان', h),
      inputControlView(
        {
          id: 'habit-title',
          label: 'عنوان عادت',
          value: model.title,
          placeholder: 'مثلاً کتاب خواندن',
          isDisabled: !inputs.isStoreReady || model.isSaving,
          onInput: value => Message.UpdatedHabitTitle({ value }),
        },
        h,
      ),
    ],
  )

const descriptionFieldView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('grid min-w-0 gap-1')],
    [
      fieldLabel('توضیح (اختیاری)', h),
      textAreaControlView(
        {
          id: 'habit-description',
          label: 'توضیح عادت',
          value: model.description,
          rows: 2,
          isDisabled: !inputs.isStoreReady || model.isSaving,
          onInput: value => Message.UpdatedHabitDescription({ value }),
        },
        h,
      ),
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
      h.Class(
        'min-h-10 rounded-full border border-base-300 bg-base-100 px-3 text-[0.82rem] text-base-content/60 transition-colors hover:border-base-content/20 aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:font-semibold aria-pressed:text-primary',
      ),
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
    [h.Class('grid min-w-0 gap-1')],
    [
      h.span(
        [
          h.Id('habit-frequency-label'),
          h.Class('text-[0.76rem] leading-6 text-base-content/55'),
        ],
        ['فراوانی'],
      ),
      h.div(
        [
          h.Class('flex flex-wrap gap-1'),
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
    [h.Class('grid min-w-0 gap-1')],
    [
      fieldLabel('روزها', h),
      h.div(
        [
          h.Class('flex flex-wrap gap-1'),
          h.Role('group'),
          h.AriaLabel('روزهای هفته'),
        ],
        Array.map([6, 7, 1, 2, 3, 4, 5], day =>
          h.button(
            [
              h.Type('button'),
              h.Class(
                'grid size-10 place-items-center rounded-xl border border-base-300 bg-base-100 text-[0.8rem] text-base-content/60 transition-colors hover:border-base-content/20 aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:font-bold aria-pressed:text-primary',
              ),
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
    [h.Class('grid min-w-0 gap-1')],
    [
      fieldLabel('تعداد در هفته', h),
      h.div(
        [
          h.Class('flex items-center gap-2'),
          h.Role('group'),
          h.AriaLabel('تعداد در هفته'),
        ],
        [
          h.button(
            [
              h.Type('button'),
              h.Class(
                'grid size-10 place-items-center rounded-xl border border-base-300 bg-base-100 text-base transition-colors hover:border-base-content/20 disabled:opacity-55',
              ),
              h.AriaLabel('کاهش تعداد'),
              h.Disabled(model.timesPerWeek <= 1),
              h.OnClick(Message.PressedDecreaseTimes()),
            ],
            ['−'],
          ),
          h.output(
            [
              h.Class('min-w-10 text-center text-[0.95rem] font-semibold'),
              h.AriaLive('polite'),
            ],
            [localizeDigits(model.timesPerWeek, digits)],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class(
                'grid size-10 place-items-center rounded-xl border border-base-300 bg-base-100 text-base transition-colors hover:border-base-content/20 disabled:opacity-55',
              ),
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
  h.div(
    [h.Class('grid min-w-0 gap-1')],
    [
      pickerTriggerView(
        {
          id: 'habit-reminder-time',
          label: 'زمان یادآوری (اختیاری)',
          target: 'habit:reminderTime',
          mode: 'time',
          value: model.reminderTime,
          today: habitToday(model.now, inputs.display.timeZone),
          digits: inputs.display.digits,
          isDisabled: !inputs.isStoreReady || model.isSaving,
          toParentMessage: message => Message.GotPickerMessage({ message }),
        },
        h,
      ),
      ...(model.reminderTime === ''
        ? []
        : [
            h.button(
              [
                h.Type('button'),
                h.Class('btn btn-outline btn-sm w-fit'),
                h.Disabled(!inputs.isStoreReady || model.isSaving),
                h.OnClick(Message.ClickedClearReminder()),
              ],
              ['حذف یادآور'],
            ),
          ]),
    ],
  )

const iconFieldView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('grid min-w-0 gap-1')],
    [
      fieldLabel('نشان', h),
      h.div(
        [
          h.Class('flex flex-wrap gap-1.5'),
          h.Role('group'),
          h.AriaLabel('نشان عادت'),
        ],
        Array.map(iconChoicesFor(model, inputs), choice =>
          h.button(
            [
              h.Type('button'),
              h.Class(
                'grid size-10 place-items-center rounded-xl border border-base-300 bg-base-100 text-lg transition-colors hover:border-base-content/20 aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary',
              ),
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
    [h.Class('grid min-w-0 gap-1')],
    [
      fieldLabel('رنگ', h),
      h.div(
        [
          h.Class('flex flex-wrap gap-1.5'),
          h.Role('group'),
          h.AriaLabel('رنگ عادت'),
        ],
        Array.map(HABIT_COLORS, entry =>
          h.button([
            h.Type('button'),
            h.Class(
              'size-10 rounded-full border-2 border-transparent p-0 transition-colors aria-pressed:border-base-content aria-pressed:ring-2 aria-pressed:ring-base-100 aria-pressed:ring-inset',
            ),
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
      h.Class('panel grid grid-cols-1 min-w-0 gap-3 p-4 sm:p-5'),
      h.AriaLabel('فرم عادت'),
      h.OnSubmit(Message.SubmittedHabitForm()),
    ],
    [
      h.h2([h.Class('m-0 text-[0.95rem] font-semibold')], [heading]),
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
          h.p([h.Role('alert'), h.Class('notice notice-error')], [message]),
      }),
      h.div(
        [h.Class('flex flex-wrap items-center gap-2')],
        [
          h.button(
            [
              h.Type('submit'),
              h.Class('btn btn-primary min-h-10'),
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
                    h.Class('btn btn-outline min-h-10'),
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
    [h.Class('m-0 text-[0.72rem] leading-6 break-words text-base-content/50')],
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
      h.Class('panel grid grid-cols-1 min-w-0 gap-2 border-s-4 p-4'),
      h.Style({
        'border-inline-start-color': habit.color ?? DEFAULT_HABIT_COLOR,
      }),
    ],
    [
      h.div(
        [h.Class('flex flex-wrap items-center gap-2')],
        [
          h.span(
            [
              h.Class('grid w-6 shrink-0 place-items-center'),
              h.AriaHidden(true),
            ],
            [habit.icon ?? '•'],
          ),
          h.h3(
            [h.Class('m-0 text-[1.02rem] leading-6 font-semibold break-words')],
            [habit.title],
          ),
          h.span(
            [
              h.Class(
                'inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/12 px-2 py-0.5 text-[0.72rem] leading-5 text-warning',
              ),
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
                  [
                    h.Class('badge badge-sm'),
                    h.AriaLabel('در انتظار همگام‌سازی'),
                  ],
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
        : [
            h.p(
              [
                h.Class(
                  'm-0 text-[0.72rem] leading-6 break-words text-base-content/50',
                ),
              ],
              [habit.description],
            ),
          ]),
      habitMetaView(habit, stats, digits, h),
      h.div(
        [h.Class('flex flex-wrap items-center justify-between gap-2')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class(
                'inline-flex min-h-10 min-w-11 items-center gap-1.5 rounded-full border border-base-300 bg-base-200 px-3.5 text-[0.82rem] transition-colors hover:border-base-content/20 disabled:opacity-55 data-[status=done]:border-success/45 data-[status=done]:bg-success/12 data-[status=done]:text-success data-[status=partial]:border-warning/45 data-[status=partial]:bg-warning/12 data-[status=partial]:text-warning data-[status=missed]:border-error/40 data-[status=missed]:bg-error/10 data-[status=missed]:text-error',
              ),
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
            [h.Class('ms-auto grid min-w-0 gap-px text-end')],
            [
              h.span(
                [h.Class('text-[0.68rem] leading-5 text-base-content/50')],
                [`نرخ ${localizeDigits(model.windowDays, digits)} روزه`],
              ),
              h.span(
                [
                  h.Class(
                    'text-[0.86rem] leading-6 font-semibold data-[kind=progress]:text-warning data-[kind=none]:text-base-content/50',
                  ),
                  h.DataAttribute('kind', rate.kind),
                ],
                [rate.label],
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class('flex flex-wrap items-center justify-end gap-1.5')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class('btn btn-outline min-h-10'),
              h.AriaLabel(`ویرایش ${habit.title}`),
              h.OnClick(Message.ClickedEditHabit({ habitId: habit.id })),
            ],
            ['ویرایش'],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class(
                'btn btn-outline min-h-10 aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary',
              ),
              h.AriaLabel(`نقشه ماه ${habit.title}`),
              h.AriaPressed(Option.isSome(maybeHeat) ? 'true' : 'false'),
              h.OnClick(Message.ClickedToggleHeat({ habitId: habit.id })),
            ],
            ['نقشهٔ ماه'],
          ),
          ...(Option.contains(inputs.maybeUserId, habit.ownerId)
            ? [
                h.button(
                  [
                    h.Type('button'),
                    h.Class('btn btn-outline min-h-10'),
                    h.AriaLabel(
                      habit.visibility === 'shared'
                        ? `خصوصی کردن ${habit.title}`
                        : `اشتراک ${habit.title} با خانه`,
                    ),
                    h.OnClick(
                      Message.ClickedToggleHabitVisibility({
                        habitId: habit.id,
                      }),
                    ),
                  ],
                  [shareActionOf(habit.visibility).label],
                ),
              ]
            : []),
          h.button(
            [
              h.Type('button'),
              h.Class(
                'btn btn-outline min-h-10 border-error/30 bg-error/8 text-error hover:border-error/50 hover:bg-error/12',
              ),
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
    [h.Class('grid min-w-0 gap-4')],
    [
      h.div(
        [h.Class('flex flex-wrap items-center justify-between gap-2')],
        [
          h.div(
            [h.Class('grid gap-1')],
            [
              h.h2(
                [h.Class('m-0 text-[0.95rem] font-semibold')],
                ['فهرست عادت‌ها'],
              ),
              h.p(
                [h.Class('m-0 text-[0.8rem] leading-6 text-base-content/55')],
                [
                  'با هر ضربه وضعیت امروز می‌چرخد: انجام شد → نیمه → از دست رفت.',
                ],
              ),
            ],
          ),
          h.div(
            [
              h.Class('flex flex-wrap gap-1'),
              h.Role('group'),
              h.AriaLabel('بازهٔ نرخ موفقیت'),
            ],
            Array.map(HABIT_WINDOW_DAYS, days =>
              h.button(
                [
                  h.Type('button'),
                  h.Class(
                    'min-h-8 rounded-full border border-base-300 bg-base-100 px-2.5 text-[0.76rem] text-base-content/60 transition-colors hover:border-base-content/20 aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:font-semibold aria-pressed:text-primary',
                  ),
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
            [
              h.Class(
                'grid justify-items-center gap-2 rounded-2xl border border-dashed border-base-300 px-6 py-10 text-center text-sm text-base-content/55',
              ),
            ],
            [
              h.p(
                [h.Class('m-0')],
                [
                  'هنوز عادتی ندارید. عنوان را بنویسید و «افزودن عادت» را بزنید؛ همین یک فرم کافی است.',
                ],
              ),
            ],
          ),
        onNonEmpty: habits =>
          h.ul(
            [h.Class('m-0 grid list-none gap-3 p-0'), h.AriaLabel('عادت‌ها')],
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
    [
      h.Class('overflow-x-clip bg-base-200 text-base-content'),
      h.Dir('rtl'),
      h.Lang('fa'),
    ],
    [
      h.div(
        [
          h.Class(
            'page-wrap mx-auto grid w-full max-w-4xl grid-cols-1 min-w-0 gap-4',
          ),
        ],
        [
          h.header(
            [h.Class('flex flex-wrap items-baseline justify-between gap-2')],
            [
              h.div(
                [h.Class('grid gap-1')],
                [
                  h.h1(
                    [
                      h.Class(
                        'm-0 text-2xl font-bold tracking-tight sm:text-3xl',
                      ),
                    ],
                    ['عادت‌ها'],
                  ),
                  h.p(
                    [h.Class('m-0 text-sm leading-7 text-base-content/55')],
                    [
                      'یک عادت، یک تعریف و یک ثبت روزانه. آمار از ثبت‌ها ساخته می‌شود، نه از حافظه.',
                    ],
                  ),
                ],
              ),
              ...(inputs.isStoreReady
                ? [
                    h.p(
                      [
                        h.Class('m-0 text-[0.72rem] leading-6 text-warning'),
                        h.Role('status'),
                      ],
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
            [h.Class('sr-only'), h.Role('status'), h.AriaLive('polite')],
            [model.announcement],
          ),
          habitsToastView(model, h),
          habitsConfirmDialogView(model, h),
          pickerDialogView(
            {
              model: model.picker,
              toParentMessage: message => Message.GotPickerMessage({ message }),
              digits: inputs.display.digits,
              weekStart: inputs.display.weekStart,
            },
            h,
          ),
        ],
      ),
    ],
  )
}
