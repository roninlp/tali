import { Array, Effect, Match, Option, Schema } from 'effect'
import { Command, Dom, Update } from 'foldkit'
import type { ChildAttribute, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { Dialog } from '@foldkit/ui'
import {
  type Digits,
  JALALI_MONTHS,
  JALALI_WEEKDAYS,
  type WeekStart,
  addJalaliMonths,
  formatJalaliDate,
  jalaliDate,
  jalaliMonthGrid,
  localizeDigits,
  toIsoDate,
  toJalaliDate,
  toJalaliFields,
} from '@tali/domain'

import { type ButtonConfig, buttonView } from './button'
import {
  calendarIcon,
  chevronLeftIcon,
  chevronRightIcon,
  clockIcon,
  closeIcon,
} from './icons'

/**
 * The shared date and time picker.
 *
 * One picker instance per screen owns whichever field is open, so a dynamic
 * card list needs no per-row submodel. A trigger dispatches `RequestedOpen`
 * with a `target` string the screen understands; the dialog seeds itself from
 * the current value, shows a Jalali month grid and/or a clock-time grid, and
 * reports the committed value through `PickedValue` with the same target.
 *
 * Dates stay ISO `YYYY-MM-DD` on the wire while the grid and trigger render
 * Jalali months and Persian digits, matching the rest of the calendar screen.
 * Times stay `HH:mm`. `datetime` reports a local `YYYY-MM-DDTHH:mm` pair so the
 * screen can resolve it against its own timezone.
 */

// MODEL

export const PickerMode = Schema.Literals(['date', 'time', 'datetime'])

export type PickerMode = typeof PickerMode.Type

export const Model = Schema.Struct({
  id: Schema.String,
  dialog: Dialog.Model,
  target: Schema.Option(Schema.String),
  mode: PickerMode,
  dateValue: Schema.String,
  timeValue: Schema.String,
  today: Schema.String,
  viewYear: Schema.Int,
  viewMonth: Schema.Int,
})

export type Model = typeof Model.Type

export type InitConfig = Readonly<{
  id: string
}>

export const init = (config: InitConfig): Model => ({
  id: config.id,
  dialog: Dialog.init({ id: `${config.id}-dialog`, isAnimated: true }),
  target: Option.none(),
  mode: 'date',
  dateValue: '',
  timeValue: '09:00',
  today: '',
  viewYear: 1404,
  viewMonth: 1,
})

// MESSAGE

export const Message = defineMessageUnion({
  GotDialogMessage: { message: Dialog.Message },
  RequestedOpen: {
    target: Schema.String,
    mode: PickerMode,
    value: Schema.String,
    today: Schema.String,
  },
  ClickedPreviousMonth: {},
  ClickedNextMonth: {},
  ClickedDay: { date: Schema.String },
  SelectedHour: { hour: Schema.Int },
  SelectedMinute: { minute: Schema.Int },
  SelectedPeriod: { isPm: Schema.Boolean },
  ScrolledHour: { index: Schema.Int },
  ScrolledMinute: { index: Schema.Int },
  ScrolledPeriod: { index: Schema.Int },
  CompletedScrollTimeWheel: {},
  ClickedToday: {},
  ClickedClear: {},
  ClickedConfirm: {},
})

export type Message = typeof Message.Type

// OUT MESSAGE

export const OutMessage = defineMessageUnion({
  PickedValue: { target: Schema.String, value: Schema.String },
  ClearedValue: { target: Schema.String },
})

export type OutMessage = typeof OutMessage.Type

// COMMAND

/** Centers one wheel column on the selected row. The picker owns one command
 *  per column so the wheel opens on the current value instead of row zero. */
export const ScrollTimeWheel = Command.define('ScrollTimeWheel', {
  args: { itemId: Schema.String },
  messages: [Message.CompletedScrollTimeWheel],
  execute: ({ itemId }) =>
    Dom.scrollIntoViewAfterPaint(`#${itemId}`, { block: 'center' }).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedScrollTimeWheel()),
    ),
})

// HELPERS

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const CLOCK_TIME = /^(\d{1,2}):(\d{2})$/
const LOCAL_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})$/

const pad2 = (value: number): string => String(value).padStart(2, '0')

const isValidIsoDate = (value: string): boolean =>
  ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))

const isValidClockTime = (value: string): boolean => CLOCK_TIME.test(value)

const clockParts = (value: string) => {
  const match = CLOCK_TIME.exec(value)

  if (match === null) {
    return { hour: 9, minute: 0 }
  }

  const hour = Number.parseInt(match[1] ?? '0', 10)
  const minute = Number.parseInt(match[2] ?? '0', 10)

  return {
    hour: Number.isNaN(hour) ? 9 : Math.min(23, Math.max(0, hour)),
    minute: Number.isNaN(minute) ? 0 : Math.min(59, Math.max(0, minute)),
  }
}

