import { Array } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { formatJalaliDate, localizeDigits, toJalaliDate } from '@tali/domain'
import type { HabitEntryStatus } from '@tali/domain'

import { type HabitRow, habitHeatmapMonth, habitMonthOf } from '../habits-model'
import { Message } from './habits'
import type { HeatState, ViewInputs } from './habits'

/**
 * The monthly Jalali heatmap, ported from
 * `apps/web/src/components/habits/heatmap.tsx` (ticket #66).
 *
 * One Jalali month at a time, bucketed by the same local dates the streak
 * counts, with whole weeks so the grid aligns. Each cell paints the raw entry
 * status — done / partial / missed / blank — and nothing else, so the heatmap
 * and the streak badge cannot disagree by construction. A week that straddles
 * a Jalali month boundary stays one counting week while its days paint in the
 * month they belong to (E15).
 */

const cellStatusText = (status: HabitEntryStatus | null): string => {
  if (status === 'done') {
    return 'انجام شد'
  }

  if (status === 'partial') {
    return 'نیمه'
  }

  if (status === 'missed') {
    return 'از دست رفت'
  }

  return 'بدون ثبت'
}

const legendDot = (
  maybeStyle: Readonly<Record<string, string>> | undefined,
  h: HtmlBuilder<Message>,
): Html =>
  h.span([
    h.Class('habits-heat-dot'),
    ...(maybeStyle === undefined ? [] : [h.Style(maybeStyle)]),
  ])

const legendKey = (
  label: string,
  maybeStyle: Readonly<Record<string, string>> | undefined,
  h: HtmlBuilder<Message>,
): Html =>
  h.span([h.Class('habits-heat-key')], [legendDot(maybeStyle, h), label])

const legendView = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('habits-heat-legend'), h.AriaLabel('راهنمای نقشه')],
    [
      legendKey(
        'انجام شد',
        {
          background: 'var(--color-success)',
          'border-color': 'var(--color-success)',
        },
        h,
      ),
      legendKey(
        'نیمه',
        {
          background: 'var(--color-warning)',
          'border-color': 'var(--color-warning)',
        },
        h,
      ),
      legendKey(
        'از دست رفت',
        {
          background: 'var(--color-error)',
          'border-color': 'var(--color-error)',
        },
        h,
      ),
      legendKey('بدون ثبت', undefined, h),
    ],
  )

const heatNavButton = (
  label: string,
  glyph: string,
  message: Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Class('habits-heat-nav'),
      h.AriaLabel(label),
      h.OnClick(message),
    ],
    [glyph],
  )

export const habitHeatmapView = (
  habit: HabitRow,
  heat: HeatState,
  today: string,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits
  const month = habitHeatmapMonth({
    habitId: habit.id,
    entries: inputs.mirror.habitEntries,
    year: heat.month.year,
    month: heat.month.month,
    digits,
    weekStart: inputs.display.weekStart,
  })
  const current = habitMonthOf(today)
  const isCurrentMonth =
    month.year === current.year && month.month === current.month

  return h.section(
    [h.Class('habits-heat'), h.AriaLabel(`نقشه ماه ${month.label}`)],
    [
      h.header(
        [h.Class('habits-heat-head')],
        [
          heatNavButton('ماه قبل', '›', Message.PressedPreviousHeatMonth(), h),
          h.strong([h.AriaLive('polite')], [month.label]),
          heatNavButton('ماه بعد', '‹', Message.PressedNextHeatMonth(), h),
        ],
      ),
      h.div(
        [
          h.Class('habits-heat-grid'),
          h.Role('grid'),
          h.AriaLabel(`روزهای ${month.label}`),
        ],
        [
          ...Array.map(month.weekdayLabels, label =>
            h.span(
              [h.Class('habits-heat-weekday'), h.Role('columnheader')],
              [label],
            ),
          ),
          ...Array.flatMap(month.weeks, week =>
            Array.map(week, cell => {
              const dateLabel = formatJalaliDate(toJalaliDate(cell.date), {
                digits,
                style: 'medium',
              })

              return h.keyed('span')(
                cell.date,
                [
                  h.Role('gridcell'),
                  h.Class('habits-heat-cell'),
                  h.DataAttribute('status', cell.status ?? 'blank'),
                  ...(cell.inMonth ? [] : [h.DataAttribute('outside', 'true')]),
                  ...(cell.date === today ? [h.AriaCurrent('date')] : []),
                  h.AriaLabel(`${dateLabel}: ${cellStatusText(cell.status)}`),
                  h.Title(dateLabel),
                ],
                [localizeDigits(cell.day, digits)],
              )
            }),
          ),
        ],
      ),
      legendView(h),
      h.p(
        [h.Class('habits-heat-hint')],
        [
          'نقشه فقط ثبت خام هر روز را نشان می‌دهد؛ سهمیه و نرخ هفته را زنجیره حساب می‌کند. یک هفته ممکن است میان دو ماه شمسی بیفتد ولی یک‌بار شمرده می‌شود.',
        ],
      ),
      ...(isCurrentMonth
        ? []
        : [
            h.button(
              [
                h.Type('button'),
                h.Class('habit-action'),
                h.OnClick(Message.ClickedCurrentHeatMonth()),
              ],
              ['بازگشت به ماه جاری'],
            ),
          ]),
    ],
  )
}
