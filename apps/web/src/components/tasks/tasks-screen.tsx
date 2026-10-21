import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { tokens } from "@tali/ui"
import {
  DEFAULT_TIME_ZONE,
  localizeDigits,
  taskBucketOf,
  type Digits,
  type TaskBucketBounds,
  type TaskBucketPlacement
} from "@tali/domain"
import { useAuth } from "../../lib/auth"
import { usePreferences } from "../../lib/preferences"
import { useLocalStore } from "../../lib/local-store"
import {
  DEFAULT_TASK_VIEW,
  cacheTaskViewSettings,
  readTaskViewSettings,
  type TaskViewSettings
} from "../../lib/tasks/view-cache"
import {
  buildTaskView,
  completeTaskInMirror,
  createProjectInMirror,
  createTagInMirror,
  createTaskInMirror,
  moveTaskInMirror,
  pendingTaskIds,
  recentCompletions,
  toProjectRow,
  toTagRow,
  toTaskRow,
  undoTaskInMirror,
  updateTaskInMirror,
  type ProjectRow,
  type TagRow,
  type TaskBoard,
  type TaskBoardKey,
  type TaskEditPatch,
  type TaskRow,
  type TaskSort
} from "../../lib/tasks/model"
import { CompletionHistory } from "./history-list"
import { FilterPanel } from "./filter-panel"
import { QuickAdd } from "./quick-add"
import { TaskCard } from "./task-card"
import { TasksStyles } from "./ui"

/**
 * The `/tasks` board (ticket #37).
 *
 * Reads: the IndexedDB mirror only, so the screen renders the same online and
 * offline. Writes: every action (`writeLocal`) commits the mirror row and the
 * outbox entry in one transaction before the UI updates; the global sync
 * engine pushes them and the pending chip comes from the outbox. Nothing here
 * calls RPC, which is why an offline reload cannot blank the week.
 */

interface Ghost {
  readonly id: string
  readonly title: string
  readonly placement: TaskBucketPlacement
}

const groupTitles: Readonly<Record<TaskBucketPlacement, string>> = {
  overdue: "از قبل مانده",
  today: "امروز",
  tomorrow: "فردا",
  thisWeek: "این هفته",
  later: "بعدتر",
  noDate: "بدون تاریخ",
  done: ""
}

const BOARD_COPY: Readonly<Record<TaskBoardKey, { title: string; subtitle: string; empty: string }>> = {
  today: {
    title: "امروز",
    subtitle: "کارهای امروز و آنچه از قبل مانده",
    empty: "امروز خالی است — یک کار تازه اضافه کنید."
  },
  upcoming: {
    title: "پیش‌رو",
    subtitle: "فردا تا هفتهٔ پیش‌رو",
    empty: "برای روزهای آینده کاری برنامه‌ریزی نشده است."
  },
  inbox: {
    title: "بدون تاریخ",
    subtitle: "صندوق ورودی برای وقتی هنوز روزش معلوم نیست",
    empty: "صندوق ورودی خالی است."
  }
}