const timeOf = (hour: number, minute: number): string =>
  `${pad2(hour)}:${pad2(minute)}`

const jalaliFieldsOf = (isoDate: string) => {
  const date = toJalaliDate(
    isValidIsoDate(isoDate) ? isoDate : toIsoDate(jalaliDate(1404, 1, 1)),
  )

  const fields = toJalaliFields(date)

  return { year: fields.year, month: fields.month }
}

const seedValues = (config: typeof Message.RequestedOpen.Type) => {
  if (config.mode === 'date') {
    return {
      dateValue: isValidIsoDate(config.value) ? config.value : '',
      timeValue: '09:00',
    }
  }

  if (config.mode === 'time') {
    return {
      dateValue: config.today,
      timeValue: isValidClockTime(config.value) ? config.value : '09:00',
    }
  }

  const match = LOCAL_DATETIME.exec(config.value)
  const datePart = match?.[1] ?? ''

  return {
    dateValue: isValidIsoDate(datePart) ? datePart : config.today,
    timeValue:
      match !== null
        ? timeOf(
            Number.parseInt(match[2] ?? '9', 10),
            Number.parseInt(match[3] ?? '0', 10),
          )
        : '09:00',
  }
}

const seeded = (
  model: Model,
  config: typeof Message.RequestedOpen.Type,
): Model => {
  const values = seedValues(config)

  const fields = jalaliFieldsOf(
    values.dateValue === '' ? config.today : values.dateValue,
  )

  return modifyFields(model, {
    target: () => Option.some(config.target),
    mode: () => config.mode,
    dateValue: () => values.dateValue,
    timeValue: () => values.timeValue,
    today: () => config.today,
    viewYear: () => fields.year,
    viewMonth: () => fields.month,
  })
}

const valueOf = (model: Model): string => {
  if (model.mode === 'date') {
    return model.dateValue
  }

  if (model.mode === 'time') {
    return model.timeValue
  }

  return `${model.dateValue}T${model.timeValue}`
}

const shiftViewMonth = (model: Model, delta: number): Model => {
  const next = addJalaliMonths(
    jalaliDate(model.viewYear, model.viewMonth, 1),
    delta,
  )

  const fields = toJalaliFields(next)

  return modifyFields(model, {
    viewYear: () => fields.year,
    viewMonth: () => fields.month,
  })
}

const WHEEL_ITEM_HEIGHT = 40

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

/** The 12-hour display value for a 24-hour clock value (0 → 12, 13 → 1). */
const displayHourOf = (hour: number): number =>
  hour % 12 === 0 ? 12 : hour % 12

const hourFromDisplay = (displayHour: number, isPm: boolean): number => {
  if (displayHour === 12) {
    return isPm ? 12 : 0
  }

  return isPm ? displayHour + 12 : displayHour
}

const isPmOf = (hour: number): boolean => hour >= 12

const periodIndex = (hour: number): number => (isPmOf(hour) ? 1 : 0)

const scrollCommandsFor = (
  model: Model,
): ReadonlyArray<Command.Command<Message>> => {
  if (model.mode === 'date') {
    return []
  }

  const { hour, minute } = clockParts(model.timeValue)

  return [
    ScrollTimeWheel({
      itemId: `${model.id}-hour-${displayHourOf(hour)}`,
    }),
    ScrollTimeWheel({ itemId: `${model.id}-minute-${minute}` }),
    ScrollTimeWheel({ itemId: `${model.id}-period-${periodIndex(hour)}` }),
  ]
}

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const foldDialogOutMessage = Dialog.OutMessage.match<
  Update.Step<Model, Message>
>({
  Opened: () => model => ({ model }),
  Closed: () => stepModel => ({
    model: modifyFields(stepModel, { target: () => Option.none() }),
  }),
})

const foldDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.dialog),
  write: (model, nextDialog) =>
    modifyFields(model, { dialog: () => nextDialog }),
  toParentMessage: message => Message.GotDialogMessage({ message }),
  foldOutMessage: foldDialogOutMessage,
})

const foldDialogOpen = Update.foldChildStep({
  update: Dialog.open,
  read: (model: Model) => Option.some(model.dialog),
  write: (model, nextDialog) =>
    modifyFields(model, { dialog: () => nextDialog }),
  toParentMessage: message => Message.GotDialogMessage({ message }),
  foldOutMessage: foldDialogOutMessage,
})

