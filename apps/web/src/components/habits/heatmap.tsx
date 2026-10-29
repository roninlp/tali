import { For, Show, createMemo, createSignal } from "solid-js"
import {
  localizeDigits,
  toJalaliDate,
  formatJalaliDate,
  type Digits,
  type LocalDate,
  type WeekStart
} from "@tali/domain"
import {
  habitHeatmapMonth,
  habitMonthOf,
  shiftHabitMonth,
  type HabitEntryRow,
  type HabitRow
} from "../../lib/habits/model"

/**
 * The monthly heatmap (ticket #66).
 *
 * One Jalali month at a time, bucketed by **local month** (the same wall dates
 * the streak algorithm counts), with whole weeks so the grid aligns. Each cell
 * paints the raw entry status — done / partial / missed / blank — and nothing
 * else: the quota and the weights stay in `habitStreak`, so the heatmap and the
 * badge cannot disagree by construction. A week that straddles a Jalali month
 * boundary is judged once by the streak but paints its days in the months they
 * belong to (E15).
 */

export function HabitHeatmap(props: {
  habit: HabitRow
  entries: ReadonlyArray<HabitEntryRow>
  today: LocalDate
  digits: Digits
  weekStart: WeekStart
}) {
  const initial = createMemo(() => habitMonthOf(props.today))
  const [month, setMonth] = createSignal(initial())

  const model = createMemo(() =>
    habitHeatmapMonth({
      habitId: props.habit.id,
      entries: props.entries,
      year: month().year,
      month: month().month,
      digits: props.digits,
      weekStart: props.weekStart
    })
  )

  return (
    <section class="habits-heat" aria-label={`نقشه ماه ${model().label}`}>
      <header class="habits-heat-head">
        <button
          type="button"
          class="habits-heat-nav"
          aria-label="ماه قبل"
          onClick={() => setMonth((current) => shiftHabitMonth(current.year, current.month, -1))}
        >
          ›
        </button>
        <strong aria-live="polite">{model().label}</strong>
        <button
          type="button"
          class="habits-heat-nav"
          aria-label="ماه بعد"
          onClick={() => setMonth((current) => shiftHabitMonth(current.year, current.month, 1))}
        >
          ‹
        </button>
      </header>

      <div class="habits-heat-grid" role="grid" aria-label={`روزهای ${model().label}`}>
        <For each={model().weekdayLabels}>
          {(label) => (
            <span class="habits-heat-weekday" role="columnheader">
              {label}
            </span>
          )}
        </For>
        <For each={model().weeks}>
          {(week) => (
            <For each={week}>
              {(cell) => (
                <span
                  role="gridcell"
                  class="habits-heat-cell"
                  data-status={cell.status ?? "blank"}
                  data-outside={cell.inMonth ? undefined : "true"}
                  aria-current={cell.date === props.today ? "date" : undefined}
                  aria-label={`${formatJalaliDate(toJalaliDate(cell.date), {
                    digits: props.digits,
                    style: "medium"
                  })}: ${
                    cell.status === "done"
                      ? "انجام شد"
                      : cell.status === "partial"
                        ? "نیمه"
                        : cell.status === "missed"
                          ? "از دست رفت"
                          : "بدون ثبت"
                  }`}
                  title={formatJalaliDate(toJalaliDate(cell.date), {
                    digits: props.digits,
                    style: "medium"
                  })}
                >
                  {localizeDigits(cell.day, props.digits)}
                </span>
              )}
            </For>
          )}
        </For>
      </div>

      <div class="habits-heat-legend" aria-label="راهنمای نقشه">
        <span class="habits-heat-key">
          <span
            class="habits-heat-dot"
            style={{ background: "var(--color-success)", "border-color": "var(--color-success)" }}
          />
          انجام شد
        </span>
        <span class="habits-heat-key">
          <span
            class="habits-heat-dot"
            style={{ background: "var(--color-warning)", "border-color": "var(--color-warning)" }}
          />
          نیمه
        </span>
        <span class="habits-heat-key">
          <span
            class="habits-heat-dot"
            style={{ background: "var(--color-error)", "border-color": "var(--color-error)" }}
          />
          از دست رفت
        </span>
        <span class="habits-heat-key">
          <span class="habits-heat-dot" />
          بدون ثبت
        </span>
      </div>
      <p class="habits-heat-hint">
        نقشه فقط ثبت خام هر روز را نشان می‌دهد؛ سهمیه و نرخ هفته را زنجیره حساب
        می‌کند. یک هفته ممکن است میان دو ماه شمسی بیفتد ولی یک‌بار شمرده می‌شود.
      </p>
      <Show when={month().year !== initial().year || month().month !== initial().month}>
        <button
          type="button"
          class="habit-action"
          onClick={() => setMonth(initial())}
        >
          بازگشت به ماه جاری
        </button>
      </Show>
    </section>
  )
}
