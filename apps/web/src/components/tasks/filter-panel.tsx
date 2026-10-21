import { For, Show, createSignal } from "solid-js"
import type { JSX } from "@solidjs/web"
import { tokens } from "@tali/ui"
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
import { inputStyle, pillButtonStyle } from "./ui"

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

const fieldStyle = { display: "grid", gap: "4px" } as const
const fieldLabelStyle = { "font-size": "0.78rem", color: tokens.color.inkSoft } as const

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
    <div
      class="tasks-filter-card"
      style={{
        display: "grid",
        gap: tokens.space.sm,
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.line}`,
        "border-radius": tokens.radius.lg,
        padding: tokens.space.md,
        "min-width": 0
      }}
    >
      <Show when={props.onClose}>
        <button
          type="button"
          class="tasks-filter-close"
          onClick={() => props.onClose?.()}
        >
          بستن فیلترها
        </button>
      </Show>

      <header style={{ display: "grid", gap: "2px" }}>
        <h2 style={{ margin: 0, "font-size": "0.95rem" }}>فیلتر و مرتب‌سازی</h2>
        <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.78rem", "line-height": "1.8" }}>
          {num(props.total)} کار · امروز {num(props.counts.today)} · آینده {num(props.counts.upcoming)} · بدون تاریخ{" "}
          {num(props.counts.inbox)}
        </p>
      </header>

      <section aria-labelledby="tasks-filter-projects" style={{ display: "grid", gap: "4px" }}>
        <h3 id="tasks-filter-projects" style={{ margin: 0, "font-size": "0.82rem", color: tokens.color.inkSoft }}>
          پروژه‌ها
        </h3>
        <div style={{ display: "grid", gap: "2px" }}>
          <button
            type="button"
            aria-pressed={props.filters.projectId === undefined ? "true" : "false"}
            onClick={() => patch({ projectId: undefined })}
            style={projectButtonStyle(props.filters.projectId === undefined)}
          >
            <span>همه‌ی کارها</span>
            <span style={countStyle}>{num(props.allCount)}</span>
          </button>
          <For each={props.projects}>
            {(project) => (
              <button
                type="button"
                aria-pressed={props.filters.projectId === project.id ? "true" : "false"}
                onClick={() => patch({ projectId: project.id })}
                style={projectButtonStyle(props.filters.projectId === project.id)}
              >
                <span style={{ "overflow-wrap": "anywhere", "min-width": 0 }}>
                  {project.title}
                </span>
                <span style={countStyle}>{num(props.projectCounts.get(project.id) ?? 0)}</span>
              </button>
            )}
          </For>
          <button
            type="button"
            aria-pressed={props.filters.projectId === null ? "true" : "false"}
            onClick={() => patch({ projectId: null })}
            style={projectButtonStyle(props.filters.projectId === null)}
          >
            <span>بدون پروژه</span>
            <span style={countStyle}>{num(props.noProjectCount)}</span>
          </button>
        </div>
        <div style={{ display: "flex", gap: "4px", "flex-wrap": "wrap", "margin-top": "4px" }}>
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
            style={{ ...inputStyle, "font-size": "0.82rem", flex: "1 1 110px", padding: "4px 8px" }}
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

      <section aria-labelledby="tasks-filter-tags" style={{ display: "grid", gap: "4px" }}>
        <h3 id="tasks-filter-tags" style={{ margin: 0, "font-size": "0.82rem", color: tokens.color.inkSoft }}>
          برچسب‌ها {props.filters.tagIds.length > 0 ? `(${num(props.filters.tagIds.length)})` : ""}
        </h3>
        <Show
          when={props.tags.length > 0}
          fallback={
            <p style={{ margin: 0, "font-size": "0.78rem", color: tokens.color.inkSoft }}>
              هنوز برچسبی ندارید.
            </p>
          }
        >
          <div style={{ display: "flex", gap: "4px", "flex-wrap": "wrap" }}>
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
        <div style={{ display: "flex", gap: "4px", "flex-wrap": "wrap", "margin-top": "2px" }}>
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
            style={{ ...inputStyle, "font-size": "0.82rem", flex: "1 1 110px", padding: "4px 8px" }}
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

      <label style={fieldStyle}>
        <span style={fieldLabelStyle}>اولویت</span>
        <select
          value={props.filters.priority}
          onChange={(event) =>
            patch({ priority: event.currentTarget.value as Priority | "all" })
          }
          style={inputStyle}
        >
          <For each={priorityOptions}>
            {(option) => <option value={option.value}>{option.label}</option>}
          </For>
        </select>
      </label>

      <label style={fieldStyle}>
        <span style={fieldLabelStyle}>وضعیت</span>
        <select
          value={props.filters.status}
          onChange={(event) =>
            patch({ status: event.currentTarget.value as TaskStatus | "all" })
          }
          style={inputStyle}
        >
          <For each={statusOptions}>
            {(option) => <option value={option.value}>{option.label}</option>}
          </For>
        </select>
      </label>

      <label style={fieldStyle}>
        <span style={fieldLabelStyle}>زمان</span>
        <select
          value={props.filters.date}
          onChange={(event) => patch({ date: event.currentTarget.value as TaskDateFilter })}
          style={inputStyle}
        >
          <For each={dateOptions}>
            {(option) => <option value={option.value}>{option.label}</option>}
          </For>
        </select>
      </label>

      <div style={{ display: "grid", gap: "4px", "grid-template-columns": "minmax(0, 1fr) auto" }}>
        <label style={fieldStyle}>
          <span style={fieldLabelStyle}>مرتب‌سازی</span>
          <select
            value={props.sort.by}
            onChange={(event) =>
              props.onSort({ ...props.sort, by: event.currentTarget.value as TaskSortField })
            }
            style={inputStyle}
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
          style={{ ...pillButtonStyle(true), "align-self": "end", "min-height": "38px" }}
        >
          {props.sort.direction === "asc" ? "↑" : "↓"}
        </button>
      </div>

      <Show when={active() > 0}>
        <button type="button" onClick={() => props.onClear()} style={pillButtonStyle(false)}>
          پاک کردن فیلترها ({num(active())})
        </button>
      </Show>

      <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.72rem", "line-height": "1.8" }}>
        فیلترها و مرتب‌سازی روی همین دستگاه ذخیره می‌شوند.
      </p>
    </div>
  )
}

const projectButtonStyle = (selected: boolean): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  gap: "8px",
  "font-family": tokens.font.sans,
  "font-size": "0.82rem",
  "min-height": "36px",
  padding: "4px 8px",
  "border-radius": tokens.radius.md,
  border: `1px solid ${selected ? tokens.color.brand : "transparent"}`,
  background: selected ? "#eaf0ff" : "transparent",
  color: selected ? tokens.color.brand : tokens.color.ink,
  cursor: "pointer",
  "text-align": "start",
  "min-width": "0"
})

const countStyle = {
  "font-size": "0.72rem",
  color: tokens.color.inkSoft,
  flex: "none"
} as const
