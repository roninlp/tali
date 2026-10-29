import { For, Show, createEffect, createSignal, untrack, type ParentProps } from "solid-js"
import { Button } from "@tali/ui"
import type { Digits, Priority } from "@tali/domain"
import {
  formatLocalDate,
  shiftLocalDate,
  type ProjectRow,
  type TagRow,
  type TaskCreateDraft
} from "../../lib/tasks/model"
import { TagChip } from "./tag-chip"
import { pillButtonStyle } from "./ui"

/**
 * One-field quick add (FR-TASK-01) with chips for due / priority / tags /
 * project. Submitting calls `onCreate`, which commits to the IndexedDB mirror
 * and the outbox in one transaction — the task is on the board before the
 * form clears and regardless of connectivity. Chips stay set between adds so
 * entering a week of tasks doesn't mean re-picking the project every time.
 */

let nextId = 0

const PRIORITIES: ReadonlyArray<{ value: Priority; label: string }> = [
  { value: "high", label: "بالا" },
  { value: "medium", label: "متوسط" },
  { value: "low", label: "پایین" }
]

const priorityLabel = (priority: Priority): string =>
  PRIORITIES.find((entry) => entry.value === priority)?.label ?? "متوسط"

export function QuickAdd(props: {
  disabled: boolean
  timeZone: string
  /** The viewer's live wall date (`YYYY-MM-DD`), re-evaluated across midnight. */
  today: string
  digits: Digits
  projects: ReadonlyArray<ProjectRow>
  tags: ReadonlyArray<TagRow>
  onCreate: (draft: TaskCreateDraft) => Promise<void>
  onCreateProject: (title: string) => Promise<string | undefined>
  onCreateTag: (name: string) => Promise<string | undefined>
}) {
  const uid = `quick-add-${++nextId}`
  let inputRef: HTMLInputElement | undefined

  const [title, setTitle] = createSignal("")
  const [dueDate, setDueDate] = createSignal<string | null>(
    untrack(() => props.today)
  )
  const [priority, setPriority] = createSignal<Priority>("medium")
  const [projectId, setProjectId] = createSignal<string | null>(null)
  const [tagIds, setTagIds] = createSignal<ReadonlyArray<string>>([])
  const [panel, setPanel] = createSignal<"due" | "priority" | "tags" | "project">()
  const [busy, setBusy] = createSignal(false)
  let dueTouched = false
  const [saved, setSaved] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [newProject, setNewProject] = createSignal("")
  const [newTag, setNewTag] = createSignal("")

  // The default due day follows the viewer's zone and stays on *today* while the
  // form sits open past midnight. Until the first edit it is recomputed
  // whenever the screen's day rolls over, so a task added at 00:05 is never
  // silently dated yesterday.
  createEffect(() => props.today, (today) => {
    if (!dueTouched) setDueDate(today)
  })

  const chooseDue = (value: string | null) => {
    dueTouched = true
    setDueDate(value)
  }

  const togglePanel = (next: "due" | "priority" | "tags" | "project") =>
    setPanel((current) => (current === next ? undefined : next))

  const projectTitle = () =>
    props.projects.find((project) => project.id === projectId())?.title ?? ""

  const dueChipLabel = () => {
    const date = dueDate()
    if (date === null) return "بدون موعد"
    if (date === props.today) return "امروز"
    return formatLocalDate(date, props.digits)
  }

  const toggleTag = (tagId: string) =>
    setTagIds((current) =>
      current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId]
    )

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const value = title().trim()
    if (props.disabled || busy() || value === "") return
    setBusy(true)
    setError(undefined)
    try {
      await props.onCreate({
        title: value,
        dueDate: dueDate(),
        priority: priority(),
        projectId: projectId(),
        tagIds: tagIds(),
        timeZone: props.timeZone
      })
      setTitle("")
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
      inputRef?.focus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ذخیره نشد")
    } finally {
      setBusy(false)
    }
  }

  const addProject = async () => {
    const value = newProject().trim()
    if (value === "" || props.disabled) return
    try {
      const id = await props.onCreateProject(value)
      setNewProject("")
      if (id !== undefined) setProjectId(id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ساخت پروژه ناموفق بود")
    }
  }

  const addTag = async () => {
    const value = newTag().trim()
    if (value === "" || props.disabled) return
    try {
      const id = await props.onCreateTag(value)
      setNewTag("")
      if (id !== undefined) {
        setTagIds((current) => (current.includes(id) ? current : [...current, id]))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ساخت برچسب ناموفق بود")
    }
  }

  const Panel = (panelProps: ParentProps<{ id: string }>) => (
    <div
      id={panelProps.id}
      class="grid min-w-0 gap-2 rounded-field border border-base-300 bg-base-200/60 p-2.5"
    >
      {panelProps.children}
    </div>
  )

  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-label="افزودن سریع کار"
      class="panel grid min-w-0 gap-2 p-4"
    >
      <div class="flex flex-wrap gap-2">
        <input
          ref={(element) => (inputRef = element)}
          type="text"
          aria-label="عنوان کار تازه"
          placeholder="یک کار تازه… (مثلاً خرید شیر)"
          value={title()}
          disabled={props.disabled}
          onInput={(event) => setTitle(event.currentTarget.value)}
          class="input input-bordered h-11 min-w-0 flex-1 basis-48"
        />
        <Button
          type="submit"
          disabled={props.disabled || busy() || title().trim() === ""}
          loading={busy()}
        >
          افزودن
        </Button>
      </div>

      <div role="group" aria-label="جزئیات کار" class="flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-expanded={panel() === "due" ? "true" : "false"}
          aria-controls={`${uid}-due`}
          onClick={() => togglePanel("due")}
          style={pillButtonStyle(panel() === "due" || dueDate() !== null)}
        >
          موعد: {dueChipLabel()}
        </button>
        <button
          type="button"
          aria-expanded={panel() === "priority" ? "true" : "false"}
          aria-controls={`${uid}-priority`}
          onClick={() => togglePanel("priority")}
          style={pillButtonStyle(panel() === "priority" || priority() !== "medium")}
        >
          اولویت: {priorityLabel(priority())}
        </button>
        <button
          type="button"
          aria-expanded={panel() === "tags" ? "true" : "false"}
          aria-controls={`${uid}-tags`}
          onClick={() => togglePanel("tags")}
          style={pillButtonStyle(panel() === "tags" || tagIds().length > 0)}
        >
          برچسب‌ها{tagIds().length > 0 ? `: ${tagIds().length}` : ""}
        </button>
        <button
          type="button"
          aria-expanded={panel() === "project" ? "true" : "false"}
          aria-controls={`${uid}-project`}
          onClick={() => togglePanel("project")}
          style={pillButtonStyle(panel() === "project" || projectId() !== null)}
        >
          {projectId() === null ? "پروژه" : `پروژه: ${projectTitle()}`}
        </button>
      </div>

      <Show when={panel() === "due"}>
        <Panel id={`${uid}-due`}>
          <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
            <For
              each={[
                { label: "امروز", value: props.today },
                { label: "فردا", value: shiftLocalDate(props.today, 1) },
                { label: "هفتهٔ بعد", value: shiftLocalDate(props.today, 7) },
                { label: "بدون تاریخ", value: null as string | null }
              ]}
            >
              {(option) => (
                <button
                  type="button"
                  aria-pressed={dueDate() === option.value ? "true" : "false"}
                  onClick={() => chooseDue(option.value)}
                  style={pillButtonStyle(dueDate() === option.value)}
                >
                  {option.label}
                </button>
              )}
            </For>
          </div>
          <label class="grid gap-1 text-[0.8rem] text-base-content/60">
            <span>تاریخ دلخواه</span>
            <input
              type="date"
              aria-label="تاریخ موعد"
              value={dueDate() ?? ""}
              onInput={(event) =>
                chooseDue(event.currentTarget.value === "" ? null : event.currentTarget.value)
              }
              class="input input-bordered input-sm w-full"
            />
          </label>
        </Panel>
      </Show>

      <Show when={panel() === "priority"}>
        <Panel id={`${uid}-priority`}>
          <div role="group" aria-label="اولویت" style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
            <For each={PRIORITIES}>
              {(entry) => (
                <button
                  type="button"
                  aria-pressed={priority() === entry.value ? "true" : "false"}
                  onClick={() => setPriority(entry.value)}
                  style={pillButtonStyle(priority() === entry.value)}
                >
                  {entry.label}
                </button>
              )}
            </For>
          </div>
        </Panel>
      </Show>

      <Show when={panel() === "tags"}>
        <Panel id={`${uid}-tags`}>
          <Show
            when={props.tags.length > 0}
            fallback={
              <p class="m-0 text-[0.8rem] text-base-content/50">
                هنوز برچسبی ندارید.
              </p>
            }
          >
            <div class="flex flex-wrap gap-1">
              <For each={props.tags}>
                {(tag) => (
                  <TagChip
                    tag={tag}
                    selected={tagIds().includes(tag.id)}
                    onClick={() => toggleTag(tag.id)}
                  />
                )}
              </For>
            </div>
          </Show>
          <div class="flex flex-wrap gap-1.5">
            <input
              type="text"
              aria-label="نام برچسب تازه"
              placeholder="برچسب تازه…"
              value={newTag()}
              disabled={props.disabled}
              onInput={(event) => setNewTag(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void addTag()
                }
              }}
              class="input input-bordered input-sm min-w-0 flex-1 basis-36"
            />
            <button type="button" disabled={props.disabled || newTag().trim() === ""} onClick={() => void addTag()} style={pillButtonStyle(false)}>
              ساخت برچسب
            </button>
          </div>
        </Panel>
      </Show>

      <Show when={panel() === "project"}>
        <Panel id={`${uid}-project`}>
          <label class="grid gap-1 text-[0.8rem] text-base-content/60">
            <span>پروژه</span>
            <select
              aria-label="پروژه"
              value={projectId() ?? ""}
              onChange={(event) =>
                setProjectId(event.currentTarget.value === "" ? null : event.currentTarget.value)
              }
              class="select select-bordered select-sm w-full"
            >
              <option value="">بدون پروژه</option>
              <For each={props.projects}>
                {(project) => <option value={project.id}>{project.title}</option>}
              </For>
            </select>
          </label>
          <div class="flex flex-wrap gap-1.5">
            <input
              type="text"
              aria-label="نام پروژه‌ی تازه"
              placeholder="پروژه‌ی تازه…"
              value={newProject()}
              disabled={props.disabled}
              onInput={(event) => setNewProject(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void addProject()
                }
              }}
              class="input input-bordered input-sm min-w-0 flex-1 basis-36"
            />
            <button type="button" disabled={props.disabled || newProject().trim() === ""} onClick={() => void addProject()} style={pillButtonStyle(false)}>
              ساخت پروژه
            </button>
          </div>
        </Panel>
      </Show>

      <div aria-live="polite" role="status" class="min-h-[1.1em] text-[0.76rem] text-base-content/50">
        <Show when={error()}>
          <span class="text-error">{error()}</span>
        </Show>
        <Show when={error() === undefined && saved()}>ذخیره شد؛ در صف همگام‌سازی.</Show>
        <Show when={error() === undefined && !saved()}>
          هر تغییر اول روی همین دستگاه ذخیره می‌شود؛ بی‌نیاز از اینترنت.
        </Show>
      </div>
    </form>
  )
}
