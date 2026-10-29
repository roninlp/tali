import type { JSX } from "@solidjs/web"

/**
 * `/tasks` layout primitives (ticket #37).
 *
 * The board needs two things inline styles cannot express — a desktop/mobile
 * layout switch and the completion/toast animations — so the responsive shell
 * lives in one scoped stylesheet here. All colours resolve from the active
 * daisyUI theme, so light, dark and gallery themes share one sheet. Everything
 * uses logical properties and a single column at phone widths.
 */

export const inputStyle: JSX.CSSProperties = {
  "font-family": "inherit",
  "font-size": "0.9rem",
  padding: "6px 10px",
  border: "1px solid var(--color-base-300)",
  "border-radius": "var(--radius-field)",
  color: "inherit",
  background: "var(--color-base-100)",
  width: "100%",
  "box-sizing": "border-box",
  "min-width": 0
}

export const pillButtonStyle = (active: boolean): JSX.CSSProperties => ({
  "font-family": "inherit",
  "font-size": "0.78rem",
  "min-height": "32px",
  padding: "4px 12px",
  "border-radius": "999px",
  border: `1px solid ${active ? "var(--color-primary)" : "var(--color-base-300)"}`,
  background: active
    ? "color-mix(in oklch, var(--color-primary) 12%, var(--color-base-100))"
    : "var(--color-base-100)",
  color: active
    ? "var(--color-primary)"
    : "color-mix(in oklch, var(--color-base-content) 70%, transparent)",
  cursor: "pointer"
})

/**
 * Scoped stylesheet. `prefers-reduced-motion` turns the completion ghost and
 * the toast entrance off; the move buttons make drag non-essential.
 */
export function TasksStyles() {
  return <style>{TASKS_CSS}</style>
}

