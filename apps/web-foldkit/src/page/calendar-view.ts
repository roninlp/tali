import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { Digits, EventOccurrence } from '@tali/domain'
import { formatJalaliDate, localizeDigits, toJalaliDate } from '@tali/domain'

import type { CalendarEventOccurrence } from '../lib/calendar-data'
import {
  hasTimedEvents,
  isAnchorOccurrence,
  occurrenceDurationMinutes,
  occurrenceStartMinutes,
  occurrenceTimeLabel,
} from '../lib/event-writes'
import {
  ADVANCE_OPTIONS,
  advanceLabel,
  formatAdvanceReminder,
  formatOccasionDate,
  upcomingOccasions,
} from '../lib/occasion-writes'
import { shareActionOf } from '../lib/visibility-writes'
import { entityKey } from '../mirror'
import { taskAnchorPath } from '../route'
import { Message } from './calendar'
import type { Model, ViewInputs } from './calendar'
import {
  type CalendarView,
  calendarViewOf,
  dayLabel,
  emptyDayCopy,
  emptyWeekCopy,
  jalaliDayNumber,
  monthDayLabel,
  monthEventSummary,
  monthNameOf,
  monthOccasionSummary,
  monthTitle,
  showsSourceHint,
  sourceText,
  taskCountLabel,
  weekDaysFor,
  weekTitle,
  weekdayOf,
} from './calendar-model'

/**
 * `/calendar`, ported from `apps/web/src/components/calendar/calendar-screen.tsx`,
 * `events.tsx`, and `apps/web/src/components/occasions/occasions-panel.tsx`.
 *
 * The week is a seven-column grid on a wide screen and a stack of day cards on
 * a phone; the month is always a seven-column grid with the drill-down below.
 * Everything uses logical properties, so RTL needs no physical side rule.
 */

const HOUR_HEIGHT = 40
const MIN_BLOCK_MINUTES = 28

const viewOf = (model: Model, inputs: ViewInputs): CalendarView =>
  calendarViewOf({
    view: model.view,
    anchor: model.anchor,
    maybeSelectedDay: model.maybeSelectedDay,
    maybeServerWeek: model.maybeServerWeek,
    maybeServerMonth: model.maybeServerMonth,
    dirtyTaskIds: model.dirtyTaskIds,
    dirtyEventIds: model.dirtyEventIds,
    now: model.now,
    inputs,
  })

const taskDraftOf = (model: Model, date: string): string =>
  Option.getOrElse(
    Array.findFirst(model.taskDrafts, draft => draft.date === date),
    () => ({ date, value: '' }),
  ).value

const defaultQuickEvent = (date: string) => ({
  date,
  title: '',
  allDay: true,
  startTime: '09:00',
  endTime: '10:00',
  open: false,
})

const quickEventOf = (model: Model, date: string) =>
  Option.getOrElse(
    Array.findFirst(model.quickEvents, draft => draft.date === date),
    () => defaultQuickEvent(date),
  )

type PRIORITY = 'high' | 'medium' | 'low'

const priorityOf = (value: string): PRIORITY =>
  value === 'high' || value === 'low' ? value : 'medium'

const optionValue = (
  value: string,
  label: string,
  h: HtmlBuilder<Message>,
): Html => h.option([h.Value(value)], [label])

const tabButton = (
  label: string,
  view: 'week' | 'month',
  model: Model,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Class('calendar-tab'),
      h.AriaPressed(model.view === view ? 'true' : 'false'),
      h.OnClick(Message.SelectedCalendarView({ view })),
    ],
    [label],
  )

const sourceHintView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  showsSourceHint(inputs.isOnline, model.fetchState)
    ? h.p(
        [h.Role('status'), h.Class('calendar-source')],
        [sourceText(inputs.isOnline, model.fetchState)],
      )
    : h.empty

const headerView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.header(
    [h.Class('calendar-head')],
    [
      h.div([], [h.h1([], ['تقویم'])]),
      h.div(
        [h.Class('calendar-head-meta')],
        [
          sourceHintView(model, inputs, h),
          h.div(
            [
              h.Class('calendar-tabs'),
              h.Role('group'),
              h.AriaLabel('نمای تقویم'),
            ],
            [
              tabButton('هفته', 'week', model, h),
              tabButton('ماه', 'month', model, h),
            ],
          ),
        ],
      ),
    ],
  )

const taskRow = (
  item: CalendarView['week']['days'][number]['tasks'][number],
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const busy = Option.contains(model.maybeBusyKey, `done:${item.id}`)

  return h.li(
    [
      h.Class('calendar-task'),
      h.DataAttribute('priority', item.priority),
      ...(item.projected ? [h.DataAttribute('projected', 'true')] : []),
    ],
    [
      item.projected
        ? h.span([h.AriaHidden(true), h.Class('calendar-task-check')], ['↻'])
        : h.button(
            [
              h.Type('button'),
              h.Role('checkbox'),
              h.AriaChecked(false),
              h.Class('calendar-task-check'),
              h.AriaLabel(`انجام ${item.title}`),
              h.Disabled(!inputs.isStoreReady || busy),
              h.OnClick(
                Message.ClickedCompleteCalendarTask({
                  taskId: item.id,
                  title: item.title,
                  projected: item.projected,
                }),
              ),
            ],
            ['✓'],
          ),
      h.div(
        [h.Class('calendar-task-body')],
        [
          item.projected
            ? h.span([h.Class('calendar-task-title')], [item.title])
            : h.a(
                [
                  h.Class('calendar-task-title'),
                  h.Href(taskAnchorPath(item.id)),
                ],
                [item.title],
              ),
          ...(item.projected
            ? [
                h.span(
                  [h.Class('calendar-task-badge')],
                  ['تکرارشونده — فقط نمایش'],
                ),
              ]
            : []),
          ...(item.priority === 'high' && !item.projected
            ? [h.span([h.Class('calendar-task-badge')], ['اولویت بالا'])]
            : []),
        ],
      ),
    ],
  )
}

const taskQuickAdd = (
  model: Model,
  inputs: ViewInputs,
  date: string,
  label: string,
  h: HtmlBuilder<Message>,
): Html => {
  const value = taskDraftOf(model, date)
  const busy = Option.contains(model.maybeBusyKey, `add:${date}`)

  return h.form(
    [
      h.Class('calendar-quick'),
      h.OnSubmit(Message.SubmittedTaskQuickAdd({ date })),
    ],
    [
      h.input([
        h.Type('text'),
        h.AriaLabel(`کار تازه برای ${label}`),
        h.Placeholder('کار تازه…'),
        h.Value(value),
        h.Disabled(!inputs.isStoreReady),
        h.OnInput(next => Message.UpdatedTaskDraft({ date, value: next })),
      ]),
      h.button(
        [
          h.Type('submit'),
          h.Disabled(!inputs.isStoreReady || busy || value.trim() === ''),
        ],
        ['افزودن'],
      ),
    ],
  )
}

