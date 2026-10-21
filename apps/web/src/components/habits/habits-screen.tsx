import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import {
  DEFAULT_TIME_ZONE,
  localizeDigits,
  toIsoDate,
  todayInTimeZone,
  type Digits,
  type HabitFrequency,
  type LocalDate
} from "@tali/domain"
import { tokens } from "@tali/ui"
import { useLocalStore } from "../../lib/local-store"
import { usePreferences } from "../../lib/preferences"
import { useAuth } from "../../lib/auth"
import { HABIT_RESTORE_REFUSED } from "../../lib/sync-engine"
import { habitEntryStatusOf, tapHabitEntry } from "../../lib/habits/log"
import {
  HABIT_COLORS,
  HABIT_ICONS,
  HABIT_WINDOW_DAYS,
  createHabitInMirror,
  deleteHabitInMirror,
  habitBadgeLabel,
  habitBestLabel,
  habitCountingPeriodLabel,
  habitEntryOn,
  habitFrequencyLabel,
  habitRateCopy,
  habitStatsFor,
  habitStatusIcon,
  habitStatusLabel,
  liveHabitEntryRows,
  liveHabitRows,
  restoreHabitInMirror,
  updateHabitInMirror,
  type HabitEntryRow,
  type HabitRow,
  type HabitWindowDays
} from "../../lib/habits/model"
import { HabitHeatmap } from "./heatmap"
import { HabitStyles } from "./ui"

/**
 * `/habits` (ticket #66; FR-HAB-01/02/03).
 *
 * One form creates and edits: the title, the frequency segmented control
 * (every day / selected weekdays / X times a week), the icon and the colour.
 * Creation and every edit are local-first (`writeLocal` commits the mirror row
 * and the outbox entry in one transaction), so the habit is in the list before
 * the network is involved; delete is a tombstone with an undo toast that
 * restores the same row, history intact.
 *
 * The badge and rate come from `habitStreak` on every render — never from a
 * stored counter — which is what lets a backfilled day grow a streak and a
 * correction lower `best` (E5, E6). The monthly heatmap paints raw statuses and
 * follows Jalali months, while the counting week stays Saturday–Friday (E15).
 */

