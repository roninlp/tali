import { For, Show } from "solid-js"
import { tokens } from "@tali/ui"
import { localizeDigits, type Digits } from "@tali/domain"
import {
  formatCompletionTime,
  type TaskRow
} from "../../lib/tasks/model"

/**
 * Recent completion history (FR-TASK-06). Completions stay restorable for
 * seven days — the same window TaskService.undo enforces; older rows are
 * archived and deliberately not offered here.
 */
export function CompletionHistory(props: {
  tasks: ReadonlyArray<TaskRow>
  digits: Digits
  timeZone: string
  onRestore: (task: TaskRow) => void
}) {
  return (
    <details class="tasks-history">
      <summary>
        <span>تاریخچهٔ انجام</span>
        <span class="tasks-count">{localizeDigits(props.tasks.length, props.digits)}</span>
      </summary>
      <p
        style={{
          margin: "4px 0 8px",
          color: tokens.color.inkSoft,
          "font-size": "0.76rem",
          "line-height": "1.8"
        }}
      >
        تا هفت روز قابل بازگردانی است؛ پس از آن بایگانی می‌شود.
      </p>
      <Show
        when={props.tasks.length > 0}
        fallback={
          <p style={{ margin: "0 0 8px", color: tokens.color.inkSoft, "font-size": "0.82rem" }}>
            هنوز کاری در این هفته انجام نشده است.
          </p>
        }
      >
        <ul>
          <For each={props.tasks}>
            {(task) => (
              <li>
                <p class="tasks-history-title">{task.title}</p>
                <span style={{ color: tokens.color.inkSoft, "font-size": "0.72rem" }}>
                  {task.completedAt === null
                    ? ""
                    : formatCompletionTime(task.completedAt, props.timeZone, props.digits)}
                </span>
                <button
                  type="button"
                  aria-label={`بازگرداندن ${task.title}`}
                  onClick={() => props.onRestore(task)}
                  style={{
                    "font-family": tokens.font.sans,
                    "font-size": "0.76rem",
                    "min-height": "36px",
                    padding: "2px 12px",
                    "border-radius": "999px",
                    border: `1px solid ${tokens.color.line}`,
                    background: tokens.color.surface,
                    color: tokens.color.inkSoft,
                    cursor: "pointer"
                  }}
                >
                  بازگرداندن
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </details>
  )
}
