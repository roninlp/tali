import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack
} from "solid-js"
import { Title } from "@solidjs/meta"
import { useNavigate } from "@solidjs/router"
import {
  DEFAULT_TIME_ZONE,
  formatJalaliDate,
  localizeDigits,
  moveDashboardSection,
  normalizeDashboardSectionOrder,
  taskBucketBounds,
  taskBucketOf,
  toIsoDate,
  todayInTimeZone,
  type DashboardSection,
  type LocalDate,
  type TodayReadModel
} from "@tali/domain"
import { AppHeader } from "../components/app-header"
import { Guard } from "../components/guard"
import { TextInput } from "../components/form"
import { TodayStyles, TODAY_MAIN, TODAY_ROOT } from "../components/today/ui"
import { TodayHabits } from "../components/habits/today-habits"
import { usePreferences } from "../lib/preferences"
import { authErrorMessage } from "../lib/auth-copy"
import { weekDaysFor } from "../lib/preferences-format"
import { useLocalStore } from "../lib/local-store"
import type { MirrorRecord } from "../lib/local-store"
import { fetchToday } from "../lib/today/api"
import {
  fromMirrorToday,
  fromServerToday,
  overlayPendingToday,
  type TodayView
} from "../lib/today/model"
import {
  completeTaskInMirror,
  createTaskInMirror,
  dueLabel,
  moveTaskInMirror,
  type TaskRow
} from "../lib/tasks/model"
import type { NoteRow } from "../lib/notes/mirror"

const DRAFT_KEY = "today.quickAdd.title"

/** Events/reminders stay quiet until their UI slices land; do not fake content. */
const QUIET_COPY: Readonly<Record<"events" | "reminders", string>> = {
  events: "امروز رویدادی نیست؛ تقویم در گام بعدی می‌آید.",
  reminders: "یادآوری‌ای برای امروز نیست."
}

const SECTION_TITLES: Readonly<Record<DashboardSection, string>> = {
  tasks: "کارهای امروز",
  events: "رویدادها",
  reminders: "یادآورها",
  habits: "عادت‌ها",
  notes: "یادداشت‌های پین‌شده"
}

const SOURCE_HINT: Readonly<Record<string, string>> = {
  offline: "آفلاین — نمایش از حافظهٔ محلی",
  error: "ارتباط با سرور برقرار نشد؛ نمایش از حافظهٔ محلی"
}

export default function TodayRoute() {
  return (
    <>
      <Title>امروز — تالی</Title>
      <Guard access="household">
        <TodayPage />
      </Guard>
    </>
  )
}

/**
 * The daily picture (FR-VIEW-01, ticket #42).
 *
 * Online, the `GET /today` read model paints the screen and its ETag
 * revalidates without re-downloading; pending local writes are overlaid on it
 * until the outbox drains. Offline (or when the API is unreachable) the same
 * view is aggregated from the IndexedDB mirror, so Today never blanks. Inline
 * actions always go through the #37 local-first helpers; section order comes
 * from the #35 preferences signal, so a settings change re-renders without a
 * reload.
 */
