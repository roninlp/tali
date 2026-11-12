import { Array, Match, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Checkbox } from '@foldkit/ui'
import { localizeDigits } from '@tali/domain'

import type { HabitRow } from '../habits-model'
import {
  HABIT_WINDOW_DAYS,
  habitBadgeLabel,
  habitCountingPeriodLabel,
  habitEntryOn,
  habitFrequencyLabel,
  habitRateCopy,
  habitStatsFor,
  habitStatusIcon,
  habitStatusLabel,
} from '../habits-model'
import type { TaskRow } from '../mirror'
import { habitsRouter, notePath, notesRouter, taskAnchorPath } from '../route'
import { inlineAlertView } from '../ui/feedback'
import { inputControlView } from '../ui/field'
import { Message } from './today'
import type { Model, ViewInputs } from './today'
import {
  type DashboardSection,
  SECTION_TITLES,
  STRIP_TICKS,
  type TodayView,
  boundsFor,
  dueLabel,
  formatTodayHeading,
  isOfflineSource,
  isOverdue,
  nextTimedTask,
  orderedTasks,
  sectionOrderOf,
  sourceText,
  stripPercent,
  timeLabel,
  timedTasks,
  todayView,
  weekDaysFor,
  zoneMinutes,
} from './today-model'

const SOURCE_QUIET: Readonly<Record<'events' | 'reminders', string>> = {
  events: 'امروز رویدادی نیست؛ تقویم در گام بعدی می‌آید.',
  reminders: 'یادآوری‌ای برای امروز نیست.',
}

const KBD_CLASS =
  'me-1 inline-grid min-h-[18px] min-w-[18px] place-items-center rounded-[5px] border border-b-2 border-base-300 bg-base-200 px-1 text-[0.62rem] text-base-content/70'

const GLANCE_ROW_CLASS =
  'flex min-h-9 items-center justify-between gap-2.5 border-t border-base-content/8 text-[0.78rem] first:border-t-0'

const GLANCE_VALUE_CLASS =
  'min-w-7 rounded-full bg-base-content/8 px-2 py-0.5 text-center tabular-nums text-base-content/70'

const viewOf = (model: Model, inputs: ViewInputs): TodayView =>
  todayView({
    maybeServer: model.maybeServer,
    mirror: inputs.mirror,
    pendingKeys: inputs.pendingKeys,
    dirtyKeys: model.dirtyKeys,
    isOnline: inputs.isOnline,
    timeZone: inputs.display.timeZone,
    now: model.now,
  })

const quickAddView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const canSubmit =
    inputs.isStoreReady && !model.isAdding && model.draft.trim() !== ''

  return h.form(
    [
      h.Class(
        'flex items-center gap-3 rounded-2xl border border-primary/25 bg-gradient-to-l from-primary/8 to-base-100 p-3 shadow-sm',
      ),
      h.OnSubmit(Message.SubmittedQuickAdd()),
    ],
    [
      h.span(
        [
          h.AriaHidden(true),
          h.Class(
            'grid size-11 flex-none place-items-center rounded-xl bg-primary text-[1.4rem] font-bold leading-none text-primary-content shadow',
          ),
        ],
        ['+'],
      ),
      h.div(
        [h.Class('grid min-w-0 flex-1 gap-0.5')],
        [
          h.label(
            [
              h.For('today-quick-add'),
              h.Class('text-[0.7rem] font-semibold text-base-content/70'),
            ],
            ['کار تازه برای امروز'],
          ),
          inputControlView(
            {
              id: 'today-quick-add',
              label: 'کار تازه برای امروز',
              value: model.draft,
              placeholder: 'مثلاً: خرید نان…',
              isDisabled: !inputs.isStoreReady,
              class:
                'min-h-9 min-w-0 border-0 bg-transparent px-1 text-sm outline-none placeholder:text-base-content/70 focus:ring-0',
              onInput: value => Message.UpdatedQuickAddDraft({ value }),
              attributes: [
                h.OnKeyDownPreventDefault(key =>
                  key === 'Enter'
                    ? Option.some(Message.SubmittedQuickAdd())
                    : Option.none(),
                ),
              ],
            },
            h,
          ),
        ],
      ),
      h.button(
        [
          h.Type('submit'),
          h.AriaLabel('افزودن کار'),
          h.Disabled(!canSubmit),
          h.Class(
            'size-11 flex-none rounded-xl bg-primary text-[0.85rem] font-bold text-primary-content shadow transition hover:opacity-90 active:scale-95 disabled:opacity-40',
          ),
        ],
        [model.isAdding ? '…' : 'افزودن'],
      ),
    ],
  )
}

