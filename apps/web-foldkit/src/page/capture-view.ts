import { Option } from 'effect'
import { Submodel } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'

import {
  type Capture,
  type CaptureCreatedRow,
  type NeedsInput,
  localizeDigits,
} from '@tali/domain'

import { instantPartsOf } from '../lib/capture-instant'
import type { DisplayFields } from '../preferences-model'
import {
  calendarRouter,
  habitsRouter,
  notePath,
  remindersRouter,
  taskAnchorPath,
} from '../route'
import { buttonView } from '../ui/button'
import { inputControlView, textAreaControlView } from '../ui/field'
import { retryIcon, trashIcon } from '../ui/icons'
import {
  type PickerMode,
  pickerDialogView,
  pickerTriggerView,
} from '../ui/picker'
import {
  type CaptureCard,
  type Inputs,
  Message,
  type Model,
  visibleCards,
} from './capture'

/**
 * The `/capture` view (ticket #101; ADR-0012).
 *
 * One composer, a flat card list, a result strip and the history. Cards show
 * the title, the verbatim Source Quote, the one structural field and every
 * unanswered Needs Input as a real picker. The commit button is disabled with
 * an explanation while a visible card still needs input.
 */

const TYPE_LABELS: Readonly<Record<string, string>> = {
  task: 'کار',
  event: 'رویداد',
  note: 'یادداشت',
  habit: 'عادت',
  reminder: 'یادآور',
}

const STATUS_LABELS: Readonly<Record<Capture['status'], string>> = {
  pending: 'در حال تجزیه',
  parsed: 'آماده‌ی بررسی',
  failed: 'ناموفق',
  committed: 'ساخته شد',
}

const WEEKDAYS: ReadonlyArray<{
  readonly day: number
  readonly label: string
}> = [
  { day: 6, label: 'شنبه' },
  { day: 7, label: 'یکشنبه' },
  { day: 1, label: 'دوشنبه' },
  { day: 2, label: 'سه‌شنبه' },
  { day: 3, label: 'چهارشنبه' },
  { day: 4, label: 'پنج‌شنبه' },
  { day: 5, label: 'جمعه' },
]

const digitsOf = (display: DisplayFields) => display.digits

const habitFrequencyKind = (value: string): 'daily' | 'weekdays' | 'weekly' =>
  value === 'weekdays' ? 'weekdays' : value === 'weekly' ? 'weekly' : 'daily'

const reminderRepeatKind = (
  value: string,
): 'once' | 'daily' | 'weekly' | 'interval' =>
  value === 'once'
    ? 'once'
    : value === 'weekly'
      ? 'weekly'
      : value === 'interval'
        ? 'interval'
        : 'daily'

const countText = (count: number, display: DisplayFields): string =>
  localizeDigits(count, digitsOf(display))

const routeForRow = (row: CaptureCreatedRow): string => {
  switch (row.type) {
    case 'task':
      return taskAnchorPath(row.id)
    case 'event':
      return calendarRouter()
    case 'note':
      return notePath(row.id)
    case 'habit':
      return habitsRouter()
    case 'reminder':
      return remindersRouter()
  }
}

const createdSummary = (
  rows: ReadonlyArray<CaptureCreatedRow>,
  display: DisplayFields,
): string => {
  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.type] = (acc[row.type] ?? 0) + 1

    return acc
  }, {})

  const parts = Object.entries(counts).map(
    ([type, count]) =>
      `${countText(count, display)} ${TYPE_LABELS[type] ?? type}`,
  )

  return parts.length === 0
    ? 'چیزی ساخته نشد.'
    : `${parts.join('، ')} ساخته شد.`
}

