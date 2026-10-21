import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack
} from "solid-js"
import {
  JALALI_MONTHS,
  JALALI_WEEKDAYS,
  localizeDigits,
  toJalaliDate,
  type CalendarTaskItem,
  type Digits,
  type MonthReadModel,
  type WeekReadModel
} from "@tali/domain"
import { usePreferences } from "../../lib/preferences"
import { useLocalStore } from "../../lib/local-store"
import type { MirrorRecord } from "../../lib/local-store"
import { weekDaysFor } from "../../lib/preferences-format"
import {
  completeTaskInMirror,
  createTaskInMirror,
  moveTaskInMirror,
  updateTaskInMirror
} from "../../lib/tasks/model"
import { fetchMonth, fetchWeek } from "../../lib/calendar/api"
import {
  PRIORITY_LABELS,
  dayLabel,
  emptyDayCopy,
  emptyWeekCopy,
  jalaliDayNumber,
  monthDayLabel,
  monthFromMirror,
  monthFromSources,
  monthTitle,
  overlayCalendarSources,
  shiftDay,
  shiftMonth,
  taskCountLabel,
  todayIn,
  weekFromMirror,
  weekFromSources,
  weekTitle
} from "../../lib/calendar/model"
import { CALENDAR_MAIN } from "./ui"

/**
 * The week/month screen (ticket #43; FR-VIEW-02/03).
 *
 * Online, `GET /week` / `GET /month` paint the calendar with ETag
 * revalidation; while the outbox holds a write (or the API is unreachable) the
 * same domain builders project the IndexedDB mirror, so the grid never blanks.
 * Every inline action is local-first: quick add, complete, reprioritise and
 * move all go through the #37 mirror helpers first and sync afterwards.
 *
 * Weekly planning is a review-and-prioritise workflow, not a second data model:
 * it lists the week's real rows, sets their priority and shifts them a day at a
 * time. Projected recurrence occurrences are visibly read-only everywhere.
 */

type CalendarViewName = "week" | "month"
type FetchState = "idle" | "ready" | "offline" | "error"

const SOURCE_HINT: Readonly<Record<string, string>> = {
  offline: "آفلاین — نمایش از حافظهٔ محلی",
  error: "ارتباط با سرور برقرار نشد؛ نمایش از حافظهٔ محلی"
}

const WEEKDAY_BY_ISO = JALALI_WEEKDAYS

const isPriority = (value: string): value is keyof typeof PRIORITY_LABELS =>
  value === "high" || value === "medium" || value === "low"