const timelineView = (
  model: Model,
  inputs: ViewInputs,
  view: TodayView,
  h: HtmlBuilder<Message>,
): Html => {
  const timeZone = view.timeZone
  const digits = inputs.display.digits
  const timed = timedTasks(view.tasks, timeZone)
  const nowMinutes = zoneMinutes(new Date(model.now).toISOString(), timeZone)

  if (Array.isReadonlyArrayEmpty(timed)) {
    return h.empty
  }

  return h.section(
    [
      h.AriaLabel('نوار زمان امروز'),
      h.Class('rounded-2xl border border-base-300 bg-base-100 p-4 shadow-sm'),
    ],
    [
      h.div(
        [h.Class('mb-2 flex items-center justify-between gap-2')],
        [
          h.span(
            [
              h.Class(
                'text-[0.78rem] font-bold uppercase tracking-wide text-base-content/70',
              ),
            ],
            ['نوار زمان امروز'],
          ),
          h.span(
            [h.Class('text-[0.72rem] text-base-content/70')],
            [`${localizeDigits(timed.length, digits)} کار زمان‌دار`],
          ),
        ],
      ),
      h.div(
        [h.Class('relative h-[52px]')],
        [
          h.span([
            h.AriaHidden(true),
            h.Class('absolute inset-x-2 top-[26px] h-px bg-base-content/10'),
          ]),
          ...Array.map(STRIP_TICKS, hour =>
            h.span(
              [
                h.Class(
                  "absolute top-[26px] translate-x-1/2 pt-2.5 text-[0.62rem] leading-none tabular-nums text-base-content/70 before:absolute before:start-1/2 before:top-0 before:h-1.5 before:w-px before:bg-base-content/15 before:content-['']",
                ),
                h.Style({
                  'inset-inline-start': `${Math.max(stripPercent(hour * 60), 2.5)}%`,
                }),
              ],
              [localizeDigits(hour, digits)],
            ),
          ),
          h.span(
            [
              h.Class(
                "absolute top-[26px] translate-x-1/2 pt-2.5 text-[0.62rem] leading-none tabular-nums text-base-content/70 before:absolute before:start-1/2 before:top-0 before:h-1.5 before:w-px before:bg-base-content/15 before:content-['']",
              ),
              h.Style({ 'inset-inline-end': '2px', transform: 'none' }),
            ],
            [localizeDigits(24, digits)],
          ),
          h.span([
            h.AriaHidden(true),
            h.Class(
              "absolute top-[12px] h-[27px] w-0.5 translate-x-1/2 rounded-[2px] bg-primary before:absolute before:-start-0.5 before:-top-[3px] before:size-1.5 before:rounded-full before:bg-primary before:content-['']",
            ),
            h.Style({
              'inset-inline-start': `${stripPercent(nowMinutes)}%`,
            }),
          ]),
          ...Array.map(timed, task =>
            h.keyed('button')(task.id, [
              h.Type('button'),
              h.Class(
                "absolute top-2 grid h-[48px] w-10 translate-x-1/2 place-items-center border-0 bg-transparent p-0 transition active:scale-95 before:size-3.5 before:rounded-full before:border-2 before:border-base-content/35 before:bg-base-100 before:transition hover:before:scale-125 hover:before:border-primary hover:before:bg-primary/15 before:content-['']",
              ),
              h.Style({
                'inset-inline-start': `${stripPercent(
                  zoneMinutes(task.dueAt ?? '', timeZone),
                )}%`,
              }),
              h.AriaLabel(
                `${timeLabel(task.dueAt ?? '', timeZone, digits)}، ${task.title}`,
              ),
              h.Title(
                `${timeLabel(task.dueAt ?? '', timeZone, digits)} — ${task.title}`,
              ),
              h.OnClick(Message.ClickedTimelineMark({ taskId: task.id })),
            ]),
          ),
        ],
      ),
    ],
  )
}