const noticeView = (
  tone: 'error' | 'info',
  text: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.p(
    [
      h.Role(tone === 'error' ? 'alert' : 'status'),
      h.Class(
        tone === 'error'
          ? 'm-0 rounded-2xl border border-error/25 bg-error/10 px-4 py-3 text-[0.82rem] leading-6 text-error-content'
          : 'm-0 rounded-2xl border border-base-300 bg-base-200/60 px-4 py-3 text-[0.82rem] leading-6 text-base-content/70',
      ),
    ],
    [text],
  )

const fieldLabel = (text: string, h: HtmlBuilder<Message>): Html =>
  h.span([h.Class('text-[0.72rem] font-medium text-base-content/55')], [text])

const choiceField = (
  label: string,
  value: string,
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  onChange: (value: string) => Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('grid min-w-0 gap-1')],
    [
      fieldLabel(label, h),
      h.div(
        [
          h.Role('group'),
          h.AriaLabel(label),
          h.Class('flex flex-wrap gap-1.5'),
        ],
        options.map(option =>
          h.button(
            [
              h.Type('button'),
              h.AriaLabel(option.label),
              h.AriaPressed(value === option.value ? 'true' : 'false'),
              h.Class(
                'min-h-8 rounded-full border border-base-300 bg-base-100 px-3 text-[0.76rem] text-base-content/65 transition-colors hover:border-base-content/20 aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:font-semibold aria-pressed:text-primary',
              ),
              h.OnClick(onChange(option.value)),
            ],
            [option.label],
          ),
        ),
      ),
    ],
  )

const numberField = (
  label: string,
  value: number,
  min: number,
  max: number,
  digits: DisplayFields['digits'],
  onChange: (value: number) => Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('grid min-w-0 gap-1')],
    [
      fieldLabel(label, h),
      h.div(
        [
          h.Role('group'),
          h.AriaLabel(label),
          h.Class('flex items-center gap-2'),
        ],
        [
          buttonView(
            {
              variant: 'outline',
              size: 'sm',
              isSquare: true,
              ariaLabel: `کاهش ${label}`,
              isDisabled: value <= min,
              onClick: onChange(Math.max(min, value - 1)),
              children: ['−'],
            },
            h,
          ),
          h.output(
            [
              h.AriaLive('polite'),
              h.Class('min-w-8 text-center text-[0.95rem] font-semibold'),
            ],
            [localizeDigits(value, digits)],
          ),
          buttonView(
            {
              variant: 'outline',
              size: 'sm',
              isSquare: true,
              ariaLabel: `افزایش ${label}`,
              isDisabled: value >= max,
              onClick: onChange(Math.min(max, value + 1)),
              children: ['+'],
            },
            h,
          ),
        ],
      ),
    ],
  )

