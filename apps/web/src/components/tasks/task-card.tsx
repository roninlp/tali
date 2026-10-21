import { For, Show, createEffect, createSignal, onCleanup, untrack } from "solid-js"
import type { JSX } from "@solidjs/web"
import { tokens } from "@tali/ui"
import type { Digits, Priority, TaskBucketBounds, TaskStatus } from "@tali/domain"
import {
  dueLabel,
  shiftLocalDate,
  type ProjectRow,
  type TagRow,
  type TaskEditPatch,
  type TaskRow
} from "../../lib/tasks/model"
import { TagChip } from "./tag-chip"
import { inputStyle, pillButtonStyle } from "./ui"

/**
 * One task card (FR-TASK-01/02/05).
 *
 * The card is readable at a glance and expands into the editor: title and
 * description autosave with a debounce and a saving → saved indicator, while
 * selects and tag chips patch immediately. Completion is a single 44px target;
 * moving between days is one tap (`امروز` / `فردا` / `هفتهٔ بعد` / `بدون
 * تاریخ`), so drag is an accelerator rather than the only route.
 */

export type SaveState = "idle" | "saving" | "saved" | "error"

const SAVE_LABELS: Record<SaveState, string> = {
  idle: "",
  saving: "در حال ذخیره…",
  saved: "ذخیره شد",
  error: "ذخیره نشد؛ دوباره تلاش کنید"
}

const priorityLabels: Record<Priority, string> = {
  high: "بالا",
  medium: "متوسط",
  low: "پایین"
}

const statusLabels: Record<TaskStatus, string> = {
  todo: "انجام‌نشده",
  doing: "در حال انجام",
  done: "انجام‌شده"
}

