import { For, Show } from "solid-js"
import { localizeDigits, type Digits } from "@tali/domain"
import { formatCompletionTime, type TaskRow } from "../../lib/tasks/model"

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
      <p class="m-0 mb-2 mt-1 text-[0.76rem] leading-7 text-base-content/50">
        تا هفت روز قابل بازگردانی است؛ پس از آن بایگانی می‌شود.
      </p>
      <Show
        when={props.tasks.length > 0}
        fallback={
          <p class="m-0 mb-2 text-[0.82rem] text-base-content/50">
            هنوز کاری در این هفته انجام نشده است.
          </p>
        }
      >
        <ul>
          <For each={props.tasks}>
            {(task) => (
              <li>
                <p class="tasks-history-title">{task.title}</p>
                <span class="text-[0.72rem] text-base-content/50">
                  {task.completedAt === null
                    ? ""
                    : formatCompletionTime(task.completedAt, props.timeZone, props.digits)}
                </span>
                <button
                  type="button"
                  aria-label={`بازگرداندن ${task.title}`}
                  onClick={() => props.onRestore(task)}
                  class="btn btn-ghost btn-xs rounded-full px-3 text-[0.76rem] font-normal"
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