const eventQuickAdd = (
  model: Model,
  inputs: ViewInputs,
  date: string,
  label: string,
  h: HtmlBuilder<Message>,
): Html => {
  const draft = quickEventOf(model, date)

  return h.keyed('details')(
    `${date}:${draft.open ? 'open' : 'closed'}`,
    [
      h.Class('calendar-event-add'),
      // The details is native-controlled while open: rendering an explicit
      // `open=false` on every pass can close it between the click and the
      // OnToggle dispatch while the mirror is still settling. Keying the
      // element on the open state remounts it closed after a successful add
      // without racing the native toggle.
      ...(draft.open ? [h.Open(true)] : []),
      h.OnToggle(isOpen => Message.ToggledEventQuickAdd({ date, isOpen })),
    ],
    [
      h.summary([h.AriaLabel(`رویداد تازه برای ${label}`)], ['+ رویداد']),
      h.form(
        [
          h.Class('calendar-event-form'),
          h.OnSubmit(Message.SubmittedEventQuickAdd({ date })),
        ],
        [
          h.input([
            h.Type('text'),
            h.AriaLabel(`عنوان رویداد برای ${label}`),
            h.Placeholder('رویداد تازه…'),
            h.Value(draft.title),
            h.Disabled(!inputs.isStoreReady),
            h.OnInput(value => Message.UpdatedQuickEventTitle({ date, value })),
          ]),
          h.label(
            [h.Class('calendar-event-check')],
            [
              h.input([
                h.Type('checkbox'),
                h.Checked(draft.allDay),
                h.AriaLabel('تمام روز'),
                h.OnClick(
                  Message.ToggledQuickEventAllDay({
                    date,
                    allDay: !draft.allDay,
                  }),
                ),
              ]),
              'تمام روز',
            ],
          ),
          draft.allDay
            ? h.p([h.Class('calendar-event-hint')], ['بدون ساعت'])
            : h.span(
                [h.Class('calendar-event-times')],
                [
                  h.label(
                    [],
                    [
                      'از',
                      h.input([
                        h.Type('time'),
                        h.AriaLabel(`ساعت شروع رویداد در ${label}`),
                        h.Value(draft.startTime),
                        h.OnInput(value =>
                          Message.UpdatedQuickEventStart({ date, value }),
                        ),
                      ]),
                    ],
                  ),
                  h.label(
                    [],
                    [
                      'تا',
                      h.input([
                        h.Type('time'),
                        h.AriaLabel(`ساعت پایان رویداد در ${label}`),
                        h.Value(draft.endTime),
                        h.OnInput(value =>
                          Message.UpdatedQuickEventEnd({ date, value }),
                        ),
                      ]),
                    ],
                  ),
                ],
              ),
          h.button(
            [
              h.Type('submit'),
              h.Disabled(
                !inputs.isStoreReady ||
                  model.isEventBusy ||
                  draft.title.trim() === '',
              ),
            ],
            [model.isEventBusy ? 'در حال ذخیره…' : 'افزودن رویداد'],
          ),
        ],
      ),
    ],
  )
}

const eventChip = (
  occurrence: CalendarEventOccurrence | EventOccurrence,
  digits: Digits,
  timeZone: string,
  h: HtmlBuilder<Message>,
): Html => {
  const time = occurrenceTimeLabel(occurrence, timeZone, digits)

  return h.button(
    [
      h.Type('button'),
      h.Class('calendar-event-chip'),
      ...(occurrence.timing._tag === 'allDay'
        ? [h.DataAttribute('allday', 'true')]
        : []),
      h.Title(`${time === null ? 'تمام روز' : time} — ${occurrence.title}`),
      h.OnClick(Message.OpenedEventEditor({ occurrence })),
    ],
    [
      ...(time === null
        ? []
        : [h.span([h.Class('calendar-event-chip-time')], [time])]),
      h.span([h.Class('calendar-event-chip-title')], [occurrence.title]),
    ],
  )
}

const eventRow = (
  occurrence: CalendarEventOccurrence | EventOccurrence,
  digits: Digits,
  timeZone: string,
  h: HtmlBuilder<Message>,
): Html => {
  const time = occurrenceTimeLabel(occurrence, timeZone, digits)

  return h.li(
    [
      h.Class('calendar-event-row'),
      ...(occurrence.timing._tag === 'allDay'
        ? [h.DataAttribute('allday', 'true')]
        : []),
    ],
    [
      h.button(
        [
          h.Type('button'),
          h.Class('calendar-event-open'),
          h.AriaLabel(`بازکردن ${occurrence.title}`),
          h.OnClick(Message.OpenedEventEditor({ occurrence })),
        ],
        [
          h.span([h.Class('calendar-event-time')], [time ?? 'تمام روز']),
          h.span([h.Class('calendar-event-title')], [occurrence.title]),
          ...(occurrence.projected
            ? [h.span([h.Class('calendar-task-badge')], ['از مجموعه'])]
            : []),
        ],
      ),
    ],
  )
}

const hourLabel = (hour: number, digits: Digits): string =>
  localizeDigits(`${String(hour).padStart(2, '0')}`, digits)

const timedStarts = (
  occurrences: ReadonlyArray<EventOccurrence | CalendarEventOccurrence>,
  timeZone: string,
): ReadonlyArray<number> =>
  occurrences.flatMap(occurrence => {
    const start = occurrenceStartMinutes(occurrence, timeZone)

    return start === null ? [] : [start]
  })

const timedEnds = (
  occurrences: ReadonlyArray<EventOccurrence | CalendarEventOccurrence>,
  timeZone: string,
): ReadonlyArray<number> =>
  occurrences.flatMap(occurrence => {
    const start = occurrenceStartMinutes(occurrence, timeZone)

    return start === null ? [] : [start + occurrenceDurationMinutes(occurrence)]
  })

const windowStart = (
  occurrences: ReadonlyArray<EventOccurrence | CalendarEventOccurrence>,
  timeZone: string,
): number => {
  const starts = timedStarts(occurrences, timeZone)

  return Array.isReadonlyArrayEmpty(starts)
    ? 8
    : Math.max(0, Math.floor(Math.min(...starts) / 60) - 1)
}

const windowEnd = (
  occurrences: ReadonlyArray<EventOccurrence | CalendarEventOccurrence>,
  timeZone: string,
): number => {
  const ends = timedEnds(occurrences, timeZone)
  const start = windowStart(occurrences, timeZone)

  return Array.isReadonlyArrayEmpty(ends)
    ? Math.min(24, start + 3)
    : Math.min(24, Math.max(start + 2, Math.ceil(Math.max(...ends) / 60) + 1))
}

