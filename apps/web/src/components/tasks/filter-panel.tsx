import { For, Show, createSignal } from "solid-js"
import { localizeDigits, type Digits, type Priority, type TaskStatus } from "@tali/domain"
import {
  TASK_SORT_FIELDS,
  activeFilterCount,
  type ProjectRow,
  type TagRow,
  type TaskBoardKey,
  type TaskDateFilter,
  type TaskFilters,
  type TaskSort,
  type TaskSortField
} from "../../lib/tasks/model"
import { TagChip } from "./tag-chip"
import { pillButtonStyle } from "./ui"

/**
 * The persistent filter bar and desktop project sidebar (FR-TASK-02).
 *
 * One panel serves both layouts: it is a sticky sidebar at ≥960px and a
 * collapsible sheet on a phone. Project/tag counts come from the unfiltered
 * live set, so the sidebar reads like an index while the summary row reports
 * the currently filtered totals.
 */

const priorityOptions: ReadonlyArray<{ value: Priority | "all"; label: string }> = [
  { value: "all", label: "همه‌ی اولویت‌ها" },
  { value: "high", label: "بالا" },
  { value: "medium", label: "متوسط" },
  { value: "low", label: "پایین" }
]

const statusOptions: ReadonlyArray<{ value: TaskStatus | "all"; label: string }> = [
  { value: "all", label: "همه‌ی وضعیت‌ها" },
  { value: "todo", label: "انجام‌نشده" },
  { value: "doing", label: "در حال انجام" }
]

const dateOptions: ReadonlyArray<{ value: TaskDateFilter; label: string }> = [
  { value: "all", label: "همه‌ی زمان‌ها" },
  { value: "overdue", label: "عقب‌افتاده" },
  { value: "today", label: "امروز" },
  { value: "tomorrow", label: "فردا" },
  { value: "week", label: "این هفته" },
  { value: "none", label: "بدون تاریخ" }
]

const sortLabels: Record<TaskSortField, string> = {
  dueDate: "موعد",
  priority: "اولویت",
  status: "وضعیت",
  createdAt: "تاریخ ایجاد",
  updatedAt: "آخرین تغییر",
  title: "عنوان"
}

const projectButtonClass = (selected: boolean): string =>
  selected
    ? "flex min-w-0 items-center justify-between gap-2 rounded-lg bg-primary/10 px-2 py-1.5 text-start text-[0.82rem] font-medium text-primary"
    : "flex min-w-0 items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start text-[0.82rem] hover:bg-base-200"

