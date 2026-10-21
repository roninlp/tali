import type { JSX } from "@solidjs/web"
import { tokens } from "@tali/ui"

/**
 * `/tasks` layout primitives (ticket #37).
 *
 * The rest of the app styles components inline; the board needs two things
 * inline styles cannot express — a desktop/mobile layout switch and the
 * completion/toast animations — so the responsive shell lives in one scoped
 * stylesheet here. Everything uses logical properties and a single column at
 * phone widths, so RTL and 390px need no special cases.
 */

export const TASKS_ROOT = {
  direction: "rtl",
  "min-height": "100dvh",
  "font-family": tokens.font.sans,
  color: tokens.color.ink,
  background: "#f7f9fd",
  "overflow-x": "hidden"
} as const

export const screenStyle = {
  padding: tokens.space.lg,
  display: "grid",
  gap: tokens.space.md,
  width: "100%",
  "max-width": "1180px",
  "box-sizing": "border-box",
  "min-width": 0,
  margin: "0 auto"
} as const

export const cardStyle = {
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.line}`,
  "border-radius": tokens.radius.lg,
  padding: tokens.space.md,
  display: "grid",
  gap: tokens.space.sm,
  "min-width": 0
} as const

export const hintStyle = {
  margin: 0,
  padding: "10px 12px",
  "border-radius": tokens.radius.md,
  background: "#eef4ff",
  color: tokens.color.inkSoft,
  "font-size": "0.85rem",
  "line-height": "1.8"
} as const

export const groupTitleStyle = {
  margin: `${tokens.space.sm} 0 0`,
  "font-size": "0.82rem",
  color: tokens.color.inkSoft,
  display: "flex",
  "align-items": "center",
  gap: "6px"
} as const

export const pillButtonStyle = (active: boolean): JSX.CSSProperties => ({
  "font-family": tokens.font.sans,
  "font-size": "0.8rem",
  "min-height": "36px",
  padding: "4px 12px",
  "border-radius": "999px",
  border: `1px solid ${active ? tokens.color.brand : tokens.color.line}`,
  background: active ? "#eaf0ff" : tokens.color.surface,
  color: active ? tokens.color.brand : tokens.color.inkSoft,
  cursor: "pointer"
})

export const inputStyle: JSX.CSSProperties = {
  "font-family": tokens.font.sans,
  "font-size": "0.95rem",
  padding: `${tokens.space.sm} 12px`,
  border: `1px solid ${tokens.color.line}`,
  "border-radius": tokens.radius.md,
  color: tokens.color.ink,
  background: tokens.color.surface,
  width: "100%",
  "box-sizing": "border-box",
  "min-width": 0
}

/**
 * Scoped stylesheet. `prefers-reduced-motion` turns the completion ghost and
 * the toast entrance off; the move buttons make drag non-essential.
 */
export function TasksStyles() {
  return <style>{TASKS_CSS}</style>
}

const TASKS_CSS = `
.tasks-root { direction: rtl; }
.tasks-root :focus-visible { outline: 2px solid ${tokens.color.brand}; outline-offset: 2px; }
.tasks-layout { display: grid; gap: ${tokens.space.md}; min-width: 0; grid-template-areas: "toggle" "panel" "main"; }
.tasks-filter-toggle-wrap { grid-area: toggle; display: flex; }
.tasks-filter-toggle { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 6px 14px; border-radius: 999px; border: 1px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.ink}; font-family: ${tokens.font.sans}; font-size: 0.9rem; cursor: pointer; }
.tasks-filter-toggle[aria-expanded="true"] { border-color: ${tokens.color.brand}; color: ${tokens.color.brand}; background: #eaf0ff; }
.tasks-filter-panel { grid-area: panel; display: none; }
.tasks-filter-panel[data-open="true"] { display: grid; }
.tasks-filter-card { min-width: 0; }
.tasks-filter-close { display: inline-flex; align-items: center; justify-content: center; min-height: 40px; padding: 4px 14px; margin-inline-start: auto; border-radius: 999px; border: 1px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.inkSoft}; font-family: ${tokens.font.sans}; font-size: 0.82rem; cursor: pointer; }
.tasks-main { grid-area: main; display: grid; gap: ${tokens.space.md}; min-width: 0; }
.tasks-boards { display: grid; gap: ${tokens.space.md}; min-width: 0; }
.tasks-board { min-width: 0; display: grid; gap: 6px; align-content: start; border-radius: ${tokens.radius.lg}; border: 1px solid transparent; padding: 2px; transition: background 120ms ease, border-color 120ms ease; }
.tasks-board[data-over="true"] { background: #eef4ff; border-color: ${tokens.color.brand}; border-style: dashed; }
.tasks-board-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.tasks-board-head h2 { margin: 0; font-size: 1.05rem; }
.tasks-count { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; padding: 1px 8px; border-radius: 999px; background: #eef2fa; color: ${tokens.color.inkSoft}; font-size: 0.78rem; }
.tasks-board-sub { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.78rem; line-height: 1.7; }
.tasks-board ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; min-width: 0; }
.tasks-card { min-width: 0; background: ${tokens.color.surface}; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.md}; padding: 8px 10px; display: grid; gap: 6px; }
.tasks-card[data-overdue="true"] { background: #fff8ec; border-color: #f0dfc0; }
.tasks-card[data-dragging="true"] { opacity: 0.5; }
.tasks-card-row { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.tasks-card-title { all: unset; box-sizing: border-box; cursor: pointer; flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 1.7; font-weight: 500; }
.tasks-card-title:hover { text-decoration: underline; }
.tasks-card-done-zone { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.tasks-check { width: 44px; height: 44px; flex: none; border-radius: 50%; border: 1.5px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.inkSoft}; font-size: 1rem; cursor: pointer; display: grid; place-items: center; transition: background 140ms ease, border-color 140ms ease, transform 100ms ease; }
.tasks-check:hover { border-color: ${tokens.color.accent}; color: ${tokens.color.accent}; }
.tasks-check:active { transform: scale(0.92); }
.tasks-drag-handle { display: none; cursor: grab; color: ${tokens.color.inkSoft}; font-size: 0.9rem; padding: 4px 2px; user-select: none; }
.tasks-meta { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-width: 0; }
.tasks-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; font-size: 0.72rem; line-height: 1.8; border: 1px solid ${tokens.color.line}; background: #f7f9fd; color: ${tokens.color.inkSoft}; max-width: 100%; overflow-wrap: anywhere; }
.tasks-chip[data-tone="overdue"] { background: #fdf1dd; border-color: #e8d3ae; color: #8a5a12; }
.tasks-chip[data-tone="high"] { background: #fdecef; border-color: #f3cbd4; color: #9f1239; }
.tasks-chip[data-tone="pending"] { background: #fff7e6; border-color: #ecd9b0; color: #92600e; }
.tasks-moves { display: flex; flex-wrap: wrap; gap: 4px; }
.tasks-move { font-family: ${tokens.font.sans}; font-size: 0.74rem; min-height: 44px; padding: 4px 12px; border-radius: 999px; border: 1px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.inkSoft}; cursor: pointer; }
.tasks-move:hover { border-color: ${tokens.color.brand}; color: ${tokens.color.brand}; }
.tasks-editor { display: grid; gap: 8px; border-top: 1px dashed ${tokens.color.line}; padding-top: 8px; }
.tasks-field { display: grid; gap: 4px; }
.tasks-field > span { font-size: 0.78rem; color: ${tokens.color.inkSoft}; }
.tasks-save-state { font-size: 0.72rem; color: ${tokens.color.inkSoft}; min-height: 1.2em; }
.tasks-save-state[data-state="saved"] { color: ${tokens.color.accent}; }
.tasks-save-state[data-state="error"] { color: #9f1239; }
.tasks-ghost { list-style: none; min-width: 0; background: ${tokens.color.surface}; border: 1px solid #bfe6db; border-radius: ${tokens.radius.md}; padding: 10px; display: flex; align-items: center; gap: 8px; color: ${tokens.color.accent}; animation: tasks-complete 300ms ease-out forwards; }
@keyframes tasks-complete { 0% { opacity: 1; transform: translateY(0); } 60% { opacity: 0.85; } 100% { opacity: 0; transform: translateY(-6px); } }
.tasks-toast { position: fixed; inset-inline: 12px; bottom: 12px; margin-inline: auto; max-width: 420px; z-index: 40; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-radius: ${tokens.radius.lg}; background: #10251f; color: #fff; box-shadow: 0 10px 30px rgba(16, 37, 31, 0.28); animation: tasks-toast-in 180ms ease-out; }
.tasks-toast p { margin: 0; font-size: 0.86rem; line-height: 1.7; overflow-wrap: anywhere; }
.tasks-toast button { font-family: ${tokens.font.sans}; font-size: 0.84rem; min-height: 40px; padding: 4px 14px; border-radius: 999px; border: 1px solid #7fd3bd; background: transparent; color: #b8f0e2; cursor: pointer; flex: none; }
@keyframes tasks-toast-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.tasks-history { border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.lg}; background: ${tokens.color.surface}; padding: 8px ${tokens.space.md}; }
.tasks-history summary { cursor: pointer; min-height: 40px; display: flex; align-items: center; gap: 8px; font-size: 0.95rem; }
.tasks-history ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.tasks-history li { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 6px 0; border-top: 1px solid ${tokens.color.line}; min-width: 0; }
.tasks-history .tasks-history-title { margin: 0; font-size: 0.88rem; overflow-wrap: anywhere; min-width: 0; flex: 1; text-decoration: line-through; color: ${tokens.color.inkSoft}; }
@media (min-width: 960px) {
  .tasks-layout { grid-template-columns: 268px minmax(0, 1fr); grid-template-areas: "panel main"; align-items: start; }
  .tasks-filter-toggle-wrap { display: none; }
  .tasks-filter-close { display: none; }
  .tasks-filter-panel { display: grid !important; position: sticky; inset-block-start: ${tokens.space.md}; }
  .tasks-boards { grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: start; }
  .tasks-drag-handle { display: inline-flex; }
}
@media (prefers-reduced-motion: reduce) {
  .tasks-ghost, .tasks-toast { animation: none !important; }
  .tasks-board, .tasks-check { transition: none !important; }
}
`