const foldDialogClose = Update.foldChildStep({
  update: Dialog.close,
  read: (model: Model) => Option.some(model.dialog),
  write: (model, nextDialog) =>
    modifyFields(model, { dialog: () => nextDialog }),
  toParentMessage: message => Message.GotDialogMessage({ message }),
  foldOutMessage: foldDialogOutMessage,
})

/** Programmatically opens the picker on a target. Screens normally let the
 *  trigger dispatch `RequestedOpen`; this helper exists for flows that open a
 *  picker from an unrelated action. */
export const open = (
  model: Model,
  config: typeof Message.RequestedOpen.Type,
): UpdateReturn =>
  Update.combine(seeded(model, config), [
    foldDialogOpen,
    stepModel => ({ model: stepModel, commands: scrollCommandsFor(stepModel) }),
  ])

const targetOf = (model: Model): Option.Option<string> => model.target

const closeWith = (
  model: Model,
  outMessage: OutMessage | undefined,
): UpdateReturn =>
  Update.withOutMessage(Update.combine(model, [foldDialogClose]), outMessage)

const commit = (model: Model): UpdateReturn =>
  Option.match(targetOf(model), {
    onNone: () => closeWith(model, undefined),
    onSome: target =>
      closeWith(
        model,
        OutMessage.PickedValue({ target, value: valueOf(model) }),
      ),
  })

const clear = (model: Model): UpdateReturn =>
  Option.match(targetOf(model), {
    onNone: () => closeWith(model, undefined),
    onSome: target => closeWith(model, OutMessage.ClearedValue({ target })),
  })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    GotDialogMessage: ({ message: dialogMessage }) =>
      foldDialog(model, dialogMessage),

    RequestedOpen: config => open(model, config),

    ClickedPreviousMonth: () => ({ model: shiftViewMonth(model, -1) }),
    ClickedNextMonth: () => ({ model: shiftViewMonth(model, 1) }),

    ClickedDay: ({ date }) => {
      const next = modifyFields(model, { dateValue: () => date })

      return model.mode === 'date' ? commit(next) : { model: next }
    },

    SelectedHour: ({ hour }) => {
      const parts = clockParts(model.timeValue)

      const next = modifyFields(model, {
        timeValue: () => timeOf(clamp(hour, 0, 23), parts.minute),
      })

      return { model: next, commands: scrollCommandsFor(next) }
    },

    SelectedMinute: ({ minute }) => {
      const parts = clockParts(model.timeValue)

      const next = modifyFields(model, {
        timeValue: () => timeOf(parts.hour, clamp(minute, 0, 59)),
      })

      return { model: next, commands: scrollCommandsFor(next) }
    },

    SelectedPeriod: ({ isPm }) => {
      const parts = clockParts(model.timeValue)

      const next = modifyFields(model, {
        timeValue: () =>
          timeOf(
            hourFromDisplay(displayHourOf(parts.hour), isPm),
            parts.minute,
          ),
      })

      return { model: next, commands: scrollCommandsFor(next) }
    },

    ScrolledHour: ({ index }) => {
      const parts = clockParts(model.timeValue)
      const hour = hourFromDisplay(clamp(index, 0, 11) + 1, isPmOf(parts.hour))
      const nextTime = timeOf(hour, parts.minute)

      return nextTime === model.timeValue
        ? { model }
        : { model: modifyFields(model, { timeValue: () => nextTime }) }
    },

    ScrolledMinute: ({ index }) => {
      const parts = clockParts(model.timeValue)
      const minute = clamp(index, 0, 59)

      return minute === parts.minute
        ? { model }
        : {
            model: modifyFields(model, {
              timeValue: () => timeOf(parts.hour, minute),
            }),
          }
    },

    ScrolledPeriod: ({ index }) => {
      const parts = clockParts(model.timeValue)
      const isPm = clamp(index, 0, 1) === 1

      if (isPmOf(parts.hour) === isPm) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          timeValue: () =>
            timeOf(
              hourFromDisplay(displayHourOf(parts.hour), isPm),
              parts.minute,
            ),
        }),
      }
    },

    CompletedScrollTimeWheel: () => ({ model }),

    ClickedToday: () => {
      const next = modifyFields(model, { dateValue: () => model.today })
      const fields = jalaliFieldsOf(model.today)

      const focused = modifyFields(next, {
        viewYear: () => fields.year,
        viewMonth: () => fields.month,
      })

      return model.mode === 'date' ? commit(focused) : { model: focused }
    },

    ClickedClear: () => clear(model),
    ClickedConfirm: () => commit(model),
  })

// VIEW

const PANEL_CLASS =
  'float-card grid w-full max-w-[23.5rem] max-h-[calc(100dvh-2rem)] gap-3 overflow-y-auto rounded-b-none rounded-t-3xl p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:rounded-2xl'