const timeGridView = (
  occurrences: ReadonlyArray<EventOccurrence | CalendarEventOccurrence>,
  digits: Digits,
  timeZone: string,
  h: HtmlBuilder<Message>,
): Html => {
  const base = windowStart(occurrences, timeZone)
  const hours = Array.makeBy(
    windowEnd(occurrences, timeZone) - base,
    index => base + index,
  )
  const positioned = occurrences
    .flatMap(occurrence => {
      const start = occurrenceStartMinutes(occurrence, timeZone)

      return start === null
        ? []
        : [
            {
              occurrence,
              start,
              top: (start - base * 60) * (HOUR_HEIGHT / 60),
              height:
                Math.max(
                  MIN_BLOCK_MINUTES,
                  occurrenceDurationMinutes(occurrence),
                ) *
                (HOUR_HEIGHT / 60),
              time: occurrenceTimeLabel(occurrence, timeZone, digits) ?? '',
            },
          ]
    })
    .sort((left, right) => left.start - right.start)

  return h.div(
    [
      h.Class('calendar-time-grid'),
      h.Role('list'),
      h.AriaLabel('رویدادهای زمانی'),
      h.Style({ height: `${hours.length * HOUR_HEIGHT}px` }),
    ],
    [
      ...Array.map(hours, hour =>
        h.div(
          [
            h.Class('calendar-hour'),
            h.Role('listitem'),
            h.DataAttribute('hour', String(hour)),
          ],
          [h.span([h.Class('calendar-hour-label')], [hourLabel(hour, digits)])],
        ),
      ),
      ...Array.map(positioned, entry =>
        h.button(
          [
            h.Type('button'),
            h.Class('calendar-time-event'),
            h.DataAttribute('event-key', entry.occurrence.key),
            h.AriaLabel(`${entry.time} ${entry.occurrence.title}`),
            h.Style({
              top: `${entry.top}px`,
              height: `${entry.height}px`,
            }),
            h.OnClick(
              Message.OpenedEventEditor({ occurrence: entry.occurrence }),
            ),
          ],
          [
            h.span([h.Class('calendar-time-event-time')], [entry.time]),
            h.span(
              [h.Class('calendar-time-event-title')],
              [entry.occurrence.title],
            ),
          ],
        ),
      ),
    ],
  )
}

const eventLanes = (
  day: CalendarView['week']['days'][number],
  digits: Digits,
  timeZone: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const label = dayLabel(day.date, digits)
  const allDay = Array.filter(
    day.events,
    occurrence => occurrence.timing._tag === 'allDay',
  )
  const timed = Array.filter(
    day.events,
    occurrence => occurrence.timing._tag === 'timed',
  )

  return [
    ...(allDay.length > 0 || day.occasions.length > 0
      ? [
          h.div(
            [
              h.Class('calendar-allday'),
              h.AriaLabel(`تمام‌روزها و مناسبت‌های ${label}`),
            ],
            [
              ...Array.map(allDay, occurrence =>
                eventChip(occurrence, digits, timeZone, h),
              ),
              ...Array.map(day.occasions, occasion =>
                h.span(
                  [
                    h.Class(
                      'calendar-occasion-chip calendar-occasion-chip-week',
                    ),
                    h.DataAttribute('occasion', occasion.id),
                    h.AriaLabel(
                      `مناسبت ${occasion.title} — ${formatOccasionDate(occasion, digits)}`,
                    ),
                  ],
                  [occasion.title],
                ),
              ),
            ],
          ),
        ]
      : []),
    hasTimedEvents(timed)
      ? timeGridView(timed, digits, timeZone, h)
      : h.p(
          [h.Class('calendar-lane'), h.DataAttribute('lane', 'events-timed')],
          ['رویداد زمانی — خالی'],
        ),
  ]
}

const quietLanes = (h: HtmlBuilder<Message>): Html =>
  h.ul(
    [h.Class('calendar-lanes'), h.AriaLabel('مسیرهای دیگر')],
    [
      h.li(
        [h.Class('calendar-lane'), h.DataAttribute('lane', 'reminders')],
        ['یادآوری — خالی'],
      ),
      h.li(
        [h.Class('calendar-lane'), h.DataAttribute('lane', 'habits')],
        ['عادت — خالی'],
      ),
    ],
  )

const weekDayCard = (
  day: CalendarView['week']['days'][number],
  model: Model,
  inputs: ViewInputs,
  view: CalendarView,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits
  const label = dayLabel(day.date, digits)
  const isToday = day.date === view.today
  const tasksLabel = `کارهای ${label}`

  return h.section(
    [
      h.Class('calendar-day-card'),
      ...(isToday
        ? [h.DataAttribute('today', 'true'), h.AriaCurrent('date')]
        : []),
      h.AriaLabel(label),
    ],
    [
      h.header(
        [h.Class('calendar-day-head')],
        [
          h.span([h.Class('calendar-day-name')], [weekdayOf(day.date)]),
          h.span(
            [],
            [
              h.span(
                [h.Class('calendar-day-number')],
                [jalaliDayNumber(day.date, digits)],
              ),
              ' ',
              h.span([h.Class('calendar-day-month')], [monthNameOf(day.date)]),
            ],
          ),
        ],
      ),
      taskQuickAdd(model, inputs, day.date, label, h),
      eventQuickAdd(model, inputs, day.date, label, h),
      ...eventLanes(day, digits, view.week.timeZone, h),
      ...(day.tasks.length > 0
        ? [
            h.ul(
              [h.Class('calendar-tasks'), h.AriaLabel(tasksLabel)],
              Array.map(day.tasks, item => taskRow(item, model, inputs, h)),
            ),
          ]
        : []),
      ...(day.tasks.length === 0 &&
      day.events.length === 0 &&
      day.occasions.length === 0
        ? [h.p([h.Class('calendar-empty')], [emptyDayCopy])]
        : []),
      quietLanes(h),
    ],
  )
}

const planningGroups = (view: CalendarView) =>
  view.week.days.flatMap(day => {
    const items = Array.filter(day.tasks, item => !item.projected)

    return Array.isReadonlyArrayEmpty(items) ? [] : [{ date: day.date, items }]
  })