const pickerField = (
  config: Readonly<{
    id: string
    label: string
    target: string
    mode: PickerMode
    value: string
    inputs: Inputs
    isDisabled?: boolean
    placeholder?: string
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  pickerTriggerView(
    {
      id: config.id,
      label: config.label,
      target: config.target,
      mode: config.mode,
      value: config.value,
      today: config.inputs.today,
      digits: digitsOf(config.inputs.display),
      ...(config.isDisabled === undefined
        ? {}
        : { isDisabled: config.isDisabled }),
      ...(config.placeholder === undefined
        ? {}
        : { placeholder: config.placeholder }),
      toParentMessage: message => Message.GotPickerMessage({ message }),
    },
    h,
  )

const weekdayToggles = (
  days: ReadonlyArray<number>,
  kind: 'habit' | 'reminder',
  index: number,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-wrap gap-1.5')],
    WEEKDAYS.map(weekday =>
      h.button(
        [
          h.Type('button'),
          h.AriaPressed(days.includes(weekday.day) ? 'true' : 'false'),
          h.OnClick(Message.ToggledWeekday({ index, kind, day: weekday.day })),
          h.Class(
            'min-h-9 rounded-full border border-base-300 bg-base-100 px-3 text-[0.76rem] text-base-content/65 transition-colors aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:font-semibold aria-pressed:text-primary',
          ),
        ],
        [weekday.label],
      ),
    ),
  )

const habitStructural = (
  card: CaptureCard,
  index: number,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html => {
  if (card.draft._tag !== 'habit') return h.empty
  const draft = card.draft
  const frequency = draft.frequency
  const kind = frequency?._tag ?? 'daily'

  return h.div(
    [h.Class('grid gap-2')],
    [
      choiceField(
        'تکرار',
        kind,
        [
          { value: 'daily', label: 'هر روز' },
          { value: 'weekdays', label: 'روزهای انتخابی' },
          { value: 'weekly', label: 'چند بار در هفته' },
        ],
        value =>
          Message.SelectedHabitFrequency({
            index,
            kind: habitFrequencyKind(value),
          }),
        h,
      ),
      frequency?._tag === 'weekdays'
        ? weekdayToggles(frequency.days, 'habit', index, h)
        : h.empty,
      frequency?._tag === 'weekly'
        ? numberField(
            'بار در هفته',
            frequency.times,
            1,
            7,
            digitsOf(inputs.display),
            value =>
              Message.ChangedNumberField({ index, field: 'times', value }),
            h,
          )
        : h.empty,
      pickerField(
        {
          id: `habit-reminder-time-${index}`,
          label: 'ساعت یادآوری (اختیاری)',
          target: `card:${index}:reminderTime`,
          mode: 'time',
          value: draft.reminderTime ?? '',
          inputs,
        },
        h,
      ),
    ],
  )
}

const reminderStructural = (
  card: CaptureCard,
  index: number,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html => {
  if (card.draft._tag !== 'reminder') return h.empty
  const draft = card.draft
  const repeat = draft.repeat
  const kind = repeat?._tag ?? 'daily'

  const time =
    repeat !== undefined &&
    (repeat._tag === 'daily' || repeat._tag === 'weekly')
      ? repeat.time
      : ''

  const maybeFireParts =
    draft.fireAt === undefined || draft.fireAt === null
      ? undefined
      : instantPartsOf(draft.fireAt, inputs.display.timeZone)

  return h.div(
    [h.Class('grid gap-2')],
    [
      choiceField(
        'تکرار',
        kind,
        [
          { value: 'once', label: 'یک‌بار' },
          { value: 'daily', label: 'هر روز' },
          { value: 'weekly', label: 'روزهای انتخابی' },
          { value: 'interval', label: 'هر چند ساعت' },
        ],
        value =>
          Message.SelectedReminderRepeat({
            index,
            kind: reminderRepeatKind(value),
          }),
        h,
      ),
      repeat?._tag === 'daily' || repeat?._tag === 'weekly'
        ? pickerField(
            {
              id: `reminder-repeat-time-${index}`,
              label: 'ساعت',
              target: `card:${index}:repeat.time`,
              mode: 'time',
              value: time,
              inputs,
            },
            h,
          )
        : h.empty,
      repeat?._tag === 'weekly'
        ? weekdayToggles(repeat.days, 'reminder', index, h)
        : h.empty,
      repeat?._tag === 'interval'
        ? numberField(
            'هر چند ساعت',
            repeat.hours,
            1,
            24,
            digitsOf(inputs.display),
            value =>
              Message.ChangedNumberField({ index, field: 'hours', value }),
            h,
          )
        : h.empty,
      kind === 'once'
        ? h.div(
            [h.Class('grid gap-2 sm:grid-cols-2')],
            [
              pickerField(
                {
                  id: `reminder-fire-date-${index}`,
                  label: 'روز',
                  target: `card-instant-date:${index}:fireAt`,
                  mode: 'date',
                  value: maybeFireParts?.date ?? '',
                  inputs,
                },
                h,
              ),
              pickerField(
                {
                  id: `reminder-fire-time-${index}`,
                  label: 'ساعت',
                  target: `card-instant:${index}:fireAt`,
                  mode: 'time',
                  value: maybeFireParts?.time ?? '',
                  inputs,
                  isDisabled: maybeFireParts === undefined,
                },
                h,
              ),
            ],
          )
        : h.empty,
    ],
  )
}

const taskStructural = (
  card: CaptureCard,
  index: number,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html => {
  if (card.draft._tag !== 'task') return h.empty
  const draft = card.draft

  const maybeParts =
    draft.dueAt === undefined || draft.dueAt === null
      ? undefined
      : instantPartsOf(draft.dueAt, inputs.display.timeZone)

  const date = draft.dueDate ?? maybeParts?.date ?? ''

  return h.div(
    [h.Class('grid gap-2 sm:grid-cols-2')],
    [
      pickerField(
        {
          id: `task-due-date-${index}`,
          label: 'روز',
          target: `card:${index}:dueDate`,
          mode: 'date',
          value: date,
          inputs,
        },
        h,
      ),
      pickerField(
        {
          id: `task-due-time-${index}`,
          label: 'ساعت (اختیاری)',
          target: `card-instant:${index}:dueAt`,
          mode: 'time',
          value: maybeParts?.time ?? '',
          inputs,
          isDisabled: date === '',
        },
        h,
      ),
    ],
  )
}

const eventStructural = (
  card: CaptureCard,
  index: number,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html => {
  if (card.draft._tag !== 'event') return h.empty
  const timing = card.draft.timing

  const maybeStartParts =
    timing?._tag === 'timed'
      ? instantPartsOf(timing.start, inputs.display.timeZone)
      : undefined

  const maybeEndParts =
    timing?._tag === 'timed'
      ? instantPartsOf(timing.end, inputs.display.timeZone)
      : undefined

  const date =
    timing?._tag === 'allDay'
      ? timing.date
      : timing?._tag === 'timed'
        ? (maybeStartParts?.date ?? '')
        : ''

  const start = maybeStartParts?.time ?? ''
  const end = maybeEndParts?.time ?? ''

  return h.div(
    [h.Class('grid gap-2')],
    [
      pickerField(
        {
          id: `event-date-${index}`,
          label: 'روز',
          target: `card:${index}:timing.date`,
          mode: 'date',
          value: date,
          inputs,
        },
        h,
      ),
      date === ''
        ? h.empty
        : h.div(
            [h.Class('grid gap-2 sm:grid-cols-2')],
            [
              pickerField(
                {
                  id: `event-start-${index}`,
                  label: 'شروع (اختیاری)',
                  target: `card-instant:${index}:timing.start`,
                  mode: 'time',
                  value: start,
                  inputs,
                },
                h,
              ),
              pickerField(
                {
                  id: `event-end-${index}`,
                  label: 'پایان (اختیاری)',
                  target: `card-instant:${index}:timing.end`,
                  mode: 'time',
                  value: end,
                  inputs,
                  isDisabled: start === '',
                },
                h,
              ),
            ],
          ),
      h.p(
        [h.Class('m-0 text-[0.7rem] leading-5 text-base-content/45')],
        ['بدون ساعت، رویداد تمام‌روز است.'],
      ),
    ],
  )
}

const structuralView = (
  card: CaptureCard,
  index: number,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html => {
  if (card.draft._tag === 'task') return taskStructural(card, index, inputs, h)

  if (card.draft._tag === 'event')
    return eventStructural(card, index, inputs, h)

  if (card.draft._tag === 'habit')
    return habitStructural(card, index, inputs, h)

  if (card.draft._tag === 'reminder') {
    return reminderStructural(card, index, inputs, h)
  }

  return h.empty
}

const instantPicker = (
  entry: NeedsInput,
  card: CaptureCard,
  index: number,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html => {
  const current = currentInstantOf(card, entry.field)

  const parts =
    current === undefined
      ? undefined
      : instantPartsOf(current, inputs.display.timeZone)

  const value = parts === undefined ? '' : `${parts.date}T${parts.time}`

  return pickerField(
    {
      id: `needs-datetime-${index}-${entry.field}`,
      label: entry.question,
      target: `need-datetime:${index}:${entry.field}`,
      mode: 'datetime',
      value,
      inputs,
    },
    h,
  )
}

/** Fields whose draft value is a UTC instant, never a bare clock time. */
const INSTANT_FIELDS: ReadonlyArray<string> = [
  'dueAt',
  'fireAt',
  'timing.start',
  'timing.end',
  'start',
  'end',
]

const isInstantField = (field: string): boolean =>
  INSTANT_FIELDS.includes(field)

/** The draft's current value for one of the instant fields, if any. */
const currentInstantOf = (
  card: CaptureCard,
  field: string,
): string | undefined => {
  const draft = card.draft

  if (draft._tag === 'task' && field === 'dueAt') {
    return draft.dueAt ?? undefined
  }

  if (draft._tag === 'reminder' && field === 'fireAt') {
    return draft.fireAt ?? undefined
  }

  if (draft._tag === 'event' && draft.timing?._tag === 'timed') {
    if (field === 'timing.start' || field === 'start') {
      return draft.timing.start
    }

    if (field === 'timing.end' || field === 'end') return draft.timing.end
  }

  return undefined
}

/** The day a clock-time answer belongs to, from the draft's own date. */
const draftDateOf = (
  card: CaptureCard,
  field: string,
  timeZone: string,
): string | undefined => {
  const draft = card.draft
  const instant = currentInstantOf(card, field)

  if (instant !== undefined) {
    const date = instantPartsOf(instant, timeZone)?.date

    if (date !== undefined) return date
  }

  if (draft._tag === 'task' && field === 'dueAt') {
    return draft.dueDate ?? undefined
  }

  if (draft._tag === 'event') {
    const timing = draft.timing

    if (timing?._tag === 'allDay') return timing.date
  }

  return undefined
}

/** The local clock time of the draft's current instant, for a time picker. */
const draftClockTimeOf = (
  card: CaptureCard,
  field: string,
  timeZone: string,
): string => {
  const instant = currentInstantOf(card, field)

  return instant === undefined
    ? ''
    : (instantPartsOf(instant, timeZone)?.time ?? '')
}

const needsInputView = (
  card: CaptureCard,
  index: number,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html => {
  if (card.draft.missing.length === 0) return h.empty

  return h.div(
    [
      h.Class(
        'grid gap-2 rounded-xl border border-warning/30 bg-warning/8 p-3',
      ),
    ],
    [
      h.p(
        [h.Class('m-0 text-[0.72rem] font-semibold text-warning-content')],
        ['برای ساخت، این‌ها را کامل کن:'],
      ),
      ...card.draft.missing.map(entry => {
        const question = h.p(
          [h.Class('m-0 text-[0.76rem] leading-6 text-base-content/70')],
          [entry.question],
        )

        if (entry.shape === 'frequency' && card.draft._tag === 'habit') {
          return h.div(
            [h.Class('grid gap-1')],
            [question, habitStructural(card, index, inputs, h)],
          )
        }

        if (entry.shape === 'repeat' && card.draft._tag === 'reminder') {
          return h.div(
            [h.Class('grid gap-1')],
            [question, reminderStructural(card, index, inputs, h)],
          )
        }

        if (entry.shape === 'instant') {
          return h.div(
            [h.Class('grid gap-1')],
            [question, instantPicker(entry, card, index, inputs, h)],
          )
        }

        if (entry.shape === 'clockTime') {
          const date = isInstantField(entry.field)
            ? draftDateOf(card, entry.field, inputs.display.timeZone)
            : ''

          // A clock time only answers an instant field when the draft already
          // knows the day; otherwise the picker has to collect both.
          if (isInstantField(entry.field) && date === undefined) {
            return h.div(
              [h.Class('grid gap-1')],
              [question, instantPicker(entry, card, index, inputs, h)],
            )
          }

          return h.div(
            [h.Class('grid gap-1')],
            [
              question,
              pickerField(
                {
                  id: `needs-time-${index}-${entry.field}`,
                  label: entry.question,
                  target: `need-time:${index}:${entry.field}`,
                  mode: 'time',
                  value: draftClockTimeOf(
                    card,
                    entry.field,
                    inputs.display.timeZone,
                  ),
                  inputs,
                },
                h,
              ),
            ],
          )
        }

        return h.div(
          [h.Class('grid gap-1')],
          [
            question,
            pickerField(
              {
                id: `needs-date-${index}-${entry.field}`,
                label: entry.question,
                target: `need-date:${index}:${entry.field}`,
                mode: 'date',
                value: '',
                inputs,
              },
              h,
            ),
          ],
        )
      }),
    ],
  )
}

const cardView = (
  card: CaptureCard,
  index: number,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html =>
  card.isDiscarded
    ? h.keyed('article')(
        card.cardId,
        [
          h.Class(
            'flex items-center justify-between gap-2 rounded-2xl border border-dashed border-base-300 px-4 py-3 text-[0.78rem] text-base-content/45',
          ),
        ],
        [
          h.span([], [`${TYPE_LABELS[card.draft._tag]} کنار گذاشته شد`]),
          h.button(
            [
              h.Type('button'),
              h.Class('btn btn-ghost btn-xs'),
              h.OnClick(Message.ClickedNewCapture()),
            ],
            ['شروع دوباره'],
          ),
        ],
      )
    : h.keyed('article')(
        card.cardId,
        [h.Class('panel grid gap-3 p-4')],
        [
          h.header(
            [h.Class('flex flex-wrap items-start justify-between gap-2')],
            [
              h.div(
                [h.Class('flex min-w-0 flex-1 flex-col gap-1')],
                [
                  h.div(
                    [h.Class('flex items-center gap-2')],
                    [
                      h.span(
                        [
                          h.Class(
                            'badge badge-outline badge-sm shrink-0 text-[0.68rem]',
                          ),
                        ],
                        [TYPE_LABELS[card.draft._tag] ?? card.draft._tag],
                      ),
                      inputControlView(
                        {
                          id: `capture-card-title-${index}`,
                          label: 'عنوان پیش‌نویس',
                          value: card.title,
                          onInput: value =>
                            Message.UpdatedCardTitle({ index, value }),
                          class:
                            'min-h-9 w-full rounded-xl px-2 text-[0.9rem] font-semibold',
                        },
                        h,
                      ),
                    ],
                  ),
                  h.p(
                    [
                      h.Class(
                        'm-0 text-[0.72rem] leading-5 text-base-content/45',
                      ),
                    ],
                    [`«${card.draft.sourceQuote}»`],
                  ),
                ],
              ),
              h.button(
                [
                  h.Type('button'),
                  h.Class('btn btn-ghost btn-xs shrink-0'),
                  h.OnClick(Message.ClickedDiscardCard({ index })),
                ],
                ['کنار گذاشتن'],
              ),
            ],
          ),
          card.draft._tag === 'note'
            ? h.p(
                [
                  h.Class(
                    'm-0 overflow-hidden whitespace-pre-wrap rounded-xl bg-base-200/50 p-3 text-[0.8rem] leading-6 break-words text-base-content/70',
                  ),
                ],
                [card.draft.body ?? ''],
              )
            : structuralView(card, index, inputs, h),
          needsInputView(card, index, inputs, h),
        ],
      )

const composerView = (
  model: Model,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html => {
  const isBusy = model.phase === 'dissecting' || model.phase === 'committing'
  const characterCount = countText(model.text.length, inputs.display)

  return h.section(
    [h.Class('panel grid gap-3 p-4')],
    [
      h.label(
        [h.Class('grid gap-1')],
        [
          fieldLabel('چه چیزی در ذهن داری؟', h),
          textAreaControlView(
            {
              id: 'capture-text',
              label: 'متن کپچر',
              value: model.text,
              rows: 5,
              isDisabled: isBusy,
              placeholder:
                'فردا ساعت ۵ دکتر، یادم باشه قرص رو بگیرم، پنجشنبه مهمونی ساراست…',
              class:
                'min-h-28 w-full resize-y rounded-xl p-3 text-[0.9rem] leading-7',
              onInput: value => Message.UpdatedText({ value }),
            },
            h,
          ),
        ],
      ),
      h.div(
        [h.Class('flex flex-wrap items-center justify-between gap-2')],
        [
          h.span(
            [h.Class('text-[0.7rem] text-base-content/40')],
            [`${characterCount} از ${countText(4000, inputs.display)} کاراکتر`],
          ),
          h.div(
            [h.Class('flex flex-wrap gap-2')],
            [
              h.button(
                [
                  h.Type('button'),
                  h.Class('btn btn-primary btn-sm'),
                  h.Disabled(isBusy || model.text.trim() === ''),
                  h.OnClick(Message.ClickedDissect()),
                ],
                [model.phase === 'dissecting' ? 'در حال تجزیه…' : 'تجزیه'],
              ),
              Option.match(model.maybeError, {
                onNone: () => h.empty,
                onSome: () =>
                  h.button(
                    [
                      h.Type('button'),
                      h.Class('btn btn-ghost btn-sm'),
                      h.Disabled(isBusy),
                      h.OnClick(Message.ClickedRetryDissect()),
                    ],
                    ['تلاش دوباره'],
                  ),
              }),
              h.button(
                [
                  h.Type('button'),
                  h.Class('btn btn-ghost btn-sm'),
                  h.Disabled(isBusy),
                  h.OnClick(Message.ClickedNewCapture()),
                ],
                ['پاک کردن'],
              ),
            ],
          ),
        ],
      ),
      !inputs.isOnline
        ? noticeView(
            'info',
            'کپچر به اینترنت نیاز دارد. متن تو در همین دستگاه می‌ماند؛ آنلاین شو و دوباره تلاش کن.',
            h,
          )
        : h.empty,
      Option.match(model.maybeError, {
        onNone: () => h.empty,
        onSome: error => noticeView('error', error, h),
      }),
    ],
  )
}

const reviewView = (
  model: Model,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html => {
  const cards = visibleCards(model)
  const blocked = cards.filter(card => card.draft.missing.length > 0)
  const isCommitting = model.phase === 'committing'
  const canCommit = cards.length > 0 && blocked.length === 0 && !isCommitting

  return h.section(
    [h.Class('grid gap-3')],
    [
      h.header(
        [h.Class('flex flex-wrap items-end justify-between gap-2')],
        [
          h.div(
            [h.Class('grid gap-0.5')],
            [
              h.h2(
                [h.Class('m-0 text-lg font-bold tracking-tight')],
                ['پیشنهادها'],
              ),
              h.p(
                [h.Class('m-0 text-[0.76rem] leading-6 text-base-content/55')],
                [
                  `${countText(cards.length, inputs.display)} کارت؛ هر کدام را که نمی‌خواهی کنار بگذار.`,
                ],
              ),
            ],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class('btn btn-primary btn-sm'),
              h.Disabled(!canCommit),
              h.OnClick(Message.ClickedCommit()),
            ],
            [isCommitting ? 'در حال ساخت…' : 'ساخت همه'],
          ),
        ],
      ),
      blocked.length > 0
        ? noticeView(
            'info',
            `تا وقتی Needs Input یک کارت پاسخ داده نشده، ساخت انجام نمی‌شود: ${blocked[0]?.draft.missing[0]?.question ?? ''}`,
            h,
          )
        : h.empty,
      Option.match(model.maybeError, {
        onNone: () => h.empty,
        onSome: error => noticeView('error', error, h),
      }),
      ...cards.map((card, index) => cardView(card, index, inputs, h)),
    ],
  )
}

const resultView = (
  model: Model,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(model.maybeResult, {
    onNone: () => h.empty,
    onSome: result =>
      h.section(
        [h.Class('panel grid gap-3 p-4')],
        [
          h.h2(
            [h.Class('m-0 text-lg font-bold tracking-tight')],
            [createdSummary(result.created, inputs.display)],
          ),
          result.failure === null
            ? h.empty
            : noticeView(
                'error',
                'بخشی از کارت‌ها ساخته نشد. با تلاش دوباره، بقیه بدون تکرار ساخته می‌شوند.',
                h,
              ),
          h.div(
            [h.Class('flex flex-wrap gap-2')],
            [
              ...result.created.map(row =>
                h.keyed('a')(
                  row.id,
                  [
                    h.Href(routeForRow(row)),
                    h.Class(
                      'badge badge-outline badge-lg min-w-0 max-w-full truncate text-[0.72rem] no-underline',
                    ),
                  ],
                  [row.title],
                ),
              ),
            ],
          ),
          h.div(
            [h.Class('flex flex-wrap gap-2')],
            [
              result.failure === null
                ? h.empty
                : h.button(
                    [
                      h.Type('button'),
                      h.Class('btn btn-primary btn-sm'),
                      h.OnClick(Message.ClickedRetryCommit()),
                    ],
                    ['تلاش دوباره'],
                  ),
              h.button(
                [
                  h.Type('button'),
                  h.Class('btn btn-ghost btn-sm'),
                  h.OnClick(Message.ClickedNewCapture()),
                ],
                ['کپچر تازه'],
              ),
            ],
          ),
        ],
      ),
  })

const historyRow = (
  capture: Capture,
  model: Model,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html => {
  const isExpanded = Option.contains(model.expandedHistoryId, capture.id)

  return h.keyed('li')(
    capture.id,
    [h.Class('grid min-w-0 gap-2 border-b border-base-200 py-3 last:border-0')],
    [
      h.div(
        [h.Class('flex min-w-0 items-center gap-2')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class(
                'flex min-w-0 flex-1 items-center justify-between gap-2 overflow-hidden text-right',
              ),
              h.AriaExpanded(isExpanded),
              h.OnClick(
                Message.ClickedToggleHistory({ captureId: capture.id }),
              ),
            ],
            [
              h.span(
                [
                  h.Class(
                    'line-clamp-2 min-w-0 flex-1 text-[0.82rem] leading-6 break-words',
                  ),
                ],
                [capture.text],
              ),
              h.span(
                [h.Class('badge badge-ghost badge-sm shrink-0 text-[0.66rem]')],
                [STATUS_LABELS[capture.status]],
              ),
            ],
          ),
          capture.status === 'failed'
            ? h.div(
                [h.Class('flex shrink-0 items-center gap-1')],
                [
                  h.button(
                    [
                      h.Type('button'),
                      h.Class('btn btn-ghost btn-xs btn-square'),
                      h.AriaLabel('تلاش دوباره'),
                      h.Title('تلاش دوباره'),
                      h.OnClick(
                        Message.ClickedRetryHistory({ captureId: capture.id }),
                      ),
                    ],
                    [retryIcon('size-4')],
                  ),
                  h.button(
                    [
                      h.Type('button'),
                      h.Class(
                        'btn btn-ghost btn-xs btn-square hover:text-error',
                      ),
                      h.AriaLabel('حذف'),
                      h.Title('حذف'),
                      h.OnClick(
                        Message.ClickedDeleteHistory({ captureId: capture.id }),
                      ),
                    ],
                    [trashIcon('size-4')],
                  ),
                ],
              )
            : h.empty,
        ],
      ),
      isExpanded
        ? h.div(
            [h.Class('grid gap-2')],
            [
              capture.status === 'failed' && capture.error !== null
                ? noticeView('error', capture.error, h)
                : h.empty,
              h.p(
                [
                  h.Class(
                    'm-0 overflow-hidden whitespace-pre-wrap rounded-xl bg-base-200/50 p-3 text-[0.8rem] leading-6 break-words text-base-content/70',
                  ),
                ],
                [capture.text],
              ),
              capture.createdIds.length === 0
                ? h.empty
                : h.div(
                    [h.Class('flex min-w-0 flex-wrap gap-1.5')],
                    capture.createdIds.map(row =>
                      h.keyed('a')(
                        row.id,
                        [
                          h.Href(routeForRow(row)),
                          h.Class(
                            'badge badge-outline badge-sm min-w-0 max-w-full truncate text-[0.68rem] no-underline',
                          ),
                        ],
                        [row.title],
                      ),
                    ),
                  ),
            ],
          )
        : h.empty,
    ],
  )
}

const historyView = (
  model: Model,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class('panel grid min-w-0 gap-2 p-4')],
    [
      h.h2([h.Class('m-0 text-lg font-bold tracking-tight')], ['کپچرهای اخیر']),
      model.isHistoryLoading
        ? h.p(
            [h.Class('m-0 text-[0.78rem] text-base-content/50')],
            ['در حال بارگذاری…'],
          )
        : h.empty,
      Option.match(model.maybeHistoryError, {
        onNone: () => h.empty,
        onSome: error => noticeView('error', error, h),
      }),
      model.history.length === 0 && !model.isHistoryLoading
        ? h.p(
            [h.Class('m-0 text-[0.78rem] leading-6 text-base-content/50')],
            ['هنوز کپچری ثبت نشده است.'],
          )
        : h.ul(
            [h.Class('m-0 min-w-0 list-none p-0')],
            model.history.map(capture => historyRow(capture, model, inputs, h)),
          ),
    ],
  )

export const captureView = Submodel.defineView<Model, Message, Inputs>(
  (model, inputs, h) =>
    h.section(
      [h.Class('page-wrap grid w-full max-w-3xl min-w-0 grid-cols-1 gap-4')],
      [
        h.header(
          [h.Class('grid gap-1')],
          [
            h.h1(
              [h.Class('m-0 text-2xl font-bold tracking-tight sm:text-3xl')],
              ['کپچر'],
            ),
            h.p(
              [h.Class('m-0 text-sm leading-7 text-base-content/55')],
              [
                'هر چه در ذهن داری بنویس؛ پیشنهادها را ببین، ویرایش کن و یک‌جا بساز.',
              ],
            ),
          ],
        ),
        composerView(model, inputs, h),
        model.phase === 'dissecting'
          ? noticeView('info', 'در حال خواندن متن و ساختن پیشنهادها…', h)
          : h.empty,
        model.phase === 'review' || model.phase === 'committing'
          ? reviewView(model, inputs, h)
          : h.empty,
        model.phase === 'result' ? resultView(model, inputs, h) : h.empty,
        historyView(model, inputs, h),
        pickerDialogView(
          {
            model: model.picker,
            toParentMessage: message => Message.GotPickerMessage({ message }),
            digits: digitsOf(inputs.display),
            weekStart: inputs.display.weekStart,
          },
          h,
        ),
      ],
    ),
)