export function TasksScreen() {
  const local = useLocalStore()
  const preferences = usePreferences()
  const auth = useAuth()

  const initialUserId = untrack(() => auth.session()?.user.id)
  const [settings, setSettings] = createSignal<TaskViewSettings>(
    initialUserId === undefined
      ? DEFAULT_TASK_VIEW
      : readTaskViewSettings(initialUserId) ?? DEFAULT_TASK_VIEW
  )
  const [tasks, setTasks] = createSignal<ReadonlyArray<TaskRow>>([])
  const [projects, setProjects] = createSignal<ReadonlyArray<ProjectRow>>([])
  const [tags, setTags] = createSignal<ReadonlyArray<TagRow>>([])
  const [pendingIds, setPendingIds] = createSignal<ReadonlySet<string>>(new Set())
  const [filtersOpen, setFiltersOpen] = createSignal(false)
  const [now, setNow] = createSignal(new Date().toISOString())
  const [pageError, setPageError] = createSignal<string>()
  const [ghosts, setGhosts] = createSignal<ReadonlyArray<Ghost>>([])
  const [toast, setToast] = createSignal<TaskRow>()
  const [draggingId, setDraggingId] = createSignal<string>()
  const [dragOver, setDragOver] = createSignal<TaskBoardKey>()

  let toastTimer: ReturnType<typeof setTimeout> | undefined

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

  // Re-evaluate "today" while the screen stays open across midnight.
  createEffect(
    () => null,
    () => {
      const timer = setInterval(() => setNow(new Date().toISOString()), 60_000)
      return () => clearInterval(timer)
    }
  )
  onCleanup(() => clearTimeout(toastTimer))

  // A different account gets its own saved view; the first read is synchronous
  // in the initializer above, so there is no default-flash on a reload.
  let loadedUserId = initialUserId
  createEffect(() => auth.session()?.user.id, (userId) => {
    if (userId === undefined || userId === loadedUserId) return
    loadedUserId = userId
    setSettings(readTaskViewSettings(userId) ?? DEFAULT_TASK_VIEW)
  })
  createEffect(
    () => ({ userId: auth.session()?.user.id, settings: settings() }),
    ({ userId, settings: current }) => {
      if (userId === undefined) return
      cacheTaskViewSettings(userId, current)
    }
  )

  // Mirror → board. `subscribe` fires after every committed local write or
  // server ack, so pending chips and content stay in step with the store.
  createEffect(
    () => local.store(),
    (store) => {
      if (store === undefined) {
        setTasks([])
        setProjects([])
        setTags([])
        setPendingIds(new Set<string>())
        return
      }
      let cancelled = false
      const reload = () => {
        void Promise.all([
          store.list("task"),
          store.list("project"),
          store.list("tag"),
          store.pending()
        ])
          .then(([taskRows, projectRows, tagRows, pending]) => {
            if (cancelled) return
            setTasks(taskRows.map(toTaskRow))
            setProjects(projectRows.map(toProjectRow))
            setTags(tagRows.map(toTagRow))
            setPendingIds(pendingTaskIds(pending))
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

  const view = createMemo(() =>
    buildTaskView(tasks(), {
      timeZone: timeZone(),
      now: now(),
      filters: settings().filters,
      sort: settings().sort
    })
  )

  const history = createMemo(() => recentCompletions(tasks(), now()))
  const liveTasks = createMemo(() => tasks().filter((task) => task.status !== "done"))
  const projectCounts = createMemo(() => {
    const counts = new Map<string, number>()
    for (const task of liveTasks()) {
      if (task.projectId === null) continue
      counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1)
    }
    return counts
  })
  const noProjectCount = createMemo(
    () => liveTasks().filter((task) => task.projectId === null).length
  )

  const setFilters = (filters: TaskViewSettings["filters"]) =>
    setSettings((current) => ({ ...current, filters }))
  const setSort = (sort: TaskSort) => setSettings((current) => ({ ...current, sort }))

  const reportError = (cause: unknown) => {
    setPageError(cause instanceof Error ? cause.message : "ذخیره در حافظه‌ی محلی ناموفق بود")
  }

  const createTask = async (draft: Parameters<typeof createTaskInMirror>[1]) => {
    const store = local.store()
    if (store === undefined) throw new Error("حافظه‌ی محلی هنوز آماده نیست")
    setPageError(undefined)
    try {
      await createTaskInMirror(store, draft)
    } catch (cause) {
      reportError(cause)
      throw cause
    }
  }

  const createProject = async (title: string): Promise<string | undefined> => {
    const store = local.store()
    if (store === undefined) return undefined
    try {
      return await createProjectInMirror(store, title)
    } catch (cause) {
      reportError(cause)
      return undefined
    }
  }

  const createTag = async (name: string): Promise<string | undefined> => {
    const store = local.store()
    if (store === undefined) return undefined
    try {
      return await createTagInMirror(store, name)
    } catch (cause) {
      reportError(cause)
      return undefined
    }
  }

  const patchTask = async (task: TaskRow, patch: TaskEditPatch) => {
    const store = local.store()
    if (store === undefined) throw new Error("حافظه‌ی محلی در دسترس نیست")
    await updateTaskInMirror(store, task.id, patch)
  }

  const moveTask = async (task: TaskRow, dueDate: string | null) => {
    const store = local.store()
    if (store === undefined) return
    try {
      await moveTaskInMirror(store, task.id, dueDate, timeZone())
    } catch (cause) {
      reportError(cause)
    }
  }

  const showToast = (task: TaskRow) => {
    clearTimeout(toastTimer)
    setToast(task)
    toastTimer = setTimeout(() => setToast(undefined), 6000)
  }

  const completeTask = (task: TaskRow) => {
    const store = local.store()
    if (store === undefined) return
    const placement = taskBucketOf(
      { dueAt: task.dueAt, dueDate: task.dueDate, status: task.status },
      view().bounds
    )
    // The write is immediate (local-first); the ghost is only the visual exit.
    void completeTaskInMirror(store, task.id).catch(reportError)
    setGhosts((current) => [
      ...current.filter((ghost) => ghost.id !== task.id),
      { id: task.id, title: task.title, placement }
    ])
    window.setTimeout(() => {
      setGhosts((current) => current.filter((ghost) => ghost.id !== task.id))
    }, 320)
    showToast(task)
  }

  const undoCompletion = async (task: TaskRow) => {
    const store = local.store()
    if (store === undefined) return
    clearTimeout(toastTimer)
    setToast(undefined)
    try {
      await undoTaskInMirror(store, task)
    } catch (cause) {
      reportError(cause)
    }
  }

  const dropOn = (board: TaskBoardKey) => {
    const task = tasks().find((entry) => entry.id === draggingId())
    setDraggingId(undefined)
    setDragOver(undefined)
    if (task === undefined) return
    const dueDate =
      board === "inbox" ? null : board === "upcoming" ? view().bounds.tomorrow : view().bounds.today
    void moveTask(task, dueDate)
  }

  const ghostsFor = (placement: TaskBucketPlacement): ReadonlyArray<Ghost> =>
    ghosts().filter((ghost) => ghost.placement === placement)

  const boardProps = (board: TaskBoard) => ({
    board,
    digits: digits(),
    bounds: view().bounds,
    projects: projects(),
    tags: tags(),
    pendingIds: pendingIds(),
    draggingId: draggingId(),
    onPatch: patchTask,
    onComplete: completeTask,
    onMove: moveTask,
    onDragStart: (task: TaskRow) => setDraggingId(task.id),
    onDragEnd: () => setDraggingId(undefined)
  })

  return (
    <div style={{ display: "grid", gap: tokens.space.md, "min-width": 0 }}>
      <TasksStyles />

      <div class="tasks-layout">
        <div class="tasks-filter-toggle-wrap">
          <button
            type="button"
            class="tasks-filter-toggle"
            aria-expanded={filtersOpen() ? "true" : "false"}
            aria-controls="tasks-filter-panel"
            onClick={() => setFiltersOpen(!filtersOpen())}
          >
            فیلترها و پروژه‌ها
          </button>
        </div>

        <aside
          id="tasks-filter-panel"
          class="tasks-filter-panel"
          data-open={filtersOpen() ? "true" : "false"}
          aria-label="فیلتر کارها"
        >
          <FilterPanel
            filters={settings().filters}
            sort={settings().sort}
            digits={digits()}
            counts={view().counts}
            total={view().total}
            projects={projects()}
            tags={tags()}
            projectCounts={projectCounts()}
            noProjectCount={noProjectCount()}
            allCount={liveTasks().length}
            disabled={local.store() === undefined}
            onFilters={setFilters}
            onSort={setSort}
            onCreateProject={createProject}
            onCreateTag={createTag}
            onClear={() =>
              setSettings((current) => ({ ...current, filters: DEFAULT_TASK_VIEW.filters }))
            }
            onClose={() => setFiltersOpen(false)}
          />
        </aside>

        <div class="tasks-main">
          <header
            style={{
              display: "grid",
              gap: "4px",
              background: tokens.color.surface,
              border: `1px solid ${tokens.color.line}`,
              "border-radius": tokens.radius.lg,
              padding: tokens.space.md
            }}
          >
            <h1 style={{ margin: 0, "font-size": "1.4rem" }}>کارها</h1>
            <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.84rem", "line-height": "1.8" }}>
              هر تغییر اول روی همین دستگاه ذخیره می‌شود؛ بعد در پس‌زمینه همگام می‌شود.
            </p>
            <Show when={!local.online()}>
              <p role="status" style={{ margin: 0, color: "#8a5a12", "font-size": "0.8rem", "line-height": "1.8" }}>
                آفلاین هستید: ساخت، جابه‌جایی و انجام‌دادن کار می‌کند و بعداً ارسال می‌شود.
              </p>
            </Show>
            <Show when={local.pending() > 0}>
              <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.78rem" }} role="status" aria-live="polite">
                {localizeDigits(local.pending(), digits())} تغییر در صف همگام‌سازی است.
              </p>
            </Show>
          </header>

          <QuickAdd
            disabled={local.store() === undefined}
            timeZone={timeZone()}
            digits={digits()}
            projects={projects()}
            tags={tags()}
            onCreate={createTask}
            onCreateProject={createProject}
            onCreateTag={createTag}
          />

          <Show when={pageError()}>
            <p
              role="alert"
              style={{
                margin: 0,
                padding: "10px 12px",
                "border-radius": tokens.radius.md,
                background: "#fdecef",
                color: "#9f1239",
                "font-size": "0.85rem",
                "line-height": "1.8"
              }}
            >
              {pageError()}
            </p>
          </Show>

          <Show
            when={local.status() !== "opening"}
            fallback={
              <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.9rem" }}>
                در حال آماده‌سازی حافظه‌ی محلی…
              </p>
            }
          >
            <div class="tasks-boards">
              <BoardSection
                boardKey="today"
                view={boardProps(view().today)}
                ghostsFor={ghostsFor}
                dragOver={dragOver()}
                onDragOver={setDragOver}
                onDragLeave={() => setDragOver(undefined)}
                onDrop={dropOn}
              />
              <BoardSection
                boardKey="upcoming"
                view={boardProps(view().upcoming)}
                ghostsFor={ghostsFor}
                dragOver={dragOver()}
                onDragOver={setDragOver}
                onDragLeave={() => setDragOver(undefined)}
                onDrop={dropOn}
              />
              <BoardSection
                boardKey="inbox"
                view={boardProps(view().inbox)}
                ghostsFor={ghostsFor}
                dragOver={dragOver()}
                onDragOver={setDragOver}
                onDragLeave={() => setDragOver(undefined)}
                onDrop={dropOn}
              />
            </div>

            <CompletionHistory
              tasks={history()}
              digits={digits()}
              timeZone={timeZone()}
              onRestore={(task) => void undoCompletion(task)}
            />
          </Show>
        </div>
      </div>

      <Show when={toast()}>
        {(task) => (
          <div class="tasks-toast" role="status" aria-live="polite">
            <p>انجام شد: {task().title}</p>
            <button type="button" onClick={() => void undoCompletion(task())}>
              بازگرداندن
            </button>
          </div>
        )}
      </Show>
    </div>
  )
}

interface BoardSectionProps {
  boardKey: TaskBoardKey
  view: {
    board: TaskBoard
    digits: Digits
    bounds: TaskBucketBounds
    projects: ReadonlyArray<ProjectRow>
    tags: ReadonlyArray<TagRow>
    pendingIds: ReadonlySet<string>
    draggingId: string | undefined
    onPatch: (task: TaskRow, patch: TaskEditPatch) => Promise<void>
    onComplete: (task: TaskRow) => void
    onMove: (task: TaskRow, dueDate: string | null) => Promise<void>
    onDragStart: (task: TaskRow) => void
    onDragEnd: () => void
  }
  ghostsFor: (placement: TaskBucketPlacement) => ReadonlyArray<Ghost>
  dragOver: TaskBoardKey | undefined
  onDragOver: (key: TaskBoardKey) => void
  onDragLeave: () => void
  onDrop: (key: TaskBoardKey) => void
}

function BoardSection(props: BoardSectionProps) {
  const copy = () => BOARD_COPY[props.boardKey]
  const headingId = () => `tasks-board-${props.boardKey}`
  const hasGhosts = () =>
    props.view.board.groups.some((group) => props.ghostsFor(group.key).length > 0)

  return (
    <section
      class="tasks-board"
      data-over={props.dragOver === props.boardKey ? "true" : "false"}
      aria-labelledby={headingId()}
      onDragOver={(event) => {
        event.preventDefault()
        props.onDragOver(props.boardKey)
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && event.currentTarget.contains(next)) return
        props.onDragLeave()
      }}
      onDrop={(event) => {
        event.preventDefault()
        props.onDrop(props.boardKey)
      }}
    >
      <div class="tasks-board-head">
        <h2 id={headingId()}>{copy().title}</h2>
        <span class="tasks-count" aria-label={`${localizeDigits(props.view.board.count, props.view.digits)} کار`}>
          {localizeDigits(props.view.board.count, props.view.digits)}
        </span>
      </div>
      <p class="tasks-board-sub">{copy().subtitle}</p>

      <Show
        when={props.view.board.count > 0 || hasGhosts()}
        fallback={
          <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.82rem", "line-height": "1.8" }}>
            {copy().empty}
          </p>
        }
      >
        <For each={props.view.board.groups}>
          {(group) => {
            const ghosts = () => props.ghostsFor(group.key)
            return (
              <Show when={group.tasks.length > 0 || ghosts().length > 0}>
                <Show when={group.key !== "today" && group.key !== "noDate"}>
                  <h3 style={{ margin: "4px 0 0", "font-size": "0.78rem", color: tokens.color.inkSoft }}>
                    {groupTitles[group.key]}
                  </h3>
                </Show>
                <ul>
                  <For each={group.tasks}>
                    {(task) => (
                      <TaskCard
                        task={task}
                        bounds={props.view.bounds}
                        digits={props.view.digits}
                        projects={props.view.projects}
                        tags={props.view.tags}
                        pending={props.view.pendingIds.has(task.id)}
                        dragging={props.view.draggingId === task.id}
                        onPatch={props.view.onPatch}
                        onComplete={props.view.onComplete}
                        onMove={props.view.onMove}
                        onDragStart={props.view.onDragStart}
                        onDragEnd={props.view.onDragEnd}
                      />
                    )}
                  </For>
                  <For each={ghosts()}>
                    {(ghost) => (
                      <li class="tasks-ghost" aria-hidden="true">
                        <span>✓</span>
                        <span style={{ "overflow-wrap": "anywhere" }}>{ghost.title}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            )
          }}
        </For>
      </Show>
    </section>
  )
}
