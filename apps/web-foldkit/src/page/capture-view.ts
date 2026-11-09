import { Option } from 'effect'
import { Submodel } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'

import {
  type Capture,
  type CaptureCreatedRow,
  type NeedsInput,
  localDateTimeToInstant,
  localizeDigits,
} from '@tali/domain'

import { instantOf, instantPartsOf } from '../lib/capture-instant'

import {
  calendarRouter,
  habitsRouter,
  notePath,
  remindersRouter,
  taskAnchorPath,
} from '../route'
import type { DisplayFields } from '../preferences-model'
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

const WEEKDAYS: ReadonlyArray<{ readonly day: number; readonly label: string }> = [
  { day: 6, label: 'شنبه' },
  { day: 7, label: 'یکشنبه' },
  { day: 1, label: 'دوشنبه' },
  { day: 2, label: 'سه‌شنبه' },
  { day: 3, label: 'چهارشنبه' },
  { day: 4, label: 'پنج‌شنبه' },
  { day: 5, label: 'جمعه' },
]

const digitsOf = (display: DisplayFields) => display.digits

const habitFrequencyKind = (
  value: string,
): 'daily' | 'weekdays' | 'weekly' =>
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
    ([type, count]) => `${countText(count, display)} ${TYPE_LABELS[type] ?? type}`,
  )
  return parts.length === 0 ? 'چیزی ساخته نشد.' : `${parts.join('، ')} ساخته شد.`
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
  h.span(
    [h.Class('text-[0.72rem] font-medium text-base-content/55')],
    [text],
  )

const inputClass =
  'field-input min-h-10 w-full rounded-xl border border-base-300 bg-base-100 px-3 text-[0.85rem]'

