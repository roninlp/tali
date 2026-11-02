import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Checkbox, Listbox } from '@foldkit/ui'
import type { CalendarTaskItem, Digits, EventOccurrence } from '@tali/domain'
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
import { listboxViewInputs } from '../ui/listbox'
import {
  Message,
  OccasionAdvanceListbox,
  PlanningPriorityListbox,
  planningPriorityListboxFor,
} from './calendar'
import type { Model, PlanningPriorityOption, ViewInputs } from './calendar'
import {
  type CalendarView,
  PRIORITY_LABELS,
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
 *
 * Every surface is a Tailwind recipe; the `data-calendar-*` attributes are
 * structural hooks for the scene tests, not styling classes.
 */

const HOUR_HEIGHT = 40
const MIN_BLOCK_MINUTES = 28

/* Dense-row recipes reused across the week cards and the month detail. */
const TASK_ROW_CLASS =
  'grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-1.5 py-0.5'
const TASK_TITLE_CLASS =
  'break-words text-[0.84rem] leading-6 no-underline hover:underline group-data-[priority=high]:text-warning'
const TASK_BADGE_CLASS =
  'justify-self-start rounded-full border border-primary/25 bg-primary/10 px-1.5 text-[0.68rem] leading-5 text-primary'
const TASK_CHECK_CLASS =
  'relative grid size-5 flex-none place-items-center rounded-full border-[1.5px] border-base-300 bg-base-100 text-[0.62rem] text-base-content/55 transition-colors before:absolute before:-inset-1.5 before:content-[""] hover:border-secondary hover:text-secondary disabled:opacity-45'

const QUICK_INPUT_CLASS =
  'min-h-10 min-w-0 flex-1 rounded-xl border border-base-300 bg-base-100 px-2.5 text-[0.8rem] outline-none transition-colors placeholder:text-base-content/35 focus:border-primary focus:ring-4 focus:ring-primary/10 disabled:opacity-55 min-[1024px]:min-h-9'

const NAV_BUTTON_CLASS = 'btn btn-sm btn-outline min-h-10 rounded-full px-3.5'
const PRIMARY_BUTTON_CLASS = 'btn btn-primary min-h-10 rounded-xl'
const DANGER_BUTTON_CLASS =
  'btn min-h-10 rounded-xl border-error/30 bg-error/8 text-error hover:bg-error/14 hover:text-error'
const SMALL_BUTTON_CLASS = 'btn btn-sm btn-outline min-h-10 rounded-full px-3'

const TIME_LABEL_CLASS =
  'grid min-w-0 gap-0.5 text-[0.68rem] text-base-content/50'
const TIME_INPUT_CLASS = 'field-input h-8 w-full min-w-0 px-1.5 text-[0.78rem]'

const EVENT_CHIP_CLASS =
  'flex w-full min-w-0 items-center gap-1 rounded-lg bg-secondary/12 px-1.5 py-0.5 text-start text-[0.66rem] leading-6 text-secondary data-[allday=true]:bg-info/12 data-[allday=true]:text-info'
const EVENT_CHIP_MONTH_CLASS =
  'flex w-full min-w-0 items-center justify-center gap-1 rounded-full bg-secondary/12 px-1 text-[0.5rem] leading-5 text-secondary data-[allday=true]:bg-info/12 data-[allday=true]:text-info'
const EVENT_CHIP_MORE_CLASS =
  'flex w-full items-center justify-center rounded-lg px-1.5 py-0.5 text-[0.66rem] leading-6 text-base-content/55'

const OCCASION_CHIP_CLASS =
  'min-w-0 truncate rounded-full bg-error/12 px-1.5 text-[0.55rem] leading-5 text-error'
const OCCASION_CHIP_WEEK_CLASS =
  'w-full truncate rounded-full bg-error/12 px-1.5 py-0.5 text-[0.64rem] leading-5 text-error'
const OCCASION_CHIP_MORE_CLASS =
  'min-w-0 rounded-full px-1.5 text-center text-[0.55rem] leading-5 text-base-content/55'

const META_CLASS = 'm-0 text-[0.78rem] leading-6 text-base-content/55'
const FIELD_CLASS = 'grid min-w-0 gap-1.5'
const FIELD_LABEL_CLASS = 'text-[0.78rem] text-base-content/55'

const DIALOG_BACKDROP_CLASS =
  'fixed inset-0 z-[60] grid place-items-center bg-black/40 p-3 backdrop-blur-[2px]'
const DIALOG_CLASS =
  'grid max-h-[calc(100dvh-1.5rem)] w-full max-w-[27.5rem] gap-3 overflow-y-auto rounded-2xl border border-base-300 bg-base-100 p-5 text-base-content shadow-float'
const DIALOG_TITLE_CLASS = 'm-0 text-base font-semibold outline-none'
const DIALOG_HINT_CLASS = 'm-0 text-[0.78rem] leading-6 text-base-content/55'
const DIALOG_ACTIONS_CLASS = 'flex flex-wrap justify-end gap-2'
const SCOPE_OPTION_CLASS =
  'grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-xl border border-base-300 bg-base-100 p-3 transition-colors data-[disabled=true]:opacity-60 data-[selected=true]:border-primary data-[selected=true]:bg-primary/8'
const SCOPE_HINT_CLASS = 'text-[0.7rem] leading-6 text-base-content/55'

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

const PLANNING_PRIORITY_OPTIONS: ReadonlyArray<PlanningPriorityOption> = [
  { value: 'high', label: PRIORITY_LABELS.high },
  { value: 'medium', label: PRIORITY_LABELS.medium },
  { value: 'low', label: PRIORITY_LABELS.low },
]

const tabButton = (
  label: string,
  view: 'week' | 'month',
  model: Model,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Class(
        'inline-flex min-h-10 items-center justify-center rounded-full px-3.5 text-[0.8rem] text-base-content/55 transition-colors hover:text-base-content aria-pressed:bg-primary aria-pressed:font-semibold aria-pressed:text-primary-content',
      ),
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
        [
          h.Role('status'),
          h.Class('m-0 text-[0.72rem] leading-6 text-warning'),
        ],
        [sourceText(inputs.isOnline, model.fetchState)],
      )
    : h.empty

const headerView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.header(
    [h.Class('flex flex-wrap items-end justify-between gap-3')],
    [
      h.div(
        [h.Class('grid min-w-0 gap-1')],
        [
          h.h1(
            [h.Class('m-0 text-2xl font-bold tracking-tight sm:text-3xl')],
            ['تقویم'],
          ),
          h.p(
            [h.Class('m-0 text-sm leading-7 text-base-content/55')],
            [
              'هفته و ماه را یک‌جا ببینید؛ کارها، رویدادها و مناسبت‌ها در یک نگاه.',
            ],
          ),
          sourceHintView(model, inputs, h),
        ],
      ),
      h.div(
        [
          h.Class(
            'inline-flex gap-0.5 rounded-full border border-base-300 bg-base-100 p-1',
          ),
          h.Role('group'),
          h.AriaLabel('نمای تقویم'),
        ],
        [
          tabButton('هفته', 'week', model, h),
          tabButton('ماه', 'month', model, h),
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
  const taskBody = h.div(
    [h.Class('grid min-w-0 gap-px')],
    [
      item.projected
        ? h.span([h.Class(TASK_TITLE_CLASS)], [item.title])
        : h.a(
            [h.Class(TASK_TITLE_CLASS), h.Href(taskAnchorPath(item.id))],
            [item.title],
          ),
      ...(item.projected
        ? [h.span([h.Class(TASK_BADGE_CLASS)], ['تکرارشونده — فقط نمایش'])]
        : []),
      ...(item.priority === 'high' && !item.projected
        ? [h.span([h.Class(TASK_BADGE_CLASS)], ['اولویت بالا'])]
        : []),
    ],
  )

  if (item.projected) {
    return h.li(
      [
        h.Class(`${TASK_ROW_CLASS} group`),
        h.DataAttribute('priority', item.priority),
        ...(item.projected ? [h.DataAttribute('projected', 'true')] : []),
      ],
      [
        h.span([h.AriaHidden(true), h.Class(TASK_CHECK_CLASS)], ['↻']),
        taskBody,
      ],
    )
  }

  return Checkbox.view(
    {
      id: `calendar-check-${item.id}`,
      isChecked: false,
      onToggle: () =>
        Message.ClickedCompleteCalendarTask({
          taskId: item.id,
          title: item.title,
          projected: item.projected,
        }),
      toView: attributes =>
        h.li(
          [
            h.Class(`${TASK_ROW_CLASS} group`),
            h.DataAttribute('priority', item.priority),
          ],
          [
            h.span(
              [...attributes.label, h.Class('sr-only')],
              [`انجام ${item.title}`],
            ),
            h.button(
              [
                ...attributes.checkbox,
                h.Class(TASK_CHECK_CLASS),
                h.Disabled(!inputs.isStoreReady || busy),
              ],
              ['✓'],
            ),
            taskBody,
          ],
        ),
    },
    h,
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
      h.Class('flex min-w-0 gap-1.5'),
      h.OnSubmit(Message.SubmittedTaskQuickAdd({ date })),
    ],
    [
      h.input([
        h.Type('text'),
        h.Class(QUICK_INPUT_CLASS),
        h.AriaLabel(`کار تازه برای ${label}`),
        h.Placeholder('کار تازه…'),
        h.Value(value),
        h.Disabled(!inputs.isStoreReady),
        h.OnInput(next => Message.UpdatedTaskDraft({ date, value: next })),
      ]),
      h.button(
        [
          h.Type('submit'),
          h.AriaLabel(`افزودن کار برای ${label}`),
          h.Class(
            'grid size-10 flex-none place-items-center rounded-xl bg-primary text-base leading-none text-primary-content transition hover:opacity-90 active:scale-95 disabled:opacity-40 min-[1024px]:size-9',
          ),
          h.Disabled(!inputs.isStoreReady || busy || value.trim() === ''),
        ],
        ['+'],
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
      h.Class('group min-w-0'),
      h.DataAttribute('calendar-event-add', 'true'),
      // The details is native-controlled while open: rendering an explicit
      // `open=false` on every pass can close it between the click and the
      // OnToggle dispatch while the mirror is still settling. Keying the
      // element on the open state remounts it closed after a successful add
      // without racing the native toggle.
      ...(draft.open ? [h.Open(true)] : []),
      h.OnToggle(isOpen => Message.ToggledEventQuickAdd({ date, isOpen })),
    ],
    [
      h.summary(
        [
          h.AriaLabel(`رویداد تازه برای ${label}`),
          h.Class(
            'inline-flex cursor-pointer list-none items-center gap-1 rounded-lg py-1 text-[0.7rem] leading-6 text-base-content/45 transition-colors hover:text-primary group-open:text-primary [&::-webkit-details-marker]:hidden',
          ),
        ],
        ['+ رویداد'],
      ),
      h.form(
        [
          h.Class(
            'mt-1 grid min-w-0 gap-2 rounded-xl border border-base-300 bg-base-200/50 p-2',
          ),
          h.OnSubmit(Message.SubmittedEventQuickAdd({ date })),
        ],
        [
          h.input([
            h.Type('text'),
            h.Class('field-input'),
            h.AriaLabel(`عنوان رویداد برای ${label}`),
            h.Placeholder('رویداد تازه…'),
            h.Value(draft.title),
            h.Disabled(!inputs.isStoreReady),
            h.OnInput(value => Message.UpdatedQuickEventTitle({ date, value })),
          ]),
          Checkbox.view(
            {
              id: `quick-event-all-day-${date}`,
              isChecked: draft.allDay,
              onToggle: allDay =>
                Message.ToggledQuickEventAllDay({ date, allDay }),
              toView: attributes =>
                h.div(
                  [
                    h.Class(
                      'inline-flex items-center gap-1.5 text-[0.72rem] leading-6 text-base-content/55',
                    ),
                  ],
                  [
                    h.button([...attributes.checkbox, h.Class('form-check')]),
                    h.span([...attributes.label], ['تمام روز']),
                  ],
                ),
            },
            h,
          ),
          draft.allDay
            ? h.p(
                [h.Class('m-0 text-[0.68rem] leading-6 text-base-content/55')],
                ['بدون ساعت'],
              )
            : h.span(
                [h.Class('grid min-w-0 gap-1.5')],
                [
                  h.label(
                    [h.Class(TIME_LABEL_CLASS)],
                    [
                      'از',
                      h.input([
                        h.Type('time'),
                        h.Class(TIME_INPUT_CLASS),
                        h.AriaLabel(`ساعت شروع رویداد در ${label}`),
                        h.Value(draft.startTime),
                        h.OnInput(value =>
                          Message.UpdatedQuickEventStart({ date, value }),
                        ),
                      ]),
                    ],
                  ),
                  h.label(
                    [h.Class(TIME_LABEL_CLASS)],
                    [
                      'تا',
                      h.input([
                        h.Type('time'),
                        h.Class(TIME_INPUT_CLASS),
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
              h.Class(`${PRIMARY_BUTTON_CLASS} w-full`),
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
      h.Class(EVENT_CHIP_CLASS),
      h.DataAttribute('calendar-event-chip', 'true'),
      ...(occurrence.timing._tag === 'allDay'
        ? [h.DataAttribute('allday', 'true')]
        : []),
      h.Title(`${time === null ? 'تمام روز' : time} — ${occurrence.title}`),
      h.OnClick(Message.OpenedEventEditor({ occurrence })),
    ],
    [
      ...(time === null
        ? []
        : [h.span([h.Class('flex-none tabular-nums opacity-85')], [time])]),
      h.span([h.Class('min-w-0 truncate')], [occurrence.title]),
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
      h.Class('min-w-0'),
      ...(occurrence.timing._tag === 'allDay'
        ? [h.DataAttribute('allday', 'true')]
        : []),
    ],
    [
      h.button(
        [
          h.Type('button'),
          h.Class(
            'flex w-full min-w-0 items-center gap-1.5 rounded-xl border border-transparent px-1.5 py-1 text-start transition-colors hover:border-base-300 hover:bg-base-200',
          ),
          h.AriaLabel(`بازکردن ${occurrence.title}`),
          h.OnClick(Message.OpenedEventEditor({ occurrence })),
        ],
        [
          h.span(
            [
              h.Class(
                'flex-none text-[0.68rem] tabular-nums text-base-content/55',
              ),
            ],
            [time ?? 'تمام روز'],
          ),
          h.span(
            [h.Class('min-w-0 text-[0.82rem] leading-6 break-words')],
            [occurrence.title],
          ),
          ...(occurrence.projected
            ? [h.span([h.Class(TASK_BADGE_CLASS)], ['از مجموعه'])]
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
      h.Class('relative my-0.5 border-s border-base-300 ps-[34px]'),
      h.DataAttribute('calendar-time-grid', 'true'),
      h.Role('list'),
      h.AriaLabel('رویدادهای زمانی'),
      h.Style({ height: `${hours.length * HOUR_HEIGHT}px` }),
    ],
    [
      ...Array.map(hours, hour =>
        h.div(
          [
            h.Class('h-10 border-t border-base-content/8 first:border-t-0'),
            h.Role('listitem'),
            h.DataAttribute('hour', String(hour)),
          ],
          [
            h.span(
              [
                h.Class(
                  'absolute start-0 translate-y-[-0.6em] text-[0.58rem] tabular-nums text-base-content/35',
                ),
              ],
              [hourLabel(hour, digits)],
            ),
          ],
        ),
      ),
      ...Array.map(positioned, entry =>
        h.button(
          [
            h.Type('button'),
            h.Class(
              'absolute start-[34px] end-0.5 grid content-start gap-0 overflow-hidden rounded-lg border border-secondary/35 bg-secondary/12 px-1.5 py-px text-start text-secondary',
            ),
            h.DataAttribute('event-key', entry.occurrence.key),
            h.DataAttribute('calendar-time-event', 'true'),
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
            h.span([h.Class('text-[0.62rem] tabular-nums')], [entry.time]),
            h.span(
              [h.Class('truncate text-[0.72rem] leading-6')],
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
              h.Class('grid gap-1'),
              h.AriaLabel(`تمام‌روزها و مناسبت‌های ${label}`),
            ],
            [
              ...Array.map(allDay, occurrence =>
                eventChip(occurrence, digits, timeZone, h),
              ),
              ...Array.map(day.occasions, occasion =>
                h.span(
                  [
                    h.Class(OCCASION_CHIP_WEEK_CLASS),
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
    hasTimedEvents(timed) ? timeGridView(timed, digits, timeZone, h) : h.empty,
  ]
}

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
      h.Class(
        'panel group grid min-w-0 grid-cols-1 content-start gap-2 overflow-hidden p-3 data-[today=true]:border-primary data-[today=true]:ring-2 data-[today=true]:ring-primary/15',
      ),
      h.DataAttribute('calendar-week-day', 'true'),
      ...(isToday
        ? [h.DataAttribute('today', 'true'), h.AriaCurrent('date')]
        : []),
      h.AriaLabel(label),
    ],
    [
      h.header(
        [h.Class('flex items-baseline justify-between gap-1.5')],
        [
          h.span(
            [h.Class('text-[0.78rem] leading-6 text-base-content/55')],
            [weekdayOf(day.date)],
          ),
          h.span(
            [],
            [
              h.span(
                [
                  h.Class(
                    'text-base leading-5 font-bold group-data-[today=true]:text-primary',
                  ),
                ],
                [jalaliDayNumber(day.date, digits)],
              ),
              ' ',
              h.span(
                [h.Class('text-[0.68rem] text-base-content/55')],
                [monthNameOf(day.date)],
              ),
            ],
          ),
        ],
      ),
      taskQuickAdd(model, inputs, day.date, label, h),
      ...(day.tasks.length > 0
        ? [
            h.ul(
              [
                h.Class('m-0 grid list-none gap-0.5 p-0'),
                h.AriaLabel(tasksLabel),
              ],
              Array.map(day.tasks, item => taskRow(item, model, inputs, h)),
            ),
          ]
        : []),
      ...eventLanes(day, digits, view.week.timeZone, h),
      ...(day.tasks.length === 0 &&
      day.events.length === 0 &&
      day.occasions.length === 0
        ? [
            h.p(
              [
                h.Class(
                  'm-0 py-1 text-[0.75rem] leading-6 text-base-content/45',
                ),
              ],
              [emptyDayCopy],
            ),
          ]
        : []),
      eventQuickAdd(model, inputs, day.date, label, h),
    ],
  )
}

const planningGroups = (view: CalendarView) =>
  view.week.days.flatMap(day => {
    const items = Array.filter(day.tasks, item => !item.projected)

    return Array.isReadonlyArrayEmpty(items) ? [] : [{ date: day.date, items }]
  })

const planningRowView = (
  item: CalendarTaskItem,
  date: string,
  model: Model,
  inputs: ViewInputs,
  view: CalendarView,
  h: HtmlBuilder<Message>,
): Html => {
  const priorityListbox = planningPriorityListboxFor(model, item.id)

  return h.keyed('li')(
    item.id,
    [
      h.Class(
        'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-base-300 py-2 first:border-t-0 first:pt-0',
      ),
    ],
    [
      h.span(
        [h.Class('min-w-0 text-[0.82rem] leading-6 break-words')],
        [item.title],
      ),
      h.div(
        [h.Class('flex flex-wrap items-center justify-end gap-1.5')],
        [
          h.div(
            [h.Class('grid gap-1.5')],
            [
              h.label(
                [
                  h.For(Listbox.buttonId(priorityListbox.id)),
                  h.Class('sr-only'),
                ],
                [`اولویت ${item.title}`],
              ),
              h.submodel({
                slotId: priorityListbox.id,
                model: priorityListbox,
                view: PlanningPriorityListbox.view,
                viewInputs: listboxViewInputs({
                  items: PLANNING_PRIORITY_OPTIONS,
                  maybeSelectedValue: Option.some(item.priority),
                  isDisabled: !inputs.isStoreReady || item.projected,
                  h,
                }),
                toParentMessage: message =>
                  Message.GotPlanningPriorityListboxMessage({
                    taskId: item.id,
                    message,
                  }),
              }),
            ],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class(`${SMALL_BUTTON_CLASS} text-[0.74rem]`),
              h.AriaLabel(`یک روز قبل ${item.title}`),
              h.Disabled(!inputs.isStoreReady || date <= view.week.start),
              h.OnClick(
                Message.ClickedMoveCalendarTask({
                  taskId: item.id,
                  title: item.title,
                  date,
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
              h.Class(`${SMALL_BUTTON_CLASS} text-[0.74rem]`),
              h.AriaLabel(`یک روز بعد ${item.title}`),
              h.Disabled(!inputs.isStoreReady || date >= view.week.end),
              h.OnClick(
                Message.ClickedMoveCalendarTask({
                  taskId: item.id,
                  title: item.title,
                  date,
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
  )
}

const planningPanel = (
  model: Model,
  inputs: ViewInputs,
  view: CalendarView,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits
  const groups = planningGroups(view)

  return h.section(
    [
      h.Class('panel grid grid-cols-1 gap-3 p-4 sm:p-5'),
      h.AriaLabel('برنامه‌ریزی هفته'),
    ],
    [
      h.h2([h.Class('m-0 text-[0.95rem] font-semibold')], ['برنامه‌ریزی هفته']),
      h.p(
        [h.Class('m-0 text-[0.72rem] leading-6 text-base-content/50')],
        [
          'هفته را مرور کنید: اولویت هر کار را تعیین کنید یا آن را یک روز جابه‌جا کنید. کارهای تکرارشونده فقط نمایشی‌اند.',
        ],
      ),
      ...(Array.isReadonlyArrayEmpty(groups)
        ? [
            h.p(
              [h.Class('m-0 text-[0.78rem] leading-6 text-base-content/55')],
              [emptyWeekCopy],
            ),
          ]
        : Array.map(groups, group =>
            h.div(
              [h.Class('grid gap-1.5')],
              [
                h.p(
                  [
                    h.Class(
                      'm-0 text-[0.74rem] leading-6 text-base-content/50',
                    ),
                  ],
                  [dayLabel(group.date, digits)],
                ),
                h.ul(
                  [h.Class('m-0 grid list-none gap-2 p-0')],
                  Array.map(group.items, item =>
                    planningRowView(item, group.date, model, inputs, view, h),
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
    [h.Class('flex flex-wrap items-center gap-1.5')],
    [
      h.button(
        [
          h.Type('button'),
          h.Class(NAV_BUTTON_CLASS),
          h.AriaLabel('ماه قبل'),
          h.OnClick(Message.PressedPreviousMonth()),
        ],
        ['→'],
      ),
      h.p(
        [
          h.Class(
            'm-0 min-w-0 text-[0.92rem] leading-6 font-medium break-words',
          ),
        ],
        [monthTitle(model.anchor, digits)],
      ),
      h.button(
        [
          h.Type('button'),
          h.Class(NAV_BUTTON_CLASS),
          h.AriaLabel('ماه بعد'),
          h.OnClick(Message.PressedNextMonth()),
        ],
        ['←'],
      ),
      h.button(
        [
          h.Type('button'),
          h.Class(NAV_BUTTON_CLASS),
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
        [h.Class('grid grid-cols-7 gap-0.5'), h.Role('row')],
        Array.map(weekdays, day =>
          h.div(
            [
              h.Class(
                'text-center text-[0.64rem] leading-6 text-base-content/55',
              ),
              h.Role('columnheader'),
              h.AriaLabel(day.weekday),
            ],
            [h.span([h.AriaHidden(true)], [day.shortWeekday])],
          ),
        ),
      ),
      h.ol(
        [
          h.Class('m-0 grid min-w-0 list-none grid-cols-7 gap-0.5 p-0'),
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
            [h.Class('min-w-0')],
            [
              h.button(
                [
                  h.Type('button'),
                  h.Class(
                    'grid min-h-11 w-full min-w-0 content-start justify-items-center gap-1 rounded-xl border border-transparent bg-base-100 px-1 py-1.5 text-base-content transition-colors hover:border-base-300 data-[busy=true]:border-primary/30 data-[outside=true]:bg-base-200 data-[outside=true]:text-base-content/35 data-[today=true]:ring-2 data-[today=true]:ring-primary/60 data-[today=true]:ring-inset aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary',
                  ),
                  ...(cell.inMonth ? [] : [h.DataAttribute('outside', 'true')]),
                  ...(cell.isBusy ? [h.DataAttribute('busy', 'true')] : []),
                  ...(cell.date === view.today
                    ? [h.DataAttribute('today', 'true')]
                    : []),
                  h.DataAttribute('calendar-month-day', 'true'),
                  h.AriaLabel(parts.join(' — ')),
                  h.AriaPressed(isSelected ? 'true' : 'false'),
                  h.OnClick(Message.SelectedCalendarDay({ date: cell.date })),
                ],
                [
                  h.span(
                    [h.Class('text-[0.8rem] leading-5')],
                    [jalaliDayNumber(cell.date, digits)],
                  ),
                  h.span(
                    [h.Class('flex min-h-1 gap-0.5'), h.AriaHidden(true)],
                    Array.makeBy(cell.busyLevel, () =>
                      h.span([
                        h.Class('size-1 rounded-full bg-primary/75'),
                        h.DataAttribute('calendar-month-dot', 'true'),
                      ]),
                    ),
                  ),
                  ...(dayEvents.length > 0
                    ? [
                        h.span(
                          [
                            h.Class(
                              'grid w-full min-w-0 justify-items-stretch gap-px',
                            ),
                            h.AriaHidden(true),
                          ],
                          [
                            ...Array.map(Array.take(dayEvents, 2), occurrence =>
                              h.span(
                                [
                                  h.Class(EVENT_CHIP_MONTH_CLASS),
                                  h.DataAttribute(
                                    'calendar-month-event',
                                    'true',
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
                                          [
                                            h.Class(
                                              'flex-none tabular-nums opacity-85',
                                            ),
                                          ],
                                          [time],
                                        ),
                                      ],
                                    },
                                  ),
                                  h.span(
                                    [h.Class('min-w-0 truncate')],
                                    [occurrence.title],
                                  ),
                                ],
                              ),
                            ),
                            ...(dayEvents.length > 2
                              ? [
                                  h.span(
                                    [
                                      h.Class(EVENT_CHIP_MORE_CLASS),
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
                            h.Class(
                              'grid w-full min-w-0 justify-items-stretch gap-px',
                            ),
                            h.AriaHidden(true),
                          ],
                          [
                            ...Array.map(
                              Array.take(dayOccasions, 2),
                              occasion =>
                                h.span(
                                  [
                                    h.Class(OCCASION_CHIP_CLASS),
                                    h.DataAttribute(
                                      'calendar-occasion-chip',
                                      'true',
                                    ),
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
                                      h.Class(OCCASION_CHIP_MORE_CLASS),
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
          [
            h.Class('panel grid grid-cols-1 gap-3 p-4 sm:p-5'),
            h.AriaLabel('جزئیات روز'),
          ],
          [
            h.header(
              [h.Class('flex flex-wrap items-center justify-between gap-2')],
              [
                h.h2([h.Class('m-0 text-[0.95rem] font-semibold')], [label]),
                h.div(
                  [h.Class('flex flex-wrap items-center gap-1.5')],
                  [
                    h.button(
                      [
                        h.Type('button'),
                        h.Class(NAV_BUTTON_CLASS),
                        h.OnClick(
                          Message.OpenedDayInWeek({ date: detail.date }),
                        ),
                      ],
                      ['دیدن در نمای هفته'],
                    ),
                    h.button(
                      [
                        h.Type('button'),
                        h.Class(NAV_BUTTON_CLASS),
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
                      h.Class('m-0 grid list-none gap-1 p-0'),
                      h.AriaLabel(`مناسبت‌های ${label}`),
                    ],
                    Array.map(detail.occasions, occasion =>
                      h.li(
                        [
                          h.Class(
                            'flex min-w-0 flex-wrap items-center gap-1.5',
                          ),
                          h.DataAttribute('occasion-date', occasion.date),
                        ],
                        [
                          h.span(
                            [
                              h.Class(OCCASION_CHIP_CLASS),
                              ...(occasion.color === null
                                ? []
                                : [h.DataAttribute('color', occasion.color)]),
                            ],
                            [occasion.title],
                          ),
                          h.span(
                            [h.Class('text-[0.7rem] text-base-content/55')],
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
                      h.Class('m-0 grid list-none gap-0.5 p-0'),
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
                    [
                      h.Class('m-0 grid list-none gap-0.5 p-0'),
                      h.AriaLabel(`کارهای ${label}`),
                    ],
                    Array.map(detail.tasks, item =>
                      taskRow(item, model, inputs, h),
                    ),
                  ),
                ]
              : []),
            ...(detail.tasks.length === 0 &&
            detail.events.length === 0 &&
            detail.occasions.length === 0
              ? [
                  h.p(
                    [
                      h.Class(
                        'm-0 text-[0.78rem] leading-6 text-base-content/55',
                      ),
                    ],
                    [emptyDayCopy],
                  ),
                ]
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
    [
      h.Class('grid min-w-0 gap-1.5 py-3'),
      h.DataAttribute('occasion-id', occasion.id),
    ],
    [
      h.div(
        [h.Class('flex min-w-0 items-center gap-1.5')],
        [
          ...(occasion.color === null
            ? []
            : [
                h.span([
                  h.AriaHidden(true),
                  h.Class('size-2.5 flex-none rounded-full'),
                  h.Style({ background: occasion.color }),
                ]),
              ]),
          h.strong(
            [h.Class('min-w-0 wrap-anywhere text-[0.92rem] font-semibold')],
            [occasion.title],
          ),
          ...(occasion.yearly
            ? []
            : [
                h.span(
                  [h.Class('text-[0.78rem] leading-6 text-base-content/55')],
                  ['یک‌بار'],
                ),
              ]),
        ],
      ),
      ...(entry.occurrence === null
        ? [
            h.p(
              [h.Class('m-0 text-[0.78rem] leading-6 text-base-content/55')],
              ['تاریخ این مناسبت گذشته است.'],
            ),
          ]
        : [
            h.p(
              [h.Class('m-0 text-[0.78rem] leading-6 text-base-content/55')],
              [formatOccasionDate(entry.occurrence, digits)],
            ),
            h.p(
              [h.Class('m-0 text-[0.78rem] leading-6 text-base-content/55')],
              [
                formatAdvanceReminder(entry.occurrence, digits) ??
                  advanceLabel(occasion.advanceReminderDays),
              ],
            ),
          ]),
      h.div(
        [h.Class('flex flex-wrap items-center gap-1.5')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class(
                `${SMALL_BUTTON_CLASS} data-[active=true]:border-primary data-[active=true]:bg-primary/10 data-[active=true]:text-primary`,
              ),
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
              h.Class(SMALL_BUTTON_CLASS),
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
              h.Class(DANGER_BUTTON_CLASS),
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
    [
      h.Class('panel grid grid-cols-1 min-w-0 gap-3 p-4 sm:p-5'),
      h.AriaLabel('مناسبت‌ها'),
    ],
    [
      h.header(
        [h.Class('flex flex-wrap items-center justify-between gap-2')],
        [
          h.h2([h.Class('m-0 text-base font-semibold')], ['مناسبت‌ها']),
          h.p(
            [h.Class(META_CLASS)],
            [
              `${localizeDigits(inputs.mirror.occasions.length, digits)} مناسبت ثبت شده`,
            ],
          ),
        ],
      ),
      h.p(
        [h.Class(META_CLASS)],
        [
          'تاریخ‌های مهمی که هر سال در تقویم شمسی تکرار می‌شوند؛ تاریخ میلادی هم کنارشان نمایش داده می‌شود.',
        ],
      ),
      h.form(
        [
          h.Class('grid min-w-0 items-end gap-3 sm:grid-cols-2'),
          h.OnSubmit(Message.SubmittedOccasion()),
        ],
        [
          h.div(
            [h.Class(`${FIELD_CLASS} min-w-0 sm:col-span-2`)],
            [
              h.label(
                [h.For('occasion-title'), h.Class(FIELD_LABEL_CLASS)],
                ['عنوان'],
              ),
              h.input([
                h.Id('occasion-title'),
                h.Type('text'),
                h.Class('field-input'),
                h.AriaLabel('عنوان مناسبت'),
                h.Placeholder('تولد، سالگرد…'),
                h.Value(model.occasionTitle),
                h.OnInput(value => Message.UpdatedOccasionTitle({ value })),
              ]),
            ],
          ),
          h.div(
            [h.Class(FIELD_CLASS)],
            [
              h.label(
                [h.For('occasion-origin'), h.Class(FIELD_LABEL_CLASS)],
                ['تاریخ شروع (میلادی)'],
              ),
              h.input([
                h.Id('occasion-origin'),
                h.Type('date'),
                h.Class('field-input'),
                h.AriaLabel('تاریخ شروع مناسبت'),
                h.Value(model.occasionOriginDate),
                h.OnInput(value =>
                  Message.UpdatedOccasionOriginDate({ value }),
                ),
              ]),
              ...(preview === ''
                ? []
                : [h.span([h.Class(META_CLASS)], [preview])]),
            ],
          ),
          h.div(
            [h.Class(FIELD_CLASS)],
            [
              h.label(
                [
                  h.For(Listbox.buttonId(model.occasionAdvanceListbox.id)),
                  h.Class(FIELD_LABEL_CLASS),
                ],
                ['یادآوری پیش از موعد'],
              ),
              h.submodel({
                slotId: model.occasionAdvanceListbox.id,
                model: model.occasionAdvanceListbox,
                view: OccasionAdvanceListbox.view,
                viewInputs: listboxViewInputs({
                  items: ADVANCE_OPTIONS,
                  maybeSelectedValue: Option.some(model.occasionAdvance),
                  h,
                }),
                toParentMessage: message =>
                  Message.GotOccasionAdvanceListboxMessage({ message }),
              }),
            ],
          ),
          Checkbox.view(
            {
              id: 'occasion-yearly-check',
              isChecked: model.occasionYearly,
              onToggle: yearly => Message.ToggledOccasionYearly({ yearly }),
              toView: attributes =>
                h.div(
                  [
                    h.Class(
                      'inline-flex items-center gap-2 text-[0.8rem] text-base-content/65 sm:col-span-2',
                    ),
                  ],
                  [
                    h.button([...attributes.checkbox, h.Class('form-check')]),
                    h.span([...attributes.label], ['هر سال تکرار شود']),
                  ],
                ),
            },
            h,
          ),
          h.div(
            [h.Class('flex flex-wrap items-center gap-1.5 sm:col-span-2')],
            [
              h.button(
                [
                  h.Type('submit'),
                  h.Class(PRIMARY_BUTTON_CLASS),
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
                              h.Class(SMALL_BUTTON_CLASS),
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
                        h.Class(SMALL_BUTTON_CLASS),
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
              [h.Class(META_CLASS)],
              [
                'هنوز مناسبت‌ی ثبت نشده است. تولدها و سالگردها را این‌جا اضافه کنید تا هر سال خودشان در تقویم بیایند.',
              ],
            ),
          ]
        : [
            h.ul(
              [h.Class('m-0 list-none divide-y divide-base-300 p-0')],
              Array.map(ordered, entry =>
                occasionRowView(entry, model, inputs, h),
              ),
            ),
          ]),
      ...Option.match(model.maybeOccasionError, {
        onNone: () => [],
        onSome: message => [
          h.p([h.Role('alert'), h.Class('notice notice-error m-0')], [message]),
        ],
      }),
      h.p(
        [h.Role('status'), h.AriaLive('polite'), h.Class(META_CLASS)],
        [model.occasionAnnouncement],
      ),
      h.p([h.Class('sr-only')], [busy ? 'در حال ذخیره…' : '']),
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
          h.Class(DIALOG_BACKDROP_CLASS),
          h.Inert(inactive),
          ...(inactive ? [h.AriaHidden(true)] : []),
        ],
        [
          h.section(
            [
              h.Class(DIALOG_CLASS),
              h.Role('dialog'),
              h.AriaModal(true),
              h.AriaLabelledBy('calendar-event-editor-title'),
            ],
            [
              h.h2(
                [
                  h.Id('calendar-event-editor-title'),
                  h.Tabindex(-1),
                  h.Class(DIALOG_TITLE_CLASS),
                ],
                ['رویداد'],
              ),
              h.p(
                [h.Class(DIALOG_HINT_CLASS)],
                [
                  occurrence.recurring
                    ? 'این رویداد بخشی از یک مجموعهٔ تکرارشونده است.'
                    : 'رویداد تک‌باره.',
                ],
              ),
              h.form(
                [
                  h.Class('grid min-w-0 gap-2'),
                  h.OnSubmit(Message.SubmittedEventEditor()),
                ],
                [
                  h.label(
                    [h.Class('grid gap-1 text-[0.8rem] text-base-content/55')],
                    [
                      'عنوان',
                      h.input([
                        h.Type('text'),
                        h.Class('field-input'),
                        h.AriaLabel('عنوان رویداد'),
                        h.Value(draft.title),
                        h.Disabled(!canEdit || model.isEventBusy),
                        h.OnInput(value =>
                          Message.UpdatedEventEditorTitle({ value }),
                        ),
                      ]),
                    ],
                  ),
                  Checkbox.view(
                    {
                      id: 'event-all-day-check',
                      isChecked: draft.allDay,
                      onToggle: allDay =>
                        Message.ToggledEventEditorAllDay({ allDay }),
                      toView: attributes =>
                        h.div(
                          [
                            h.Class(
                              'inline-flex items-center gap-1.5 text-[0.72rem] leading-6 text-base-content/55',
                            ),
                          ],
                          [
                            h.button([
                              ...attributes.checkbox,
                              h.Class('form-check'),
                              h.Disabled(!canEdit || model.isEventBusy),
                            ]),
                            h.span([...attributes.label], ['تمام روز']),
                          ],
                        ),
                    },
                    h,
                  ),
                  h.label(
                    [h.Class('grid gap-1 text-[0.8rem] text-base-content/55')],
                    [
                      'تاریخ',
                      h.input([
                        h.Type('date'),
                        h.Class('field-input'),
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
                          [h.Class('flex flex-wrap gap-2')],
                          [
                            h.label(
                              [h.Class(TIME_LABEL_CLASS)],
                              [
                                'از',
                                h.input([
                                  h.Type('time'),
                                  h.Class(TIME_INPUT_CLASS),
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
                              [h.Class(TIME_LABEL_CLASS)],
                              [
                                'تا',
                                h.input([
                                  h.Type('time'),
                                  h.Class(TIME_INPUT_CLASS),
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
                          [
                            h.Role('status'),
                            h.Class(
                              'm-0 text-[0.68rem] leading-6 text-base-content/55',
                            ),
                          ],
                          [
                            'این رویداد هنوز در حافظهٔ محلی نیست؛ کمی بعد دوباره تلاش کنید.',
                          ],
                        ),
                      ]),
                  ...Option.match(model.maybeEditorError, {
                    onNone: () => [],
                    onSome: message => [
                      h.p(
                        [h.Role('alert'), h.Class('notice notice-error m-0')],
                        [message],
                      ),
                    ],
                  }),
                  h.div(
                    [h.Class(DIALOG_ACTIONS_CLASS)],
                    [
                      h.button(
                        [
                          h.Type('submit'),
                          h.Class(PRIMARY_BUTTON_CLASS),
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
                                h.Class(NAV_BUTTON_CLASS),
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
                          h.Class(DANGER_BUTTON_CLASS),
                          h.Disabled(!canEdit || model.isEventBusy),
                          h.OnClick(Message.ClickedDeleteEvent()),
                        ],
                        ['حذف رویداد'],
                      ),
                      h.button(
                        [
                          h.Type('button'),
                          h.Class(NAV_BUTTON_CLASS),
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
        [h.Class(DIALOG_BACKDROP_CLASS)],
        [
          h.section(
            [
              h.Class(DIALOG_CLASS),
              h.Role('dialog'),
              h.AriaModal(true),
              h.AriaLabelledBy('calendar-scope-title'),
              h.AriaDescribedBy('calendar-scope-body'),
            ],
            [
              h.h2(
                [
                  h.Id('calendar-scope-title'),
                  h.Tabindex(-1),
                  h.Class(DIALOG_TITLE_CLASS),
                ],
                ['این رویداد یا این رویداد و رویدادهای بعدی؟'],
              ),
              h.p(
                [h.Id('calendar-scope-body'), h.Class(DIALOG_HINT_CLASS)],
                [
                  `«${title}» بخشی از یک مجموعهٔ تکرارشونده است. تغییر را روی کدام بخش اعمال کنم؟`,
                ],
              ),
              h.div(
                [
                  h.Class('grid gap-2'),
                  h.Role('radiogroup'),
                  h.AriaLabelledBy('calendar-scope-title'),
                ],
                [
                  h.label(
                    [
                      h.Class(SCOPE_OPTION_CLASS),
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
                        [h.Class('grid min-w-0 gap-0.5')],
                        [
                          h.strong(
                            [h.Class('text-[0.84rem] leading-6 font-semibold')],
                            ['فقط این رویداد'],
                          ),
                          h.small(
                            [h.Class(SCOPE_HINT_CLASS)],
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
                      h.Class(SCOPE_OPTION_CLASS),
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
                        [h.Class('grid min-w-0 gap-0.5')],
                        [
                          h.strong(
                            [h.Class('text-[0.84rem] leading-6 font-semibold')],
                            ['این رویداد و رویدادهای بعدی'],
                          ),
                          h.small(
                            [
                              h.Id('calendar-scope-following-hint'),
                              h.Class(SCOPE_HINT_CLASS),
                            ],
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
                  h.p(
                    [h.Role('alert'), h.Class('notice notice-error m-0')],
                    [message],
                  ),
                ],
              }),
              h.div(
                [h.Class(DIALOG_ACTIONS_CLASS)],
                [
                  h.button(
                    [
                      h.Type('button'),
                      h.Class(PRIMARY_BUTTON_CLASS),
                      h.Disabled(confirmDisabled),
                      h.OnClick(Message.PressedConfirmEventScope()),
                    ],
                    [model.isEventBusy ? 'در حال اعمال…' : 'ادامه'],
                  ),
                  h.button(
                    [
                      h.Type('button'),
                      h.Class(NAV_BUTTON_CLASS),
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
  return h.div(
    [h.Class('grid min-w-0 gap-3')],
    [
      h.div(
        [h.Class('flex flex-wrap items-center justify-between gap-2')],
        [
          h.div(
            [h.Class('flex min-w-0 flex-wrap items-center gap-1.5')],
            [
              h.button(
                [
                  h.Type('button'),
                  h.Class(NAV_BUTTON_CLASS),
                  h.AriaLabel('هفتهٔ قبل'),
                  h.OnClick(Message.PressedPreviousWeek()),
                ],
                ['→'],
              ),
              h.p(
                [
                  h.Class(
                    'm-0 min-w-0 text-[0.92rem] leading-6 font-medium break-words',
                  ),
                ],
                [weekTitle(view.week.start, view.week.end, digits)],
              ),
              h.button(
                [
                  h.Type('button'),
                  h.Class(NAV_BUTTON_CLASS),
                  h.AriaLabel('هفتهٔ بعد'),
                  h.OnClick(Message.PressedNextWeek()),
                ],
                ['←'],
              ),
              h.button(
                [
                  h.Type('button'),
                  h.Class(NAV_BUTTON_CLASS),
                  h.OnClick(Message.PressedTodayWeek()),
                ],
                ['امروز'],
              ),
            ],
          ),
          h.div(
            [h.Class('flex flex-wrap items-center gap-2')],
            [
              h.p(
                [h.Class('m-0 text-[0.72rem] leading-6 text-base-content/50')],
                [
                  `${localizeDigits(view.week.totals.tasks, digits)} کار · ${localizeDigits(view.week.totals.events, digits)} رویداد · ${localizeDigits(view.week.totals.occasions, digits)} مناسبت`,
                ],
              ),
              h.button(
                [
                  h.Type('button'),
                  h.Class(NAV_BUTTON_CLASS),
                  h.AriaExpanded(model.planningOpen),
                  h.AriaControls('calendar-planning-panel'),
                  h.OnClick(Message.ClickedTogglePlanning()),
                ],
                ['برنامه‌ریزی هفته'],
              ),
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
      h.div(
        [h.Class('grid min-w-0 gap-2 min-[1024px]:grid-cols-7')],
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
      h.Class(
        'grid gap-1.5 rounded-2xl border border-dashed border-base-300 bg-base-100 p-4',
      ),
      h.AriaLabel('روند عادت‌ها'),
      h.DataAttribute('reserved', 'habits'),
    ],
    [
      h.h2([h.Class('m-0 text-[0.9rem] font-semibold')], ['روند عادت‌ها']),
      h.p(
        [h.Class('m-0 text-[0.72rem] leading-6 text-base-content/50')],
        ['نمودار ماهانهٔ عادت‌ها در گام عادت‌ها این‌جا نمایش داده می‌شود.'],
      ),
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
      h.Class('page-wrap grid grid-cols-1 max-w-6xl gap-4 overflow-x-clip'),
      h.DataAttribute('source', view.source),
      h.Dir('rtl'),
      h.Lang('fa'),
    ],
    [
      headerView(model, inputs, h),
      ...(model.view === 'week'
        ? [weekView(model, inputs, view, h)]
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
          h.p([h.Role('alert'), h.Class('notice notice-error m-0')], [message]),
        ],
      }),
      eventEditorView(model, inputs, h),
      scopePromptView(model, inputs, h),
      h.p(
        [
          h.Class('sr-only'),
          h.Role('status'),
          h.AriaLive('polite'),
          h.DataAttribute('calendar-status', 'true'),
        ],
        [model.announcement],
      ),
    ],
  )
}
