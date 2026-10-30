import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

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

/**
 * The Today dashboard's view, ported from `apps/web/src/routes/today.tsx` and
 * its `components/today/ui.tsx` layout.
 *
 * One panel per section in the saved order, a compact side rail, a
 * minute-accurate time strip for timed tasks, and a keyboard-first task list.
 * Colours come from the active daisyUI theme; layout uses logical properties
 * only, so RTL needs no special case.
 */

const SOURCE_QUIET: Readonly<Record<'events' | 'reminders', string>> = {
  events: 'امروز رویدادی نیست؛ تقویم در گام بعدی می‌آید.',
  reminders: 'یادآوری‌ای برای امروز نیست.',
}

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
    [h.Class('today-quick'), h.OnSubmit(Message.SubmittedQuickAdd())],
    [
      h.input([
        h.Id('today-quick-add'),
        h.Type('text'),
        h.Value(model.draft),
        h.Placeholder('افزودن کار…'),
        h.AriaLabel('کار تازه برای امروز'),
        h.Disabled(!inputs.isStoreReady),
        h.OnInput(value => Message.UpdatedQuickAddDraft({ value })),
      ]),
      h.button(
        [h.Type('submit'), h.AriaLabel('افزودن کار'), h.Disabled(!canSubmit)],
        [model.isAdding ? '…' : '+'],
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
    [h.AriaLabel('نوار زمان امروز'), h.Class('today-timeline')],
    [
      h.div(
        [h.Class('today-track')],
        [
          h.span([h.AriaHidden(true), h.Class('today-axis')]),
          ...Array.map(STRIP_TICKS, hour =>
            h.span(
              [
                h.Class('today-tick'),
                h.Style({
                  'inset-inline-start': `${Math.max(stripPercent(hour * 60), 2.5)}%`,
                }),
              ],
              [localizeDigits(hour, digits)],
            ),
          ),
          h.span(
            [
              h.Class('today-tick'),
              h.Style({ 'inset-inline-end': '2px', transform: 'none' }),
            ],
            [localizeDigits(24, digits)],
          ),
          h.span([
            h.AriaHidden(true),
            h.Class('today-now'),
            h.Style({
              'inset-inline-start': `${stripPercent(nowMinutes)}%`,
            }),
          ]),
          ...Array.map(timed, task =>
            h.keyed('button')(task.id, [
              h.Type('button'),
              h.Class('today-mark'),
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

  return h.keyed('li')(
    task.id,
    [
      h.Id(`today-task-${task.id}`),
      h.Class('today-row'),
      h.DataAttribute('overdue', overdue ? 'true' : 'false'),
      h.DataAttribute(
        'cursor',
        model.cursorActive && model.cursor === index ? 'true' : 'false',
      ),
    ],
    [
      h.button([
        h.Type('button'),
        h.Role('checkbox'),
        h.AriaChecked(false),
        h.AriaLabel(`انجام ${task.title}`),
        h.Class('today-check'),
        h.Disabled(!inputs.isStoreReady),
        h.OnClick(
          Message.ClickedCompleteTask({ taskId: task.id, title: task.title }),
        ),
      ]),
      h.div(
        [h.Class('today-row-main')],
        [
          h.a(
            [h.Class('today-row-title'), h.Href(taskAnchorPath(task.id))],
            [task.title],
          ),
          h.p(
            [h.Class('today-row-meta')],
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
        [h.Class('today-actions')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class('today-action'),
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
    [],
    [
      timelineView(model, inputs, view, h),
      quickAddView(model, inputs, h),
      Array.match(ordered, {
        onEmpty: () =>
          h.div(
            [h.Class('today-empty')],
            [
              h.p([], ['امروز خالی است. یک کار کوچک برای شروع کافی است.']),
              h.button(
                [h.Type('button'), h.OnClick(Message.ClickedFocusQuickAdd())],
                ['افزودن اولین کار'],
              ),
            ],
          ),
        onNonEmpty: tasks =>
          h.div(
            [],
            [
              h.ul(
                [h.Class('today-list')],
                Array.map(tasks, (task, index) =>
                  taskRowView(model, inputs, view, task, index, h),
                ),
              ),
              h.footer(
                [h.Class('today-hints')],
                [
                  h.span([], [h.kbd([], ['↑']), h.kbd([], ['↓']), ' حرکت']),
                  h.span([], [h.kbd([], ['Enter']), ' انجام']),
                  h.span([], [h.kbd([], ['/']), ' افزودن']),
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
        [h.Class('today-empty')],
        [
          h.p([], ['یادداشتی پین نشده است.']),
          h.a([h.Href(notesRouter())], ['پیشنهاد: ساخت یادداشت تازه']),
        ],
      ),
    onNonEmpty: notes =>
      h.ul(
        [h.Class('today-list')],
        Array.map(notes, note =>
          h.keyed('li')(
            note.id,
            [h.Class('today-row')],
            [
              h.span([h.AriaHidden(true), h.Class('today-note-dot')]),
              h.div(
                [h.Class('today-row-main')],
                [
                  h.a(
                    [h.Class('today-row-title'), h.Href(notePath(note.id))],
                    [note.title],
                  ),
                  note.excerpt === ''
                    ? h.empty
                    : h.p([h.Class('today-note-excerpt')], [note.excerpt]),
                ],
              ),
              h.div(
                [h.Class('today-actions')],
                [
                  h.a(
                    [
                      h.Class('today-action'),
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
    [h.Class('habit-lane-row')],
    [
      h.div(
        [h.Class('habit-lane-main')],
        [
          h.div(
            [h.Class('habit-lane-title')],
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
              h.strong([], [habit.title]),
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
            ],
          ),
          h.p(
            [h.Class('habit-lane-meta')],
            [
              habitFrequencyLabel(habit.frequency, digits),
              ...(period === null ? [] : [' · ', period]),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class('habit-lane-actions')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class('habit-tap'),
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
            [h.Class('habit-stat')],
            [
              h.span(
                [h.Class('habit-stat-label')],
                [`نرخ ${localizeDigits(model.habitWindow, digits)} روزه`],
              ),
              h.span(
                [
                  h.Class('habit-stat-value'),
                  h.DataAttribute('kind', rate.kind),
                ],
                [rate.label],
              ),
              ...(period === null
                ? []
                : [h.span([h.Class('habit-stat-note')], [period])]),
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
    [h.Class('habit-lane')],
    [
      Array.match(habits, {
        onEmpty: () =>
          h.div(
            [h.Class('habit-lane-empty')],
            [
              h.p(
                [],
                ['هنوز عادتی نساخته‌اید. یک عادت کوچک برای امروز کافی است.'],
              ),
              h.a([h.Href(habitsRouter())], ['ساختن عادت']),
            ],
          ),
        onNonEmpty: rows =>
          h.div(
            [],
            [
              h.div(
                [h.Class('habit-lane-head')],
                [
                  h.div(
                    [
                      h.Role('group'),
                      h.AriaLabel('بازهٔ نرخ موفقیت'),
                      h.Class('habit-lane-windows'),
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
                    [h.Role('alert'), h.Class('habit-lane-alert')],
                    [message],
                  ),
              }),
              h.ul(
                [h.Class('habit-lane-list'), h.AriaLabel('عادت‌های امروز')],
                Array.map(rows, habit =>
                  habitRowView(model, inputs, view, habit, h),
                ),
              ),
            ],
          ),
      }),
      h.p(
        [h.Class('habit-lane-sr'), h.Role('status'), h.AriaLive('polite')],
        [model.habitAnnouncement],
      ),
    ],
  )
}

const quietLaneView = (
  section: 'events' | 'reminders',
  h: HtmlBuilder<Message>,
): Html => h.p([h.Class('today-quiet')], [SOURCE_QUIET[section]])

const sectionBodyView = (
  model: Model,
  inputs: ViewInputs,
  view: TodayView,
  section: DashboardSection,
  h: HtmlBuilder<Message>,
): Html =>
  section === 'tasks'
    ? tasksLaneView(model, inputs, view, h)
    : section === 'habits'
      ? habitsLaneView(model, inputs, view, h)
      : section === 'notes'
        ? notesLaneView(view, h)
        : quietLaneView(section, h)

const sectionCount = (
  inputs: ViewInputs,
  view: TodayView,
  section: DashboardSection,
): number =>
  section === 'tasks'
    ? view.counts.tasks
    : section === 'habits'
      ? inputs.mirror.habits.length
      : section === 'notes'
        ? view.counts.notes
        : 0

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
      h.Class('today-panel today-section'),
      h.DataAttribute('section', section),
      h.AriaLabelledBy(`today-${section}`),
    ],
    [
      h.header(
        [h.Class('today-section-head')],
        [
          h.h2([h.Id(`today-${section}`)], [SECTION_TITLES[section]]),
          h.span(
            [
              h.Class('today-count'),
              h.AriaLabel(
                `${localizeDigits(count, inputs.display.digits)} مورد`,
              ),
            ],
            [localizeDigits(count, inputs.display.digits)],
          ),
        ],
      ),
      h.div(
        [h.Class('today-section-body')],
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
      h.Class('today-panel today-order'),
      h.AriaLabelledBy('today-order-title'),
    ],
    [
      h.h2(
        [h.Id('today-order-title'), h.Class('today-order-title')],
        ['ترتیب بخش‌ها'],
      ),
      h.p(
        [h.Class('today-order-hint')],
        [
          'جای هر بخش را با دکمه‌های بالا و پایین تغییر دهید؛ تغییر بلافاصله ذخیره می‌شود.',
        ],
      ),
      h.ol(
        [h.Class('today-order-list'), h.AriaLabel('ترتیب بخش‌های امروز')],
        Array.map(order, (section, index) =>
          h.keyed('li')(
            section,
            [h.Class('today-order-row')],
            [
              h.span([h.Class('today-order-name')], [SECTION_TITLES[section]]),
              h.span(
                [h.Class('today-order-actions')],
                [
                  h.button(
                    [
                      h.Type('button'),
                      h.Class('today-order-move'),
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
                      h.Class('today-order-move'),
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
            [h.Role('status'), h.Class('today-order-status')],
            ['در حال ذخیره‌ی ترتیب…'],
          )
        : h.empty,
      Option.match(model.orderError, {
        onNone: () => h.empty,
        onSome: message =>
          h.p([h.Role('alert'), h.Class('today-alert')], [message]),
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
    [h.Class('today-bar')],
    [
      h.div(
        [h.Class('today-bar-title')],
        [
          h.h1([], ['امروز']),
          h.p([], [formatTodayHeading(view.today, digits)]),
        ],
      ),
      h.div(
        [h.Class('today-bar-actions')],
        [
          h.p(
            [
              h.Class('today-source'),
              h.Role('status'),
              ...(offline ? [h.DataAttribute('offline', 'true')] : []),
            ],
            [
              h.span([h.AriaHidden(true), h.Class('today-source-dot')]),
              sourceText(inputs.isOnline, model.fetchState),
            ],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class('today-order-toggle'),
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
    [h.Class('today-rail'), h.AriaLabel('خلاصه‌ی امروز')],
    [
      h.section(
        [h.Class('today-card'), h.AriaLabel('کار بعدی')],
        [
          h.div(
            [h.Class('today-card-head')],
            [
              h.span([h.Class('today-eyebrow')], ['بعدی']),
              Option.match(maybeNext, {
                onNone: () => h.empty,
                onSome: task =>
                  h.span(
                    [h.Class('today-pill')],
                    [timeLabel(task.dueAt ?? '', view.timeZone, digits)],
                  ),
              }),
            ],
          ),
          Option.match(maybeNext, {
            onNone: () =>
              h.p(
                [h.Class('today-card-empty')],
                ['برای امروز کار زمان‌داری نمانده است.'],
              ),
            onSome: task =>
              h.div(
                [],
                [
                  h.p([h.Class('today-next-title')], [task.title]),
                  h.p(
                    [h.Class('today-next-meta')],
                    [dueLabel(task, bounds, digits)],
                  ),
                ],
              ),
          }),
        ],
      ),
      h.section(
        [h.Class('today-card'), h.AriaLabel('امروز در یک نگاه')],
        [
          h.div(
            [h.Class('today-card-head')],
            [h.span([h.Class('today-eyebrow')], ['امروز در یک نگاه'])],
          ),
          h.div(
            [h.Class('today-glance')],
            [
              h.div(
                [h.Class('today-glance-row')],
                [
                  h.span([], ['کارهای باقی‌مانده']),
                  h.span([], [localizeDigits(view.counts.tasks, digits)]),
                ],
              ),
              view.counts.overdue > 0
                ? h.div(
                    [
                      h.Class('today-glance-row'),
                      h.DataAttribute('alert', 'true'),
                    ],
                    [
                      h.span([], ['عقب‌افتاده']),
                      h.span([], [localizeDigits(view.counts.overdue, digits)]),
                    ],
                  )
                : h.empty,
              h.div(
                [h.Class('today-glance-row')],
                [
                  h.span([], ['عادت‌ها']),
                  h.span(
                    [],
                    [localizeDigits(inputs.mirror.habits.length, digits)],
                  ),
                ],
              ),
              h.div(
                [h.Class('today-glance-row')],
                [
                  h.span([], ['یادداشت‌ها']),
                  h.span([], [localizeDigits(view.counts.notes, digits)]),
                ],
              ),
            ],
          ),
        ],
      ),
      h.section(
        [h.Class('today-card'), h.AriaLabel('هفته‌ی جاری')],
        [
          h.div(
            [h.Class('today-card-head')],
            [h.span([h.Class('today-eyebrow')], ['این هفته'])],
          ),
          h.ul(
            [h.Class('today-week')],
            Array.map(week, cell =>
              h.keyed('li')(
                cell.key,
                [
                  h.AriaLabel(cell.label),
                  ...(cell.isToday ? [h.AriaCurrent('date')] : []),
                ],
                [
                  h.span(
                    [h.AriaHidden(true), h.Class('today-weekday')],
                    [cell.shortWeekday],
                  ),
                  h.span([h.Class('today-day')], [cell.day]),
                ],
              ),
            ),
          ),
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
    [h.Class('today-root'), h.Dir('rtl'), h.Lang('fa')],
    [
      h.div(
        [h.Class('today-shell page-wrap grid max-w-6xl gap-3.5')],
        [
          headerView(model, inputs, view, h),
          orderPanelView(model, inputs, h),
          Option.match(model.maybeError, {
            onNone: () => h.empty,
            onSome: message =>
              h.p([h.Role('alert'), h.Class('today-alert')], [message]),
          }),
          h.div(
            [h.Class('today-layout')],
            [
              h.div(
                [h.Class('today-col')],
                Array.map(order, section =>
                  sectionPanelView(model, inputs, view, section, h),
                ),
              ),
              railView(model, inputs, view, h),
            ],
          ),
          h.p(
            [h.Class('today-sr'), h.Role('status'), h.AriaLive('polite')],
            [model.announcement],
          ),
        ],
      ),
    ],
  )
}
