import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { localizeDigits, type Digits, type LocalDate } from "@tali/domain"
import type { LocalStore } from "../../lib/local-store"
import { habitEntryStatusOf, tapHabitEntry } from "../../lib/habits/log"
import {
  HABIT_WINDOW_DAYS,
  habitCountingPeriodLabel,
  habitEntryOn,
  habitFrequencyLabel,
  habitRateCopy,
  habitStatsFor,
  habitStatusIcon,
  habitStatusLabel,
  habitStreakLabel,
  liveHabitEntryRows,
  liveHabitRows,
  type HabitEntryRow,
  type HabitRow,
  type HabitWindowDays
} from "../../lib/habits/model"
import { HabitLaneStyles } from "./ui"

/**
 * The Today habits lane (ticket #66; FR-HAB-03).
 *
 * One tap per habit cycles Done → Partial → Missed. The tap goes through
 * `tapHabitEntry`, which commits the mirror row **and** its outbox mutation in
 * one IndexedDB transaction before returning, so the badge below re-renders
 * from the local rows with no network involved — the lane works on a plane and
 * the queue drains later. The streak and the rate are recomputed with the
 * authoritative `habitStreak` on every render; nothing is cached.
 *
 * For an X-times-a-week habit the 7-day rate is structurally `null` (a closed
 * counting week is seven days long, E13). The lane then shows the open week's
 * progress («۲ از ۳ این هفته») and never `0%`.
 */

export function TodayHabits(props: {
  store: LocalStore | undefined
  timeZone: string
  digits: Digits
  today: LocalDate
  onCount?: (count: number) => void
}) {
  const [habits, setHabits] = createSignal<ReadonlyArray<HabitRow>>([])
  const [entries, setEntries] = createSignal<ReadonlyArray<HabitEntryRow>>([])
  const [windowDays, setWindowDays] = createSignal<HabitWindowDays>(7)
  const [busyId, setBusyId] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [announcement, setAnnouncement] = createSignal("")

  createEffect(
    () => props.store,
    (store) => {
      if (store === undefined) {
        setHabits([])
        setEntries([])
        return
      }
      let cancelled = false
      const reload = () => {
        void Promise.all([store.list("habit"), store.list("habitEntry")])
          .then(([habitRecords, entryRecords]) => {
            if (cancelled) return
            const rows = liveHabitRows(habitRecords)
            setHabits(rows)
            setEntries(liveHabitEntryRows(entryRecords))
          })
          .catch(() => {
            // The store closed (sign-out) while the read was in flight.
          })
      }
      reload()
      const unsubscribe = store.subscribe(reload)
      return () => {
        cancelled = true
        unsubscribe()
      }
    }
  )

  createEffect(
    () => habits().length,
    (count) => {
      props.onCount?.(count)
    }
  )

  const tap = async (habit: HabitRow) => {
    const store = props.store
    if (store === undefined || busyId() !== undefined) return
    setBusyId(habit.id)
    setError(undefined)
    try {
      const row = await tapHabitEntry(store, {
        habitId: habit.id,
        localDate: props.today,
        timeZone: props.timeZone
      })
      setAnnouncement(`${habit.title}: ${habitStatusLabel(habitEntryStatusOf(row))}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ثبت عادت ناموفق بود")
    } finally {
      setBusyId(undefined)
    }
  }

  return (
    <div class="habit-lane">
      <HabitLaneStyles />
      <Show
        when={habits().length > 0}
        fallback={
          <div class="habit-lane-empty">
            <p>هنوز عادتی نساخته‌اید. یک عادت کوچک برای امروز کافی است.</p>
            <a href="/habits">ساختن عادت</a>
          </div>
        }
      >
        <div class="habit-lane-head">
          <div class="habit-lane-windows" role="group" aria-label="بازهٔ نرخ موفقیت">
            <For each={HABIT_WINDOW_DAYS}>
              {(days) => (
                <button
                  type="button"
                  aria-pressed={windowDays() === days ? "true" : "false"}
                  onClick={() => setWindowDays(days)}
                >
                  {localizeDigits(days, props.digits)} روز
                </button>
              )}
            </For>
          </div>
        </div>

        <Show when={error()}>
          <p class="habit-lane-alert" role="alert">
            {error()}
          </p>
        </Show>

        <ul class="habit-lane-list" aria-label="عادت‌های امروز">
          <For each={habits()}>
            {(habit) => {
              const entry = createMemo(() => habitEntryOn(entries(), habit.id, props.today))
              const stats = createMemo(() =>
                habitStatsFor(habit, entries(), props.today, windowDays())
              )
              const rate = createMemo(() => habitRateCopy(stats(), props.digits))
              const period = createMemo(() => habitCountingPeriodLabel(stats(), props.digits))
              return (
                <li class="habit-lane-row">
                  <div class="habit-lane-main">
                    <div class="habit-lane-title">
                      <span aria-hidden="true" style={{ color: habit.color ?? undefined }}>
                        {habit.icon ?? "•"}
                      </span>
                      <strong>{habit.title}</strong>
                      <span
                        class="habit-badge"
                        aria-label={`زنجیره: ${habitStreakLabel(stats(), props.digits)}`}
                      >
                        <span aria-hidden="true">🔥</span>
                        {habitStreakLabel(stats(), props.digits)}
                      </span>
                    </div>
                    <p class="habit-lane-meta">
                      {habitFrequencyLabel(habit.frequency, props.digits)}
                      <Show when={period()}> · {period()}</Show>
                    </p>
                  </div>
                  <div class="habit-lane-actions">
                    <button
                      type="button"
                      class="habit-tap"
                      data-status={entry()?.status ?? "blank"}
                      aria-label={`تغییر وضعیت ${habit.title}`}
                      title="هر ضربه: انجام شد → نیمه → از دست رفت"
                      disabled={props.store === undefined || busyId() !== undefined}
                      onClick={() => void tap(habit)}
                    >
                      <span aria-hidden="true">{habitStatusIcon(entry()?.status ?? null)}</span>
                      {habitStatusLabel(entry()?.status ?? null)}
                    </button>
                    <div class="habit-stat">
                      <span class="habit-stat-label">
                        نرخ {localizeDigits(windowDays(), props.digits)} روزه
                      </span>
                      <span class="habit-stat-value" data-kind={rate().kind}>
                        {rate().label}
                      </span>
                      <Show when={period()}>
                        <span class="habit-stat-note">{period()}</span>
                      </Show>
                    </div>
                  </div>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
      <p class="habit-lane-sr" role="status" aria-live="polite">
        {announcement()}
      </p>
    </div>
  )
}