function TodayPage() {
  const preferences = usePreferences()
  const local = useLocalStore()
  const navigate = useNavigate()

  const [mirrorTasks, setMirrorTasks] = createSignal<ReadonlyArray<MirrorRecord>>([])
  const [mirrorNotes, setMirrorNotes] = createSignal<ReadonlyArray<MirrorRecord>>([])
  const [pendingKeys, setPendingKeys] = createSignal<ReadonlySet<string>>(new Set<string>())
  /**
   * Rows this screen wrote locally and has not yet seen come back from the
   * read model. An outbox entry is only half the story: once the sync engine
   * acks it, the pending set empties while `GET /today` (and its ETag) still
   * describes the pre-write world, so the completed row would flash back until
   * the refetch lands. These keys keep the optimistic state on screen across
   * that window and are dropped only by a fresh 200.
   */
  const [dirtyKeys, setDirtyKeys] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [server, setServer] = createSignal<TodayReadModel>()
  const [serverEtag, setServerEtag] = createSignal<string>()
  const [fetchState, setFetchState] = createSignal<"idle" | "ready" | "offline" | "error">("idle")
  const [now, setNow] = createSignal(new Date().toISOString())
  const [draft, setDraft] = createSignal("")
  const [addBusy, setAddBusy] = createSignal(false)
  const [pageError, setPageError] = createSignal<string>()
  const [announcement, setAnnouncement] = createSignal("")
  const [orderBusy, setOrderBusy] = createSignal(false)
  /** The habits lane owns its mirror read; it reports its row count for the header. */
  const [habitCount, setHabitCount] = createSignal(0)
  const [orderError, setOrderError] = createSignal<string>()
  const [orderOpen, setOrderOpen] = createSignal(false)

  let inputRef: HTMLInputElement | undefined
  let draftTimer: ReturnType<typeof setTimeout> | undefined
  let refreshGeneration = 0

  const digits = () => preferences.preferences().digits
  const timeZone = () => {
    const zone = preferences.preferences().timeZone
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone })
      return zone
    } catch {
      return DEFAULT_TIME_ZONE
    }
  }
  const todayDate = () => {
    // Track the minute clock so the date (and the habits lane's "today") roll
    // over at midnight without a reload.
    void now()
    return todayInTimeZone(timeZone())
  }
  const todayIso = () => toIsoDate(todayDate())
  const week = () => weekDaysFor(todayDate(), preferences.preferences())
  const bounds = () => taskBucketBounds(timeZone(), now())
  const order = () =>
    normalizeDashboardSectionOrder(preferences.preferences().dashboardSectionOrder)

  /**
   * Move one section and persist the whole order. The control can only swap
   * adjacent items of the normalized permutation, so it can never send a
   * duplicate or a missing section; an out-of-range move is disabled. The
   * settings signal updates in the same tick, so the dashboard re-renders
   * without a reload.
   */
  const moveSection = async (
    section: DashboardSection,
    direction: "up" | "down"
  ): Promise<void> => {
    if (orderBusy()) return
    const current = order()
    const next = moveDashboardSection(current, section, direction)
    if (next.every((value, index) => value === current[index])) return
    setOrderBusy(true)
    setOrderError(undefined)
    const result = await preferences.update({ dashboardSectionOrder: next })
    setOrderBusy(false)
    if (!result.ok) {
      setOrderError(authErrorMessage(result.code))
      return
    }
    setAnnouncement(`ترتیب بخش‌ها به‌روز شد: ${SECTION_TITLES[section]}`)
  }

  // Reflect the mirror immediately; `subscribe` fires after local writes and
  // server acks, which is also how an offline action updates the picture.
  createEffect(
    () => local.store(),
    (store) => {
      if (store === undefined) {
        setMirrorTasks([])
        setMirrorNotes([])
        setPendingKeys(new Set<string>())
        setDirtyKeys(new Set<string>())
        return
      }
      let cancelled = false
      const reload = () => {
        void Promise.all([store.list("task"), store.list("note"), store.pending()])
          .then(([tasks, notes, queued]) => {
            if (cancelled) return
            setMirrorTasks(tasks)
            setMirrorNotes(notes)
            setPendingKeys(
              new Set(queued.map((entry) => `${entry.entityType}\u0000${entry.entityId}`))
            )
          })
          .catch(() => {
            // The store closed (sign-out) while the read was in flight.
          })
      }
      reload()
      const unsubscribe = store.subscribe(reload)

      // Recover a half-typed quick add after a reload or an accidental close.
      void store
        .readDraft(DRAFT_KEY)
        .then((saved) => {
          if (cancelled || saved === undefined) return
          setDraft((current) => (current === "" ? saved : current))
        })
        .catch(() => {
          // Drafts are best-effort; a read failure must not block the screen.
        })

      return () => {
        cancelled = true
        unsubscribe()
      }
    }
  )

  const refreshToday = async (online: boolean, pending: number): Promise<void> => {
    if (!online || pending > 0) return
    const ticket = ++refreshGeneration
    const existing = untrack(server)
    const inFlightDirty = untrack(dirtyKeys)
    const result = await fetchToday(existing === undefined ? undefined : serverEtag())
    if (ticket !== refreshGeneration) return
    // A local write may have landed while this was in flight; the mirror is
    // then newer than the server response (its outbox entry has not pushed).
    if (!untrack(() => local.online() && local.pending() === 0)) return
    if (!result.ok) {
      setServer(undefined)
      setFetchState(result.error.code === "Network" ? "offline" : "error")
      return
    }
    if (result.notModified) {
      // 304 means the server still describes the world before those writes
      // (a rejected push, or a push that has not committed yet): keep them.
      setFetchState("ready")
      return
    }
    setServer(result.model)
    setServerEtag(result.etag)
    setFetchState("ready")
    if (inFlightDirty.size > 0) {
      setDirtyKeys((current) => {
        const next = new Set(current)
        for (const key of inFlightDirty) next.delete(key)
        return next
      })
    }
  }

  // Revalidate on boot, reconnect, and once the outbox is empty again. While
  // writes are queued, the view overlays them on the read model instead of
  // accepting a response the outbox has not reached the server with yet.
  createEffect(
    () => ({ online: local.online(), pending: local.pending() }),
    (state) => {
      if (!state.online) {
        setServer(undefined)
        setFetchState("offline")
        return
      }
      if (state.pending > 0) {
        setFetchState("idle")
        return
      }
      void refreshToday(state.online, state.pending)
    }
  )

  // Keep "today" and shared items current while the screen stays open.
  createEffect(
    () => null,
    () => {
      const clock = setInterval(() => setNow(new Date().toISOString()), 60_000)
      const poll = setInterval(() => {
        const state = untrack(() => ({
          online: local.online(),
          pending: local.pending()
        }))
        void refreshToday(state.online, state.pending)
      }, 60_000)
      return () => {
        clearInterval(clock)
        clearInterval(poll)
      }
    }
  )

  onCleanup(() => {
    clearTimeout(draftTimer)
    refreshGeneration += 1
  })

  const overlayKeys = (): ReadonlySet<string> => {
    const keys = new Set(pendingKeys())
    for (const key of dirtyKeys()) keys.add(key)
    return keys
  }

  const markDirty = (entityType: string, entityId: string) => {
    const key = `${entityType}\u0000${entityId}`
    setDirtyKeys((current) => new Set([...current, key]))
  }

  const view = createMemo<TodayView>(() => {
    const model = server()
    if (model !== undefined && local.online() && model.today === todayIso()) {
      return overlayPendingToday(fromServerToday(model), {
        tasks: mirrorTasks(),
        notes: mirrorNotes(),
        pending: overlayKeys(),
        timeZone: timeZone(),
        now: now()
      })
    }
    return fromMirrorToday({
      tasks: mirrorTasks(),
      notes: mirrorNotes(),
      timeZone: timeZone(),
      now: now()
    })
  })

  const updateDraft = (value: string) => {
    setDraft(value)
    const store = local.store()
    if (store === undefined) return
    clearTimeout(draftTimer)
    draftTimer = setTimeout(() => {
      if (value.trim() === "") void store.clearDraft(DRAFT_KEY)
      else void store.saveDraft(DRAFT_KEY, value)
    }, 300)
  }

  const reportError = (cause: unknown) => {
    setPageError(cause instanceof Error ? cause.message : "ذخیره در حافظه‌ی محلی ناموفق بود")
  }

  const focusQuickAdd = () => inputRef?.focus()

  const addTask = async (event: SubmitEvent) => {
    event.preventDefault()
    const store = local.store()
    const title = draft().trim()
    if (store === undefined || title === "" || addBusy()) return

    setAddBusy(true)
    setPageError(undefined)
    try {
      const id = await createTaskInMirror(store, {
        title,
        dueDate: todayIso(),
        priority: "medium",
        projectId: null,
        tagIds: [],
        timeZone: timeZone()
      })
      markDirty("task", id)
      clearTimeout(draftTimer)
      setDraft("")
      await store.clearDraft(DRAFT_KEY)
      setAnnouncement(`کار تازه: ${title}`)
    } catch (cause) {
      reportError(cause)
    } finally {
      setAddBusy(false)
    }
  }

  const complete = async (task: TaskRow) => {
    const store = local.store()
    if (store === undefined) return
    try {
      await completeTaskInMirror(store, task.id)
      markDirty("task", task.id)
      setAnnouncement(`انجام شد: ${task.title}`)
    } catch (cause) {
      reportError(cause)
    }
  }

  const moveToTomorrow = async (task: TaskRow) => {
    const store = local.store()
    if (store === undefined) return
    const tomorrow = view().tomorrow
    try {
      await moveTaskInMirror(store, task.id, tomorrow, timeZone())
      markDirty("task", task.id)
      setAnnouncement(`به فردا منتقل شد: ${task.title}`)
    } catch (cause) {
      reportError(cause)
    }
  }

  const newNote = (event: MouseEvent) => {
    event.preventDefault()
    navigate("/notes")
  }

  const sectionCount = (section: DashboardSection): number =>
    section === "habits" ? habitCount() : view().counts[section]

  const isOverdue = (task: TaskRow): boolean =>
    taskBucketOf(
      { dueAt: task.dueAt, dueDate: task.dueDate, status: task.status },
      bounds()
    ) === "overdue"

  const renderSection = (section: DashboardSection) => {
    if (section === "tasks") {
      return (
        <>
          <form class="today-quick" onSubmit={(event) => void addTask(event)}>
            <TextInput
              ref={(element) => (inputRef = element)}
              aria-label="کار تازه برای امروز"
              placeholder="یک کار تازه برای امروز…"
              value={draft()}
              onInput={(event) => updateDraft(event.currentTarget.value)}
              disabled={local.store() === undefined}
            />
            <button
              type="submit"
              disabled={local.store() === undefined || addBusy() || draft().trim() === ""}
            >
              افزودن
            </button>
          </form>

          <Show
            when={view().tasks.length > 0}
            fallback={
              <div class="today-empty">
                <p>امروز خالی است. یک کار کوچک برای شروع کافی است.</p>
                <button type="button" onClick={focusQuickAdd}>
                  پیشنهاد: افزودن اولین کار
                </button>
              </div>
            }
          >
            <ul class="today-list">
              <For each={view().tasks}>
                {(task) => (
                  <li class="today-row" data-overdue={isOverdue(task) ? "true" : undefined}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked="false"
                      class="today-check"
                      aria-label={`انجام ${task.title}`}
                      disabled={local.store() === undefined}
                      onClick={() => void complete(task)}
                    >
                      ✓
                    </button>
                    <div class="today-row-main">
                      <a class="today-row-title" href={`/tasks#task-${task.id}`}>
                        {task.title}
                      </a>
                      <p class="today-row-meta">
                        {isOverdue(task)
                          ? `عقب‌افتاده · ${dueLabel(task, bounds(), digits())}`
                          : dueLabel(task, bounds(), digits())}
                      </p>
                    </div>
                    <div class="today-actions">
                      <button
                        type="button"
                        class="today-action"
                        aria-label={`فردا کردن ${task.title}`}
                        disabled={local.store() === undefined}
                        onClick={() => void moveToTomorrow(task)}
                      >
                        فردا
                      </button>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </>
      )
    }

    if (section === "habits") {
      return (
        <TodayHabits
          store={local.store()}
          timeZone={timeZone()}
          digits={digits()}
          today={todayIso() as LocalDate}
          onCount={setHabitCount}
        />
      )
    }

    if (section === "notes") {
      return (
        <Show
          when={view().notes.length > 0}
          fallback={
            <div class="today-empty">
              <p>یادداشتی پین نشده است.</p>
              <button type="button" onClick={newNote}>
                پیشنهاد: ساخت یادداشت تازه
              </button>
            </div>
          }
        >
          <ul class="today-list">
            <For each={view().notes}>
              {(note: NoteRow) => (
                <li class="today-row">
                  <span aria-hidden="true" class="today-pin">
                    📌
                  </span>
                  <div class="today-row-main">
                    <a class="today-row-title" href={`/notes/${note.id}`}>
                      {note.title}
                    </a>
                    <Show when={note.excerpt !== ""}>
                      <p class="today-note-excerpt">{note.excerpt}</p>
                    </Show>
                  </div>
                  <div class="today-actions">
                    <a
                      class="today-action"
                      href={`/notes/${note.id}`}
                      aria-label={`باز کردن ${note.title}`}
                    >
                      باز کردن
                    </a>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      )
    }

    return (
      <p class="today-quiet">
        {section === "events" || section === "reminders" ? QUIET_COPY[section] : ""}
      </p>
    )
  }

  return (
    <div class="today-root" dir="rtl" lang="fa" style={TODAY_ROOT}>
      <TodayStyles />
      <AppHeader active="today" />

      <main style={TODAY_MAIN}>
        <header class="today-head">
          <div>
            <h1>امروز</h1>
            <p class="today-date">{formatJalaliDate(todayDate(), { digits: digits() })}</p>
          </div>
          <div class="today-head-actions">
            <Show
              when={!local.online() || fetchState() === "offline" || fetchState() === "error"}
            >
              <p class="today-source" role="status">
                {SOURCE_HINT[local.online() ? fetchState() : "offline"]}
              </p>
            </Show>
            <button
              type="button"
              class="today-order-toggle"
              aria-expanded={orderOpen() ? "true" : "false"}
              aria-controls="today-order-panel"
              onClick={() => setOrderOpen((open) => !open)}
            >
              ترتیب بخش‌ها
            </button>
          </div>
        </header>

        <ul class="today-week" aria-label="هفته‌ی جاری">
          <For each={week()}>
            {(cell) => (
              <li aria-label={cell.label} aria-current={cell.isToday ? "date" : undefined}>
                <span aria-hidden="true" class="today-weekday">
                  {cell.shortWeekday}
                </span>
                <span class="today-day">{cell.day}</span>
              </li>
            )}
          </For>
        </ul>

        <Show when={orderOpen()}>
          <section
            id="today-order-panel"
            class="today-order"
            aria-labelledby="today-order-title"
          >
            <h2 id="today-order-title" class="today-order-title">
              ترتیب بخش‌ها
            </h2>
            <p class="today-order-hint">
              جای هر بخش را با دکمه‌های بالا و پایین تغییر دهید؛ تغییر بلافاصله ذخیره
              می‌شود.
            </p>
            <ol class="today-order-list" aria-label="ترتیب بخش‌های امروز">
              <For each={order()}>
                {(section, index) => (
                  <li class="today-order-row">
                    <span class="today-order-name">{SECTION_TITLES[section]}</span>
                    <span class="today-order-actions">
                      <button
                        type="button"
                        class="today-order-move"
                        aria-label={`انتقال ${SECTION_TITLES[section]} به بالا`}
                        disabled={index() === 0 || orderBusy()}
                        onClick={() => void moveSection(section, "up")}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        class="today-order-move"
                        aria-label={`انتقال ${SECTION_TITLES[section]} به پایین`}
                        disabled={index() === order().length - 1 || orderBusy()}
                        onClick={() => void moveSection(section, "down")}
                      >
                        ↓
                      </button>
                    </span>
                  </li>
                )}
              </For>
            </ol>
            <Show when={orderBusy()}>
              <p class="today-order-status" role="status">
                در حال ذخیره‌ی ترتیب…
              </p>
            </Show>
            <Show when={orderError()}>
              <p class="today-alert" role="alert">
                {orderError()}
              </p>
            </Show>
          </section>
        </Show>

        <Show when={pageError()}>
          <p class="today-alert" role="alert">
            {pageError()}
          </p>
        </Show>

        <For each={order()}>
          {(section) => (
            <section class="today-section" data-section={section} aria-labelledby={`today-${section}`}>
              <header class="today-section-head">
                <h2 id={`today-${section}`}>{SECTION_TITLES[section]}</h2>
                <span class="today-count" aria-label={`${localizeDigits(sectionCount(section), digits())} مورد`}>
                  {localizeDigits(sectionCount(section), digits())}
                </span>
              </header>
              {renderSection(section)}
            </section>
          )}
        </For>

        <p class="today-sr" role="status" aria-live="polite">
          {announcement()}
        </p>
      </main>
    </div>
  )
}