const NAV_BUTTON_CLASS = 'text-base-content/70'

const WEEKDAY_ORDER: Readonly<Record<WeekStart, ReadonlyArray<number>>> = {
  saturday: [5, 6, 0, 1, 2, 3, 4],
  sunday: [6, 0, 1, 2, 3, 4, 5],
  monday: [0, 1, 2, 3, 4, 5, 6],
}

const weekdayHeaders = (weekStart: WeekStart): ReadonlyArray<string> =>
  Array.map(WEEKDAY_ORDER[weekStart], index => {
    const label = JALALI_WEEKDAYS[index] ?? ''

    return label.slice(0, 1)
  })

const dayClass = (
  isSelected: boolean,
  isToday: boolean,
  inMonth: boolean,
): string =>
  [
    'grid size-10 place-items-center rounded-full text-[0.82rem] leading-none tabular-nums transition-colors',
    isSelected
      ? 'bg-primary font-bold text-primary-content shadow-sm'
      : inMonth
        ? 'text-base-content hover:bg-base-200'
        : 'text-base-content/70 hover:bg-base-200/70',
    isToday && !isSelected ? 'ring-1 ring-primary/45' : '',
  ]
    .filter(value => value !== '')
    .join(' ')

const monthTitle = (year: number, month: number, digits: Digits): string =>
  `${JALALI_MONTHS[month - 1] ?? ''} ${localizeDigits(year, digits)}`

const weekdaysHeadView = <ParentMessage>(
  weekStart: WeekStart,
  h: HtmlBuilder<ParentMessage>,
): Html =>
  h.div(
    [h.Class('grid grid-cols-7 gap-1 px-0.5')],
    Array.map(weekdayHeaders(weekStart), label =>
      h.span(
        [
          h.AriaHidden(true),
          h.Class(
            'py-1 text-center text-[0.66rem] font-medium text-base-content/70',
          ),
        ],
        [label],
      ),
    ),
  )

const daysGridView = <ParentMessage>(
  model: Model,
  digits: Digits,
  weekStart: WeekStart,
  initialFocus: ReadonlyArray<ChildAttribute>,
  toParentMessage: (message: Message) => ParentMessage,
  h: HtmlBuilder<ParentMessage>,
): Html => {
  const grid = jalaliMonthGrid(model.viewYear, model.viewMonth, { weekStart })

  const maybeSelected = isValidIsoDate(model.dateValue)
    ? Option.some(model.dateValue)
    : Option.none()

  const allDays = Array.flatMap(grid.weeks, week => week.days)

  const maybeTodayDay = Array.findFirst(
    allDays,
    day => toIsoDate(day.date) === model.today,
  )

  const maybeFocusIso = Option.match(maybeSelected, {
    onNone: () =>
      Option.map(
        Option.orElse(maybeTodayDay, () =>
          Array.findFirst(allDays, day => day.inMonth),
        ),
        day => toIsoDate(day.date),
      ),
    onSome: iso => Option.some(iso),
  })

  const weeks = Array.map(grid.weeks, week => {
    const cells = Array.map(week.days, day => {
      const iso = toIsoDate(day.date)
      const isSelected = Option.contains(maybeSelected, iso)
      const isToday = iso === model.today
      const shouldFocus = Option.contains(maybeFocusIso, iso)

      return h.div(
        [h.Class('flex items-center justify-center')],
        [
          h.button(
            [
              h.Type('button'),
              ...(shouldFocus ? initialFocus : []),
              h.AriaLabel(
                formatJalaliDate(day.date, { digits, style: 'long' }),
              ),
              ...(isToday ? [h.AriaCurrent('date')] : []),
              h.DataAttribute('selected', isSelected ? 'true' : 'false'),
              h.DataAttribute('today', isToday ? 'true' : 'false'),
              h.DataAttribute('outside', day.inMonth ? 'false' : 'true'),
              h.Class(dayClass(isSelected, isToday, day.inMonth)),
              h.OnClick(toParentMessage(Message.ClickedDay({ date: iso }))),
            ],
            [localizeDigits(toJalaliFields(day.date).day, digits)],
          ),
        ],
      )
    })

    return h.div([h.Class('grid grid-cols-7 gap-1')], cells)
  })

  return h.div(
    [
      h.Role('grid'),
      h.AriaLabel(monthTitle(model.viewYear, model.viewMonth, digits)),
      h.Class('grid grid-cols-1 gap-1'),
    ],
    [weekdaysHeadView(weekStart, h), ...weeks],
  )
}

