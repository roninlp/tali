
/**
 * `/calendar` layout (ticket #43; FR-VIEW-02/03).
 *
 * The week is a seven-column grid on a wide screen and a stack of day cards on
 * a phone — the ticket's "horizontal-scroll fallback or a stacked accessible
 * alternative", choosing the stacked variant so the whole page never scrolls
 * sideways at 390px. The month is always a seven-column grid of tappable cells,
 * with the drill-down below it. Everything uses logical properties, so RTL
 * mirrors without a single physical left/right rule.
 */

export const CALENDAR_ROOT_CLASS =
  "calendar-root min-h-dvh overflow-x-clip bg-base-200 text-base-content"

export const CALENDAR_MAIN_CLASS = "page-wrap mx-auto grid max-w-6xl gap-2.5"

export function CalendarStyles() {
  return <style>{CALENDAR_CSS}</style>
}

const CALENDAR_CSS = `
.calendar-root :focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.calendar-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.calendar-head h1 { margin: 0; font-size: 1.35rem; line-height: 1.4; letter-spacing: -0.02em; }
.calendar-head-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-inline-start: auto; }
.calendar-source { margin: 0; color: var(--color-warning); font-size: 0.72rem; line-height: 1.6; }
.calendar-tabs { display: flex; gap: 4px; padding: 3px; background: var(--color-base-100); border: 1px solid var(--color-base-300); border-radius: 999px; }
.calendar-tab { min-height: 40px; padding: 2px 14px; border: 1px solid transparent; border-radius: 999px; background: transparent; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); font-family: inherit; font-size: 0.82rem; }
.calendar-tab[aria-pressed="true"] { background: var(--color-primary); border-color: var(--color-primary); color: var(--color-primary-content); }
.calendar-nav { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.calendar-nav-title { margin: 0; font-size: 0.92rem; line-height: 1.6; min-width: 0; overflow-wrap: anywhere; }
.calendar-nav-button { min-height: 40px; min-width: 40px; padding: 2px 12px; border-radius: 999px; border: 1px solid var(--color-base-300); background: var(--color-base-100); color: color-mix(in oklch, var(--color-base-content) 55%, transparent); font-family: inherit; font-size: 0.78rem; }
.calendar-nav-button:hover:not(:disabled) { border-color: var(--color-primary); color: var(--color-primary); }
.calendar-nav-button:disabled { opacity: 0.45; cursor: not-allowed; }
.calendar-week { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr); min-width: 0; }
.calendar-day-card { min-width: 0; display: grid; gap: 6px; align-content: start; background: var(--color-base-100); border: 1px solid var(--color-base-300); border-radius: var(--radius-box); padding: 8px 10px; }
.calendar-day-card[data-today="true"] { border-color: var(--color-primary); box-shadow: 0 0 0 1px color-mix(in oklch, var(--color-primary) 30%, var(--color-base-300)) inset; }
.calendar-day-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.calendar-day-name { font-size: 0.78rem; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); line-height: 1.6; }
.calendar-day-number { font-size: 1rem; font-weight: 700; line-height: 1.4; }
.calendar-day-card[data-today="true"] .calendar-day-number { color: var(--color-primary); }
.calendar-day-month { font-size: 0.68rem; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); }
.calendar-quick { display: flex; gap: 4px; min-width: 0; }
.calendar-quick input { flex: 1; min-width: 0; box-sizing: border-box; font-family: inherit; font-size: 0.82rem; min-height: 38px; padding: 4px 8px; border: 1px solid var(--color-base-300); border-radius: var(--radius-field); color: inherit; background: var(--color-base-100); }
.calendar-quick button { flex: none; font-family: inherit; font-size: 0.76rem; min-height: 38px; padding: 3px 10px; border-radius: var(--radius-field); border: 1px solid var(--color-primary); background: var(--color-primary); color: var(--color-primary-content); }
.calendar-quick button:disabled { opacity: 0.55; }
.calendar-tasks { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.calendar-task { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 5px; min-width: 0; padding: 2px 0; }
.calendar-task-check { inline-size: 32px; block-size: 32px; flex: none; border-radius: 50%; border: 1.5px solid var(--color-base-300); background: var(--color-base-100); color: color-mix(in oklch, var(--color-base-content) 55%, transparent); font-size: 0.86rem; display: grid; place-items: center; }
.calendar-task-check:hover { border-color: var(--color-secondary); color: var(--color-secondary); }
.calendar-task-body { min-width: 0; display: grid; gap: 1px; }
.calendar-task-title { color: inherit; font-size: 0.84rem; line-height: 1.6; text-decoration: none; overflow-wrap: anywhere; }
.calendar-task-title:hover { text-decoration: underline; }
.calendar-task[data-priority="high"] .calendar-task-title { color: var(--color-warning); }
.calendar-task-badge { justify-self: start; font-size: 0.62rem; line-height: 1.5; color: var(--color-primary); background: color-mix(in oklch, var(--color-primary) 10%, var(--color-base-100)); border: 1px solid color-mix(in oklch, var(--color-primary) 25%, var(--color-base-300)); border-radius: 999px; padding: 0 6px; }
.calendar-task-projected { display: grid; gap: 1px; min-width: 0; }
.calendar-task-projected .calendar-task-title { color: color-mix(in oklch, var(--color-base-content) 55%, transparent); }
.calendar-lanes { list-style: none; margin: 0; padding: 4px 0 0; display: grid; gap: 0; border-top: 1px dashed var(--color-base-300); }
.calendar-lane { font-size: 0.62rem; line-height: 1.6; color: color-mix(in oklch, var(--color-base-content) 42%, transparent); }
.calendar-empty { margin: 0; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); font-size: 0.76rem; line-height: 1.7; }
.calendar-planning { display: grid; gap: 8px; background: var(--color-base-100); border: 1px solid var(--color-base-300); border-radius: var(--radius-box); padding: 8px 10px; }
.calendar-planning h2 { margin: 0; font-size: 0.94rem; line-height: 1.5; }
.calendar-planning-hint { margin: 0; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); font-size: 0.72rem; line-height: 1.7; }
.calendar-plan-day { display: grid; gap: 4px; }
.calendar-plan-date { margin: 0; font-size: 0.76rem; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); }
.calendar-plan-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.calendar-plan-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px; min-width: 0; padding: 4px 0; border-top: 1px solid var(--color-base-300); }
.calendar-plan-row:first-child { border-top: 0; }
.calendar-plan-title { min-width: 0; font-size: 0.82rem; line-height: 1.6; overflow-wrap: anywhere; }
.calendar-plan-controls { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.calendar-plan-controls select { font-family: inherit; font-size: 0.72rem; min-height: 34px; padding: 2px 6px; border: 1px solid var(--color-base-300); border-radius: var(--radius-field); background: var(--color-base-100); color: inherit; }
.calendar-plan-move { font-family: inherit; font-size: 0.68rem; min-height: 34px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--color-base-300); background: var(--color-base-100); color: color-mix(in oklch, var(--color-base-content) 55%, transparent); }
.calendar-plan-move:hover:not(:disabled) { border-color: var(--color-primary); color: var(--color-primary); }
.calendar-plan-move:disabled { opacity: 0.4; cursor: not-allowed; }
.calendar-month-head { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; }
.calendar-month-weekday { text-align: center; font-size: 0.64rem; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); line-height: 1.7; }
.calendar-month { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; min-width: 0; }
.calendar-month-cell { min-width: 0; }
.calendar-month-day { inline-size: 100%; min-width: 0; box-sizing: border-box; display: grid; justify-items: center; align-content: start; gap: 2px; min-height: 44px; padding: 3px 1px; border: 1px solid transparent; border-radius: var(--radius-field); background: var(--color-base-100); color: inherit; font-family: inherit; }
.calendar-month-day[data-outside="true"] { background: var(--color-base-200); color: color-mix(in oklch, var(--color-base-content) 35%, transparent); }
.calendar-month-day[data-busy="true"] { border-color: color-mix(in oklch, var(--color-primary) 30%, var(--color-base-300)); }
.calendar-month-day[aria-pressed="true"] { border-color: var(--color-primary); background: color-mix(in oklch, var(--color-primary) 10%, var(--color-base-100)); }
.calendar-month-day[data-today="true"] { box-shadow: 0 0 0 1px var(--color-primary) inset; }
.calendar-month-number { font-size: 0.8rem; line-height: 1.5; }
.calendar-month-dots { display: flex; gap: 2px; min-height: 4px; }
.calendar-month-dot { inline-size: 4px; block-size: 4px; border-radius: 50%; background: var(--color-primary); opacity: 0.75; }
.calendar-occasion-chips { display: grid; gap: 1px; inline-size: 100%; min-width: 0; justify-items: stretch; }
.calendar-occasion-chip { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.52rem; line-height: 1.5; padding: 0 3px; border-radius: 999px; background: color-mix(in oklch, var(--color-error) 12%, var(--color-base-100)); color: var(--color-error); }
.calendar-occasion-chip[data-more="true"] { text-align: center; background: transparent; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); }
.calendar-detail { display: grid; gap: 6px; background: var(--color-base-100); border: 1px solid var(--color-base-300); border-radius: var(--radius-box); padding: 8px 10px; }
.calendar-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.calendar-detail-head h2 { margin: 0; font-size: 0.94rem; line-height: 1.5; }
.calendar-detail-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.calendar-detail .calendar-quick { margin-top: 2px; }
.calendar-event-add { border: 1px dashed var(--color-base-300); border-radius: var(--radius-field); padding: 2px 6px; }
.calendar-event-add summary { cursor: pointer; font-size: 0.68rem; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); line-height: 1.9; list-style: none; }
.calendar-event-add summary::-webkit-details-marker { display: none; }
.calendar-event-add[open] summary { color: var(--color-primary); }
.calendar-event-form { display: grid; gap: 4px; padding-block: 4px; min-width: 0; }
.calendar-event-form input:not([type="checkbox"]):not([type="radio"]) { width: 100%; box-sizing: border-box; font-family: inherit; font-size: 0.78rem; min-height: 34px; padding: 2px 6px; border: 1px solid var(--color-base-300); border-radius: var(--radius-field); color: inherit; background: var(--color-base-100); }
.calendar-event-form button[type="submit"] { font-family: inherit; font-size: 0.72rem; min-height: 34px; padding: 2px 8px; border-radius: var(--radius-field); border: 1px solid var(--color-primary); background: var(--color-primary); color: var(--color-primary-content); }
.calendar-event-form button[type="submit"]:disabled { opacity: 0.55; }
.calendar-event-check { display: inline-flex; align-items: center; gap: 4px; font-size: 0.7rem; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); }
.calendar-event-times { display: flex; gap: 6px; flex-wrap: wrap; }
.calendar-event-times label { display: inline-flex; align-items: center; gap: 3px; font-size: 0.68rem; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); }
.calendar-event-hint { margin: 0; font-size: 0.66rem; line-height: 1.7; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); }
.calendar-allday { display: grid; gap: 2px; }
.calendar-event-chip { display: flex; align-items: center; gap: 3px; min-width: 0; inline-size: 100%; box-sizing: border-box; padding: 1px 5px; border: 0; border-radius: var(--radius-field); background: color-mix(in oklch, var(--color-secondary) 14%, var(--color-base-100)); color: color-mix(in oklch, var(--color-secondary) 70%, var(--color-base-content)); font-family: inherit; font-size: 0.66rem; line-height: 1.7; text-align: start; }
.calendar-event-chip[data-allday="true"] { background: color-mix(in oklch, var(--color-info) 14%, var(--color-base-100)); color: color-mix(in oklch, var(--color-info) 70%, var(--color-base-content)); }
.calendar-event-chip-month { padding: 0 3px; border-radius: 999px; font-size: 0.5rem; }
.calendar-event-chip-time { flex: none; font-variant-numeric: tabular-nums; opacity: 0.85; }
.calendar-event-chip-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.calendar-event-chip[data-more="true"] { justify-content: center; background: transparent; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); }
.calendar-event-chips { display: grid; gap: 1px; inline-size: 100%; min-width: 0; justify-items: stretch; }
.calendar-events { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.calendar-event-row { min-width: 0; }
.calendar-event-open { display: flex; align-items: center; gap: 5px; inline-size: 100%; min-width: 0; padding: 3px 4px; border: 1px solid transparent; border-radius: var(--radius-field); background: transparent; color: inherit; font-family: inherit; text-align: start; }
.calendar-event-open:hover { border-color: var(--color-base-300); background: var(--color-base-200); }
.calendar-event-time { flex: none; font-size: 0.66rem; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); font-variant-numeric: tabular-nums; }
.calendar-event-title { min-width: 0; font-size: 0.8rem; line-height: 1.6; overflow-wrap: anywhere; }
.calendar-time-grid { position: relative; margin-block: 2px; border-inline-start: 1px solid var(--color-base-300); }
.calendar-hour { block-size: 40px; border-top: 1px solid color-mix(in oklch, var(--color-base-content) 7%, transparent); }
.calendar-hour:first-child { border-top: 0; }
.calendar-hour-label { position: absolute; inset-inline-start: 0; font-size: 0.56rem; color: color-mix(in oklch, var(--color-base-content) 35%, transparent); font-variant-numeric: tabular-nums; transform: translateY(-0.6em); }
.calendar-time-grid { padding-inline-start: 34px; }
.calendar-time-event { position: absolute; inset-inline-start: 34px; inset-inline-end: 2px; display: grid; align-content: start; gap: 0; overflow: hidden; padding: 1px 5px; border: 1px solid color-mix(in oklch, var(--color-secondary) 35%, var(--color-base-300)); border-radius: var(--radius-field); background: color-mix(in oklch, var(--color-secondary) 14%, var(--color-base-100)); color: color-mix(in oklch, var(--color-secondary) 70%, var(--color-base-content)); font-family: inherit; text-align: start; }
.calendar-time-event-time { font-size: 0.6rem; font-variant-numeric: tabular-nums; }
.calendar-time-event-title { font-size: 0.7rem; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.calendar-occasions-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.calendar-occasion-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.calendar-occasion-date { font-size: 0.68rem; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); }
.calendar-occasion-chip-week { inline-size: 100%; box-sizing: border-box; font-size: 0.64rem; }
.calendar-lane-line { margin: 0; }
.calendar-dialog-backdrop { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 12px; background: rgba(15, 23, 42, 0.38); }
.calendar-dialog { inline-size: min(440px, 100%); max-block-size: calc(100dvh - 24px); overflow-y: auto; box-sizing: border-box; display: grid; gap: 8px; padding: 14px; border: 1px solid var(--color-base-300); border-radius: var(--radius-box); background: var(--color-base-100); color: inherit; box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22); }
.calendar-dialog h2 { margin: 0; font-size: 1rem; line-height: 1.5; outline: none; }
.calendar-dialog-hint { margin: 0; font-size: 0.76rem; line-height: 1.8; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); }
.calendar-dialog-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.calendar-field { display: grid; gap: 2px; font-size: 0.7rem; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); }
.calendar-primary { font-family: inherit; font-size: 0.78rem; min-height: 38px; padding: 3px 14px; border-radius: var(--radius-field); border: 1px solid var(--color-primary); background: var(--color-primary); color: var(--color-primary-content); }
.calendar-primary:disabled { opacity: 0.55; }
.calendar-danger { font-family: inherit; font-size: 0.76rem; min-height: 38px; padding: 3px 12px; border-radius: var(--radius-field); border: 1px solid color-mix(in oklch, var(--color-error) 30%, var(--color-base-300)); background: color-mix(in oklch, var(--color-error) 8%, var(--color-base-100)); color: var(--color-error); }
.calendar-danger:disabled { opacity: 0.55; }
.calendar-scope-options { display: grid; gap: 6px; }
.calendar-scope-option { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 6px; padding: 8px; border: 1px solid var(--color-base-300); border-radius: var(--radius-field); background: var(--color-base-100); cursor: pointer; }
.calendar-scope-option[data-selected="true"] { border-color: var(--color-primary); background: color-mix(in oklch, var(--color-primary) 10%, var(--color-base-100)); }
.calendar-scope-option[data-disabled="true"] { opacity: 0.62; cursor: not-allowed; }
.calendar-scope-option span { display: grid; gap: 2px; min-width: 0; }
.calendar-scope-option strong { font-size: 0.82rem; line-height: 1.6; }
.calendar-scope-option small { font-size: 0.68rem; line-height: 1.75; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); }
.calendar-trend { display: grid; gap: 2px; background: var(--color-base-100); border: 1px dashed var(--color-base-300); border-radius: var(--radius-box); padding: 8px 10px; }
.calendar-trend h2 { margin: 0; font-size: 0.88rem; line-height: 1.5; }
.calendar-trend p { margin: 0; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); font-size: 0.72rem; line-height: 1.7; }
.calendar-alert { margin: 0; padding: 6px 10px; border-radius: var(--radius-field); background: color-mix(in oklch, var(--color-error) 12%, var(--color-base-100)); color: var(--color-error); font-size: 0.78rem; line-height: 1.7; }
.calendar-sr { position: absolute; inline-size: 1px; block-size: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (min-width: 860px) {
  .calendar-week { grid-template-columns: repeat(7, minmax(0, 1fr)); align-items: stretch; }
  .calendar-plan-row { grid-template-columns: minmax(0, 1fr) auto; }
}
@media (max-width: 430px) {
  .calendar-tab { padding: 2px 10px; font-size: 0.76rem; }
  .calendar-nav-title { font-size: 0.84rem; }
  .calendar-month-day { min-height: 40px; }
  .calendar-month-number { font-size: 0.74rem; }
  .calendar-month-weekday { font-size: 0.58rem; }
}
@media (prefers-reduced-motion: reduce) {
  .calendar-tab, .calendar-month-day { transition: none; }
}
`
