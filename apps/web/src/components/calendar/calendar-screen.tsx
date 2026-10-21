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
  eventOccurrences,
  localizeDigits,
  toJalaliDate,
  type CalendarOccasionSource,
  type CalendarTaskItem,
  type Digits,
  type Event,
  type EventEditScope,
  type EventExceptionOverrides,
  type EventOccurrence,
  type MonthReadModel,
  type WeekReadModel
} from "@tali/domain"
import { useAuth } from "../../lib/auth"
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
  overlayOccasionSources,
  shiftDay,
  shiftMonth,
  taskCountLabel,
  todayIn,
  weekFromMirror,
  weekFromSources,
  weekTitle
} from "../../lib/calendar/model"
import {
  asOccasionSource,
  formatOccasionDate,
  monthOccasionsFromSources,
  occasionsByDate,
  toOccasionRow,
  type OccasionRow
} from "../../lib/occasions/model"
import {
  createEventInMirror,
  overlayEventSources,
  occurrenceTimeLabel,
  timingOfDraft
} from "../../lib/events/model"
import {
  applyEventScopeInMirror,
  deleteEventWithinScope,
  editEventWithinScope,
  eventFromMirror,
  newScopedIds
} from "../../lib/events/scope"
import { OccasionsPanel } from "../occasions/occasions-panel"
import {
  EventChip,
  EventEditor,
  EventQuickAdd,
  EventRow,
  EventScopePrompt,
  TimeGrid,
  hasTimedEvents,
  type EventDraftFields
} from "./events"
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
 * time. Projected recurrence occurrences stay visibly read-only in that lane.
 *
 * Since #62 the same grid carries the event and occasion lanes:
 *
 * - all-day events paint as a full-width strip on their day cell, timed events
 *   sit on the day's time grid, and an event can be quick-added from any cell
 *   (local-first, like a task);
 * - occasions show as chips on their annual date, projected from the origin
 *   date by the same builder #59's panel uses;
 * - opening an occurrence asks the #58 edit-scope question — "this event" or
 *   "this and following" — before the split writes to the mirror/outbox.
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
  const auth = useAuth()
  const preferences = usePreferences()
  const local = useLocalStore()

  const [view, setView] = createSignal<CalendarViewName>("week")
  const [anchor, setAnchor] = createSignal<string>(
    todayIn(preferences.preferences().timeZone)
  )
  const [selectedDay, setSelectedDay] = createSignal<string>()
  const [planning, setPlanning] = createSignal(false)
  const [mirrorTasks, setMirrorTasks] = createSignal<ReadonlyArray<MirrorRecord>>([])
  const [mirrorEvents, setMirrorEvents] = createSignal<ReadonlyArray<MirrorRecord>>([])
  const [pendingIds, setPendingIds] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [pendingEvents, setPendingEvents] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [pendingOccasions, setPendingOccasions] = createSignal<ReadonlySet<string>>(
    new Set<string>()
  )
  const [trashedEvents, setTrashedEvents] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [trashedOccasions, setTrashedOccasions] = createSignal<ReadonlySet<string>>(
    new Set<string>()
  )
  const [dirtyKeys, setDirtyKeys] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [dirtyEvents, setDirtyEvents] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [serverWeek, setServerWeek] = createSignal<WeekReadModel>()
  const [serverWeekEtag, setServerWeekEtag] = createSignal<string>()
  const [serverMonth, setServerMonth] = createSignal<MonthReadModel>()
  const [serverMonthEtag, setServerMonthEtag] = createSignal<string>()
  const [fetchState, setFetchState] = createSignal<FetchState>("idle")
  const [drafts, setDrafts] = createSignal<Readonly<Record<string, string>>>({})
  const [busyKey, setBusyKey] = createSignal<string>()
  const [pageError, setPageError] = createSignal<string>()
  const [occasions, setOccasions] = createSignal<ReadonlyArray<OccasionRow>>([])
  const [announcement, setAnnouncement] = createSignal("")
  const [editingEvent, setEditingEvent] = createSignal<EventOccurrence>()
  const [pendingAction, setPendingAction] = createSignal<{
    readonly action: "edit" | "delete"
    readonly occurrence: EventOccurrence
    readonly draft: EventDraftFields | null
  }>()
  const [scope, setScope] = createSignal<EventEditScope>("thisOccurrence")
  const [eventBusy, setEventBusy] = createSignal(false)
  const [editorError, setEditorError] = createSignal<string>()

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

  const occasionSources = createMemo<ReadonlyArray<CalendarOccasionSource>>(() =>
    occasions().map(asOccasionSource)
  )

  const mirrorWeek = createMemo<WeekReadModel>(() =>
    weekFromMirror({
      tasks: mirrorTasks(),
      events: mirrorEvents(),
      occasions: occasionSources(),
      anchor: anchor(),
      weekStart: weekStart(),
      timeZone: timeZone()
    })
  )

  const mirrorMonth = createMemo<MonthReadModel>(() =>
    monthFromMirror({
      tasks: mirrorTasks(),
      events: mirrorEvents(),
      occasions: occasionSources(),
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
  const eventOverlayIds = () => new Set<string>([...pendingEvents(), ...dirtyEvents()])
  const occasionOverlayIds = () => pendingOccasions()
  const deletedEventIds = () => trashedEvents()
  const deletedOccasionIds = () => trashedOccasions()

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
    const eventIds = eventOverlayIds()
    const occasionIds = occasionOverlayIds()
    if (ids.size === 0 && eventIds.size === 0 && occasionIds.size === 0) return model
    return weekFromSources({
      tasks: overlayCalendarSources({
        base: model.tasks,
        mirror: mirrorTasks(),
        overlayIds: ids
      }),
      events: overlayEventSources({
        base: model.events,
        mirror: mirrorEvents(),
        overlayIds: eventIds,
        deletedIds: deletedEventIds()
      }),
      occasions: overlayOccasionSources({
        base: model.occasions,
        mirror: occasionSources(),
        overlayIds: occasionIds,
        deletedIds: deletedOccasionIds()
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
    const eventIds = eventOverlayIds()
    const occasionIds = occasionOverlayIds()
    if (
      ids.size === 0 &&
      eventIds.size === 0 &&
      occasionIds.size === 0 &&
      (model.day?.date ?? undefined) === selectedDay()
    ) {
      return model
    }
    return monthFromSources({
      tasks: overlayCalendarSources({
        base: model.tasks,
        mirror: mirrorTasks(),
        overlayIds: ids
      }),
      events: overlayEventSources({
        base: model.events,
        mirror: mirrorEvents(),
        overlayIds: eventIds,
        deletedIds: deletedEventIds()
      }),
      occasions: overlayOccasionSources({
        base: model.occasions,
        mirror: occasionSources(),
        overlayIds: occasionIds,
        deletedIds: deletedOccasionIds()
      }),
      year: model.year,
      month: model.month,
      weekStart: model.weekStart,
      timeZone: model.timeZone,
      day: selectedDay() ?? null
    })
  })

  /**
   * The month's annual occasion chips. The `/month` payload ships the source
   * rows (not the occurrences) because the grid's busy marks only need a count;
   * the chips re-project the same rows — server rows plus an unsent local write
   * — with the shared annual builder, so the chip is correct offline too.
   */
  const monthOccasionMap = createMemo(() =>
    occasionsByDate(
      monthOccasionsFromSources(month().occasions, month().start, month().end)
    )
  )

  /** The event chips for the month grid, re-projected the same way. */
  const monthEventMap = createMemo(() => {
    const model = month()
    const occurrences = eventOccurrences({
      events: model.events,
      from: model.start,
      to: model.end,
      timeZone: model.timeZone
    })
    const map = new Map<string, Array<EventOccurrence>>()
    for (const occurrence of occurrences) {
      const bucket = map.get(occurrence.date) ?? []
      bucket.push(occurrence)
      map.set(occurrence.date, bucket)
    }
    return map
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
        setMirrorEvents([])
        setOccasions([])
        return
      }
      let cancelled = false
      const reload = () => {
        void Promise.all([
          store.list("task"),
          store.list("event"),
          store.list("occasion"),
          store.listTrashed("event"),
          store.listTrashed("occasion"),
          store.pending()
        ])
          .then(([tasks, events, occasionRows, trashedEventRows, trashedOccasionRows, queued]) => {
            if (cancelled) return
            setMirrorTasks(tasks)
            setMirrorEvents(events)
            setOccasions(occasionRows.map(toOccasionRow))
            setTrashedEvents(new Set(trashedEventRows.map((row) => row.entityId)))
            setTrashedOccasions(new Set(trashedOccasionRows.map((row) => row.entityId)))
            const pendingOf = (type: string) =>
              new Set(
                queued
                  .filter((entry) => entry.entityType === type)
                  .map((entry) => entry.entityId)
              )
            setPendingIds(pendingOf("task"))
            setPendingEvents(pendingOf("event"))
            setPendingOccasions(pendingOf("occasion"))
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

  const markEventDirty = (id: string) => {
    setDirtyEvents((current) => new Set([...current, id]))
  }

  const clearDirty = (ids: ReadonlySet<string>) => {
    if (ids.size === 0) return
    setDirtyKeys((current) => {
      const next = new Set(current)
      for (const id of ids) next.delete(id)
      return next
    })
  }

  const clearDirtyEvents = (ids: ReadonlySet<string>) => {
    if (ids.size === 0) return
    setDirtyEvents((current) => {
      const next = new Set(current)
      for (const id of ids) next.delete(id)
      return next
    })
  }

  /**
   * A validator is only meaningful together with the snapshot it validates.
   * Every path that drops the snapshot drops the ETag too: otherwise a later
   * `304` (the body is byte-identical) would leave the screen without a server
   * model *and* without a reason to fetch one, so it would stay on the mirror
   * forever after an offline blip or a transient error.
   */
  const dropServerWeek = () => {
    setServerWeek(undefined)
    setServerWeekEtag(undefined)
  }

  const dropServerMonth = () => {
    setServerMonth(undefined)
    setServerMonthEtag(undefined)
  }

  const refreshWeek = async (
    inFlightDirty: ReadonlySet<string>,
    inFlightDirtyEvents: ReadonlySet<string>
  ): Promise<void> => {
    const ticket = ++refreshGeneration
    const result = await fetchWeek(untrack(anchor), untrack(serverWeekEtag))
    if (ticket !== refreshGeneration) return
    if (!untrack(() => local.online() && local.pending() === 0)) return
    if (!result.ok) {
      dropServerWeek()
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
    clearDirtyEvents(inFlightDirtyEvents)
  }

  const refreshMonth = async (
    inFlightDirty: ReadonlySet<string>,
    inFlightDirtyEvents: ReadonlySet<string>
  ): Promise<void> => {
    const ticket = ++refreshGeneration
    const result = await fetchMonth(
      untrack(anchor),
      untrack(selectedDay),
      untrack(serverMonthEtag)
    )
    if (ticket !== refreshGeneration) return
    if (!untrack(() => local.online() && local.pending() === 0)) return
    if (!result.ok) {
      dropServerMonth()
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
    clearDirtyEvents(inFlightDirtyEvents)
  }

  // Revalidate on boot, reconnect, view/window changes and an empty outbox.
  createEffect(
    () => ({
      online: local.online(),
      pending: local.pending(),
      view: view(),
      anchor: anchor(),
      day: selectedDay(),
      dirty: dirtyKeys().size,
      dirtyEvents: dirtyEvents().size
    }),
    (state) => {
      if (!state.online) {
        dropServerWeek()
        dropServerMonth()
        setFetchState("offline")
        return
      }
      if (state.pending > 0) {
        setFetchState("idle")
        return
      }
      const inFlightDirty = untrack(dirtyKeys)
      const inFlightDirtyEvents = untrack(dirtyEvents)
      if (state.view === "week") void refreshWeek(inFlightDirty, inFlightDirtyEvents)
      else void refreshMonth(inFlightDirty, inFlightDirtyEvents)
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
        const inFlightDirtyEvents = untrack(dirtyEvents)
        if (state.view === "week") void refreshWeek(inFlightDirty, inFlightDirtyEvents)
        else void refreshMonth(inFlightDirty, inFlightDirtyEvents)
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

  // ── Events and occasions (#62) ─────────────────────────────────────────

  /** The mirrored series row an occurrence belongs to, or `null` when absent. */
  const seriesOf = (occurrence: EventOccurrence): Event | null => {
    const record = mirrorEvents().find((entry) => entry.entityId === occurrence.id)
    const userId = auth.session()?.user.id
    const householdId = auth.householdId()
    if (record === undefined || userId === undefined || householdId === undefined) {
      return null
    }
    return eventFromMirror(record, { userId, householdId })
  }

  /** Create an all-day or timed event from a day cell, local-first. */
  const addEvent = async (date: string, draft: EventDraftFields) => {
    const store = local.store()
    if (store === undefined || eventBusy()) return
    setEventBusy(true)
    setPageError(undefined)
    try {
      const id = await createEventInMirror(store, {
        title: draft.title,
        date: draft.date,
        allDay: draft.allDay,
        startTime: draft.startTime,
        endTime: draft.endTime,
        timeZone: timeZone()
      })
      markEventDirty(id)
      setAnnouncement(`رویداد تازه برای ${dayLabel(date, digits())}: ${draft.title}`)
    } catch (cause) {
      reportError(cause)
    } finally {
      setEventBusy(false)
    }
  }

  const openEvent = (occurrence: EventOccurrence) => {
    setEditorError(undefined)
    setEditingEvent(occurrence)
  }

  const closeEditor = () => {
    setEditingEvent(undefined)
    setEditorError(undefined)
  }

  const missingEventCopy =
    "این رویداد هنوز در حافظهٔ محلی نیست؛ کمی بعد دوباره تلاش کنید."

  /** Save from the editor; a recurring series asks the scope question first. */
  const saveEvent = (draft: EventDraftFields) => {
    const occurrence = editingEvent()
    if (occurrence === undefined) return
    const series = seriesOf(occurrence)
    if (series === null) {
      setEditorError(missingEventCopy)
      return
    }
    if (series.recurrence !== null) {
      setScope("thisOccurrence")
      setPendingAction({ action: "edit", occurrence, draft })
      return
    }
    void commitEventChange("thisOccurrence", { action: "edit", occurrence, draft })
  }

  /** Delete from the editor; a recurring series asks the scope question first. */
  const askDeleteEvent = () => {
    const occurrence = editingEvent()
    if (occurrence === undefined) return
    const series = seriesOf(occurrence)
    if (series === null) {
      setEditorError(missingEventCopy)
      return
    }
    if (series.recurrence !== null) {
      setScope("thisOccurrence")
      setPendingAction({ action: "delete", occurrence, draft: null })
      return
    }
    void commitEventChange("thisOccurrence", { action: "delete", occurrence, draft: null })
  }

  const scopeAnnouncement = (
    action: "edit" | "delete",
    chosen: EventEditScope,
    title: string
  ): string => {
    const following = chosen === "thisAndFollowing"
    if (action === "edit") {
      return following
        ? `این رویداد و رویدادهای بعدی ویرایش شد: ${title}`
        : `رویداد ویرایش شد: ${title}`
    }
    return following
      ? `این رویداد و رویدادهای بعدی حذف شد: ${title}`
      : `رویداد حذف شد: ${title}`
  }

  /**
   * The one write path for both scopes. It computes the rows with the #58 pure
   * functions and commits them to the mirror + outbox, so the calendar works
   * offline and the next sync carries the split.
   */
  const commitEventChange = async (
    chosen: EventEditScope,
    target: {
      readonly action: "edit" | "delete"
      readonly occurrence: EventOccurrence
      readonly draft: EventDraftFields | null
    }
  ): Promise<void> => {
    const store = local.store()
    const series = seriesOf(target.occurrence)
    if (store === undefined || series === null) {
      setEditorError(missingEventCopy)
      return
    }
    setEventBusy(true)
    setPageError(undefined)
    setEditorError(undefined)
    try {
      const ids = newScopedIds()
      const now = new Date().toISOString()
      const overrides: EventExceptionOverrides = target.draft === null
        ? {}
        : {
          title: target.draft.title,
          timing: timingOfDraft({ ...target.draft, timeZone: target.occurrence.timeZone })
        }
      const change = target.action === "edit"
        ? editEventWithinScope({
          event: series,
          instanceId: target.occurrence.instanceId,
          overrides,
          scope: chosen,
          exceptionId: ids.exceptionId,
          followingId: ids.followingId,
          now
        })
        : deleteEventWithinScope({
          event: series,
          instanceId: target.occurrence.instanceId,
          scope: chosen,
          exceptionId: ids.exceptionId,
          followingId: ids.followingId,
          now
        })
      await applyEventScopeInMirror(store, change, now)
      markEventDirty(change.series.id)
      if (change.following !== null) markEventDirty(change.following.id)
      setAnnouncement(
        scopeAnnouncement(
          target.action,
          chosen,
          target.draft?.title ?? target.occurrence.title
        )
      )
      setPendingAction(undefined)
      setEditingEvent(undefined)
    } catch (cause) {
      setEditorError(
        cause instanceof Error ? cause.message : "ذخیرهٔ رویداد در حافظهٔ محلی ناموفق بود"
      )
    } finally {
      setEventBusy(false)
    }
  }

  /** The all-day strip and the timed time grid for one day. */
  const eventLanes = (day: WeekReadModel["days"][number], label: string) => {
    const allDay = day.events.filter((occurrence) => occurrence.timing._tag === "allDay")
    const timed = day.events.filter((occurrence) => occurrence.timing._tag === "timed")
    return (
      <>
        <Show when={allDay.length > 0 || day.occasions.length > 0}>
          <div class="calendar-allday" aria-label={`تمام‌روزها و مناسبت‌های ${label}`}>
            <For each={allDay}>
              {(occurrence) => (
                <EventChip
                  occurrence={occurrence}
                  digits={digits()}
                  timeZone={timeZone()}
                  onOpen={openEvent}
                />
              )}
            </For>
            <For each={day.occasions}>
              {(occasion) => (
                <span
                  class="calendar-occasion-chip calendar-occasion-chip-week"
                  data-occasion={occasion.id}
                  aria-label={`مناسبت ${occasion.title} — ${formatOccasionDate(occasion, digits())}`}
                >
                  {occasion.title}
                </span>
              )}
            </For>
          </div>
        </Show>
        <Show
          when={hasTimedEvents(timed)}
          fallback={<p class="calendar-lane" data-lane="events-timed">رویداد زمانی — خالی</p>}
        >
          <TimeGrid
            occurrences={timed}
            digits={digits()}
            timeZone={timeZone()}
            onOpen={openEvent}
          />
        </Show>
      </>
    )
  }

  /** Reminder and habit lanes stay quiet until their screens land (#61/#66). */
  const quietLanes = () => (
    <ul class="calendar-lanes" aria-label="مسیرهای دیگر">
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
        <EventQuickAdd
          date={day.date}
          label={label}
          digits={digits()}
          disabled={local.store() === undefined}
          busy={eventBusy()}
          onSubmit={(draft) => void addEvent(day.date, draft)}
        />

        {eventLanes(day, label)}

        <Show when={day.tasks.length > 0}>
          <ul class="calendar-tasks" aria-label={`کارهای ${label}`}>
            <For each={day.tasks}>{(item) => taskRow(item)}</For>
          </ul>
        </Show>
        <Show
          when={
            day.tasks.length === 0 &&
            day.events.length === 0 &&
            day.occasions.length === 0
          }
        >
          <p class="calendar-empty">{emptyDayCopy}</p>
        </Show>
        {quietLanes()}
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
        <EventQuickAdd
          date={detail.date}
          label={label}
          digits={digits()}
          disabled={local.store() === undefined}
          busy={eventBusy()}
          onSubmit={(draft) => void addEvent(detail.date, draft)}
        />

        <Show when={detail.occasions.length > 0}>
          <ul class="calendar-occasions-list" aria-label={`مناسبت‌های ${label}`}>
            <For each={detail.occasions}>
              {(occasion) => (
                <li class="calendar-occasion-row" data-occasion-date={occasion.date}>
                  <span
                    class="calendar-occasion-chip"
                    data-color={occasion.color ?? undefined}
                  >
                    {occasion.title}
                  </span>
                  <span class="calendar-occasion-date">
                    {formatOccasionDate(occasion, digits())}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show when={detail.events.length > 0}>
          <ul class="calendar-events" aria-label={`رویدادهای ${label}`}>
            <For each={detail.events}>
              {(occurrence) => (
                <EventRow
                  occurrence={occurrence}
                  digits={digits()}
                  timeZone={timeZone()}
                  onOpen={openEvent}
                />
              )}
            </For>
          </ul>
        </Show>

        <Show when={detail.tasks.length > 0}>
          <ul class="calendar-tasks" aria-label={`کارهای ${label}`}>
            <For each={detail.tasks}>{(item) => taskRow(item)}</For>
          </ul>
        </Show>
        <Show
          when={
            detail.tasks.length === 0 &&
            detail.events.length === 0 &&
            detail.occasions.length === 0
          }
        >
          <p class="calendar-empty">{emptyDayCopy}</p>
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
              // Reactive memos: the occasion lane loads from the mirror after
              // the grid paints, so neither the label nor the chips may capture
              // the first (empty) map. Reading the preferences inside a memo
              // (not the untracked `<For>` body) keeps a digits/week-start
              // change live.
              const isToday = createMemo(() => cell.date === today())
              const dayOccasions = createMemo(() => monthOccasionMap().get(cell.date) ?? [])
              const dayEvents = createMemo(() => monthEventMap().get(cell.date) ?? [])
              const label = createMemo(() => {
                const parts = [
                  `${dayLabel(cell.date, digits())} — ${taskCountLabel(cell.tasks, digits())}`
                ]
                if (cell.events > 0) {
                  parts.push(`${localizeDigits(cell.events, digits())} رویداد`)
                }
                if (cell.occasions > 0) {
                  parts.push(`${localizeDigits(cell.occasions, digits())} مناسبت`)
                }
                return parts.join(" — ")
              })
              return (
                <li class="calendar-month-cell">
                  <button
                    type="button"
                    class="calendar-month-day"
                    data-outside={cell.inMonth ? undefined : "true"}
                    data-busy={cell.isBusy ? "true" : undefined}
                    data-today={isToday() ? "true" : undefined}
                    aria-label={label()}
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
                    <Show when={dayEvents().length > 0}>
                      <span class="calendar-event-chips" aria-hidden="true">
                        <For each={dayEvents().slice(0, 2)}>
                          {(occurrence) => (
                            <span
                              class="calendar-event-chip calendar-event-chip-month"
                              data-allday={occurrence.timing._tag === "allDay" ? "true" : undefined}
                              title={occurrence.title}
                            >
                              <Show
                                when={occurrenceTimeLabel(occurrence, timeZone(), digits())}
                              >
                                {(time) => (
                                  <span class="calendar-event-chip-time">{time()}</span>
                                )}
                              </Show>
                              <span class="calendar-event-chip-title">
                                {occurrence.title}
                              </span>
                            </span>
                          )}
                        </For>
                        <Show when={dayEvents().length > 2}>
                          <span class="calendar-event-chip" data-more="true">
                            +{localizeDigits(dayEvents().length - 2, digits())}
                          </span>
                        </Show>
                      </span>
                    </Show>
                    <Show when={dayOccasions().length > 0}>
                      <span class="calendar-occasion-chips" aria-hidden="true">
                        <For each={dayOccasions().slice(0, 2)}>
                          {(occasion) => (
                            <span
                              class="calendar-occasion-chip"
                              data-color={occasion.color ?? undefined}
                              title={`${occasion.title} — ${formatOccasionDate(occasion, digits())}`}
                            >
                              {occasion.title}
                            </span>
                          )}
                        </For>
                        <Show when={dayOccasions().length > 2}>
                          <span class="calendar-occasion-chip" data-more="true">
                            +{localizeDigits(dayOccasions().length - 2, digits())}
                          </span>
                        </Show>
                      </span>
                    </Show>
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
              {localizeDigits(week().totals.tasks, digits())} کار،{" "}
              {localizeDigits(week().totals.events, digits())} رویداد،{" "}
              {localizeDigits(week().totals.occasions, digits())} مناسبت در این هفته
            </p>
          </div>
          <Show when={planning()}>
            <div id="calendar-planning-panel">{planningPanel()}</div>
          </Show>
          <Show
            when={
              !week().days.some(
                (day) =>
                  day.tasks.length > 0 ||
                  day.events.length > 0 ||
                  day.occasions.length > 0
              )
            }
          >
            <p class="calendar-empty">{emptyWeekCopy}</p>
          </Show>
          <div class="calendar-week">
            <For each={week().days}>{(day) => weekDayCard(day)}</For>
          </div>
        </Show>

        <OccasionsPanel
          occasions={occasions()}
          today={today()}
          timeZone={timeZone()}
          digits={digits()}
        />

        <Show when={pageError()}>
          <p class="calendar-alert" role="alert">
            {pageError()}
          </p>
        </Show>

        <Show when={editingEvent()}>
          {(occurrence) => (
            <EventEditor
              occurrence={occurrence()}
              digits={digits()}
              canEdit={seriesOf(occurrence()) !== null}
              busy={eventBusy()}
              error={editorError()}
              onSave={saveEvent}
              onDelete={askDeleteEvent}
              onClose={closeEditor}
            />
          )}
        </Show>

        <Show when={pendingAction()}>
          {(target) => (
            <EventScopePrompt
              action={target().action}
              title={target().draft?.title ?? target().occurrence.title}
              scope={scope()}
              busy={eventBusy()}
              onScopeChange={setScope}
              onConfirm={() => void commitEventChange(scope(), target())}
              onCancel={() => setPendingAction(undefined)}
            />
          )}
        </Show>

        <p class="calendar-sr" role="status" aria-live="polite">
          {announcement()}
        </p>
      </main>
  )
}