export function CalendarScreen() {
  const preferences = usePreferences()
  const local = useLocalStore()

  const [view, setView] = createSignal<CalendarViewName>("week")
  const [anchor, setAnchor] = createSignal<string>(
    todayIn(preferences.preferences().timeZone)
  )
  const [selectedDay, setSelectedDay] = createSignal<string>()
  const [planning, setPlanning] = createSignal(false)
  const [mirrorTasks, setMirrorTasks] = createSignal<ReadonlyArray<MirrorRecord>>([])
  const [pendingIds, setPendingIds] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [dirtyKeys, setDirtyKeys] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [serverWeek, setServerWeek] = createSignal<WeekReadModel>()
  const [serverWeekEtag, setServerWeekEtag] = createSignal<string>()
  const [serverMonth, setServerMonth] = createSignal<MonthReadModel>()
  const [serverMonthEtag, setServerMonthEtag] = createSignal<string>()
  const [fetchState, setFetchState] = createSignal<FetchState>("idle")
  const [drafts, setDrafts] = createSignal<Readonly<Record<string, string>>>({})
  const [busyKey, setBusyKey] = createSignal<string>()
  const [pageError, setPageError] = createSignal<string>()
  const [announcement, setAnnouncement] = createSignal("")

  let refreshGeneration = 0

  const digits = createMemo<Digits>(() => preferences.preferences().digits)
  const weekStart = createMemo(() => preferences.preferences().weekStart)
  const timeZone = createMemo((): string => {
    const zone = preferences.preferences().timeZone
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone })
      return zone
    } catch {
      return "Asia/Tehran"
    }
  })
  const today = createMemo(() => todayIn(timeZone()))

  const mirrorWeek = createMemo<WeekReadModel>(() =>
    weekFromMirror({
      tasks: mirrorTasks(),
      anchor: anchor(),
      weekStart: weekStart(),
      timeZone: timeZone()
    })
  )

  const mirrorMonth = createMemo<MonthReadModel>(() =>
    monthFromMirror({
      tasks: mirrorTasks(),
      anchor: anchor(),
      weekStart: weekStart(),
      timeZone: timeZone(),
      day: selectedDay()
    })
  )

  /**
   * Prefer the server snapshot only while it still describes the visible
   * window. Local writes the snapshot has not seen yet are overlaid on its
   * source rows and re-projected with the same domain builders, so a quick add,
   * completion, move or priority never blanks server-only tasks.
   */
  const overlayIds = () => new Set<string>([...pendingIds(), ...dirtyKeys()])

  const weekHasServer = (): boolean => {
    const model = serverWeek()
    const localModel = mirrorWeek()
    return (
      model !== undefined &&
      local.online() &&
      model.weekStart === weekStart() &&
      model.start === localModel.start
    )
  }

  const week = createMemo<WeekReadModel>(() => {
    const model = serverWeek()
    if (!weekHasServer() || model === undefined) return mirrorWeek()
    const ids = overlayIds()
    if (ids.size === 0) return model
    return weekFromSources({
      tasks: overlayCalendarSources({
        base: model.tasks,
        mirror: mirrorTasks(),
        overlayIds: ids
      }),
      anchor: model.start,
      weekStart: model.weekStart,
      timeZone: model.timeZone
    })
  })

  const monthHasServer = (): boolean => {
    const model = serverMonth()
    const localModel = mirrorMonth()
    return (
      model !== undefined &&
      local.online() &&
      model.weekStart === weekStart() &&
      model.year === localModel.year &&
      model.month === localModel.month
    )
  }

  const month = createMemo<MonthReadModel>(() => {
    const model = serverMonth()
    if (!monthHasServer() || model === undefined) return mirrorMonth()
    const ids = overlayIds()
    if (ids.size === 0 && (model.day?.date ?? undefined) === selectedDay()) return model
    return monthFromSources({
      tasks: overlayCalendarSources({
        base: model.tasks,
        mirror: mirrorTasks(),
        overlayIds: ids
      }),
      year: model.year,
      month: model.month,
      weekStart: model.weekStart,
      timeZone: model.timeZone,
      day: selectedDay() ?? null
    })
  })

  const source = createMemo<"server" | "mirror">(() =>
    view() === "week" ? (weekHasServer() ? "server" : "mirror") : monthHasServer() ? "server" : "mirror"
  )

  // Refresh mirror rows: `subscribe` fires after local writes and server acks,
  // which is how an offline action updates the grid.
  createEffect(
    () => local.store(),
    (store) => {
      if (store === undefined) {
        setMirrorTasks([])
        return
      }
      let cancelled = false
      const reload = () => {
        void Promise.all([store.list("task"), store.pending()])
          .then(([tasks, queued]) => {
            if (cancelled) return
            setMirrorTasks(tasks)
            setPendingIds(
              new Set(
                queued
                  .filter((entry) => entry.entityType === "task")
                  .map((entry) => entry.entityId)
              )
            )
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

  const markDirty = (id: string) => {
    setDirtyKeys((current) => new Set([...current, id]))
  }

  const clearDirty = (ids: ReadonlySet<string>) => {
    if (ids.size === 0) return
    setDirtyKeys((current) => {
      const next = new Set(current)
      for (const id of ids) next.delete(id)
      return next
    })
  }

  const refreshWeek = async (inFlightDirty: ReadonlySet<string>): Promise<void> => {
    const ticket = ++refreshGeneration
    const result = await fetchWeek(untrack(anchor), untrack(serverWeekEtag))
    if (ticket !== refreshGeneration) return
    if (!untrack(() => local.online() && local.pending() === 0)) return
    if (!result.ok) {
      setServerWeek(undefined)
      setFetchState(result.error.code === "Network" ? "offline" : "error")
      return
    }
    if (result.notModified) {
      setFetchState("ready")
      return
    }
    setServerWeek(result.model)
    setServerWeekEtag(result.etag)
    setFetchState("ready")
    clearDirty(inFlightDirty)
  }

  const refreshMonth = async (inFlightDirty: ReadonlySet<string>): Promise<void> => {
    const ticket = ++refreshGeneration
    const result = await fetchMonth(
      untrack(anchor),
      untrack(selectedDay),
      untrack(serverMonthEtag)
    )
    if (ticket !== refreshGeneration) return
    if (!untrack(() => local.online() && local.pending() === 0)) return
    if (!result.ok) {
      setServerMonth(undefined)
      setFetchState(result.error.code === "Network" ? "offline" : "error")
      return
    }
    if (result.notModified) {
      setFetchState("ready")
      return
    }
    setServerMonth(result.model)
    setServerMonthEtag(result.etag)
    setFetchState("ready")
    clearDirty(inFlightDirty)
  }

  // Revalidate on boot, reconnect, view/window changes and an empty outbox.
  createEffect(
    () => ({
      online: local.online(),
      pending: local.pending(),
      view: view(),
      anchor: anchor(),
      day: selectedDay(),
      dirty: dirtyKeys().size
    }),
    (state) => {
      if (!state.online) {
        setServerWeek(undefined)
        setServerMonth(undefined)
        setFetchState("offline")
        return
      }
      if (state.pending > 0) {
        setFetchState("idle")
        return
      }
      const inFlightDirty = untrack(dirtyKeys)
      if (state.view === "week") void refreshWeek(inFlightDirty)
      else void refreshMonth(inFlightDirty)
    }
  )

  // Keep a shared item current while the screen stays open.
  createEffect(
    () => null,
    () => {
      const poll = setInterval(() => {
        const state = untrack(() => ({
          online: local.online(),
          pending: local.pending(),
          view: view()
        }))
        if (!state.online || state.pending > 0) return
        const inFlightDirty = untrack(dirtyKeys)
        if (state.view === "week") void refreshWeek(inFlightDirty)
        else void refreshMonth(inFlightDirty)
      }, 60_000)
      return () => clearInterval(poll)
    }
  )

  onCleanup(() => {
    refreshGeneration += 1
  })

  const updateDraft = (date: string, value: string) => {
    setDrafts((current) => ({ ...current, [date]: value }))
  }

  const reportError = (cause: unknown) => {
    setPageError(
      cause instanceof Error ? cause.message : "ذخیره در حافظه‌ی محلی ناموفق بود"
    )
  }

  const addTask = async (date: string, event: SubmitEvent) => {
    event.preventDefault()
    const store = local.store()
    const title = (drafts()[date] ?? "").trim()
    if (store === undefined || title === "" || busyKey() === `add:${date}`) return
    setBusyKey(`add:${date}`)
    setPageError(undefined)
    try {
      const id = await createTaskInMirror(store, {
        title,
        dueDate: date,
        priority: "medium",
        projectId: null,
        tagIds: [],
        timeZone: timeZone()
      })
      markDirty(id)
      updateDraft(date, "")
      setAnnouncement(`کار تازه برای ${dayLabel(date, digits())}: ${title}`)
    } catch (cause) {
      reportError(cause)
    } finally {
      setBusyKey(undefined)
    }
  }

  const complete = async (item: CalendarTaskItem) => {
    const store = local.store()
    if (store === undefined || item.projected) return
    setBusyKey(`done:${item.key}`)
    setPageError(undefined)
    try {
      await completeTaskInMirror(store, item.id)
      markDirty(item.id)
      setAnnouncement(`انجام شد: ${item.title}`)
    } catch (cause) {
      reportError(cause)
    } finally {
      setBusyKey(undefined)
    }
  }

  const prioritize = async (item: CalendarTaskItem, priority: string) => {
    const store = local.store()
    if (store === undefined || item.projected || !isPriority(priority)) return
    if (item.priority === priority) return
    try {
      await updateTaskInMirror(store, item.id, { priority })
      markDirty(item.id)
      setAnnouncement(`اولویت ${item.title}: ${PRIORITY_LABELS[priority]}`)
    } catch (cause) {
      reportError(cause)
    }
  }

  const moveByDay = async (item: CalendarTaskItem, day: string, days: number) => {
    const store = local.store()
    if (store === undefined || item.projected) return
    const target = shiftDay(day, days)
    try {
      await moveTaskInMirror(store, item.id, target, timeZone())
      markDirty(item.id)
      setAnnouncement(`${item.title} به ${dayLabel(target, digits())} منتقل شد`)
    } catch (cause) {
      reportError(cause)
    }
  }

  const quickAdd = (date: string, label: string) => (
    <form class="calendar-quick" onSubmit={(event) => void addTask(date, event)}>
      <input
        aria-label={`کار تازه برای ${label}`}
        placeholder="کار تازه…"
        value={drafts()[date] ?? ""}
        onInput={(event) => updateDraft(date, event.currentTarget.value)}
        disabled={local.store() === undefined}
      />
      <button
        type="submit"
        disabled={
          local.store() === undefined ||
          busyKey() === `add:${date}` ||
          (drafts()[date] ?? "").trim() === ""
        }
      >
        افزودن
      </button>
    </form>
  )

  const taskRow = (item: CalendarTaskItem) => (
    <li class="calendar-task" data-priority={item.priority} data-projected={item.projected ? "true" : undefined}>
      <Show
        when={!item.projected}
        fallback={<span aria-hidden="true" class="calendar-task-check">↻</span>}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked="false"
          class="calendar-task-check"
          aria-label={`انجام ${item.title}`}
          disabled={local.store() === undefined || busyKey() === `done:${item.key}`}
          onClick={() => void complete(item)}
        >
          ✓
        </button>
      </Show>
      <div class="calendar-task-body">
        <Show
          when={!item.projected}
          fallback={
            <span class="calendar-task-title">{item.title}</span>
          }
        >
          <a class="calendar-task-title" href={`/tasks#task-${item.id}`}>
            {item.title}
          </a>
        </Show>
        <Show when={item.projected}>
          <span class="calendar-task-badge">تکرارشونده — فقط نمایش</span>
        </Show>
        <Show when={item.priority === "high" && !item.projected}>
          <span class="calendar-task-badge">اولویت بالا</span>
        </Show>
      </div>
    </li>
  )

  const lanes = () => (
    <ul class="calendar-lanes" aria-label="مسیرهای دیگر">
      <li class="calendar-lane" data-lane="events">رویداد — خالی</li>
      <li class="calendar-lane" data-lane="reminders">یادآوری — خالی</li>
      <li class="calendar-lane" data-lane="habits">عادت — خالی</li>
    </ul>
  )

  const weekDayCard = (day: WeekReadModel["days"][number]) => {
    const label = dayLabel(day.date, digits())
    const isToday = day.date === today()
    const weekday = WEEKDAY_BY_ISO[toJalaliDate(day.date).withCalendar("iso8601").dayOfWeek - 1] ?? ""
    return (
      <section
        class="calendar-day-card"
        data-today={isToday ? "true" : undefined}
        aria-label={label}
        aria-current={isToday ? "date" : undefined}
      >
        <header class="calendar-day-head">
          <span class="calendar-day-name">{weekday}</span>
          <span>
            <span class="calendar-day-number">{jalaliDayNumber(day.date, digits())}</span>{" "}
            <span class="calendar-day-month">
              {JALALI_MONTHS[toJalaliDate(day.date).month - 1] ?? ""}
            </span>
          </span>
        </header>

        {quickAdd(day.date, label)}

        <Show when={day.tasks.length > 0} fallback={<p class="calendar-empty">{emptyDayCopy}</p>}>
          <ul class="calendar-tasks" aria-label={`کارهای ${label}`}>
            <For each={day.tasks}>{(item) => taskRow(item)}</For>
          </ul>
        </Show>
        {lanes()}
      </section>
    )
  }

  const planGroups = () =>
    week().days
      .map((day) => ({
        date: day.date,
        items: day.tasks.filter((item) => !item.projected)
      }))
      .filter((group) => group.items.length > 0)

  const planningPanel = () => {
    return (
      <section class="calendar-planning" aria-label="برنامه‌ریزی هفته">
        <h2>برنامه‌ریزی هفته</h2>
        <p class="calendar-planning-hint">
          هفته را مرور کنید: اولویت هر کار را تعیین کنید یا آن را یک روز جابه‌جا
          کنید. کارهای تکرارشونده فقط نمایشی‌اند.
        </p>
        <Show
          when={planGroups().length > 0}
          fallback={<p class="calendar-empty">{emptyWeekCopy}</p>}
        >
          <For each={planGroups()}>
            {(group) => (
              <div class="calendar-plan-day">
                <p class="calendar-plan-date">{dayLabel(group.date, digits())}</p>
                <ul class="calendar-plan-list">
                  <For each={group.items}>
                    {(item) => (
                      <li class="calendar-plan-row">
                        <span class="calendar-plan-title">{item.title}</span>
                        <span class="calendar-plan-controls">
                          <select
                            aria-label={`اولویت ${item.title}`}
                            value={item.priority}
                            disabled={local.store() === undefined}
                            onChange={(event) =>
                              void prioritize(item, event.currentTarget.value)
                            }
                          >
                            <option value="high">بالا</option>
                            <option value="medium">متوسط</option>
                            <option value="low">پایین</option>
                          </select>
                          <button
                            type="button"
                            class="calendar-plan-move"
                            aria-label={`یک روز قبل ${item.title}`}
                            disabled={
                              local.store() === undefined || group.date <= week().start
                            }
                            onClick={() => void moveByDay(item, group.date, -1)}
                          >
                            ← روز
                          </button>
                          <button
                            type="button"
                            class="calendar-plan-move"
                            aria-label={`یک روز بعد ${item.title}`}
                            disabled={
                              local.store() === undefined || group.date >= week().end
                            }
                            onClick={() => void moveByDay(item, group.date, 1)}
                          >
                            روز →
                          </button>
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            )}
          </For>
        </Show>
      </section>
    )
  }

  const dayDetail = () => {
    const detail = month().day
    if (detail === null || selectedDay() === undefined) return null
    const label = monthDayLabel(detail.date, digits())
    return (
      <section class="calendar-detail" aria-label="جزئیات روز">
        <header class="calendar-detail-head">
          <h2>{label}</h2>
          <div class="calendar-detail-actions">
            <button
              type="button"
              class="calendar-nav-button"
              onClick={() => {
                const current = month().day
                if (current !== null) openWeekForDay(current.date)
              }}
            >
              دیدن در نمای هفته
            </button>
            <button
              type="button"
              class="calendar-nav-button"
              aria-label="بستن جزئیات روز"
              onClick={() => setSelectedDay(undefined)}
            >
              بستن
            </button>
          </div>
        </header>

        {quickAdd(detail.date, label)}

        <Show
          when={detail.tasks.length > 0}
          fallback={<p class="calendar-empty">{emptyDayCopy}</p>}
        >
          <ul class="calendar-tasks" aria-label={`کارهای ${label}`}>
            <For each={detail.tasks}>{(item) => taskRow(item)}</For>
          </ul>
        </Show>
      </section>
    )
  }

  const openWeekForDay = (date: string) => {
    setAnchor(date)
    setSelectedDay(undefined)
    setPlanning(false)
    setView("week")
  }

  const weekNavigation = () => (
    <div class="calendar-nav">
      <button
        type="button"
        class="calendar-nav-button"
        aria-label="هفتهٔ قبل"
        onClick={() => setAnchor(shiftDay(week().start, -7))}
      >
        →
      </button>
      <p class="calendar-nav-title">{weekTitle(week().start, week().end, digits())}</p>
      <button
        type="button"
        class="calendar-nav-button"
        aria-label="هفتهٔ بعد"
        onClick={() => setAnchor(shiftDay(week().start, 7))}
      >
        ←
      </button>
      <button
        type="button"
        class="calendar-nav-button"
        onClick={() => setAnchor(today())}
      >
        امروز
      </button>
    </div>
  )

  const monthNavigation = () => (
    <div class="calendar-nav">
      <button
        type="button"
        class="calendar-nav-button"
        aria-label="ماه قبل"
        onClick={() => {
          setSelectedDay(undefined)
          setAnchor((current) => shiftMonth(current, -1))
        }}
      >
        →
      </button>
      <p class="calendar-nav-title">{monthTitle(anchor(), digits())}</p>
      <button
        type="button"
        class="calendar-nav-button"
        aria-label="ماه بعد"
        onClick={() => {
          setSelectedDay(undefined)
          setAnchor((current) => shiftMonth(current, 1))
        }}
      >
        ←
      </button>
      <button
        type="button"
        class="calendar-nav-button"
        onClick={() => {
          setSelectedDay(undefined)
          setAnchor(today())
        }}
      >
        امروز
      </button>
    </div>
  )

  const monthWeekdays = createMemo(() =>
    weekDaysFor(
      toJalaliDate(anchor()),
      preferences.preferences()
    )
  )

  const monthGrid = () => {
    const model = month()
    return (
      <>
        <div class="calendar-month-head" role="row">
          <For each={monthWeekdays()}>
            {(day) => (
              <div class="calendar-month-weekday" role="columnheader" aria-label={day.weekday}>
                <span aria-hidden="true">{day.shortWeekday}</span>
              </div>
            )}
          </For>
        </div>
        <ol class="calendar-month" aria-label={monthTitle(anchor(), digits())}>
          <For each={model.days}>
            {(cell) => {
              const isToday = cell.date === today()
              const label = `${dayLabel(cell.date, digits())} — ${taskCountLabel(cell.tasks, digits())}`
              return (
                <li class="calendar-month-cell">
                  <button
                    type="button"
                    class="calendar-month-day"
                    data-outside={cell.inMonth ? undefined : "true"}
                    data-busy={cell.isBusy ? "true" : undefined}
                    data-today={isToday ? "true" : undefined}
                    aria-label={label}
                    aria-pressed={selectedDay() === cell.date ? "true" : "false"}
                    onClick={() => setSelectedDay(cell.date)}
                  >
                    <span class="calendar-month-number">
                      {jalaliDayNumber(cell.date, digits())}
                    </span>
                    <span class="calendar-month-dots" aria-hidden="true">
                      <For each={Array.from({ length: cell.busyLevel })}>
                        {() => <span class="calendar-month-dot" />}
                      </For>
                    </span>
                  </button>
                </li>
              )
            }}
          </For>
        </ol>
      </>
    )
  }

  const habitTrendReserve = () => (
    <section class="calendar-trend" aria-label="روند عادت‌ها" data-reserved="habits">
      <h2>روند عادت‌ها</h2>
      <p>نمودار ماهانهٔ عادت‌ها در گام عادت‌ها این‌جا نمایش داده می‌شود.</p>
    </section>
  )

  return (
    <main style={CALENDAR_MAIN} data-source={source()}>
      <header class="calendar-head">
          <div>
            <h1>تقویم</h1>
          </div>
          <div class="calendar-head-meta">
            <Show when={!local.online() || fetchState() === "offline" || fetchState() === "error"}>
              <p class="calendar-source" role="status">
                {SOURCE_HINT[local.online() ? fetchState() : "offline"]}
              </p>
            </Show>
            <div class="calendar-tabs" role="group" aria-label="نمای تقویم">
              <button
                type="button"
                class="calendar-tab"
                aria-pressed={view() === "week" ? "true" : "false"}
                onClick={() => setView("week")}
              >
                هفته
              </button>
              <button
                type="button"
                class="calendar-tab"
                aria-pressed={view() === "month" ? "true" : "false"}
                onClick={() => setView("month")}
              >
                ماه
              </button>
            </div>
          </div>
        </header>

        <Show
          when={view() === "week"}
          fallback={
            <>
              {monthNavigation()}
              {monthGrid()}
              {dayDetail()}
              {habitTrendReserve()}
            </>
          }
        >
          {weekNavigation()}
          <div class="calendar-head">
            <button
              type="button"
              class="calendar-nav-button"
              aria-expanded={planning() ? "true" : "false"}
              aria-controls="calendar-planning-panel"
              onClick={() => setPlanning((open) => !open)}
            >
              برنامه‌ریزی هفته
            </button>
            <p class="calendar-nav-title">
              {localizeDigits(week().totals.tasks, digits())} کار در این هفته
            </p>
          </div>
          <Show when={planning()}>
            <div id="calendar-planning-panel">{planningPanel()}</div>
          </Show>
          <Show when={!week().days.some((day) => day.tasks.length > 0)}>
            <p class="calendar-empty">{emptyWeekCopy}</p>
          </Show>
          <div class="calendar-week">
            <For each={week().days}>{(day) => weekDayCard(day)}</For>
          </div>
        </Show>

        <Show when={pageError()}>
          <p class="calendar-alert" role="alert">
            {pageError()}
          </p>
        </Show>

        <p class="calendar-sr" role="status" aria-live="polite">
          {announcement()}
        </p>
      </main>
  )
}