export function HabitsScreen() {
  const local = useLocalStore()
  const preferences = usePreferences()
  const auth = useAuth()

  const [habits, setHabits] = createSignal<ReadonlyArray<HabitRow>>([])
  const [entries, setEntries] = createSignal<ReadonlyArray<HabitEntryRow>>([])
  const [pendingIds, setPendingIds] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [windowDays, setWindowDays] = createSignal<HabitWindowDays>(30)
  const [now, setNow] = createSignal(new Date().toISOString())
  const [busyId, setBusyId] = createSignal<string>()
  const [pageError, setPageError] = createSignal<string>()
  const [announcement, setAnnouncement] = createSignal("")
  const [heatId, setHeatId] = createSignal<string>()
  const [toast, setToast] = createSignal<HabitRow>()

  // Form state — one form for create and edit.
  const [editing, setEditing] = createSignal<HabitRow>()
  const [title, setTitle] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [reminderTime, setReminderTime] = createSignal("")
  const [mode, setMode] = createSignal<"daily" | "weekdays" | "weekly">("daily")
  const [days, setDays] = createSignal<ReadonlyArray<number>>([6, 1, 3])
  const [times, setTimes] = createSignal(3)
  const [icon, setIcon] = createSignal<string>("🌱")
  const [color, setColor] = createSignal<string>(tokens.color.brand)
  const [formBusy, setFormBusy] = createSignal(false)
  const [formError, setFormError] = createSignal<string>()

  let titleRef: HTMLInputElement | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined

  const digits = (): Digits => preferences.preferences().digits
  const weekStart = () => preferences.preferences().weekStart
  const timeZone = () => {
    const zone = preferences.preferences().timeZone
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone })
      return zone
    } catch {
      return DEFAULT_TIME_ZONE
    }
  }
  const today = (): LocalDate => {
    // Read the clock signal so a screen left open past midnight rolls over.
    void now()
    return toIsoDate(todayInTimeZone(timeZone())) as LocalDate
  }

  // Re-evaluate "today" while the screen stays open across midnight.
  createEffect(
    () => null,
    () => {
      const timer = setInterval(() => setNow(new Date().toISOString()), 60_000)
      return () => clearInterval(timer)
    }
  )
  onCleanup(() => clearTimeout(toastTimer))

  createEffect(
    () => local.store(),
    (store) => {
      if (store === undefined) {
        setHabits([])
        setEntries([])
        setPendingIds(new Set<string>())
        return
      }
      let cancelled = false
      const reload = () => {
        void Promise.all([
          store.list("habit"),
          store.list("habitEntry"),
          store.pending()
        ])
          .then(([habitRecords, entryRecords, queued]) => {
            if (cancelled) return
            setHabits(liveHabitRows(habitRecords))
            setEntries(liveHabitEntryRows(entryRecords))
            const pending = new Set<string>()
            for (const entry of queued) pending.add(entry.entityId)
            setPendingIds(pending)
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

  // A permanent restore refusal drops the queued undo (it can never succeed),
  // so the habit quietly disappears again on the next pull unless we say so.
  createEffect(
    () => local.error(),
    (error) => {
      if (error !== undefined && error.startsWith(HABIT_RESTORE_REFUSED)) {
        setPageError("بازگردانی عادت انجام نشد؛ ممکن است حذف آن قطعی شده باشد.")
      }
    }
  )

  const frequency = (): HabitFrequency => {
    switch (mode()) {
      case "daily":
        return { _tag: "daily" }
      case "weekdays":
        return { _tag: "weekdays", days: [...days()].sort((left, right) => left - right) }
      case "weekly":
        return { _tag: "weekly", times: times() }
    }
  }

  const resetForm = () => {
    setEditing(undefined)
    setTitle("")
    setDescription("")
    setReminderTime("")
    setMode("daily")
    setDays([6, 1, 3])
    setTimes(3)
    setIcon("🌱")
    setColor(tokens.color.brand)
    setFormError(undefined)
  }

  const beginEdit = (habit: HabitRow) => {
    setEditing(habit)
    setTitle(habit.title)
    setDescription(habit.description ?? "")
    setReminderTime(habit.reminderTime ?? "")
    setMode(habit.frequency._tag)
    if (habit.frequency._tag === "weekdays") setDays([...habit.frequency.days])
    if (habit.frequency._tag === "weekly") setTimes(habit.frequency.times)
    setIcon(habit.icon ?? "🌱")
    setColor(habit.color ?? tokens.color.brand)
    setFormError(undefined)
    titleRef?.focus()
  }

  const toggleDay = (iso: number) => {
    setDays((current) => {
      if (current.includes(iso)) {
        // "Never on any day" is a deleted habit, not a frequency.
        return current.length === 1 ? current : current.filter((day) => day !== iso)
      }
      return [...current, iso]
    })
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const store = local.store()
    const value = title().trim()
    if (store === undefined || value === "" || formBusy()) return
    setFormBusy(true)
    setFormError(undefined)
    try {
      const current = editing()
      if (current !== undefined) {
        await updateHabitInMirror(store, current, {
          title: value,
          description: description().trim() === "" ? null : description().trim(),
          reminderTime: reminderTime() === "" ? null : reminderTime(),
          icon: icon(),
          color: color(),
          frequency: frequency()
        })
        setAnnouncement(`عادت به‌روز شد: ${value}`)
      } else {
        await createHabitInMirror(store, {
          title: value,
          description: description().trim() === "" ? null : description().trim(),
          reminderTime: reminderTime() === "" ? null : reminderTime(),
          frequency: frequency(),
          icon: icon(),
          color: color(),
          timeZone: timeZone()
        })
        setAnnouncement(`عادت تازه: ${value}`)
      }
      resetForm()
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "ذخیرهٔ عادت ناموفق بود")
    } finally {
      setFormBusy(false)
    }
  }

  const tap = async (habit: HabitRow) => {
    const store = local.store()
    if (store === undefined || busyId() !== undefined) return
    setBusyId(habit.id)
    setPageError(undefined)
    try {
      const row = await tapHabitEntry(store, {
        habitId: habit.id,
        localDate: today(),
        timeZone: timeZone()
      })
      setAnnouncement(`${habit.title}: ${habitStatusLabel(habitEntryStatusOf(row))}`)
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : "ثبت عادت ناموفق بود")
    } finally {
      setBusyId(undefined)
    }
  }

  const remove = async (habit: HabitRow) => {
    const store = local.store()
    if (store === undefined) return
    const confirmed =
      typeof window === "undefined" || window.confirm(`عادت «${habit.title}» حذف شود؟`)
    if (!confirmed) return
    setPageError(undefined)
    try {
      await deleteHabitInMirror(store, habit.id)
      if (heatId() === habit.id) setHeatId(undefined)
      if (editing()?.id === habit.id) resetForm()
      clearTimeout(toastTimer)
      setToast(habit)
      toastTimer = setTimeout(() => setToast(undefined), 8_000)
      setAnnouncement(`حذف شد: ${habit.title}`)
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : "حذف عادت ناموفق بود")
    }
  }

  const undoDelete = async () => {
    const store = local.store()
    const habit = toast()
    if (store === undefined || habit === undefined) return
    clearTimeout(toastTimer)
    setToast(undefined)
    try {
      await restoreHabitInMirror(store, habit.id)
      setAnnouncement(`بازگردانی شد: ${habit.title}`)
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : "بازگردانی عادت ناموفق بود")
    }
  }

  const toggleHeat = (habit: HabitRow) =>
    setHeatId((current) => (current === habit.id ? undefined : habit.id))

  const icons = (): ReadonlyArray<string> => {
    const current = editing()?.icon
    return current !== undefined && current !== null && !HABIT_ICONS.includes(current)
      ? [current, ...HABIT_ICONS]
      : HABIT_ICONS
  }

  const pending = (id: string): boolean => pendingIds().has(id)

  return (
    <div class="habits-root" dir="rtl" lang="fa" style={{ display: "grid", gap: "10px" }}>
      <HabitStyles />

      <header class="habits-head">
        <div>
          <h1>عادت‌ها</h1>
          <p>یک عادت، یک تعریف و یک ثبت روزانه. آمار از ثبت‌ها ساخته می‌شود، نه از حافظه.</p>
        </div>
        <Show when={local.store() !== undefined && auth.session() !== undefined}>
          <p class="habits-source" role="status">
            {!local.online()
              ? "آفلاین — نمایش از حافظهٔ محلی"
              : pendingIds().size > 0
                ? `${localizeDigits(pendingIds().size, digits())} تغییر در انتظار همگام‌سازی`
                : "همه‌چیز روی این دستگاه ذخیره شده است"}
          </p>
        </Show>
      </header>

      <form class="habits-form" aria-label="فرم عادت" onSubmit={(event) => void submit(event)}>
        <h2>{editing() === undefined ? "عادت تازه" : `ویرایش «${editing()!.title}»`}</h2>

        <label class="habits-field">
          <span class="habits-label">عنوان</span>
          <input
            ref={(element) => (titleRef = element)}
            class="habits-input"
            type="text"
            aria-label="عنوان عادت"
            placeholder="مثلاً کتاب خواندن"
            value={title()}
            disabled={local.store() === undefined || formBusy()}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
        </label>

        <label class="habits-field">
          <span class="habits-label">توضیح (اختیاری)</span>
          <textarea
            class="habits-input"
            aria-label="توضیح عادت"
            rows={2}
            value={description()}
            disabled={local.store() === undefined || formBusy()}
            onInput={(event) => setDescription(event.currentTarget.value)}
          />
        </label>

        <div class="habits-field">
          <span class="habits-label" id="habit-frequency-label">
            فراوانی
          </span>
          <div class="habits-seg" role="group" aria-labelledby="habit-frequency-label">
            <button
              type="button"
              aria-pressed={mode() === "daily" ? "true" : "false"}
              onClick={() => setMode("daily")}
            >
              هر روز
            </button>
            <button
              type="button"
              aria-pressed={mode() === "weekdays" ? "true" : "false"}
              onClick={() => setMode("weekdays")}
            >
              روزهای هفته
            </button>
            <button
              type="button"
              aria-pressed={mode() === "weekly" ? "true" : "false"}
              onClick={() => setMode("weekly")}
            >
              {localizeDigits(times(), digits())} بار در هفته
            </button>
          </div>
        </div>

        <Show when={mode() === "weekdays"}>
          <div class="habits-field">
            <span class="habits-label">روزها</span>
            <div class="habits-days" role="group" aria-label="روزهای هفته">
              <For each={[6, 7, 1, 2, 3, 4, 5]}>
                {(iso) => (
                  <button
                    type="button"
                    class="habits-day"
                    aria-label={habitFrequencyLabel({ _tag: "weekdays", days: [iso] }, "latin")}
                    aria-pressed={days().includes(iso) ? "true" : "false"}
                    onClick={() => toggleDay(iso)}
                  >
                    {habitFrequencyLabel({ _tag: "weekdays", days: [iso] }, digits()).slice(0, 1)}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={mode() === "weekly"}>
          <div class="habits-field">
            <span class="habits-label">تعداد در هفته</span>
            <div class="habits-times" role="group" aria-label="تعداد در هفته">
              <button
                type="button"
                aria-label="کاهش تعداد"
                disabled={times() <= 1}
                onClick={() => setTimes((value) => Math.max(1, value - 1))}
              >
                −
              </button>
              <output aria-live="polite">{localizeDigits(times(), digits())}</output>
              <button
                type="button"
                aria-label="افزایش تعداد"
                disabled={times() >= 7}
                onClick={() => setTimes((value) => Math.min(7, value + 1))}
              >
                +
              </button>
            </div>
          </div>
        </Show>

        <label class="habits-field">
          <span class="habits-label">زمان یادآوری (اختیاری)</span>
          <div style={{ display: "flex", gap: "6px", "align-items": "center", "flex-wrap": "wrap" }}>
            <input
              class="habits-input"
              type="time"
              aria-label="زمان یادآوری عادت"
              value={reminderTime()}
              disabled={local.store() === undefined || formBusy()}
              style={{ "max-width": "160px" }}
              onInput={(event) => setReminderTime(event.currentTarget.value)}
            />
            <Show when={reminderTime() !== ""}>
              <button type="button" class="habit-action" onClick={() => setReminderTime("")}>
                حذف یادآور
              </button>
            </Show>
          </div>
        </label>

        <div class="habits-field">
          <span class="habits-label">نشان</span>
          <div class="habits-icons" role="group" aria-label="نشان عادت">
            <For each={icons()}>
              {(value) => (
                <button
                  type="button"
                  class="habits-icon"
                  aria-label={`نشان ${value}`}
                  aria-pressed={icon() === value ? "true" : "false"}
                  onClick={() => setIcon(value)}
                >
                  {value}
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="habits-field">
          <span class="habits-label">رنگ</span>
          <div class="habits-swatches" role="group" aria-label="رنگ عادت">
            <For each={HABIT_COLORS}>
              {(entry) => (
                <button
                  type="button"
                  class="habits-swatch"
                  aria-label={`رنگ ${entry.label}`}
                  aria-pressed={color() === entry.value ? "true" : "false"}
                  style={{ background: entry.value }}
                  onClick={() => setColor(entry.value)}
                />
              )}
            </For>
          </div>
        </div>

        <Show when={formError()}>
          <p class="habits-alert" role="alert">
            {formError()}
          </p>
        </Show>

        <div class="habits-form-actions">
          <button
            type="submit"
            class="habits-primary"
            disabled={local.store() === undefined || formBusy() || title().trim() === ""}
          >
            {editing() === undefined ? "افزودن عادت" : "ذخیرهٔ عادت"}
          </button>
          <Show when={editing() !== undefined}>
            <button type="button" class="habits-ghost" onClick={resetForm}>
              انصراف
            </button>
          </Show>
        </div>
      </form>

      <Show when={pageError()}>
        <p class="habits-alert" role="alert">
          {pageError()}
        </p>
      </Show>

      <div class="habits-head">
        <div>
          <h2 style={{ margin: 0, "font-size": "1rem" }}>فهرست عادت‌ها</h2>
          <p>با هر ضربه وضعیت امروز می‌چرخد: انجام شد → نیمه → از دست رفت.</p>
        </div>
        <div class="habit-lane-windows" role="group" aria-label="بازهٔ نرخ موفقیت">
          <For each={HABIT_WINDOW_DAYS}>
            {(days) => (
              <button
                type="button"
                aria-pressed={windowDays() === days ? "true" : "false"}
                onClick={() => setWindowDays(days)}
              >
                {localizeDigits(days, digits())} روز
              </button>
            )}
          </For>
        </div>
      </div>

      <Show
        when={habits().length > 0}
        fallback={
          <div class="habits-form">
            <p class="habits-label">
              هنوز عادتی ندارید. عنوان را بنویسید و «افزودن عادت» را بزنید؛ همین یک
              فرم کافی است.
            </p>
          </div>
        }
      >
        <ul class="habits-list" aria-label="عادت‌ها">
          <For each={habits()}>
            {(habit) => {
              const entry = createMemo(() => habitEntryOn(entries(), habit.id, today()))
              const stats = createMemo(() =>
                habitStatsFor(habit, entries(), today(), windowDays())
              )
              const rate = createMemo(() => habitRateCopy(stats(), digits()))
              const period = createMemo(() => habitCountingPeriodLabel(stats(), digits()))
              return (
                <li
                  class="habit-card"
                  style={{ "border-inline-start-color": habit.color ?? tokens.color.brand }}
                >
                  <div class="habit-card-head">
                    <span class="habit-mark" aria-hidden="true">
                      {habit.icon ?? "•"}
                    </span>
                    <h3>{habit.title}</h3>
                    <span
                      class="habit-badge"
                      aria-label={`زنجیره: ${habitBadgeLabel(stats(), digits())}`}
                    >
                      <span aria-hidden="true">🔥</span>
                      {habitBadgeLabel(stats(), digits())}
                    </span>
                    <Show when={pending(habit.id)}>
                      <span class="habit-action" aria-label="در انتظار همگام‌سازی">
                        در انتظار
                      </span>
                    </Show>
                  </div>

                  <Show when={habit.description !== null}>
                    <p class="habit-meta">{habit.description}</p>
                  </Show>

                  <p class="habit-meta">
                    {habitFrequencyLabel(habit.frequency, digits())} ·{" "}
                    {habitBestLabel(stats(), digits())}
                    <Show when={period()}> · دورهٔ شمارش: {period()}</Show>
                    <Show when={habit.reminderTime !== null}>
                      {" "}· یادآور {localizeDigits(habit.reminderTime!, digits())}
                    </Show>
                  </p>

                  <div class="habit-actions">
                    <button
                      type="button"
                      class="habit-tap"
                      data-status={entry()?.status ?? "blank"}
                      aria-label={`تغییر وضعیت امروز ${habit.title}`}
                      title="هر ضربه: انجام شد → نیمه → از دست رفت"
                      disabled={local.store() === undefined || busyId() !== undefined}
                      onClick={() => void tap(habit)}
                    >
                      <span aria-hidden="true">{habitStatusIcon(entry()?.status ?? null)}</span>
                      {habitStatusLabel(entry()?.status ?? null)}
                    </button>
                    <div class="habit-stat">
                      <span class="habit-stat-label">
                        نرخ {localizeDigits(windowDays(), digits())} روزه
                      </span>
                      <span class="habit-stat-value" data-kind={rate().kind}>
                        {rate().label}
                      </span>
                    </div>
                  </div>

                  <div class="habit-actions">
                    <button
                      type="button"
                      class="habit-action"
                      aria-label={`ویرایش ${habit.title}`}
                      onClick={() => beginEdit(habit)}
                    >
                      ویرایش
                    </button>
                    <button
                      type="button"
                      class="habit-action"
                      aria-label={`نقشه ماه ${habit.title}`}
                      aria-pressed={heatId() === habit.id ? "true" : "false"}
                      onClick={() => toggleHeat(habit)}
                    >
                      نقشهٔ ماه
                    </button>
                    <button
                      type="button"
                      class="habit-action habit-action--danger"
                      aria-label={`حذف ${habit.title}`}
                      onClick={() => void remove(habit)}
                    >
                      حذف
                    </button>
                  </div>

                  <Show when={heatId() === habit.id}>
                    <HabitHeatmap
                      habit={habit}
                      entries={entries()}
                      today={today()}
                      digits={digits()}
                      weekStart={weekStart()}
                    />
                  </Show>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>

      <p class="habits-sr" role="status" aria-live="polite">
        {announcement()}
      </p>

      <Show when={toast()}>
        {(habit) => (
          <div class="habits-toast" role="status">
            <span>«{habit().title}» حذف شد.</span>
            <button type="button" onClick={() => void undoDelete()}>
              بازگردانی
            </button>
          </div>
        )}
      </Show>
    </div>
  )
}