export function TaskCard(props: {
  task: TaskRow
  bounds: TaskBucketBounds
  digits: Digits
  projects: ReadonlyArray<ProjectRow>
  tags: ReadonlyArray<TagRow>
  pending: boolean
  dragging: boolean
  onPatch: (task: TaskRow, patch: TaskEditPatch) => Promise<void>
  onComplete: (task: TaskRow) => void
  onMove: (task: TaskRow, dueDate: string | null) => Promise<void>
  onDragStart: (task: TaskRow) => void
  onDragEnd: () => void
}) {
  const editorId = () => `task-${props.task.id}-editor`
  const [expanded, setExpanded] = createSignal(false)
  // One-shot seeds: the effects below keep each draft in step with the row, and
  // the dirty flags protect text the user is typing. `untrack` keeps the
  // initialization from looking like an accidental untracked read.
  const [draftTitle, setDraftTitle] = createSignal(untrack(() => props.task.title))
  const [draftDescription, setDraftDescription] = createSignal(
    untrack(() => props.task.description ?? "")
  )
  const [draftDue, setDraftDue] = createSignal(untrack(() => props.task.dueDate ?? ""))
  const [saveState, setSaveState] = createSignal<SaveState>("idle")

  let titleDirty = false
  let descriptionDirty = false
  let titleTimer: ReturnType<typeof setTimeout> | undefined
  let descriptionTimer: ReturnType<typeof setTimeout> | undefined
  let savedTimer: ReturnType<typeof setTimeout> | undefined
  let queue: Promise<void> = Promise.resolve()

  const markSaved = () => {
    setSaveState("saved")
    clearTimeout(savedTimer)
    savedTimer = setTimeout(() => setSaveState("idle"), 1500)
  }

  const enqueue = (patch: TaskEditPatch) => {
    setSaveState("saving")
    const run = async () => {
      try {
        await props.onPatch(props.task, patch)
        markSaved()
      } catch {
        setSaveState("error")
      }
    }
    queue = queue.then(run, run)
  }

  onCleanup(() => {
    // Navigate-away within the debounce window: still try to commit the text
    // rather than dropping it. A closing store rejects; nothing to do then.
    if (titleTimer !== undefined) {
      clearTimeout(titleTimer)
      const value = draftTitle()
      if (value.trim() !== "" && value !== props.task.title) {
        void props.onPatch(props.task, { title: value }).catch(() => undefined)
      }
    }
    if (descriptionTimer !== undefined) {
      clearTimeout(descriptionTimer)
      const value = draftDescription()
      if (value !== (props.task.description ?? "")) {
        void props
          .onPatch(props.task, { description: value === "" ? null : value })
          .catch(() => undefined)
      }
    }
    clearTimeout(savedTimer)
  })

  // Adopt a remote change unless the local field is mid-edit. After a save the
  // dirty flag clears, so an ack that only bumps the version cannot clobber
  // newer text typed while the write was in flight.
  createEffect(() => props.task.title, (title) => {
    if (!titleDirty) setDraftTitle(title)
  })
  createEffect(() => props.task.description ?? "", (description) => {
    if (!descriptionDirty) setDraftDescription(description)
  })
  createEffect(() => props.task.dueDate ?? "", (due) => {
    if (titleTimer === undefined && descriptionTimer === undefined) setDraftDue(due)
  })

  const changeTitle = (value: string) => {
    titleDirty = true
    setDraftTitle(value)
    setSaveState("saving")
    clearTimeout(titleTimer)
    titleTimer = setTimeout(() => {
      titleTimer = undefined
      titleDirty = false
      if (value.trim() === "" || value === props.task.title) {
        setDraftTitle(props.task.title)
        return
      }
      enqueue({ title: value })
    }, 450)
  }

  const changeDescription = (value: string) => {
    descriptionDirty = true
    setDraftDescription(value)
    setSaveState("saving")
    clearTimeout(descriptionTimer)
    descriptionTimer = setTimeout(() => {
      descriptionTimer = undefined
      descriptionDirty = false
      if (value === (props.task.description ?? "")) return
      enqueue({ description: value === "" ? null : value })
    }, 450)
  }

  const flushTitle = () => {
    if (titleTimer === undefined) return
    clearTimeout(titleTimer)
    titleTimer = undefined
    const value = draftTitle()
    if (value.trim() === "" || value === props.task.title) {
      titleDirty = false
      setDraftTitle(props.task.title)
      return
    }
    enqueue({ title: value })
    titleDirty = false
  }

  const flushDescription = () => {
    if (descriptionTimer === undefined) return
    clearTimeout(descriptionTimer)
    descriptionTimer = undefined
    const value = draftDescription()
    if (value === (props.task.description ?? "")) {
      descriptionDirty = false
      return
    }
    enqueue({ description: value === "" ? null : value })
    descriptionDirty = false
  }

  const changeDue = (value: string) => {
    setDraftDue(value)
    enqueue({ dueDate: value === "" ? null : value })
  }

  const move = (dueDate: string | null) => {
    if (dueDate === props.task.dueDate && dueDate !== null) return
    void props.onMove(props.task, dueDate)
  }

  const toggleTag = (tagId: string) => {
    const next = props.task.tagIds.includes(tagId)
      ? props.task.tagIds.filter((id) => id !== tagId)
      : [...props.task.tagIds, tagId]
    enqueue({ tagIds: next })
  }

  const project = () =>
    props.projects.find((entry) => entry.id === props.task.projectId)

  const overdue = () =>
    props.task.dueDate !== null && props.task.dueDate < props.bounds.today

  return (
    <li
      id={`task-${props.task.id}`}
      class="tasks-card"
      data-overdue={overdue() ? "true" : "false"}
      data-dragging={props.dragging ? "true" : "false"}
    >
      <div class="tasks-card-row">
        <span
          class="tasks-drag-handle"
          draggable="true"
          aria-hidden="true"
          title="بکشید تا به روز دیگری برود"
          onDragStart={(event) => {
            event.dataTransfer?.setData("text/tali-task", props.task.id)
            if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move"
            props.onDragStart(props.task)
          }}
          onDragEnd={() => props.onDragEnd()}
        >
          ⠿
        </span>

        <button
          type="button"
          class="tasks-check"
          aria-label={`انجام دادن: ${props.task.title}`}
          title="انجام دادن"
          onClick={() => props.onComplete(props.task)}
        >
          <span aria-hidden="true">✓</span>
        </button>

        <button
          type="button"
          class="tasks-card-title"
          aria-expanded={expanded() ? "true" : "false"}
          aria-controls={editorId()}
          onClick={() => setExpanded(!expanded())}
        >
          {props.task.title}
        </button>
      </div>

      <Show when={!expanded() && props.task.description !== null && props.task.description !== ""}>
        <p
          style={{
            margin: 0,
            color: tokens.color.inkSoft,
            "font-size": "0.82rem",
            "line-height": "1.7",
            "overflow-wrap": "anywhere"
          }}
        >
          {props.task.description}
        </p>
      </Show>

      <div class="tasks-meta">
        <span class="tasks-chip" data-tone={overdue() ? "overdue" : undefined}>
          {dueLabel(props.task, props.bounds, props.digits)}
        </span>
        <Show when={props.task.priority === "high"}>
          <span class="tasks-chip" data-tone="high">
            اولویت: {priorityLabels[props.task.priority]}
          </span>
        </Show>
        <Show when={props.task.status === "doing"}>
          <span class="tasks-chip">در حال انجام</span>
        </Show>
        <Show when={project()}>
          {(entry) => <span class="tasks-chip">{entry().title}</span>}
        </Show>
        <For each={props.tags.filter((tag) => props.task.tagIds.includes(tag.id))}>
          {(tag) => <TagChip tag={tag} />}
        </For>
        <Show when={props.pending}>
          <span class="tasks-chip" data-tone="pending" title="در انتظار همگام‌سازی">
            در صف
          </span>
        </Show>
      </div>

      <div class="tasks-moves" role="group" aria-label={`جابه‌جایی ${props.task.title}`}>
        <Show when={props.task.dueDate !== props.bounds.today}>
          <button type="button" class="tasks-move" onClick={() => move(props.bounds.today)}>
            امروز
          </button>
        </Show>
        <Show when={props.task.dueDate !== props.bounds.tomorrow}>
          <button type="button" class="tasks-move" onClick={() => move(props.bounds.tomorrow)}>
            فردا
          </button>
        </Show>
        <button
          type="button"
          class="tasks-move"
          onClick={() => move(shiftLocalDate(props.bounds.today, 7))}
        >
          هفتهٔ بعد
        </button>
        <Show when={props.task.dueDate !== null}>
          <button type="button" class="tasks-move" onClick={() => move(null)}>
            بدون تاریخ
          </button>
        </Show>
      </div>

      <Show when={saveState() !== "idle"}>
        <span
          class="tasks-save-state"
          data-state={saveState()}
          role="status"
          aria-live="polite"
        >
          {SAVE_LABELS[saveState()]}
        </span>
      </Show>

      <Show when={expanded()}>
        <div class="tasks-editor" id={editorId()}>
          <label class="tasks-field">
            <span>عنوان</span>
            <input
              type="text"
              value={draftTitle()}
              onInput={(event) => changeTitle(event.currentTarget.value)}
              onBlur={flushTitle}
              style={inputStyle}
            />
          </label>

          <label class="tasks-field">
            <span>توضیح</span>
            <textarea
              rows={3}
              value={draftDescription()}
              onInput={(event) => changeDescription(event.currentTarget.value)}
              onBlur={flushDescription}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </label>

          <div
            style={{
              display: "grid",
              gap: "8px",
              "grid-template-columns": "repeat(auto-fit, minmax(130px, 1fr))"
            }}
          >
            <label class="tasks-field">
              <span>موعد</span>
              <input
                type="date"
                value={draftDue()}
                onInput={(event) => changeDue(event.currentTarget.value)}
                style={inputStyle}
              />
            </label>

            <label class="tasks-field">
              <span>اولویت</span>
              <select
                value={props.task.priority}
                onChange={(event) =>
                  enqueue({ priority: event.currentTarget.value as Priority })
                }
                style={inputStyle}
              >
                <For each={Object.keys(priorityLabels) as Array<Priority>}>
                  {(value) => <option value={value}>{priorityLabels[value]}</option>}
                </For>
              </select>
            </label>

            <label class="tasks-field">
              <span>وضعیت</span>
              <select
                value={props.task.status === "doing" ? "doing" : "todo"}
                onChange={(event) =>
                  enqueue({
                    status: event.currentTarget.value === "doing" ? "doing" : "todo"
                  })
                }
                style={inputStyle}
              >
                <option value="todo">{statusLabels.todo}</option>
                <option value="doing">{statusLabels.doing}</option>
              </select>
            </label>

            <label class="tasks-field">
              <span>پروژه</span>
              <select
                value={props.task.projectId ?? ""}
                onChange={(event) =>
                  enqueue({
                    projectId:
                      event.currentTarget.value === "" ? null : event.currentTarget.value
                  })
                }
                style={inputStyle}
              >
                <option value="">بدون پروژه</option>
                <For each={props.projects}>
                  {(entry) => <option value={entry.id}>{entry.title}</option>}
                </For>
              </select>
            </label>
          </div>

          <div role="group" aria-label="برچسب‌ها" style={{ display: "grid", gap: "4px" }}>
            <span style={{ "font-size": "0.78rem", color: tokens.color.inkSoft }}>برچسب‌ها</span>
            <Show
              when={props.tags.length > 0}
              fallback={
                <p style={{ margin: 0, "font-size": "0.78rem", color: tokens.color.inkSoft }}>
                  هنوز برچسبی ساخته نشده است.
                </p>
              }
            >
              <div style={{ display: "flex", gap: "4px", "flex-wrap": "wrap" }}>
                <For each={props.tags}>
                  {(tag) => (
                    <TagChip
                      tag={tag}
                      selected={props.task.tagIds.includes(tag.id)}
                      onClick={() => toggleTag(tag.id)}
                    />
                  )}
                </For>
              </div>
            </Show>
          </div>

          <button
            type="button"
            onClick={() => setExpanded(false)}
            style={{ ...pillButtonStyle(false), "justify-self": "start" } as JSX.CSSProperties}
          >
            بستن
          </button>
        </div>
      </Show>
    </li>
  )
}