const TASKS_CSS = `
.tasks-root { direction: rtl; }
.tasks-root :focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.tasks-layout { display: grid; gap: 16px; min-width: 0; grid-template-areas: "toggle" "panel" "main"; }
.tasks-filter-toggle-wrap { grid-area: toggle; display: flex; }
.tasks-filter-toggle { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 6px 16px; border-radius: 999px; border: 1px solid var(--color-base-300); background: var(--color-base-100); color: inherit; font-family: inherit; font-size: 0.85rem; cursor: pointer; }
.tasks-filter-toggle[aria-expanded="true"] { border-color: var(--color-primary); color: var(--color-primary); background: color-mix(in oklch, var(--color-primary) 10%, var(--color-base-100)); }
.tasks-filter-panel { grid-area: panel; display: none; }
.tasks-filter-panel[data-open="true"] { display: grid; }
.tasks-filter-card { min-width: 0; }
.tasks-filter-close { display: inline-flex; align-items: center; justify-content: center; min-height: 38px; padding: 4px 14px; margin-inline-start: auto; border-radius: 999px; border: 1px solid var(--color-base-300); background: var(--color-base-100); color: color-mix(in oklch, var(--color-base-content) 65%, transparent); font-family: inherit; font-size: 0.8rem; cursor: pointer; }
.tasks-main { grid-area: main; display: grid; gap: 16px; min-width: 0; }
.tasks-boards { display: grid; gap: 16px; min-width: 0; }
.tasks-board { min-width: 0; display: grid; gap: 8px; align-content: start; border-radius: var(--radius-box); border: 1px solid var(--color-base-300); background: color-mix(in oklch, var(--color-base-content) 3%, var(--color-base-100)); padding: 12px; transition: background 120ms ease, border-color 120ms ease; }
.tasks-board[data-over="true"] { background: color-mix(in oklch, var(--color-primary) 8%, var(--color-base-100)); border-color: var(--color-primary); border-style: dashed; }
.tasks-board-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.tasks-board-head h2 { margin: 0; font-size: 1rem; letter-spacing: -0.01em; }
.tasks-count { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; padding: 1px 8px; border-radius: 999px; background: color-mix(in oklch, var(--color-primary) 12%, var(--color-base-100)); color: var(--color-primary); font-size: 0.74rem; font-weight: 600; }
.tasks-board-sub { margin: 0 0 2px; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); font-size: 0.76rem; line-height: 1.7; }
.tasks-board ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; min-width: 0; }
.tasks-card { min-width: 0; background: var(--color-base-100); border: 1px solid var(--color-base-300); border-radius: var(--radius-field); padding: 10px 12px; display: grid; gap: 8px; box-shadow: 0 1px 2px oklch(0% 0 0 / 0.04); }
.tasks-card[data-overdue="true"] { background: color-mix(in oklch, var(--color-warning) 7%, var(--color-base-100)); border-color: color-mix(in oklch, var(--color-warning) 35%, var(--color-base-300)); }
.tasks-card:target { border-color: var(--color-primary); background: color-mix(in oklch, var(--color-primary) 7%, var(--color-base-100)); }
.tasks-card[data-dragging="true"] { opacity: 0.5; }
.tasks-card-row { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.tasks-card-title { all: unset; box-sizing: border-box; cursor: pointer; flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 1.75; font-weight: 600; font-size: 0.9rem; }
.tasks-card-title:hover { color: var(--color-primary); text-decoration: underline; text-underline-offset: 3px; }
.tasks-card-done-zone { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.tasks-check { width: 36px; height: 36px; flex: none; border-radius: 50%; border: 1.5px solid var(--color-base-300); background: var(--color-base-100); color: transparent; font-size: 0.9rem; cursor: pointer; display: grid; place-items: center; transition: background 140ms ease, border-color 140ms ease, color 140ms ease, transform 100ms ease; }
.tasks-check:hover { border-color: var(--color-secondary); color: var(--color-secondary); background: color-mix(in oklch, var(--color-secondary) 8%, var(--color-base-100)); }
.tasks-check:active { transform: scale(0.92); }
.tasks-drag-handle { display: none; cursor: grab; color: color-mix(in oklch, var(--color-base-content) 35%, transparent); font-size: 0.9rem; padding: 4px 2px; user-select: none; }
.tasks-meta { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-width: 0; }
.tasks-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; font-size: 0.7rem; line-height: 1.9; border: 1px solid var(--color-base-300); background: var(--color-base-200); color: color-mix(in oklch, var(--color-base-content) 65%, transparent); max-width: 100%; overflow-wrap: anywhere; }
.tasks-chip[data-tone="overdue"] { background: color-mix(in oklch, var(--color-warning) 12%, var(--color-base-100)); border-color: color-mix(in oklch, var(--color-warning) 35%, var(--color-base-300)); color: var(--color-warning); }
.tasks-chip[data-tone="high"] { background: color-mix(in oklch, var(--color-error) 10%, var(--color-base-100)); border-color: color-mix(in oklch, var(--color-error) 30%, var(--color-base-300)); color: var(--color-error); }
.tasks-chip[data-tone="pending"] { background: color-mix(in oklch, var(--color-warning) 12%, var(--color-base-100)); border-color: color-mix(in oklch, var(--color-warning) 30%, var(--color-base-300)); color: var(--color-warning); }
.tasks-moves { display: flex; flex-wrap: wrap; gap: 4px; }
.tasks-move { font-family: inherit; font-size: 0.72rem; min-height: 32px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--color-base-300); background: var(--color-base-100); color: color-mix(in oklch, var(--color-base-content) 65%, transparent); cursor: pointer; }
.tasks-move:hover { border-color: var(--color-primary); color: var(--color-primary); background: color-mix(in oklch, var(--color-primary) 8%, var(--color-base-100)); }
.tasks-editor { display: grid; gap: 8px; border-top: 1px dashed var(--color-base-300); padding-top: 10px; }
.tasks-field { display: grid; gap: 4px; }
.tasks-field > span { font-size: 0.76rem; color: color-mix(in oklch, var(--color-base-content) 60%, transparent); }
.tasks-save-state { font-size: 0.72rem; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); min-height: 1.2em; }
.tasks-save-state[data-state="saved"] { color: var(--color-success); }
.tasks-save-state[data-state="error"] { color: var(--color-error); }
.tasks-ghost { list-style: none; min-width: 0; background: color-mix(in oklch, var(--color-secondary) 10%, var(--color-base-100)); border: 1px solid color-mix(in oklch, var(--color-secondary) 40%, var(--color-base-300)); border-radius: var(--radius-field); padding: 10px; display: flex; align-items: center; gap: 8px; color: var(--color-secondary); animation: tasks-complete 300ms ease-out forwards; }
@keyframes tasks-complete { 0% { opacity: 1; transform: translateY(0); } 60% { opacity: 0.85; } 100% { opacity: 0; transform: translateY(-6px); } }
.tasks-toast { position: fixed; inset-inline: 12px; bottom: 88px; margin-inline: auto; max-width: 420px; z-index: 40; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px 10px 16px; border-radius: var(--radius-box); background: var(--color-neutral); color: var(--color-neutral-content); box-shadow: 0 12px 32px oklch(0% 0 0 / 0.28); animation: tasks-toast-in 180ms ease-out; }
.tasks-toast p { margin: 0; font-size: 0.85rem; line-height: 1.7; overflow-wrap: anywhere; }
.tasks-toast button { font-family: inherit; font-size: 0.8rem; min-height: 36px; padding: 4px 14px; border-radius: 999px; border: 1px solid color-mix(in oklch, var(--color-neutral-content) 35%, transparent); background: transparent; color: var(--color-neutral-content); cursor: pointer; flex: none; }
@keyframes tasks-toast-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.tasks-history { border: 1px solid var(--color-base-300); border-radius: var(--radius-box); background: var(--color-base-100); padding: 8px 16px; }
.tasks-history summary { cursor: pointer; min-height: 40px; display: flex; align-items: center; gap: 8px; font-size: 0.9rem; }
.tasks-history ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.tasks-history li { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 6px 0; border-top: 1px solid var(--color-base-300); min-width: 0; }
.tasks-history .tasks-history-title { margin: 0; font-size: 0.85rem; overflow-wrap: anywhere; min-width: 0; flex: 1; text-decoration: line-through; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); }
@media (min-width: 960px) {
  .tasks-layout { grid-template-columns: 264px minmax(0, 1fr); grid-template-areas: "panel main"; align-items: start; }
  .tasks-filter-toggle-wrap { display: none; }
  .tasks-filter-close { display: none; }
  .tasks-filter-panel { display: grid !important; position: sticky; inset-block-start: 84px; }
  .tasks-boards { grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: start; }
  .tasks-drag-handle { display: inline-flex; }
}
@media (min-width: 960px) {
  .tasks-toast { bottom: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .tasks-ghost, .tasks-toast { animation: none !important; }
  .tasks-board, .tasks-check { transition: none !important; }
}
`