const taskRowView = (
  model: Model,
  inputs: ViewInputs,
  view: TodayView,
  task: TaskRow,
  index: number,
  h: HtmlBuilder<Message>,
): Html => {
  const bounds = boundsFor(view.timeZone, model.now)
  const overdue = isOverdue(task, bounds)

  return Checkbox.view(
    {
      id: `today-check-${task.id}`,
      isChecked: false,
      onToggle: () =>
        Message.ClickedCompleteTask({ taskId: task.id, title: task.title }),
      toView: attributes =>
        h.keyed('li')(
          task.id,
          [
            h.Id(`today-task-${task.id}`),
            h.Class(
              'group grid min-h-[60px] scroll-mt-20 grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-2 border-t border-base-content/8 px-3 py-1.5 transition-colors first:border-t-0 hover:bg-base-content/[0.04] data-[cursor=true]:bg-primary/10 sm:px-4',
            ),
            h.DataAttribute('overdue', overdue ? 'true' : 'false'),
            h.DataAttribute(
              'cursor',
              model.cursorActive && model.cursor === index ? 'true' : 'false',
            ),
          ],
          [
            h.span(
              [...attributes.label, h.Class('sr-only')],
              [`انجام ${task.title}`],
            ),
            h.button([
              ...attributes.checkbox,
              h.Class(
                'grid size-12 place-items-center border-0 bg-transparent p-0 text-transparent before:size-[22px] before:rounded-lg before:border-2 before:border-base-content/30 before:transition enabled:hover:before:border-primary enabled:hover:before:bg-primary/10 disabled:opacity-50',
              ),
              h.Disabled(!inputs.isStoreReady),
            ]),
            h.div(
              [h.Class('grid min-w-0 gap-px')],
              [
                h.a(
                  [
                    h.Class(
                      'text-[0.92rem] font-semibold leading-7 break-words group-data-[overdue=true]:text-warning hover:text-primary hover:underline hover:underline-offset-4',
                    ),
                    h.Href(taskAnchorPath(task.id)),
                  ],
                  [task.title],
                ),
                h.p(
                  [
                    h.Class(
                      'm-0 text-[0.74rem] leading-6 break-words text-base-content/70 group-data-[overdue=true]:text-warning/80',
                    ),
                  ],
                  [
                    `${overdue ? 'عقب‌افتاده · ' : ''}${
                      task.dueAt !== null
                        ? `${timeLabel(task.dueAt, view.timeZone, inputs.display.digits)} · `
                        : ''
                    }${dueLabel(task, bounds, inputs.display.digits)}`,
                  ],
                ),
              ],
            ),
            h.div(
              [h.Class('flex flex-none items-center gap-1.5')],
              [
                h.button(
                  [
                    h.Type('button'),
                    h.Class(
                      'inline-flex min-h-9 items-center justify-center rounded-full border border-base-300 bg-base-100 px-3 text-[0.74rem] transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary disabled:opacity-50',
                    ),
                    h.AriaLabel(`فردا کردن ${task.title}`),
                    h.Disabled(!inputs.isStoreReady),
                    h.OnClick(
                      Message.ClickedMoveToTomorrow({
                        taskId: task.id,
                        title: task.title,
                      }),
                    ),
                  ],
                  ['فردا'],
                ),
              ],
            ),
          ],
        ),
    },
    h,
  )
}

const tasksLaneView = (
  model: Model,
  inputs: ViewInputs,
  view: TodayView,
  h: HtmlBuilder<Message>,
): Html => {
  const ordered = orderedTasks(view.tasks, view.timeZone)

  return h.div(
    [h.Class('grid gap-3')],
    [
      Array.match(ordered, {
        onEmpty: () =>
          h.div(
            [
              h.Class(
                'grid gap-2 rounded-xl border border-dashed border-base-300 bg-base-200/40 px-4 py-5',
              ),
            ],
            [
              h.p(
                [h.Class('m-0 text-[0.85rem] leading-7 text-base-content/70')],
                ['امروز خالی است. یک کار کوچک برای شروع کافی است.'],
              ),
              h.button(
                [
                  h.Type('button'),
                  h.OnClick(Message.ClickedFocusQuickAdd()),
                  h.Class(
                    'inline-flex min-h-10 justify-self-start rounded-full border border-primary/40 bg-primary/10 px-4 text-[0.8rem] font-medium text-primary transition-colors hover:border-primary',
                  ),
                ],
                ['افزودن اولین کار'],
              ),
            ],
          ),
        onNonEmpty: tasks =>
          h.div(
            [],
            [
              h.ul(
                [
                  h.Class('m-0 grid list-none p-0'),
                  h.AriaLabel('کارهای امروز'),
                ],
                Array.map(tasks, (task, index) =>
                  taskRowView(model, inputs, view, task, index, h),
                ),
              ),
              h.footer(
                [
                  h.Class(
                    'hidden flex-wrap items-center gap-4 border-t border-base-content/8 px-3 py-2 text-[0.68rem] text-base-content/70 sm:flex sm:px-4',
                  ),
                ],
                [
                  h.span(
                    [],
                    [
                      h.kbd([h.Class(KBD_CLASS)], ['↑']),
                      h.kbd([h.Class(KBD_CLASS)], ['↓']),
                      ' حرکت',
                    ],
                  ),
                  h.span(
                    [],
                    [h.kbd([h.Class(KBD_CLASS)], ['Enter']), ' انجام'],
                  ),
                  h.span([], [h.kbd([h.Class(KBD_CLASS)], ['/']), ' افزودن']),
                ],
              ),
            ],
          ),
      }),
    ],
  )
}