export function FilterPanel(props: {
  filters: TaskFilters
  sort: TaskSort
  digits: Digits
  counts: Readonly<Record<TaskBoardKey, number>>
  total: number
  projects: ReadonlyArray<ProjectRow>
  tags: ReadonlyArray<TagRow>
  projectCounts: ReadonlyMap<string, number>
  noProjectCount: number
  allCount: number
  disabled: boolean
  onFilters: (filters: TaskFilters) => void
  onSort: (sort: TaskSort) => void
  onCreateProject: (title: string) => Promise<unknown>
  onCreateTag: (name: string) => Promise<unknown>
  onClear: () => void
  onClose?: () => void
}) {
  const [newProject, setNewProject] = createSignal("")
  const [newTag, setNewTag] = createSignal("")
  const num = (value: number): string => localizeDigits(value, props.digits)

  const patch = (values: Partial<TaskFilters>) =>
    props.onFilters({ ...props.filters, ...values })

  const toggleTag = (tagId: string) => {
    const tagIds = props.filters.tagIds.includes(tagId)
      ? props.filters.tagIds.filter((id) => id !== tagId)
      : [...props.filters.tagIds, tagId]
    patch({ tagIds })
  }

  const addProject = async () => {
    const value = newProject().trim()
    if (value === "" || props.disabled) return
    await props.onCreateProject(value)
    setNewProject("")
  }

  const addTag = async () => {
    const value = newTag().trim()
    if (value === "" || props.disabled) return
    await props.onCreateTag(value)
    setNewTag("")
  }

  const active = () => activeFilterCount(props.filters)

  return (
    <div class="tasks-filter-card panel grid min-w-0 gap-2.5 p-4">
      <Show when={props.onClose}>
        <button
          type="button"
          class="tasks-filter-close"
          onClick={() => props.onClose?.()}
        >
          بستن فیلترها
        </button>
      </Show>

      <header class="grid gap-0.5">
        <h2 class="m-0 text-[0.95rem] font-bold">فیلتر و مرتب‌سازی</h2>
        <p class="m-0 text-[0.78rem] leading-7 text-base-content/50">
          {num(props.total)} کار · امروز {num(props.counts.today)} · آینده {num(props.counts.upcoming)} · بدون تاریخ{" "}
          {num(props.counts.inbox)}
        </p>
      </header>

      <section aria-labelledby="tasks-filter-projects" class="grid gap-1">
        <h3 id="tasks-filter-projects" class="m-0 text-[0.82rem] font-medium text-base-content/55">
          پروژه‌ها
        </h3>
        <div class="grid gap-0.5">
          <button
            type="button"
            aria-pressed={props.filters.projectId === undefined ? "true" : "false"}
            onClick={() => patch({ projectId: undefined })}
            class={projectButtonClass(props.filters.projectId === undefined)}
          >
            <span>همه‌ی کارها</span>
            <span class="shrink-0 text-[0.72rem] text-base-content/50">{num(props.allCount)}</span>
          </button>
          <For each={props.projects}>
            {(project) => (
              <button
                type="button"
                aria-pressed={props.filters.projectId === project.id ? "true" : "false"}
                onClick={() => patch({ projectId: project.id })}
                class={projectButtonClass(props.filters.projectId === project.id)}
              >
                <span class="min-w-0 break-words">{project.title}</span>
                <span class="shrink-0 text-[0.72rem] text-base-content/50">
                  {num(props.projectCounts.get(project.id) ?? 0)}
                </span>
              </button>
            )}
          </For>
          <button
            type="button"
            aria-pressed={props.filters.projectId === null ? "true" : "false"}
            onClick={() => patch({ projectId: null })}
            class={projectButtonClass(props.filters.projectId === null)}
          >
            <span>بدون پروژه</span>
            <span class="shrink-0 text-[0.72rem] text-base-content/50">{num(props.noProjectCount)}</span>
          </button>
        </div>
        <div class="mt-1 flex flex-wrap gap-1">
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
            class="input input-bordered input-xs min-w-0 flex-1 basis-28 text-[0.82rem]"
          />
          <button
            type="button"
            disabled={props.disabled || newProject().trim() === ""}
            onClick={() => void addProject()}
            style={pillButtonStyle(false)}
          >
            ساخت
          </button>
        </div>
      </section>

      <section aria-labelledby="tasks-filter-tags" class="grid gap-1">
        <h3 id="tasks-filter-tags" class="m-0 text-[0.82rem] font-medium text-base-content/55">
          برچسب‌ها {props.filters.tagIds.length > 0 ? `(${num(props.filters.tagIds.length)})` : ""}
        </h3>
        <Show
          when={props.tags.length > 0}
          fallback={
            <p class="m-0 text-[0.78rem] text-base-content/50">
              هنوز برچسبی ندارید.
            </p>
          }
        >
          <div class="flex flex-wrap gap-1">
            <For each={props.tags}>
              {(tag) => (
                <TagChip
                  tag={tag}
                  selected={props.filters.tagIds.includes(tag.id)}
                  onClick={() => toggleTag(tag.id)}
                />
              )}
            </For>
          </div>
        </Show>
        <div class="mt-0.5 flex flex-wrap gap-1">
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
            class="input input-bordered input-xs min-w-0 flex-1 basis-28 text-[0.82rem]"
          />
          <button
            type="button"
            disabled={props.disabled || newTag().trim() === ""}
            onClick={() => void addTag()}
            style={pillButtonStyle(false)}
          >
            ساخت
          </button>
        </div>
      </section>

      <label class="grid gap-1">
        <span class="text-[0.78rem] text-base-content/55">اولویت</span>
        <select
          value={props.filters.priority}
          onChange={(event) =>
            patch({ priority: event.currentTarget.value as Priority | "all" })
          }
          class="select select-bordered select-sm w-full"
        >
          <For each={priorityOptions}>
            {(option) => <option value={option.value}>{option.label}</option>}
          </For>
        </select>
      </label>

      <label class="grid gap-1">
        <span class="text-[0.78rem] text-base-content/55">وضعیت</span>
        <select
          value={props.filters.status}
          onChange={(event) =>
            patch({ status: event.currentTarget.value as TaskStatus | "all" })
          }
          class="select select-bordered select-sm w-full"
        >
          <For each={statusOptions}>
            {(option) => <option value={option.value}>{option.label}</option>}
          </For>
        </select>
      </label>

      <label class="grid gap-1">
        <span class="text-[0.78rem] text-base-content/55">زمان</span>
        <select
          value={props.filters.date}
          onChange={(event) => patch({ date: event.currentTarget.value as TaskDateFilter })}
          class="select select-bordered select-sm w-full"
        >
          <For each={dateOptions}>
            {(option) => <option value={option.value}>{option.label}</option>}
          </For>
        </select>
      </label>

      <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-1">
        <label class="grid gap-1">
          <span class="text-[0.78rem] text-base-content/55">مرتب‌سازی</span>
          <select
            value={props.sort.by}
            onChange={(event) =>
              props.onSort({ ...props.sort, by: event.currentTarget.value as TaskSortField })
            }
            class="select select-bordered select-sm w-full"
          >
            <For each={TASK_SORT_FIELDS}>
              {(field) => <option value={field}>{sortLabels[field]}</option>}
            </For>
          </select>
        </label>
        <button
          type="button"
          aria-label={
            props.sort.direction === "asc" ? "مرتب‌سازی صعودی" : "مرتب‌سازی نزولی"
          }
          title={props.sort.direction === "asc" ? "صعودی" : "نزولی"}
          onClick={() =>
            props.onSort({
              ...props.sort,
              direction: props.sort.direction === "asc" ? "desc" : "asc"
            })
          }
          class="btn btn-outline btn-sm self-end"
        >
          {props.sort.direction === "asc" ? "↑" : "↓"}
        </button>
      </div>

      <Show when={active() > 0}>
        <button type="button" onClick={() => props.onClear()} style={pillButtonStyle(false)}>
          پاک کردن فیلترها ({num(active())})
        </button>
      </Show>

      <p class="m-0 text-[0.72rem] leading-7 text-base-content/40">
        فیلترها و مرتب‌سازی روی همین دستگاه ذخیره می‌شوند.
      </p>
    </div>
  )
}
