import { Option } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import * as Picker from './picker'

const openPicker = (
  config: Readonly<{
    target: string
    mode: Picker.PickerMode
    value: string
  }>,
): Picker.Model =>
  Picker.update(
    Picker.init({ id: 'test-picker' }),
    Picker.Message.RequestedOpen({
      ...config,
      today: '2026-11-09',
    }),
  ).model

describe('picker', () => {
  test('a day click commits an ISO date for the target', () => {
    const model = openPicker({
      target: 'task:due',
      mode: 'date',
      value: '2026-11-09',
    })

    const result = Picker.update(
      model,
      Picker.Message.ClickedDay({ date: '2026-11-14' }),
    )

    expect(result.outMessage).toStrictEqual(
      Picker.OutMessage.PickedValue({
        target: 'task:due',
        value: '2026-11-14',
      }),
    )
    expect(result.model.target).toStrictEqual(Option.none())
  })

  test('time edits stay open until confirm and report HH:mm', () => {
    const model = openPicker({
      target: 'habit:reminderTime',
      mode: 'time',
      value: '08:15',
    })

    const pickedHour = Picker.update(
      model,
      Picker.Message.SelectedHour({ hour: 19 }),
    )

    expect(pickedHour.outMessage).toBeUndefined()
    expect(pickedHour.model.timeValue).toBe('19:15')

    const pickedMinute = Picker.update(
      pickedHour.model,
      Picker.Message.SelectedMinute({ minute: 45 }),
    )

    expect(pickedMinute.model.timeValue).toBe('19:45')

    const confirmed = Picker.update(
      pickedMinute.model,
      Picker.Message.ClickedConfirm(),
    )

    expect(confirmed.outMessage).toStrictEqual(
      Picker.OutMessage.PickedValue({
        target: 'habit:reminderTime',
        value: '19:45',
      }),
    )
  })

  test('wheel scrolls map to a 12-hour clock with a period', () => {
    const model = openPicker({
      target: 'habit:reminderTime',
      mode: 'time',
      value: '09:15',
    })

    const toNoon = Picker.update(
      model,
      Picker.Message.ScrolledHour({ index: 11 }),
    )

    expect(toNoon.model.timeValue).toBe('00:15')

    const toAfternoon = Picker.update(
      toNoon.model,
      Picker.Message.ScrolledPeriod({ index: 1 }),
    )

    expect(toAfternoon.model.timeValue).toBe('12:15')

    const toNinePm = Picker.update(
      model,
      Picker.Message.ScrolledHour({ index: 8 }),
    )

    const ninePmAfternoon = Picker.update(
      toNinePm.model,
      Picker.Message.ScrolledPeriod({ index: 1 }),
    )

    expect(ninePmAfternoon.model.timeValue).toBe('21:15')

    const thirty = Picker.update(
      model,
      Picker.Message.ScrolledMinute({ index: 30 }),
    )

    expect(thirty.model.timeValue).toBe('09:30')
  })

  test('datetime commits the local date and time pair', () => {
    const model = openPicker({
      target: 'need:timing.start',
      mode: 'datetime',
      value: '',
    })

    expect(model.dateValue).toBe('2026-11-09')
    expect(model.timeValue).toBe('09:00')

    const withDay = Picker.update(
      model,
      Picker.Message.ClickedDay({ date: '2026-11-11' }),
    )

    const withHour = Picker.update(
      withDay.model,
      Picker.Message.SelectedHour({ hour: 17 }),
    )

    const confirmed = Picker.update(
      withHour.model,
      Picker.Message.ClickedConfirm(),
    )

    expect(confirmed.outMessage).toStrictEqual(
      Picker.OutMessage.PickedValue({
        target: 'need:timing.start',
        value: '2026-11-11T17:00',
      }),
    )
  })

  test('clear reports the target without a value', () => {
    const model = openPicker({
      target: 'occasion:originDate',
      mode: 'date',
      value: '2026-11-09',
    })

    const result = Picker.update(model, Picker.Message.ClickedClear())

    expect(result.outMessage).toStrictEqual(
      Picker.OutMessage.ClearedValue({ target: 'occasion:originDate' }),
    )
  })

  test('a month step keeps the selected day and moves the visible month', () => {
    const model = openPicker({
      target: 'task:due',
      mode: 'date',
      value: '2026-11-09',
    })

    const initial = { year: model.viewYear, month: model.viewMonth }

    const next = Picker.update(model, Picker.Message.ClickedNextMonth())

    expect(next.model.dateValue).toBe('2026-11-09')
    expect({
      year: next.model.viewYear,
      month: next.model.viewMonth,
    }).not.toStrictEqual(initial)
  })
})