const planningPanel = (
  model: Model,
  inputs: ViewInputs,
  view: CalendarView,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits
  const groups = planningGroups(view)

  return h.section(
    [h.Class('calendar-planning'), h.AriaLabel('برنامه‌ریزی هفته')],
    [
      h.h2([], ['برنامه‌ریزی هفته']),
      h.p(
        [h.Class('calendar-planning-hint')],
        [
          'هفته را مرور کنید: اولویت هر کار را تعیین کنید یا آن را یک روز جابه‌جا کنید. کارهای تکرارشونده فقط نمایشی‌اند.',
        ],
      ),
      ...(Array.isReadonlyArrayEmpty(groups)
        ? [h.p([h.Class('calendar-empty')], [emptyWeekCopy])]
        : Array.map(groups, group =>
            h.div(
              [h.Class('calendar-plan-day')],
              [
                h.p(
                  [h.Class('calendar-plan-date')],
                  [dayLabel(group.date, digits)],
                ),
                h.ul(
                  [h.Class('calendar-plan-list')],
                  Array.map(group.items, item =>
                    h.keyed('li')(
                      item.id,
                      [h.Class('calendar-plan-row')],
                      [
                        h.span([h.Class('calendar-plan-title')], [item.title]),
                        h.span(
                          [h.Class('calendar-plan-controls')],
                          [
                            h.select(
                              [
                                h.AriaLabel(`اولویت ${item.title}`),
                                h.Value(item.priority),
                                h.Disabled(!inputs.isStoreReady),
                                h.OnChange(value =>
                                  Message.ClickedPrioritizeCalendarTask({
                                    taskId: item.id,
                                    title: item.title,
                                    priority: priorityOf(value),
                                    currentPriority: item.priority,
                                    projected: item.projected,
                                  }),
                                ),
                              ],
                              [
                                optionValue('high', 'بالا', h),
                                optionValue('medium', 'متوسط', h),
                                optionValue('low', 'پایین', h),
                              ],
                            ),
                            h.button(
                              [
                                h.Type('button'),
                                h.Class('calendar-plan-move'),
                                h.AriaLabel(`یک روز قبل ${item.title}`),
                                h.Disabled(
                                  !inputs.isStoreReady ||
                                    group.date <= view.week.start,
                                ),
                                h.OnClick(
                                  Message.ClickedMoveCalendarTask({
                                    taskId: item.id,
                                    title: item.title,
                                    date: group.date,
                                    days: -1,
                                    projected: item.projected,
                                  }),
                                ),
                              ],
                              ['← روز'],
                            ),
                            h.button(
                              [
                                h.Type('button'),
                                h.Class('calendar-plan-move'),
                                h.AriaLabel(`یک روز بعد ${item.title}`),
                                h.Disabled(
                                  !inputs.isStoreReady ||
                                    group.date >= view.week.end,
                                ),
                                h.OnClick(
                                  Message.ClickedMoveCalendarTask({
                                    taskId: item.id,
                                    title: item.title,
                                    date: group.date,
                                    days: 1,
                                    projected: item.projected,
                                  }),
                                ),
                              ],
                              ['روز →'],
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          )),
    ],
  )
}

const monthNavigation = (
  model: Model,
  digits: Digits,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('calendar-nav')],
    [
      h.button(
        [
          h.Type('button'),
          h.Class('calendar-nav-button'),
          h.AriaLabel('ماه قبل'),
          h.OnClick(Message.PressedPreviousMonth()),
        ],
        ['→'],
      ),
      h.p([h.Class('calendar-nav-title')], [monthTitle(model.anchor, digits)]),
      h.button(
        [
          h.Type('button'),
          h.Class('calendar-nav-button'),
          h.AriaLabel('ماه بعد'),
          h.OnClick(Message.PressedNextMonth()),
        ],
        ['←'],
      ),
      h.button(
        [
          h.Type('button'),
          h.Class('calendar-nav-button'),
          h.OnClick(Message.PressedTodayMonth()),
        ],
        ['امروز'],
      ),
    ],
  )

const monthGrid = (
  model: Model,
  inputs: ViewInputs,
  view: CalendarView,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits
  const weekdays = weekDaysFor(model.anchor, inputs.display.weekStart)

  return h.div(
    [],
    [
      h.div(
        [h.Class('calendar-month-head'), h.Role('row')],
        Array.map(weekdays, day =>
          h.div(
            [
              h.Class('calendar-month-weekday'),
              h.Role('columnheader'),
              h.AriaLabel(day.weekday),
            ],
            [h.span([h.AriaHidden(true)], [day.shortWeekday])],
          ),
        ),
      ),
      h.ol(
        [
          h.Class('calendar-month'),
          h.AriaLabel(monthTitle(model.anchor, digits)),
        ],
        Array.map(view.month.days, cell => {
          const dayEvents = Option.getOrElse(
            Option.fromNullishOr(view.monthEvents.get(cell.date)),
            () => [],
          )
          const dayOccasions = Option.getOrElse(
            Option.fromNullishOr(view.monthOccasions.get(cell.date)),
            () => [],
          )
          const parts = [
            `${dayLabel(cell.date, digits)} — ${taskCountLabel(cell.tasks, digits)}`,
          ]

          if (cell.events > 0) {
            parts.push(monthEventSummary(cell.events, digits))
          }

          if (cell.occasions > 0) {
            parts.push(monthOccasionSummary(cell.occasions, digits))
          }

          const isSelected = Option.contains(model.maybeSelectedDay, cell.date)

          return h.li(
            [h.Class('calendar-month-cell')],
            [
              h.button(
                [
                  h.Type('button'),
                  h.Class('calendar-month-day'),
                  ...(cell.inMonth ? [] : [h.DataAttribute('outside', 'true')]),
                  ...(cell.isBusy ? [h.DataAttribute('busy', 'true')] : []),
                  ...(cell.date === view.today
                    ? [h.DataAttribute('today', 'true')]
                    : []),
                  h.AriaLabel(parts.join(' — ')),
                  h.AriaPressed(isSelected ? 'true' : 'false'),
                  h.OnClick(Message.SelectedCalendarDay({ date: cell.date })),
                ],
                [
                  h.span(
                    [h.Class('calendar-month-number')],
                    [jalaliDayNumber(cell.date, digits)],
                  ),
                  h.span(
                    [h.Class('calendar-month-dots'), h.AriaHidden(true)],
                    Array.makeBy(cell.busyLevel, () =>
                      h.span([h.Class('calendar-month-dot')]),
                    ),
                  ),
                  ...(dayEvents.length > 0
                    ? [
                        h.span(
                          [h.Class('calendar-event-chips'), h.AriaHidden(true)],
                          [
                            ...Array.map(Array.take(dayEvents, 2), occurrence =>
                              h.span(
                                [
                                  h.Class(
                                    'calendar-event-chip calendar-event-chip-month',
                                  ),
                                  ...(occurrence.timing._tag === 'allDay'
                                    ? [h.DataAttribute('allday', 'true')]
                                    : []),
                                  h.Title(occurrence.title),
                                ],
                                [
                                  ...Option.match(
                                    Option.fromNullishOr(
                                      occurrenceTimeLabel(
                                        occurrence,
                                        view.month.timeZone,
                                        digits,
                                      ),
                                    ),
                                    {
                                      onNone: () => [],
                                      onSome: time => [
                                        h.span(
                                          [h.Class('calendar-event-chip-time')],
                                          [time],
                                        ),
                                      ],
                                    },
                                  ),
                                  h.span(
                                    [h.Class('calendar-event-chip-title')],
                                    [occurrence.title],
                                  ),
                                ],
                              ),
                            ),
                            ...(dayEvents.length > 2
                              ? [
                                  h.span(
                                    [
                                      h.Class('calendar-event-chip'),
                                      h.DataAttribute('more', 'true'),
                                    ],
                                    [
                                      `+${localizeDigits(
                                        dayEvents.length - 2,
                                        digits,
                                      )}`,
                                    ],
                                  ),
                                ]
                              : []),
                          ],
                        ),
                      ]
                    : []),
                  ...(dayOccasions.length > 0
                    ? [
                        h.span(
                          [
                            h.Class('calendar-occasion-chips'),
                            h.AriaHidden(true),
                          ],
                          [
                            ...Array.map(
                              Array.take(dayOccasions, 2),
                              occasion =>
                                h.span(
                                  [
                                    h.Class('calendar-occasion-chip'),
                                    ...(occasion.color === null
                                      ? []
                                      : [
                                          h.DataAttribute(
                                            'color',
                                            occasion.color,
                                          ),
                                        ]),
                                    h.Title(
                                      `${occasion.title} — ${formatOccasionDate(
                                        occasion,
                                        digits,
                                      )}`,
                                    ),
                                  ],
                                  [occasion.title],
                                ),
                            ),
                            ...(dayOccasions.length > 2
                              ? [
                                  h.span(
                                    [
                                      h.Class('calendar-occasion-chip'),
                                      h.DataAttribute('more', 'true'),
                                    ],
                                    [
                                      `+${localizeDigits(
                                        dayOccasions.length - 2,
                                        digits,
                                      )}`,
                                    ],
                                  ),
                                ]
                              : []),
                          ],
                        ),
                      ]
                    : []),
                ],
              ),
            ],
          )
        }),
      ),
    ],
  )
}

const dayDetail = (
  model: Model,
  inputs: ViewInputs,
  view: CalendarView,
  h: HtmlBuilder<Message>,
): Html => {
  const detail = view.month.day

  return detail === null
    ? h.empty
    : (() => {
        const digits = inputs.display.digits
        const label = monthDayLabel(detail.date, digits)

        return h.section(
          [h.Class('calendar-detail'), h.AriaLabel('جزئیات روز')],
          [
            h.header(
              [h.Class('calendar-detail-head')],
              [
                h.h2([], [label]),
                h.div(
                  [h.Class('calendar-detail-actions')],
                  [
                    h.button(
                      [
                        h.Type('button'),
                        h.Class('calendar-nav-button'),
                        h.OnClick(
                          Message.OpenedDayInWeek({ date: detail.date }),
                        ),
                      ],
                      ['دیدن در نمای هفته'],
                    ),
                    h.button(
                      [
                        h.Type('button'),
                        h.Class('calendar-nav-button'),
                        h.AriaLabel('بستن جزئیات روز'),
                        h.OnClick(Message.ClosedCalendarDay()),
                      ],
                      ['بستن'],
                    ),
                  ],
                ),
              ],
            ),
            taskQuickAdd(model, inputs, detail.date, label, h),
            eventQuickAdd(model, inputs, detail.date, label, h),
            ...(detail.occasions.length > 0
              ? [
                  h.ul(
                    [
                      h.Class('calendar-occasions-list'),
                      h.AriaLabel(`مناسبت‌های ${label}`),
                    ],
                    Array.map(detail.occasions, occasion =>
                      h.li(
                        [
                          h.Class('calendar-occasion-row'),
                          h.DataAttribute('occasion-date', occasion.date),
                        ],
                        [
                          h.span(
                            [
                              h.Class('calendar-occasion-chip'),
                              ...(occasion.color === null
                                ? []
                                : [h.DataAttribute('color', occasion.color)]),
                            ],
                            [occasion.title],
                          ),
                          h.span(
                            [h.Class('calendar-occasion-date')],
                            [formatOccasionDate(occasion, digits)],
                          ),
                        ],
                      ),
                    ),
                  ),
                ]
              : []),
            ...(detail.events.length > 0
              ? [
                  h.ul(
                    [
                      h.Class('calendar-events'),
                      h.AriaLabel(`رویدادهای ${label}`),
                    ],
                    Array.map(detail.events, occurrence =>
                      eventRow(occurrence, digits, view.month.timeZone, h),
                    ),
                  ),
                ]
              : []),
            ...(detail.tasks.length > 0
              ? [
                  h.ul(
                    [h.Class('calendar-tasks'), h.AriaLabel(`کارهای ${label}`)],
                    Array.map(detail.tasks, item =>
                      taskRow(item, model, inputs, h),
                    ),
                  ),
                ]
              : []),
            ...(detail.tasks.length === 0 &&
            detail.events.length === 0 &&
            detail.occasions.length === 0
              ? [h.p([h.Class('calendar-empty')], [emptyDayCopy])]
              : []),
          ],
        )
      })()
}

const occasionRowView = (
  entry: ReturnType<typeof upcomingOccasions>[number],
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits
  const occasion = entry.occasion
  const busy = model.maybeOccasionBusy

  return h.li(
    [h.Class('occasions-row'), h.DataAttribute('occasion-id', occasion.id)],
    [
      h.div(
        [h.Class('occasions-row-head')],
        [
          ...(occasion.color === null
            ? []
            : [
                h.span([
                  h.AriaHidden(true),
                  h.Class('occasions-dot'),
                  h.Style({ background: occasion.color }),
                ]),
              ]),
          h.strong([h.Class('occasions-row-title')], [occasion.title]),
          ...(occasion.yearly
            ? []
            : [h.span([h.Class('occasions-meta')], ['یک‌بار'])]),
        ],
      ),
      ...(entry.occurrence === null
        ? [h.p([h.Class('occasions-meta')], ['تاریخ این مناسبت گذشته است.'])]
        : [
            h.p(
              [h.Class('occasions-meta')],
              [formatOccasionDate(entry.occurrence, digits)],
            ),
            h.p(
              [h.Class('occasions-meta')],
              [
                formatAdvanceReminder(entry.occurrence, digits) ??
                  advanceLabel(occasion.advanceReminderDays),
              ],
            ),
          ]),
      h.div(
        [h.Class('occasions-row-actions')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class('occasions-small-button'),
              ...(occasion.preparationTaskId !== null
                ? [h.DataAttribute('active', 'true')]
                : []),
              h.AriaLabel(`آماده‌سازی ${occasion.title}`),
              h.Disabled(
                !inputs.isStoreReady ||
                  Option.contains(busy, `prepare:${occasion.id}`),
              ),
              h.OnClick(
                Message.ClickedPrepareOccasion({
                  occasionId: occasion.id,
                  title: occasion.title,
                }),
              ),
            ],
            [
              occasion.preparationTaskId === null
                ? 'آماده‌سازی'
                : 'آماده‌سازی ساخته شده',
            ],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class('occasions-small-button'),
              h.AriaLabel(`ویرایش ${occasion.title}`),
              h.OnClick(
                Message.ClickedEditOccasion({ occasionId: occasion.id }),
              ),
            ],
            ['ویرایش'],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class('occasions-danger-button'),
              h.AriaLabel(`حذف ${occasion.title}`),
              h.Disabled(
                !inputs.isStoreReady ||
                  Option.contains(busy, `delete:${occasion.id}`),
              ),
              h.OnClick(
                Message.ClickedDeleteOccasion({
                  occasionId: occasion.id,
                  title: occasion.title,
                }),
              ),
            ],
            ['حذف'],
          ),
        ],
      ),
    ],
  )
}

const occasionsPreview = (value: string, digits: Digits): string => {
  if (value === '') {
    return ''
  }

  try {
    return formatJalaliDate(toJalaliDate(value), {
      digits,
      style: 'medium',
    })
  } catch {
    return ''
  }
}

const occasionsPanel = (
  model: Model,
  inputs: ViewInputs,
  view: CalendarView,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits
  const ordered = upcomingOccasions(inputs.mirror.occasions, view.today)
  const preview = occasionsPreview(model.occasionOriginDate, digits)
  const busy = Option.isSome(model.maybeOccasionBusy)
  const isEditing = Option.isSome(model.occasionEditingId)
  const editingOccasion = Option.flatMap(model.occasionEditingId, occasionId =>
    Array.findFirst(
      inputs.mirror.occasions,
      occasion => occasion.id === occasionId,
    ),
  )
  const canShare = Option.match(editingOccasion, {
    onNone: () => false,
    onSome: occasion => Option.contains(inputs.maybeUserId, occasion.ownerId),
  })
  const editingVisibility = Option.getOrElse(
    Option.map(editingOccasion, occasion => occasion.visibility),
    () => 'private' as const,
  )

  return h.section(
    [h.Class('occasions-panel'), h.AriaLabel('مناسبت‌ها')],
    [
      h.header(
        [h.Class('occasions-head')],
        [
          h.h2([], ['مناسبت‌ها']),
          h.p(
            [h.Class('occasions-meta')],
            [
              `${localizeDigits(inputs.mirror.occasions.length, digits)} مناسبت ثبت شده`,
            ],
          ),
        ],
      ),
      h.p(
        [h.Class('occasions-meta')],
        [
          'تاریخ‌های مهمی که هر سال در تقویم شمسی تکرار می‌شوند؛ تاریخ میلادی هم کنارشان نمایش داده می‌شود.',
        ],
      ),
      h.form(
        [h.Class('occasions-form'), h.OnSubmit(Message.SubmittedOccasion())],
        [
          h.div(
            [h.Class('occasions-field')],
            [
              h.label(
                [h.For('occasion-title'), h.Class('occasions-label')],
                ['عنوان'],
              ),
              h.input([
                h.Id('occasion-title'),
                h.Type('text'),
                h.Class('occasions-input'),
                h.AriaLabel('عنوان مناسبت'),
                h.Placeholder('تولد، سالگرد…'),
                h.Value(model.occasionTitle),
                h.OnInput(value => Message.UpdatedOccasionTitle({ value })),
              ]),
            ],
          ),
          h.div(
            [h.Class('occasions-field')],
            [
              h.label(
                [h.For('occasion-origin'), h.Class('occasions-label')],
                ['تاریخ شروع (میلادی)'],
              ),
              h.input([
                h.Id('occasion-origin'),
                h.Type('date'),
                h.Class('occasions-input'),
                h.AriaLabel('تاریخ شروع مناسبت'),
                h.Value(model.occasionOriginDate),
                h.OnInput(value =>
                  Message.UpdatedOccasionOriginDate({ value }),
                ),
              ]),
              ...(preview === ''
                ? []
                : [h.span([h.Class('occasions-meta')], [preview])]),
            ],
          ),
          h.div(
            [h.Class('occasions-field')],
            [
              h.label(
                [h.For('occasion-advance'), h.Class('occasions-label')],
                ['یادآوری پیش از موعد'],
              ),
              h.select(
                [
                  h.Id('occasion-advance'),
                  h.Class('occasions-input'),
                  h.AriaLabel('یادآوری پیش از موعد'),
                  h.Value(model.occasionAdvance),
                  h.OnChange(value =>
                    Message.SelectedOccasionAdvance({ value }),
                  ),
                ],
                Array.map(ADVANCE_OPTIONS, option =>
                  optionValue(option.value, option.label, h),
                ),
              ),
            ],
          ),
          h.label(
            [h.Class('occasions-check')],
            [
              h.input([
                h.Type('checkbox'),
                h.Checked(model.occasionYearly),
                h.AriaLabel('هر سال تکرار شود'),
                h.OnClick(
                  Message.ToggledOccasionYearly({
                    yearly: !model.occasionYearly,
                  }),
                ),
              ]),
              'هر سال تکرار شود',
            ],
          ),
          h.div(
            [h.Class('occasions-row-actions')],
            [
              h.button(
                [
                  h.Type('submit'),
                  h.Class('occasions-primary'),
                  h.Disabled(
                    !inputs.isStoreReady ||
                      Option.contains(model.maybeOccasionBusy, 'save') ||
                      model.occasionTitle.trim() === '' ||
                      model.occasionOriginDate === '',
                  ),
                ],
                [isEditing ? 'ذخیرهٔ ویرایش' : 'افزودن مناسبت'],
              ),
              ...(isEditing
                ? [
                    ...(canShare
                      ? [
                          h.button(
                            [
                              h.Type('button'),
                              h.Class('occasions-small-button'),
                              h.Disabled(busy),
                              h.OnClick(
                                Message.ClickedToggleOccasionVisibility(),
                              ),
                            ],
                            [shareActionOf(editingVisibility).label],
                          ),
                        ]
                      : []),
                    h.button(
                      [
                        h.Type('button'),
                        h.Class('occasions-small-button'),
                        h.OnClick(Message.ClickedCancelOccasionEdit()),
                      ],
                      ['انصراف'],
                    ),
                  ]
                : []),
            ],
          ),
        ],
      ),
      ...(Array.isReadonlyArrayEmpty(ordered)
        ? [
            h.p(
              [h.Class('occasions-meta')],
              [
                'هنوز مناسبت‌ی ثبت نشده است. تولدها و سالگردها را این‌جا اضافه کنید تا هر سال خودشان در تقویم بیایند.',
              ],
            ),
          ]
        : [
            h.ul(
              [h.Class('occasions-list')],
              Array.map(ordered, entry =>
                occasionRowView(entry, model, inputs, h),
              ),
            ),
          ]),
      ...Option.match(model.maybeOccasionError, {
        onNone: () => [],
        onSome: message => [
          h.p([h.Role('alert'), h.Class('occasions-alert')], [message]),
        ],
      }),
      h.p(
        [h.Role('status'), h.AriaLive('polite'), h.Class('occasions-status')],
        [model.occasionAnnouncement],
      ),
      h.p([h.Class('occasions-sr')], [busy ? 'در حال ذخیره…' : '']),
    ],
  )
}

const eventEditorView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(model.maybeEditingEvent, {
    onNone: () => h.empty,
    onSome: editor => {
      const occurrence = editor.occurrence
      const draft = editor.draft
      const inactive = Option.isSome(model.maybePendingScope)
      const seriesRow = Array.findFirst(
        inputs.mirror.events,
        row => row.id === occurrence.id,
      )
      const isOwner = Option.match(seriesRow, {
        onNone: () => false,
        onSome: row => Option.contains(inputs.maybeUserId, row.ownerId),
      })
      const visibility = Option.getOrElse(
        Option.map(seriesRow, row => row.visibility),
        () => 'private' as const,
      )
      const canEdit =
        Option.isSome(
          Array.findFirst(
            inputs.mirror.events,
            row => row.id === occurrence.id,
          ),
        ) &&
        Option.isSome(inputs.maybeUserId) &&
        Option.isSome(inputs.maybeHouseholdId)

      return h.div(
        [
          h.Class('calendar-dialog-backdrop'),
          h.Inert(inactive),
          ...(inactive ? [h.AriaHidden(true)] : []),
        ],
        [
          h.section(
            [
              h.Class('calendar-dialog'),
              h.Role('dialog'),
              h.AriaModal(true),
              h.AriaLabelledBy('calendar-event-editor-title'),
            ],
            [
              h.h2(
                [h.Id('calendar-event-editor-title'), h.Tabindex(-1)],
                ['رویداد'],
              ),
              h.p(
                [h.Class('calendar-dialog-hint')],
                [
                  occurrence.recurring
                    ? 'این رویداد بخشی از یک مجموعهٔ تکرارشونده است.'
                    : 'رویداد تک‌باره.',
                ],
              ),
              h.form(
                [
                  h.Class('calendar-event-form'),
                  h.OnSubmit(Message.SubmittedEventEditor()),
                ],
                [
                  h.label(
                    [h.Class('calendar-field')],
                    [
                      'عنوان',
                      h.input([
                        h.Type('text'),
                        h.AriaLabel('عنوان رویداد'),
                        h.Value(draft.title),
                        h.Disabled(!canEdit || model.isEventBusy),
                        h.OnInput(value =>
                          Message.UpdatedEventEditorTitle({ value }),
                        ),
                      ]),
                    ],
                  ),
                  h.label(
                    [h.Class('calendar-event-check')],
                    [
                      h.input([
                        h.Type('checkbox'),
                        h.Checked(draft.allDay),
                        h.AriaLabel('تمام روز'),
                        h.Disabled(!canEdit || model.isEventBusy),
                        h.OnClick(
                          Message.ToggledEventEditorAllDay({
                            allDay: !draft.allDay,
                          }),
                        ),
                      ]),
                      'تمام روز',
                    ],
                  ),
                  h.label(
                    [h.Class('calendar-field')],
                    [
                      'تاریخ',
                      h.input([
                        h.Type('date'),
                        h.AriaLabel('تاریخ رویداد'),
                        h.Value(draft.date),
                        h.Disabled(!canEdit || model.isEventBusy),
                        h.OnInput(value =>
                          Message.UpdatedEventEditorDate({ value }),
                        ),
                      ]),
                    ],
                  ),
                  ...(draft.allDay
                    ? []
                    : [
                        h.span(
                          [h.Class('calendar-event-times')],
                          [
                            h.label(
                              [],
                              [
                                'از',
                                h.input([
                                  h.Type('time'),
                                  h.AriaLabel('ساعت شروع'),
                                  h.Value(draft.startTime),
                                  h.Disabled(!canEdit || model.isEventBusy),
                                  h.OnInput(value =>
                                    Message.UpdatedEventEditorStart({ value }),
                                  ),
                                ]),
                              ],
                            ),
                            h.label(
                              [],
                              [
                                'تا',
                                h.input([
                                  h.Type('time'),
                                  h.AriaLabel('ساعت پایان'),
                                  h.Value(draft.endTime),
                                  h.Disabled(!canEdit || model.isEventBusy),
                                  h.OnInput(value =>
                                    Message.UpdatedEventEditorEnd({ value }),
                                  ),
                                ]),
                              ],
                            ),
                          ],
                        ),
                      ]),
                  ...(canEdit
                    ? []
                    : [
                        h.p(
                          [h.Role('status'), h.Class('calendar-event-hint')],
                          [
                            'این رویداد هنوز در حافظهٔ محلی نیست؛ کمی بعد دوباره تلاش کنید.',
                          ],
                        ),
                      ]),
                  ...Option.match(model.maybeEditorError, {
                    onNone: () => [],
                    onSome: message => [
                      h.p(
                        [h.Role('alert'), h.Class('calendar-alert')],
                        [message],
                      ),
                    ],
                  }),
                  h.div(
                    [h.Class('calendar-dialog-actions')],
                    [
                      h.button(
                        [
                          h.Type('submit'),
                          h.Class('calendar-primary'),
                          h.Disabled(
                            !canEdit ||
                              model.isEventBusy ||
                              draft.title.trim() === '' ||
                              draft.date === '',
                          ),
                        ],
                        ['ذخیره'],
                      ),
                      ...(isOwner
                        ? [
                            h.button(
                              [
                                h.Type('button'),
                                h.Class('calendar-nav-button'),
                                h.Disabled(!canEdit || model.isEventBusy),
                                h.OnClick(
                                  Message.ClickedToggleEventVisibility(),
                                ),
                              ],
                              [shareActionOf(visibility).label],
                            ),
                          ]
                        : []),
                      h.button(
                        [
                          h.Type('button'),
                          h.Class('calendar-danger'),
                          h.Disabled(!canEdit || model.isEventBusy),
                          h.OnClick(Message.ClickedDeleteEvent()),
                        ],
                        ['حذف رویداد'],
                      ),
                      h.button(
                        [
                          h.Type('button'),
                          h.Class('calendar-nav-button'),
                          h.OnClick(Message.ClosedEventEditor()),
                        ],
                        ['بستن'],
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ],
      )
    },
  })

const scopePromptView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(model.maybePendingScope, {
    onNone: () => h.empty,
    onSome: pending => {
      const title = Option.match(pending.maybeDraft, {
        onNone: () => pending.occurrence.title,
        onSome: draft => draft.title,
      })
      const splitAvailable =
        pending.action === 'delete' ||
        (inputs.isOnline &&
          !Array.contains(
            inputs.pendingKeys,
            entityKey('event', pending.occurrence.id),
          ))
      const confirmDisabled =
        model.isEventBusy ||
        Option.isNone(pending.maybeIds) ||
        (!splitAvailable && model.eventScope === 'thisAndFollowing')

      return h.div(
        [h.Class('calendar-dialog-backdrop')],
        [
          h.section(
            [
              h.Class('calendar-dialog'),
              h.Role('dialog'),
              h.AriaModal(true),
              h.AriaLabelledBy('calendar-scope-title'),
              h.AriaDescribedBy('calendar-scope-body'),
            ],
            [
              h.h2(
                [h.Id('calendar-scope-title'), h.Tabindex(-1)],
                ['این رویداد یا این رویداد و رویدادهای بعدی؟'],
              ),
              h.p(
                [h.Id('calendar-scope-body'), h.Class('calendar-dialog-hint')],
                [
                  `«${title}» بخشی از یک مجموعهٔ تکرارشونده است. تغییر را روی کدام بخش اعمال کنم؟`,
                ],
              ),
              h.div(
                [
                  h.Class('calendar-scope-options'),
                  h.Role('radiogroup'),
                  h.AriaLabelledBy('calendar-scope-title'),
                ],
                [
                  h.label(
                    [
                      h.Class('calendar-scope-option'),
                      ...(model.eventScope === 'thisOccurrence'
                        ? [h.DataAttribute('selected', 'true')]
                        : []),
                    ],
                    [
                      h.input([
                        h.Id('calendar-scope-this'),
                        h.Type('radio'),
                        h.Name('calendar-event-scope'),
                        h.Value('thisOccurrence'),
                        h.AriaLabel('فقط این رویداد'),
                        h.Checked(model.eventScope === 'thisOccurrence'),
                        h.OnChange(() =>
                          Message.SelectedEventScope({
                            scope: 'thisOccurrence',
                          }),
                        ),
                      ]),
                      h.span(
                        [],
                        [
                          h.strong([], ['فقط این رویداد']),
                          h.small(
                            [],
                            [
                              'تازه‌ترین تغییر فقط روی همین روز اعمال می‌شود؛ بقیهٔ رویدادهای این مجموعه همان‌طور که هست می‌ماند.',
                            ],
                          ),
                        ],
                      ),
                    ],
                  ),
                  h.label(
                    [
                      h.Class('calendar-scope-option'),
                      ...(model.eventScope === 'thisAndFollowing'
                        ? [h.DataAttribute('selected', 'true')]
                        : []),
                      ...(splitAvailable
                        ? []
                        : [h.DataAttribute('disabled', 'true')]),
                    ],
                    [
                      h.input([
                        h.Type('radio'),
                        h.Name('calendar-event-scope'),
                        h.Value('thisAndFollowing'),
                        h.AriaLabel('این رویداد و رویدادهای بعدی'),
                        h.Checked(model.eventScope === 'thisAndFollowing'),
                        h.Disabled(!splitAvailable || model.isEventBusy),
                        h.AriaDescribedBy('calendar-scope-following-hint'),
                        h.OnChange(() =>
                          Message.SelectedEventScope({
                            scope: 'thisAndFollowing',
                          }),
                        ),
                      ]),
                      h.span(
                        [],
                        [
                          h.strong([], ['این رویداد و رویدادهای بعدی']),
                          h.small(
                            [h.Id('calendar-scope-following-hint')],
                            [
                              isAnchorOccurrence(pending.occurrence)
                                ? pending.action === 'delete'
                                  ? 'این رویداد اولین رویداد مجموعه است؛ این انتخاب کل مجموعه را حذف می‌کند.'
                                  : 'این رویداد اولین رویداد مجموعه است؛ این انتخاب کل مجموعه را تغییر می‌دهد.'
                                : 'مجموعه از همین روز به بعد جدا می‌شود؛ روزهای پیش از آن دست‌نخورده می‌مانند.',
                              splitAvailable
                                ? ''
                                : ' برای جدا کردن مجموعه باید به سرور متصل باشید و این رویداد همگام شده باشد.',
                            ],
                          ),
                        ],
                      ),
                    ],
                  ),
                ],
              ),
              ...Option.match(model.maybeEditorError, {
                onNone: () => [],
                onSome: message => [
                  h.p([h.Role('alert'), h.Class('calendar-alert')], [message]),
                ],
              }),
              h.div(
                [h.Class('calendar-dialog-actions')],
                [
                  h.button(
                    [
                      h.Type('button'),
                      h.Class('calendar-primary'),
                      h.Disabled(confirmDisabled),
                      h.OnClick(Message.PressedConfirmEventScope()),
                    ],
                    [model.isEventBusy ? 'در حال اعمال…' : 'ادامه'],
                  ),
                  h.button(
                    [
                      h.Type('button'),
                      h.Class('calendar-nav-button'),
                      h.OnClick(Message.PressedCancelEventScope()),
                    ],
                    ['انصراف'],
                  ),
                ],
              ),
            ],
          ),
        ],
      )
    },
  })

const weekView = (
  model: Model,
  inputs: ViewInputs,
  view: CalendarView,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits
  const empty = Array.every(
    view.week.days,
    day =>
      Array.isReadonlyArrayEmpty(day.tasks) &&
      Array.isReadonlyArrayEmpty(day.events) &&
      Array.isReadonlyArrayEmpty(day.occasions),
  )

  return h.div(
    [],
    [
      h.div(
        [h.Class('calendar-head')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class('calendar-nav-button'),
              h.AriaExpanded(model.planningOpen),
              h.AriaControls('calendar-planning-panel'),
              h.OnClick(Message.ClickedTogglePlanning()),
            ],
            ['برنامه‌ریزی هفته'],
          ),
          h.p(
            [h.Class('calendar-nav-title')],
            [
              `${localizeDigits(view.week.totals.tasks, digits)} کار، ${localizeDigits(view.week.totals.events, digits)} رویداد، ${localizeDigits(view.week.totals.occasions, digits)} مناسبت در این هفته`,
            ],
          ),
        ],
      ),
      ...(model.planningOpen
        ? [
            h.div(
              [h.Id('calendar-planning-panel')],
              [planningPanel(model, inputs, view, h)],
            ),
          ]
        : []),
      ...(empty ? [h.p([h.Class('calendar-empty')], [emptyWeekCopy])] : []),
      h.div(
        [h.Class('calendar-week')],
        Array.map(view.week.days, day =>
          weekDayCard(day, model, inputs, view, h),
        ),
      ),
    ],
  )
}

const habitTrendReserve = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.Class('calendar-trend'),
      h.AriaLabel('روند عادت‌ها'),
      h.DataAttribute('reserved', 'habits'),
    ],
    [
      h.h2([], ['روند عادت‌ها']),
      h.p([], ['نمودار ماهانهٔ عادت‌ها در گام عادت‌ها این‌جا نمایش داده می‌شود.']),
    ],
  )

export const calendarPageView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const view = viewOf(model, inputs)
  const digits = inputs.display.digits

  return h.section(
    [
      h.Class('calendar-page page-wrap grid max-w-6xl gap-2.5'),
      h.DataAttribute('source', view.source),
      h.Dir('rtl'),
      h.Lang('fa'),
    ],
    [
      headerView(model, inputs, h),
      ...(model.view === 'week'
        ? [
            h.div(
              [],
              [
                h.div(
                  [h.Class('calendar-nav')],
                  [
                    h.button(
                      [
                        h.Type('button'),
                        h.Class('calendar-nav-button'),
                        h.AriaLabel('هفتهٔ قبل'),
                        h.OnClick(Message.PressedPreviousWeek()),
                      ],
                      ['→'],
                    ),
                    h.p(
                      [h.Class('calendar-nav-title')],
                      [weekTitle(view.week.start, view.week.end, digits)],
                    ),
                    h.button(
                      [
                        h.Type('button'),
                        h.Class('calendar-nav-button'),
                        h.AriaLabel('هفتهٔ بعد'),
                        h.OnClick(Message.PressedNextWeek()),
                      ],
                      ['←'],
                    ),
                    h.button(
                      [
                        h.Type('button'),
                        h.Class('calendar-nav-button'),
                        h.OnClick(Message.PressedTodayWeek()),
                      ],
                      ['امروز'],
                    ),
                  ],
                ),
                weekView(model, inputs, view, h),
              ],
            ),
          ]
        : [
            monthNavigation(model, digits, h),
            monthGrid(model, inputs, view, h),
            dayDetail(model, inputs, view, h),
            habitTrendReserve(h),
          ]),
      occasionsPanel(model, inputs, view, h),
      ...Option.match(model.maybePageError, {
        onNone: () => [],
        onSome: message => [
          h.p([h.Role('alert'), h.Class('calendar-alert')], [message]),
        ],
      }),
      eventEditorView(model, inputs, h),
      scopePromptView(model, inputs, h),
      h.p(
        [h.Class('calendar-sr'), h.Role('status'), h.AriaLive('polite')],
        [model.announcement],
      ),
    ],
  )
}