type WheelItem = Readonly<{
  id: string
  value: number
  label: string
  ariaLabel: string
  isSelected: boolean
}>

const wheelColumnView = <ParentMessage>(
  config: Readonly<{
    label: string
    items: ReadonlyArray<WheelItem>
    widthClass: string
    onScroll: (scrollTop: number) => ParentMessage
    onClick: (value: number) => ParentMessage
    onKeyDown: (key: string) => Option.Option<ParentMessage>
  }>,
  h: HtmlBuilder<ParentMessage>,
): Html => {
  const maybeSelected = Array.findFirst(config.items, item => item.isSelected)

  return h.div(
    [
      h.Class(
        `relative h-[12.5rem] min-w-0 overflow-hidden ${config.widthClass}`,
      ),
    ],
    [
      h.div([
        h.AriaHidden(true),
        h.Class(
          'pointer-events-none absolute inset-x-1 top-1/2 z-0 h-10 -translate-y-1/2 rounded-xl bg-primary/5 ring-1 ring-primary/15',
        ),
      ]),
      h.div(
        [
          h.Role('listbox'),
          h.AriaLabel(config.label),
          h.AriaOrientation('vertical'),
          ...Option.match(maybeSelected, {
            onNone: () => [],
            onSome: item => [h.AriaActiveDescendant(item.id)],
          }),
          h.Tabindex(0),
          h.Class(
            'relative z-10 h-full touch-pan-y snap-y snap-mandatory overflow-y-scroll overscroll-contain outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          ),
          h.OnScroll(config.onScroll),
          h.OnKeyDownPreventDefault(config.onKeyDown),
        ],
        [
          h.div([h.AriaHidden(true), h.Class('h-20 shrink-0')]),
          ...Array.map(config.items, item =>
            h.button(
              [
                h.Type('button'),
                h.Id(item.id),
                h.Role('option'),
                h.AriaSelected(item.isSelected),
                h.AriaLabel(item.ariaLabel),
                h.Tabindex(-1),
                h.DataAttribute('selected', item.isSelected ? 'true' : 'false'),
                h.Class(
                  [
                    'flex h-10 w-full shrink-0 snap-center items-center justify-center rounded-lg px-1 text-[0.95rem] tabular-nums transition-colors',
                    item.isSelected
                      ? 'font-bold text-primary'
                      : 'text-base-content/70 hover:text-base-content/70',
                  ].join(' '),
                ),
                h.OnClick(config.onClick(item.value)),
              ],
              [item.label],
            ),
          ),
          h.div([h.AriaHidden(true), h.Class('h-20 shrink-0')]),
        ],
      ),
      h.div([
        h.AriaHidden(true),
        h.Class(
          'pointer-events-none absolute inset-x-0 top-0 z-20 h-8 bg-gradient-to-b from-base-100 to-transparent',
        ),
      ]),
      h.div([
        h.AriaHidden(true),
        h.Class(
          'pointer-events-none absolute inset-x-0 bottom-0 z-20 h-8 bg-gradient-to-t from-base-100 to-transparent',
        ),
      ]),
    ],
  )
}

const hoursView = <ParentMessage>(
  model: Model,
  digits: Digits,
  toParentMessage: (message: Message) => ParentMessage,
  h: HtmlBuilder<ParentMessage>,
): Html => {
  const { hour } = clockParts(model.timeValue)
  const isPm = isPmOf(hour)
  const selectedDisplay = displayHourOf(hour)

  const items: ReadonlyArray<WheelItem> = Array.makeBy(12, index => {
    const display = index + 1
    const label = localizeDigits(display, digits)

    return {
      id: `${model.id}-hour-${display}`,
      value: display,
      label,
      ariaLabel: `${label} ${isPm ? 'بعد از ظهر' : 'قبل از ظهر'}`,
      isSelected: display === selectedDisplay,
    }
  })

  const selectDisplay = (display: number): Option.Option<ParentMessage> =>
    Option.some(
      toParentMessage(
        Message.SelectedHour({ hour: hourFromDisplay(display, isPm) }),
      ),
    )

  return wheelColumnView(
    {
      label: 'ساعت',
      items,
      widthClass: 'flex-1',
      onScroll: scrollTop =>
        toParentMessage(
          Message.ScrolledHour({
            index: Math.round(scrollTop / WHEEL_ITEM_HEIGHT),
          }),
        ),
      onClick: display =>
        toParentMessage(
          Message.SelectedHour({ hour: hourFromDisplay(display, isPm) }),
        ),
      onKeyDown: key => {
        if (key === 'ArrowUp') {
          return selectDisplay(selectedDisplay === 1 ? 12 : selectedDisplay - 1)
        }

        if (key === 'ArrowDown') {
          return selectDisplay(selectedDisplay === 12 ? 1 : selectedDisplay + 1)
        }

        if (key === 'Home') {
          return selectDisplay(1)
        }

        if (key === 'End') {
          return selectDisplay(12)
        }

        return Option.none()
      },
    },
    h,
  )
}

const minutesView = <ParentMessage>(
  model: Model,
  digits: Digits,
  toParentMessage: (message: Message) => ParentMessage,
  h: HtmlBuilder<ParentMessage>,
): Html => {
  const { minute } = clockParts(model.timeValue)

  const items: ReadonlyArray<WheelItem> = Array.makeBy(60, index => ({
    id: `${model.id}-minute-${index}`,
    value: index,
    label: localizeDigits(pad2(index), digits),
    ariaLabel: `${localizeDigits(index, digits)} دقیقه`,
    isSelected: index === minute,
  }))

  const selectMinute = (value: number): Option.Option<ParentMessage> =>
    Option.some(
      toParentMessage(Message.SelectedMinute({ minute: clamp(value, 0, 59) })),
    )

  return wheelColumnView(
    {
      label: 'دقیقه',
      items,
      widthClass: 'flex-1',
      onScroll: scrollTop =>
        toParentMessage(
          Message.ScrolledMinute({
            index: Math.round(scrollTop / WHEEL_ITEM_HEIGHT),
          }),
        ),
      onClick: value =>
        toParentMessage(Message.SelectedMinute({ minute: value })),
      onKeyDown: key => {
        if (key === 'ArrowUp') {
          return selectMinute(minute - 1)
        }

        if (key === 'ArrowDown') {
          return selectMinute(minute + 1)
        }

        if (key === 'Home') {
          return selectMinute(0)
        }

        if (key === 'End') {
          return selectMinute(59)
        }

        return Option.none()
      },
    },
    h,
  )
}

const periodView = <ParentMessage>(
  model: Model,
  toParentMessage: (message: Message) => ParentMessage,
  h: HtmlBuilder<ParentMessage>,
): Html => {
  const isPm = isPmOf(clockParts(model.timeValue).hour)

  const items: ReadonlyArray<WheelItem> = [
    {
      id: `${model.id}-period-0`,
      value: 0,
      label: 'ق.ظ',
      ariaLabel: 'قبل از ظهر',
      isSelected: !isPm,
    },
    {
      id: `${model.id}-period-1`,
      value: 1,
      label: 'ب.ظ',
      ariaLabel: 'بعد از ظهر',
      isSelected: isPm,
    },
  ]

  return wheelColumnView(
    {
      label: 'بعد از ظهر یا قبل از ظهر',
      items,
      widthClass: 'w-16 shrink-0',
      onScroll: scrollTop =>
        toParentMessage(
          Message.ScrolledPeriod({
            index: Math.round(scrollTop / WHEEL_ITEM_HEIGHT),
          }),
        ),
      onClick: value =>
        toParentMessage(Message.SelectedPeriod({ isPm: value === 1 })),
      onKeyDown: key => {
        if (key === 'ArrowUp' || key === 'ArrowDown') {
          return Option.some(
            toParentMessage(Message.SelectedPeriod({ isPm: !isPm })),
          )
        }

        if (key === 'Home') {
          return Option.some(
            toParentMessage(Message.SelectedPeriod({ isPm: false })),
          )
        }

        if (key === 'End') {
          return Option.some(
            toParentMessage(Message.SelectedPeriod({ isPm: true })),
          )
        }

        return Option.none()
      },
    },
    h,
  )
}

const timeView = <ParentMessage>(
  model: Model,
  digits: Digits,
  toParentMessage: (message: Message) => ParentMessage,
  h: HtmlBuilder<ParentMessage>,
): Html => {
  const { hour, minute } = clockParts(model.timeValue)
  const selectedLabel = `${localizeDigits(displayHourOf(hour), digits)}:${localizeDigits(pad2(minute), digits)} ${isPmOf(hour) ? 'ب.ظ' : 'ق.ظ'}`

  return h.div(
    [h.Class('grid gap-2')],
    [
      h.div(
        [h.Class('flex items-center justify-between gap-2')],
        [
          h.span(
            [h.Class('text-[0.72rem] font-medium text-base-content/70')],
            ['ساعت'],
          ),
          h.span(
            [
              h.AriaLive('polite'),
              h.Class(
                'rounded-lg bg-primary/10 px-2.5 py-1 text-[1.05rem] font-bold tabular-nums text-primary',
              ),
            ],
            [selectedLabel],
          ),
        ],
      ),
      h.div(
        [h.Class('flex items-stretch justify-center gap-1'), h.Dir('ltr')],
        [
          hoursView(model, digits, toParentMessage, h),
          minutesView(model, digits, toParentMessage, h),
          periodView(model, toParentMessage, h),
        ],
      ),
      h.p(
        [
          h.AriaHidden(true),
          h.Class('m-0 text-center text-[0.66rem] text-base-content/70'),
        ],
        ['هر ستون را بکشید تا مقدار تازه انتخاب شود.'],
      ),
    ],
  )
}

const pickerDialogPanel = <ParentMessage>(
  model: Model,
  digits: Digits,
  weekStart: WeekStart,
  render: Dialog.RenderInfo,
  toParentMessage: (message: Message) => ParentMessage,
  h: HtmlBuilder<ParentMessage>,
): Html => {
  const title = Match.value(model.mode).pipe(
    Match.when('date', () => 'انتخاب تاریخ'),
    Match.when('time', () => 'انتخاب ساعت'),
    Match.orElse(() => 'انتخاب تاریخ و ساعت'),
  )

  return h.dialog(
    [
      ...render.dialog,
      h.Class('app-modal items-end p-0 sm:items-center sm:p-4'),
    ],
    render.isVisible
      ? [
          h.div([...render.backdrop, h.Class('app-modal-backdrop')]),
          h.div(
            [...render.panel, h.Class(PANEL_CLASS)],
            [
              h.div([
                h.AriaHidden(true),
                h.Class(
                  'mx-auto h-1.5 w-10 rounded-full bg-base-content/15 sm:hidden',
                ),
              ]),
              h.div(
                [h.Class('flex items-center justify-between gap-2')],
                [
                  h.h2(
                    [...render.title, h.Class('m-0 text-[0.95rem] font-bold')],
                    [title],
                  ),
                  h.button(
                    [
                      ...render.closeButton,
                      h.AriaLabel('بستن'),
                      h.Class(
                        'grid size-8 place-items-center rounded-lg text-base-content/70 transition-colors hover:bg-base-200 hover:text-base-content',
                      ),
                    ],
                    [closeIcon('size-4')],
                  ),
                ],
              ),
              ...(model.mode === 'time'
                ? []
                : [
                    h.div(
                      [h.Class('flex items-center justify-between gap-2')],
                      [
                        buttonView(
                          {
                            variant: 'ghost',
                            size: 'sm',
                            isSquare: true,
                            ariaLabel: 'ماه قبل',
                            onClick: toParentMessage(
                              Message.ClickedPreviousMonth(),
                            ),
                            children: [chevronRightIcon('size-4')],
                            class: NAV_BUTTON_CLASS,
                          },
                          h,
                        ),
                        h.span(
                          [
                            h.Class(
                              'text-[0.85rem] font-semibold tabular-nums',
                            ),
                          ],
                          [monthTitle(model.viewYear, model.viewMonth, digits)],
                        ),
                        buttonView(
                          {
                            variant: 'ghost',
                            size: 'sm',
                            isSquare: true,
                            ariaLabel: 'ماه بعد',
                            onClick: toParentMessage(
                              Message.ClickedNextMonth(),
                            ),
                            children: [chevronLeftIcon('size-4')],
                            class: NAV_BUTTON_CLASS,
                          },
                          h,
                        ),
                      ],
                    ),
                    daysGridView(
                      model,
                      digits,
                      weekStart,
                      render.initialFocus,
                      toParentMessage,
                      h,
                    ),
                  ]),
              ...(model.mode === 'date'
                ? []
                : [timeView(model, digits, toParentMessage, h)]),
              h.div(
                [h.Class('flex items-center justify-between gap-2 pt-1')],
                [
                  h.div(
                    [h.Class('flex items-center gap-1')],
                    [
                      ...(model.mode === 'time'
                        ? []
                        : [
                            buttonView(
                              {
                                variant: 'ghost',
                                size: 'sm',
                                onClick: toParentMessage(
                                  Message.ClickedToday(),
                                ),
                                children: ['امروز'],
                              },
                              h,
                            ),
                          ]),
                      buttonView(
                        {
                          variant: 'ghost',
                          size: 'sm',
                          onClick: toParentMessage(Message.ClickedClear()),
                          children: ['پاک کردن'],
                          class: 'text-base-content/70',
                        },
                        h,
                      ),
                    ],
                  ),
                  model.mode === 'date'
                    ? h.empty
                    : buttonView(
                        {
                          variant: 'primary',
                          size: 'sm',
                          onClick: toParentMessage(Message.ClickedConfirm()),
                          children: ['تأیید'],
                        },
                        h,
                      ),
                ],
              ),
            ],
          ),
        ]
      : [],
  )
}

/** Renders the single picker dialog a screen owns. Place it once at the page
 *  root; triggers across the screen feed it through `RequestedOpen`. */
export const pickerDialogView = <ParentMessage>(
  config: Readonly<{
    model: Model
    toParentMessage: (message: Message) => ParentMessage
    digits: Digits
    weekStart?: WeekStart
  }>,
  h: HtmlBuilder<ParentMessage>,
): Html =>
  h.submodel({
    slotId: config.model.dialog.id,
    model: config.model.dialog,
    view: Dialog.view,
    viewInputs: {
      toView: render =>
        pickerDialogPanel(
          config.model,
          config.digits,
          config.weekStart ?? 'saturday',
          render,
          config.toParentMessage,
          h,
        ),
    },
    toParentMessage: message =>
      config.toParentMessage(Message.GotDialogMessage({ message })),
  })

type TriggerDisplayConfig = Readonly<{
  mode: PickerMode
  value: string
  digits: Digits
}>

const formatTriggerValue = (
  config: TriggerDisplayConfig,
): Option.Option<string> => {
  if (config.mode === 'date') {
    return isValidIsoDate(config.value)
      ? Option.some(
          formatJalaliDate(toJalaliDate(config.value), {
            digits: config.digits,
            style: 'medium',
          }),
        )
      : Option.none()
  }

  if (config.mode === 'time') {
    return isValidClockTime(config.value)
      ? Option.some(localizeDigits(config.value, config.digits))
      : Option.none()
  }

  const match = LOCAL_DATETIME.exec(config.value)
  const datePart = match?.[1] ?? ''

  if (!isValidIsoDate(datePart)) {
    return Option.none()
  }

  return Option.some(
    `${formatJalaliDate(toJalaliDate(datePart), {
      digits: config.digits,
      style: 'medium',
    })}، ${localizeDigits(timeOf(Number(match?.[2] ?? '9'), Number(match?.[3] ?? '0')), config.digits)}`,
  )
}

export type PickerTriggerConfig<ParentMessage> = Readonly<{
  id: string
  label: string
  target: string
  mode: PickerMode
  value: string
  today: string
  placeholder?: string
  hint?: string
  isDisabled?: boolean
  digits: Digits
  toParentMessage: (message: Message) => ParentMessage
  class?: string
}>

/** Renders the field label and the trigger button that opens the shared
 *  picker. The button dispatches `RequestedOpen` with the caller's target. */
export const pickerTriggerView = <ParentMessage>(
  config: PickerTriggerConfig<ParentMessage>,
  h: HtmlBuilder<ParentMessage>,
): Html => {
  const maybeDisplay = formatTriggerValue(config)

  const display = Option.getOrElse(
    maybeDisplay,
    () => config.placeholder ?? 'انتخاب کنید',
  )

  const icon =
    config.mode === 'time'
      ? clockIcon('size-4 shrink-0 text-base-content/70')
      : calendarIcon('size-4 shrink-0 text-base-content/70')

  const triggerButtonConfig = {
    id: config.id,
    variant: 'outline',
    // The accessible name must contain the visible value (axe
    // `label-content-name-mismatch`), so the field label leads and the value
    // follows instead of the label replacing it.
    ariaLabel: Option.isSome(maybeDisplay)
      ? `${config.label}، ${display}`
      : config.label,
    onClick: config.toParentMessage(
      Message.RequestedOpen({
        target: config.target,
        mode: config.mode,
        value: config.value,
        today: config.today,
      }),
    ),
    class: [
      'min-h-11 w-full justify-between text-start font-normal',
      config.class,
    ]
      .filter(value => value !== undefined && value !== '')
      .join(' '),
    children: [
      h.span(
        [
          h.Class(
            Option.isSome(maybeDisplay)
              ? 'truncate text-[0.84rem] text-base-content'
              : 'truncate text-[0.84rem] text-base-content/70',
          ),
        ],
        [display],
      ),
      icon,
    ],
  } satisfies ButtonConfig<ParentMessage>

  const buttonConfig =
    config.isDisabled === true
      ? { ...triggerButtonConfig, isDisabled: true }
      : triggerButtonConfig

  return h.div(
    [h.Class('grid min-w-0 gap-1')],
    [
      h.label(
        [
          h.For(config.id),
          h.Class('text-[0.76rem] leading-6 text-base-content/70'),
        ],
        [config.label],
      ),
      buttonView(buttonConfig, h),
      ...(config.hint === undefined
        ? []
        : [
            h.span(
              [h.Class('text-[0.68rem] leading-5 text-base-content/70')],
              [config.hint],
            ),
          ]),
    ],
  )
}