const dateField = (
  label: string,
  value: string,
  onChange: (value: string) => Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.label(
    [h.Class('grid min-w-0 gap-1')],
    [
      fieldLabel(label, h),
      h.input([
        h.Type('date'),
        h.Class(inputClass),
        h.Value(value),
        h.OnChange(onChange),
      ]),
    ],
  )

const timeField = (
  label: string,
  value: string,
  onChange: (value: string) => Message,
  h: HtmlBuilder<Message>,
  disabled = false,
): Html =>
  h.label(
    [h.Class('grid min-w-0 gap-1')],
    [
      fieldLabel(label, h),
      h.input([
        h.Type('time'),
        h.Class(inputClass),
        h.Value(value),
        h.Disabled(disabled),
        h.OnChange(onChange),
      ]),
    ],
  )

const selectField = (
  label: string,
  value: string,
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  onChange: (value: string) => Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.label(
    [h.Class('grid min-w-0 gap-1')],
    [
      fieldLabel(label, h),
      h.select(
        [
          h.Class(inputClass),
          h.Value(value),
          h.OnChange(onChange),
        ],
        options.map((option) =>
          h.option([h.Value(option.value)], [option.label]),
        ),
      ),
    ],
  )

const numberField = (
  label: string,
  value: number,
  min: number,
  max: number,
  onChange: (value: number) => Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.label(
    [h.Class('grid min-w-0 gap-1')],
    [
      fieldLabel(label, h),
      h.input([
        h.Type('number'),
        h.Class(inputClass),
        h.Min(String(min)),
        h.Max(String(max)),
        h.Value(String(value)),
        h.OnInput((raw) => onChange(Number(raw))),
      ]),
    ],
  )

const weekdayToggles = (
  days: ReadonlyArray<number>,
  kind: 'habit' | 'reminder',
  index: number,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-wrap gap-1.5')],
    WEEKDAYS.map((weekday) =>
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
      selectField(
        'تکرار',
        kind,
        [
          { value: 'daily', label: 'هر روز' },
          { value: 'weekdays', label: 'روزهای انتخابی' },
          { value: 'weekly', label: 'چند بار در هفته' },
        ],
        (value) =>
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
            (value) => Message.ChangedNumberField({ index, field: 'times', value }),
            h,
          )
        : h.empty,
      timeField(
        'ساعت یادآوری (اختیاری)',
        draft.reminderTime ?? '',
        (value) =>
          Message.UpdatedCardField({ index, field: 'reminderTime', value }),
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
    repeat !== undefined && (repeat._tag === 'daily' || repeat._tag === 'weekly')
      ? repeat.time
      : ''
  const maybeFireParts =
    draft.fireAt === undefined || draft.fireAt === null
      ? undefined
      : instantPartsOf(draft.fireAt, inputs.display.timeZone)
  return h.div(
    [h.Class('grid gap-2')],
    [
      selectField(
        'تکرار',
        kind,
        [
          { value: 'once', label: 'یک‌بار' },
          { value: 'daily', label: 'هر روز' },
          { value: 'weekly', label: 'روزهای انتخابی' },
          { value: 'interval', label: 'هر چند ساعت' },
        ],
        (value) =>
          Message.SelectedReminderRepeat({
            index,
            kind: reminderRepeatKind(value),
          }),
        h,
      ),
      repeat?._tag === 'daily' || repeat?._tag === 'weekly'
        ? timeField(
            'ساعت',
            time,
            (value) =>
              Message.UpdatedCardField({ index, field: 'repeat.time', value }),
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
            (value) => Message.ChangedNumberField({ index, field: 'hours', value }),
            h,
          )
        : h.empty,
      kind === 'once'
        ? h.div(
            [h.Class('grid gap-2 sm:grid-cols-2')],
            [
              dateField(
                'روز',
                maybeFireParts?.date ?? '',
                (value) => {
                  if (value === '') {
                    return Message.UpdatedCardField({ index, field: 'fireAt', value: '' })
                  }
                  const instant = localDateTimeToInstant(
                    value,
                    maybeFireParts?.time ?? '09:00',
                    inputs.display.timeZone,
                  )
                  return Message.UpdatedCardField({ index, field: 'fireAt', value: instant })
                },
                h,
              ),
              timeField(
                'ساعت',
                maybeFireParts?.time ?? '',
                (value) => {
                  if (value === '' || maybeFireParts === undefined) {
                    return Message.UpdatedCardField({ index, field: 'fireAt', value: '' })
                  }
                  const instant = localDateTimeToInstant(
                    maybeFireParts.date,
                    value,
                    inputs.display.timeZone,
                  )
                  return Message.UpdatedCardField({ index, field: 'fireAt', value: instant })
                },
                h,
                maybeFireParts === undefined,
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
      dateField(
        'روز',
        date,
        (value) =>
          Message.UpdatedCardField({ index, field: 'dueDate', value }),
        h,
      ),
      timeField(
        'ساعت (اختیاری)',
        maybeParts?.time ?? '',
        (value) => {
          if (value === '') {
            return Message.UpdatedCardField({ index, field: 'dueAt', value: '' })
          }
          if (date === '') {
            return Message.UpdatedCardField({ index, field: 'dueAt', value: '' })
          }
          const instant = localDateTimeToInstant(
            date,
            value,
            inputs.display.timeZone,
          )
          return Message.UpdatedCardField({ index, field: 'dueAt', value: instant })
        },
        h,
        date === '',
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
        ? maybeStartParts?.date ?? ''
        : ''
  const start = maybeStartParts?.time ?? ''
  const end = maybeEndParts?.time ?? ''
  return h.div(
    [h.Class('grid gap-2')],
    [
      dateField(
        'روز',
        date,
        (value) =>
          Message.UpdatedCardField({ index, field: 'timing.date', value }),
        h,
      ),
      date === ''
        ? h.empty
        : h.div(
            [h.Class('grid gap-2 sm:grid-cols-2')],
            [
              timeField(
                'شروع (اختیاری)',
                start,
                (value) => {
                  if (value === '') {
                    return Message.UpdatedCardField({ index, field: 'timing.date', value: date })
                  }
                  return Message.UpdatedCardField({
                    index,
                    field: 'timing.start',
                    value: localDateTimeToInstant(
                      date,
                      value,
                      inputs.display.timeZone,
                    ),
                  })
                },
                h,
              ),
              timeField(
                'پایان (اختیاری)',
                end,
                (value) => {
                  if (value === '' || start === '') {
                    return Message.UpdatedCardField({ index, field: 'timing.date', value: date })
                  }
                  return Message.UpdatedCardField({
                    index,
                    field: 'timing.end',
                    value: localDateTimeToInstant(
                      date,
                      value,
                      inputs.display.timeZone,
                    ),
                  })
                },
                h,
                start === '',
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
  if (card.draft._tag === 'event') return eventStructural(card, index, inputs, h)
  if (card.draft._tag === 'habit') return habitStructural(card, index, inputs, h)
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
  return h.input([
    h.Type('datetime-local'),
    h.Class(inputClass),
    h.Value(value),
    h.OnInput((raw) => {
      // A datetime-local control may hand back a date without a time while
      // the user is still picking; ignore that instead of answering with a
      // partial (or invalid) instant.
      if (raw.length < 16) return Message.IgnoredInput()
      const instant = instantOf(
        raw.slice(0, 10),
        raw.slice(11, 16),
        inputs.display.timeZone,
      )
      return instant === undefined
        ? Message.IgnoredInput()
        : Message.AnsweredNeedsInput({
            index,
            field: entry.field,
            value: instant,
          })
    }),
  ])
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
    [h.Class('grid gap-2 rounded-xl border border-warning/30 bg-warning/8 p-3')],
    [
      h.p(
        [h.Class('m-0 text-[0.72rem] font-semibold text-warning-content')],
        ['برای ساخت، این‌ها را کامل کن:'],
      ),
      ...card.draft.missing.map((entry) => {
        const question = h.p(
          [h.Class('m-0 text-[0.76rem] leading-6 text-base-content/70')],
          [entry.question],
        )
        if (entry.shape === 'frequency' && card.draft._tag === 'habit') {
          return h.div([h.Class('grid gap-1')], [
            question,
            habitStructural(card, index, inputs, h),
          ])
        }
        if (entry.shape === 'repeat' && card.draft._tag === 'reminder') {
          return h.div([h.Class('grid gap-1')], [
            question,
            reminderStructural(card, index, inputs, h),
          ])
        }
        if (entry.shape === 'instant') {
          return h.div([h.Class('grid gap-1')], [
            question,
            instantPicker(entry, card, index, inputs, h),
          ])
        }
        if (entry.shape === 'clockTime') {
          const date = isInstantField(entry.field)
            ? draftDateOf(card, entry.field, inputs.display.timeZone)
            : ''
          // A clock time only answers an instant field when the draft already
          // knows the day; otherwise the picker has to collect both.
          if (isInstantField(entry.field) && date === undefined) {
            return h.div([h.Class('grid gap-1')], [
              question,
              instantPicker(entry, card, index, inputs, h),
            ])
          }
          return h.div([h.Class('grid gap-1')], [
            question,
            timeField(
              'ساعت',
              draftClockTimeOf(card, entry.field, inputs.display.timeZone),
              (value) =>
                Message.AnsweredNeedsInput({
                  index,
                  field: entry.field,
                  value,
                }),
              h,
            ),
          ])
        }
        return h.div([h.Class('grid gap-1')], [
          question,
          dateField(
            'روز',
            '',
            (value) =>
              Message.AnsweredNeedsInput({
                index,
                field: entry.field,
                value,
              }),
            h,
          ),
        ])
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
    ? h.keyed('article')(card.cardId, [
        h.Class(
          'flex items-center justify-between gap-2 rounded-2xl border border-dashed border-base-300 px-4 py-3 text-[0.78rem] text-base-content/45',
        ),
      ], [
        h.span([], [`${TYPE_LABELS[card.draft._tag]} کنار گذاشته شد`]),
        h.button(
          [
            h.Type('button'),
            h.Class('btn btn-ghost btn-xs'),
            h.OnClick(Message.ClickedNewCapture()),
          ],
          ['شروع دوباره'],
        ),
      ])
    : h.keyed('article')(card.cardId, [
        h.Class('panel grid gap-3 p-4'),
      ], [
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
                      h.input([
                        h.Type('text'),
                        h.Class(
                          'field-input min-h-9 w-full rounded-xl border border-base-300 bg-base-100 px-2 text-[0.9rem] font-semibold',
                        ),
                        h.AriaLabel('عنوان پیش‌نویس'),
                        h.Value(card.title),
                        h.OnInput((value) =>
                          Message.UpdatedCardTitle({ index, value }),
                        ),
                      ]),
                    ],
                  ),
                  h.p(
                    [h.Class('m-0 text-[0.72rem] leading-5 text-base-content/45')],
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
                    'm-0 whitespace-pre-wrap rounded-xl bg-base-200/50 p-3 text-[0.8rem] leading-6 text-base-content/70',
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
          h.textarea([
            h.Class(
              'field-input min-h-28 w-full resize-y rounded-xl border border-base-300 bg-base-100 p-3 text-[0.9rem] leading-7',
            ),
            h.AriaLabel('متن کپچر'),
            h.Placeholder(
              'فردا ساعت ۵ دکتر، یادم باشه قرص رو بگیرم، پنجشنبه مهمونی ساراست…',
            ),
            h.Value(model.text),
            h.Disabled(isBusy),
            h.OnInput((value) => Message.UpdatedText({ value })),
          ]),
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
        onSome: (error) => noticeView('error', error, h),
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
  const blocked = cards.filter((card) => card.draft.missing.length > 0)
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
        onSome: (error) => noticeView('error', error, h),
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
    onSome: (result) =>
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
              ...result.created.map((row) =>
                h.keyed('a')(row.id, [
                  h.Href(routeForRow(row)),
                  h.Class(
                    'badge badge-outline badge-lg text-[0.72rem] no-underline',
                  ),
                ], [row.title]),
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
  return h.keyed('li')(capture.id, [
    h.Class('grid gap-2 border-b border-base-200 py-3 last:border-0'),
  ], [
      h.button(
        [
          h.Type('button'),
          h.Class('flex w-full items-center justify-between gap-2 text-right'),
          h.AriaExpanded(isExpanded),
          h.OnClick(Message.ClickedToggleHistory({ captureId: capture.id })),
        ],
        [
          h.span(
            [h.Class('min-w-0 flex-1 truncate text-[0.82rem]')],
            [capture.text],
          ),
          h.span(
            [h.Class('badge badge-ghost badge-sm shrink-0 text-[0.66rem]')],
            [STATUS_LABELS[capture.status]],
          ),
        ],
      ),
      isExpanded
        ? h.div(
            [h.Class('grid gap-2')],
            [
              h.p(
                [
                  h.Class(
                    'm-0 whitespace-pre-wrap rounded-xl bg-base-200/50 p-3 text-[0.8rem] leading-6 text-base-content/70',
                  ),
                ],
                [capture.text],
              ),
              capture.createdIds.length === 0
                ? h.empty
                : h.div(
                    [h.Class('flex flex-wrap gap-1.5')],
                    capture.createdIds.map((row) =>
                      h.keyed('a')(row.id, [
                        h.Href(routeForRow(row)),
                        h.Class('badge badge-outline badge-sm text-[0.68rem] no-underline'),
                      ], [row.title]),
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
    [h.Class('panel grid gap-2 p-4')],
    [
      h.h2(
        [h.Class('m-0 text-lg font-bold tracking-tight')],
        ['کپچرهای اخیر'],
      ),
      model.isHistoryLoading
        ? h.p(
            [h.Class('m-0 text-[0.78rem] text-base-content/50')],
            ['در حال بارگذاری…'],
          )
        : h.empty,
      Option.match(model.maybeHistoryError, {
        onNone: () => h.empty,
        onSome: (error) => noticeView('error', error, h),
      }),
      model.history.length === 0 && !model.isHistoryLoading
        ? h.p(
            [h.Class('m-0 text-[0.78rem] leading-6 text-base-content/50')],
            ['هنوز کپچری ثبت نشده است.'],
          )
        : h.ul(
            [h.Class('m-0 list-none p-0')],
            model.history.map((capture) =>
              historyRow(capture, model, inputs, h),
            ),
          ),
    ],
  )

export const captureView = Submodel.defineView<Model, Message, Inputs>(
  (model, inputs, h) =>
    h.section(
      [h.Class('page-wrap grid grid-cols-1 max-w-3xl gap-4')],
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
      ],
    ),
)