const notesLaneView = (view: TodayView, h: HtmlBuilder<Message>): Html =>
  Array.match(view.notes, {
    onEmpty: () =>
      h.div(
        [
          h.Class(
            'grid gap-2 rounded-xl border border-dashed border-base-300 bg-base-200/40 px-4 py-5',
          ),
        ],
        [
          h.p(
            [h.Class('m-0 text-[0.85rem] leading-7 text-base-content/70')],
            ['یادداشتی پین نشده است.'],
          ),
          h.a(
            [
              h.Href(notesRouter()),
              h.Class(
                'inline-flex min-h-10 justify-self-start rounded-full border border-primary/40 bg-primary/10 px-4 text-[0.8rem] font-medium text-primary no-underline transition-colors hover:border-primary',
              ),
            ],
            ['پیشنهاد: ساخت یادداشت تازه'],
          ),
        ],
      ),
    onNonEmpty: notes =>
      h.ul(
        [h.Class('m-0 grid list-none gap-2 p-0')],
        Array.map(notes, note =>
          h.keyed('li')(
            note.id,
            [
              h.Class(
                'grid min-h-[58px] grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-base-300/70 bg-base-200/40 px-3 py-2 transition-colors hover:bg-base-content/[0.04] sm:px-4',
              ),
            ],
            [
              h.span([
                h.AriaHidden(true),
                h.Class(
                  'size-2.5 justify-self-center rounded-full bg-primary/60',
                ),
              ]),
              h.div(
                [h.Class('grid min-w-0 gap-px')],
                [
                  h.a(
                    [
                      h.Class(
                        'text-[0.88rem] font-semibold leading-7 break-words hover:text-primary hover:underline hover:underline-offset-4',
                      ),
                      h.Href(notePath(note.id)),
                    ],
                    [note.title],
                  ),
                  note.excerpt === ''
                    ? h.empty
                    : h.p(
                        [
                          h.Class(
                            'm-0 line-clamp-1 text-[0.74rem] leading-6 text-base-content/70',
                          ),
                        ],
                        [note.excerpt],
                      ),
                ],
              ),
              h.div(
                [h.Class('flex flex-none items-center gap-1')],
                [
                  h.a(
                    [
                      h.Class(
                        'inline-flex min-h-9 items-center justify-center rounded-full border border-base-300 bg-base-100 px-3 text-[0.74rem] no-underline transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary',
                      ),
                      h.Href(notePath(note.id)),
                      h.AriaLabel(`باز کردن ${note.title}`),
                    ],
                    ['باز کردن'],
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
  })

const habitRowView = (
  model: Model,
  inputs: ViewInputs,
  view: TodayView,
  habit: HabitRow,
  h: HtmlBuilder<Message>,
): Html => {
  const entries = inputs.mirror.habitEntries
  const entry = habitEntryOn(entries, habit.id, view.today)
  const stats = habitStatsFor(habit, entries, view.today, model.habitWindow)
  const digits = inputs.display.digits
  const rate = habitRateCopy(stats, digits)
  const period = habitCountingPeriodLabel(stats, digits)
  const status = entry?.status ?? null
  const isBusy = Option.isSome(model.habitBusyId)

  return h.keyed('li')(
    habit.id,
    [
      h.Class(
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-xl border border-base-300/70 bg-base-200/40 px-3 py-3',
      ),
    ],
    [
      h.div(
        [h.Class('grid min-w-0 gap-0.5')],
        [
          h.div(
            [h.Class('flex min-w-0 flex-wrap items-center gap-2')],
            [
              h.span(
                [
                  h.AriaHidden(true),
                  ...(habit.color === null
                    ? []
                    : [h.Style({ color: habit.color })]),
                ],
                [habit.icon ?? '•'],
              ),
              h.strong(
                [h.Class('text-[0.9rem] leading-6 font-semibold break-words')],
                [habit.title],
              ),
              h.span(
                [
                  h.Class(
                    'inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[0.74rem] leading-5 text-warning',
                  ),
                  h.AriaLabel(`زنجیره: ${habitBadgeLabel(stats, digits)}`),
                ],
                [
                  h.span([h.AriaHidden(true)], ['🔥']),
                  habitBadgeLabel(stats, digits),
                ],
              ),
            ],
          ),
          h.p(
            [
              h.Class(
                'm-0 text-[0.72rem] leading-6 break-words text-base-content/70',
              ),
            ],
            [
              habitFrequencyLabel(habit.frequency, digits),
              ...(period === null ? [] : [' · ', period]),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class('flex flex-wrap items-center justify-end gap-2')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class(
                'inline-flex min-h-10 min-w-12 items-center gap-1.5 rounded-full border border-base-300 bg-base-100 px-4 text-[0.84rem] transition-colors hover:border-base-content/25 disabled:opacity-55 data-[status=done]:border-success/50 data-[status=done]:bg-success/15 data-[status=done]:text-success data-[status=partial]:border-warning/50 data-[status=partial]:bg-warning/15 data-[status=partial]:text-warning data-[status=missed]:border-error/45 data-[status=missed]:bg-error/12 data-[status=missed]:text-error',
              ),
              h.DataAttribute('status', status ?? 'blank'),
              h.AriaLabel(`تغییر وضعیت ${habit.title}`),
              h.Title('هر ضربه: انجام شد → نیمه → از دست رفت'),
              h.Disabled(!inputs.isStoreReady || isBusy),
              h.OnClick(
                Message.ClickedHabit({ habitId: habit.id, title: habit.title }),
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
                [h.Class('text-[0.68rem] leading-5 text-base-content/70')],
                [`نرخ ${localizeDigits(model.habitWindow, digits)} روزه`],
              ),
              h.span(
                [
                  h.Class(
                    'text-[0.88rem] leading-6 font-semibold data-[kind=progress]:text-warning data-[kind=none]:text-base-content/70',
                  ),
                  h.DataAttribute('kind', rate.kind),
                ],
                [rate.label],
              ),
              ...(period === null
                ? []
                : [
                    h.span(
                      [
                        h.Class(
                          'text-[0.66rem] leading-5 text-base-content/70',
                        ),
                      ],
                      [period],
                    ),
                  ]),
            ],
          ),
        ],
      ),
    ],
  )
}

const habitsLaneView = (
  model: Model,
  inputs: ViewInputs,
  view: TodayView,
  h: HtmlBuilder<Message>,
): Html => {
  const habits = inputs.mirror.habits
  const digits = inputs.display.digits

  return h.div(
    [h.Class('grid gap-3')],
    [
      Array.match(habits, {
        onEmpty: () =>
          h.div(
            [
              h.Class(
                'grid justify-items-start gap-2 rounded-xl border border-dashed border-base-300 bg-base-200/40 px-4 py-5',
              ),
            ],
            [
              h.p(
                [h.Class('m-0 text-[0.85rem] leading-7 text-base-content/70')],
                ['هنوز عادتی نساخته‌اید. یک عادت کوچک برای امروز کافی است.'],
              ),
              h.a(
                [
                  h.Href(habitsRouter()),
                  h.Class(
                    'text-[0.84rem] font-medium text-primary underline-offset-4 hover:underline',
                  ),
                ],
                ['ساختن عادت'],
              ),
            ],
          ),
        onNonEmpty: rows =>
          h.div(
            [h.Class('grid gap-3')],
            [
              h.div(
                [h.Class('flex flex-wrap items-center justify-between gap-2')],
                [
                  h.div(
                    [
                      h.Role('group'),
                      h.AriaLabel('بازهٔ نرخ موفقیت'),
                      h.Class('flex flex-wrap gap-1.5'),
                    ],
                    Array.map(HABIT_WINDOW_DAYS, days =>
                      h.button(
                        [
                          h.Type('button'),
                          h.AriaPressed(
                            model.habitWindow === days ? 'true' : 'false',
                          ),
                          h.OnClick(
                            Message.SelectedHabitWindow({ window: days }),
                          ),
                          h.Class(
                            'min-h-8 rounded-full border border-base-300 bg-base-100 px-3 text-[0.78rem] text-base-content/70 transition-colors hover:border-base-content/25 aria-pressed:border-primary aria-pressed:bg-primary/12 aria-pressed:font-semibold aria-pressed:text-primary',
                          ),
                        ],
                        [`${localizeDigits(days, digits)} روز`],
                      ),
                    ),
                  ),
                ],
              ),
              Option.match(model.habitError, {
                onNone: () => h.empty,
                onSome: message =>
                  h.p(
                    [
                      h.Role('alert'),
                      h.Class('m-0 text-[0.76rem] leading-6 text-error'),
                    ],
                    [message],
                  ),
              }),
              h.ul(
                [
                  h.Class('m-0 grid list-none gap-2 p-0'),
                  h.AriaLabel('عادت‌های امروز'),
                ],
                Array.map(rows, habit =>
                  habitRowView(model, inputs, view, habit, h),
                ),
              ),
            ],
          ),
      }),
      h.p(
        [h.Class('sr-only'), h.Role('status'), h.AriaLive('polite')],
        [model.habitAnnouncement],
      ),
    ],
  )
}

const quietLaneView = (
  section: 'events' | 'reminders',
  h: HtmlBuilder<Message>,
): Html =>
  h.p(
    [
      h.Class(
        'm-0 rounded-xl border border-dashed border-base-300 bg-base-200/40 px-4 py-4 text-[0.82rem] leading-7 text-base-content/70',
      ),
    ],
    [SOURCE_QUIET[section]],
  )

const sectionBodyView = (
  model: Model,
  inputs: ViewInputs,
  view: TodayView,
  section: DashboardSection,
  h: HtmlBuilder<Message>,
): Html =>
  Match.value(section).pipe(
    Match.when('tasks', () => tasksLaneView(model, inputs, view, h)),
    Match.when('habits', () => habitsLaneView(model, inputs, view, h)),
    Match.when('notes', () => notesLaneView(view, h)),
    Match.when('events', () => quietLaneView('events', h)),
    Match.when('reminders', () => quietLaneView('reminders', h)),
    Match.exhaustive,
  )

const sectionCount = (
  inputs: ViewInputs,
  view: TodayView,
  section: DashboardSection,
): number =>
  Match.value(section).pipe(
    Match.when('tasks', () => view.counts.tasks),
    Match.when('habits', () => inputs.mirror.habits.length),
    Match.when('notes', () => view.counts.notes),
    Match.orElse(() => 0),
  )

const sectionPanelView = (
  model: Model,
  inputs: ViewInputs,
  view: TodayView,
  section: DashboardSection,
  h: HtmlBuilder<Message>,
): Html => {
  const count = sectionCount(inputs, view, section)

  return h.keyed('section')(
    section,
    [
      h.Class(
        'overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-sm',
      ),
      h.DataAttribute('section', section),
      h.AriaLabelledBy(`today-${section}`),
    ],
    [
      h.header(
        [
          h.Class(
            'flex items-center justify-between gap-3 border-b border-base-content/8 px-4 py-3 sm:px-5',
          ),
        ],
        [
          h.h2(
            [
              h.Id(`today-${section}`),
              h.Class('m-0 text-[1rem] font-bold tracking-tight'),
            ],
            [SECTION_TITLES[section]],
          ),
          h.span(
            [
              h.Class(
                'inline-flex min-w-7 items-center justify-center rounded-full bg-primary/10 px-2.5 py-0.5 text-[0.72rem] font-semibold tabular-nums text-primary',
              ),
              h.AriaLabel(
                `${localizeDigits(count, inputs.display.digits)} مورد`,
              ),
            ],
            [localizeDigits(count, inputs.display.digits)],
          ),
        ],
      ),
      h.div(
        [
          h.Class(
            section === 'habits'
              ? 'block min-w-0 px-4 py-3 sm:px-5'
              : 'block min-w-0 px-1 py-2 sm:px-2',
          ),
        ],
        [sectionBodyView(model, inputs, view, section, h)],
      ),
    ],
  )
}

const orderPanelView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  if (!model.orderOpen) {
    return h.empty
  }

  const order = sectionOrderOf(inputs.sectionOrder)

  return h.section(
    [
      h.Id('today-order-panel'),
      h.Class(
        'rounded-2xl border border-base-300 bg-base-100 p-4 shadow-sm sm:p-5',
      ),
      h.AriaLabelledBy('today-order-title'),
      h.Role('region'),
    ],
    [
      h.h2(
        [h.Id('today-order-title'), h.Class('m-0 text-[0.95rem] font-bold')],
        ['ترتیب بخش‌ها'],
      ),
      h.p(
        [
          h.Class(
            'm-0 mb-2 mt-1 text-[0.76rem] leading-7 text-base-content/70',
          ),
        ],
        [
          'جای هر بخش را با دکمه‌های بالا و پایین تغییر دهید؛ تغییر بلافاصله ذخیره می‌شود.',
        ],
      ),
      h.ol(
        [
          h.Class('m-0 grid list-none gap-1 p-0'),
          h.AriaLabel('ترتیب بخش‌های امروز'),
        ],
        Array.map(order, (section, index) =>
          h.keyed('li')(
            section,
            [
              h.Class(
                'flex min-h-11 items-center justify-between gap-3 rounded-xl border border-base-300/70 bg-base-200/40 px-3 py-1.5',
              ),
            ],
            [
              h.span(
                [h.Class('min-w-0 text-[0.82rem] font-medium leading-7')],
                [SECTION_TITLES[section]],
              ),
              h.span(
                [h.Class('flex flex-none items-center gap-1.5')],
                [
                  h.button(
                    [
                      h.Type('button'),
                      h.Class(
                        'grid size-9 place-items-center rounded-lg border border-base-300 bg-base-100 text-[0.95rem] text-base-content/70 transition-colors enabled:hover:border-primary enabled:hover:bg-primary/10 enabled:hover:text-primary disabled:opacity-35',
                      ),
                      h.AriaLabel(`انتقال ${SECTION_TITLES[section]} به بالا`),
                      h.Disabled(index === 0 || model.orderBusy),
                      h.OnClick(
                        Message.ClickedMoveSection({
                          section,
                          direction: 'up',
                        }),
                      ),
                    ],
                    ['↑'],
                  ),
                  h.button(
                    [
                      h.Type('button'),
                      h.Class(
                        'grid size-9 place-items-center rounded-lg border border-base-300 bg-base-100 text-[0.95rem] text-base-content/70 transition-colors enabled:hover:border-primary enabled:hover:bg-primary/10 enabled:hover:text-primary disabled:opacity-35',
                      ),
                      h.AriaLabel(`انتقال ${SECTION_TITLES[section]} به پایین`),
                      h.Disabled(index === order.length - 1 || model.orderBusy),
                      h.OnClick(
                        Message.ClickedMoveSection({
                          section,
                          direction: 'down',
                        }),
                      ),
                    ],
                    ['↓'],
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
      model.orderBusy
        ? h.p(
            [
              h.Role('status'),
              h.Class('m-0 mt-2 text-[0.76rem] text-base-content/70'),
            ],
            ['در حال ذخیره‌ی ترتیب…'],
          )
        : h.empty,
      Option.match(model.orderError, {
        onNone: () => h.empty,
        onSome: message =>
          h.p(
            [
              h.Role('alert'),
              h.Class(
                'notice notice-error m-0 mt-2 py-2 text-[0.8rem] leading-7',
              ),
            ],
            [message],
          ),
      }),
    ],
  )
}

const headerView = (
  model: Model,
  inputs: ViewInputs,
  view: TodayView,
  h: HtmlBuilder<Message>,
): Html => {
  const offline = isOfflineSource(inputs.isOnline, model.fetchState)
  const digits = inputs.display.digits

  return h.header(
    [
      h.Class(
        'flex flex-col gap-4 rounded-2xl border border-base-300 bg-base-100 p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between',
      ),
    ],
    [
      h.div(
        [h.Class('flex min-w-0 flex-col gap-1')],
        [
          h.h1(
            [h.Class('m-0 text-3xl font-extrabold tracking-tight sm:text-4xl')],
            ['امروز'],
          ),
          h.p(
            [h.Class('m-0 text-[0.9rem] text-base-content/70')],
            [formatTodayHeading(view.today, digits)],
          ),
        ],
      ),
      h.div(
        [h.Class('flex flex-wrap items-center gap-2')],
        [
          h.p(
            [
              h.Class(
                'group m-0 inline-flex items-center gap-2 rounded-full border border-base-300 bg-base-200/60 px-3 py-1 text-[0.76rem] text-base-content/70 data-[offline=true]:border-warning/40 data-[offline=true]:bg-warning/10 data-[offline=true]:text-warning',
              ),
              h.Role('status'),
              h.DataAttribute('today-source', 'true'),
              ...(offline ? [h.DataAttribute('offline', 'true')] : []),
            ],
            [
              h.span([
                h.AriaHidden(true),
                h.Class(
                  'size-2 rounded-full bg-secondary ring-4 ring-secondary/15 group-data-[offline=true]:bg-warning group-data-[offline=true]:ring-0',
                ),
              ]),
              sourceText(inputs.isOnline, model.fetchState),
            ],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class(
                'min-h-10 rounded-full border border-base-300 bg-base-100 px-4 text-[0.8rem] font-medium text-base-content/70 transition-colors hover:border-primary hover:text-primary aria-expanded:border-primary/40 aria-expanded:bg-primary/10 aria-expanded:text-primary',
              ),
              h.AriaExpanded(model.orderOpen),
              h.AriaControls('today-order-panel'),
              h.OnClick(Message.ClickedToggleOrderPanel()),
            ],
            ['ترتیب بخش‌ها'],
          ),
        ],
      ),
    ],
  )
}

const railView = (
  model: Model,
  inputs: ViewInputs,
  view: TodayView,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits

  const maybeNext = Option.fromNullishOr(
    nextTimedTask(view.tasks, view.timeZone, model.now),
  )

  const week = weekDaysFor(view.today, inputs.display.weekStart, digits)
  const bounds = boundsFor(view.timeZone, model.now)

  return h.aside(
    [h.Class('grid gap-4 lg:sticky lg:top-4'), h.AriaLabel('خلاصه‌ی امروز')],
    [
      h.section(
        [
          h.Class(
            'rounded-2xl border border-primary/30 bg-gradient-to-b from-primary/10 to-base-100 p-4 shadow-sm sm:p-5',
          ),
          h.AriaLabel('کار بعدی'),
        ],
        [
          h.div(
            [h.Class('mb-2 flex items-center justify-between gap-2')],
            [
              h.span(
                [
                  h.Class(
                    'text-[0.72rem] font-bold uppercase tracking-wide text-base-content/70',
                  ),
                ],
                ['بعدی'],
              ),
              Option.match(maybeNext, {
                onNone: () => h.empty,
                onSome: task =>
                  h.span(
                    [
                      h.Class(
                        'rounded-full bg-primary/15 px-2.5 py-0.5 text-[0.7rem] font-semibold tabular-nums text-primary',
                      ),
                    ],
                    [timeLabel(task.dueAt ?? '', view.timeZone, digits)],
                  ),
              }),
            ],
          ),
          Option.match(maybeNext, {
            onNone: () =>
              h.p(
                [h.Class('m-0 text-[0.82rem] leading-7 text-base-content/70')],
                ['برای امروز کار زمان‌داری نمانده است.'],
              ),
            onSome: task =>
              h.div(
                [h.Class('grid gap-1')],
                [
                  h.p(
                    [h.Class('m-0 text-[0.95rem] font-bold leading-7')],
                    [task.title],
                  ),
                  h.p(
                    [
                      h.Class(
                        'm-0 text-[0.74rem] leading-6 text-base-content/70',
                      ),
                    ],
                    [dueLabel(task, bounds, digits)],
                  ),
                ],
              ),
          }),
        ],
      ),
      h.section(
        [
          h.Class(
            'rounded-2xl border border-base-300 bg-base-100 p-4 shadow-sm sm:p-5',
          ),
          h.AriaLabel('امروز در یک نگاه'),
        ],
        [
          h.div(
            [h.Class('mb-2 flex items-center justify-between gap-2')],
            [
              h.span(
                [
                  h.Class(
                    'text-[0.72rem] font-bold uppercase tracking-wide text-base-content/70',
                  ),
                ],
                ['امروز در یک نگاه'],
              ),
            ],
          ),
          h.div(
            [h.Class('grid')],
            [
              h.div(
                [h.Class(GLANCE_ROW_CLASS)],
                [
                  h.span([], ['کارهای باقی‌مانده']),
                  h.span(
                    [h.Class(GLANCE_VALUE_CLASS)],
                    [localizeDigits(view.counts.tasks, digits)],
                  ),
                ],
              ),
              view.counts.overdue > 0
                ? h.div(
                    [
                      h.Class(
                        'flex min-h-9 items-center justify-between gap-2.5 border-t border-base-content/8 text-[0.78rem] first:border-t-0',
                      ),
                    ],
                    [
                      h.span(
                        [h.Class('text-warning font-medium')],
                        ['عقب‌افتاده'],
                      ),
                      h.span(
                        [
                          h.Class(
                            'min-w-7 rounded-full bg-warning/15 px-2 py-0.5 text-center tabular-nums text-warning',
                          ),
                        ],
                        [localizeDigits(view.counts.overdue, digits)],
                      ),
                    ],
                  )
                : h.empty,
              h.div(
                [h.Class(GLANCE_ROW_CLASS)],
                [
                  h.span([], ['عادت‌ها']),
                  h.span(
                    [h.Class(GLANCE_VALUE_CLASS)],
                    [localizeDigits(inputs.mirror.habits.length, digits)],
                  ),
                ],
              ),
              h.div(
                [h.Class(GLANCE_ROW_CLASS)],
                [
                  h.span([], ['یادداشت‌ها']),
                  h.span(
                    [h.Class(GLANCE_VALUE_CLASS)],
                    [localizeDigits(view.counts.notes, digits)],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
      h.section(
        [
          h.Class(
            'rounded-2xl border border-base-300 bg-base-100 p-4 shadow-sm sm:p-5',
          ),
          h.AriaLabel('هفته‌ی جاری'),
        ],
        [
          h.div(
            [h.Class('mb-2 flex items-center justify-between gap-2')],
            [
              h.span(
                [
                  h.Class(
                    'text-[0.72rem] font-bold uppercase tracking-wide text-base-content/70',
                  ),
                ],
                ['این هفته'],
              ),
            ],
          ),
          h.ul(
            [h.Class('m-0 grid list-none grid-cols-7 gap-1 p-0')],
            Array.map(week, cell =>
              h.keyed('li')(
                cell.key,
                [
                  h.Class(
                    'grid justify-items-center gap-px rounded-xl border border-transparent py-1.5 aria-[current=date]:border-primary/40 aria-[current=date]:bg-primary/12 aria-[current=date]:[&>span:last-child]:font-bold aria-[current=date]:[&>span:last-child]:text-primary',
                  ),
                  h.AriaLabel(cell.label),
                  ...(cell.isToday ? [h.AriaCurrent('date')] : []),
                ],
                [
                  h.span(
                    [
                      h.AriaHidden(true),
                      h.Class('text-[0.6rem] leading-4 text-base-content/70'),
                    ],
                    [cell.shortWeekday],
                  ),
                  h.span(
                    [h.Class('text-[0.86rem] leading-5 tabular-nums')],
                    [cell.day],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
      h.section(
        [
          h.Class(
            'rounded-2xl border border-base-300 bg-base-200/40 p-4 text-[0.8rem] leading-7 text-base-content/70',
          ),
          h.AriaLabel('منابع'),
        ],
        [
          h.p([h.Class('m-0')], [SOURCE_QUIET.events]),
          h.p([h.Class('m-0 mt-1')], [SOURCE_QUIET.reminders]),
        ],
      ),
    ],
  )
}

export const todayPageView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const view = viewOf(model, inputs)
  const order = sectionOrderOf(inputs.sectionOrder)

  return h.div(
    [
      h.Class('min-h-screen bg-base-200/70 text-base-content'),
      h.Dir('rtl'),
      h.Lang('fa'),
    ],
    [
      h.div(
        [
          h.Class(
            'page-wrap mx-auto grid max-w-7xl gap-5 px-4 py-5 sm:px-6 lg:py-6',
          ),
        ],
        [
          headerView(model, inputs, view, h),
          quickAddView(model, inputs, h),
          orderPanelView(model, inputs, h),
          inlineAlertView(model.maybeError, h),
          timelineView(model, inputs, view, h),
          h.div(
            [
              h.Class(
                'grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]',
              ),
            ],
            [
              h.div(
                [h.Class('grid min-w-0 gap-4')],
                Array.map(order, section =>
                  sectionPanelView(model, inputs, view, section, h),
                ),
              ),
              railView(model, inputs, view, h),
            ],
          ),
          h.p(
            [h.Class('sr-only'), h.Role('status'), h.AriaLive('polite')],
            [model.announcement],
          ),
        ],
      ),
    ],
  )
}
