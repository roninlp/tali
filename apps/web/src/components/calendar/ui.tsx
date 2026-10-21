import type { JSX } from "@solidjs/web"
import { tokens } from "@tali/ui"

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

export const CALENDAR_ROOT: JSX.CSSProperties = {
  direction: "rtl",
  "min-height": "100dvh",
  "font-family": tokens.font.sans,
  color: tokens.color.ink,
  background: "#f7f9fd",
  "overflow-x": "hidden"
}

export const CALENDAR_MAIN: JSX.CSSProperties = {
  padding: "10px 12px 28px",
  display: "grid",
  gap: "10px",
  width: "100%",
  "max-width": "1120px",
  "box-sizing": "border-box",
  "min-width": 0,
  margin: "0 auto"
}

export function CalendarStyles() {
  return <style>{CALENDAR_CSS}</style>
}

const CALENDAR_CSS = `
.calendar-root :focus-visible { outline: 2px solid ${tokens.color.brand}; outline-offset: 2px; }
.calendar-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.calendar-head h1 { margin: 0; font-size: 1.24rem; line-height: 1.4; }
.calendar-head-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-inline-start: auto; }
.calendar-source { margin: 0; color: #8a5a12; font-size: 0.72rem; line-height: 1.6; }
.calendar-tabs { display: flex; gap: 4px; padding: 3px; background: ${tokens.color.surface}; border: 1px solid ${tokens.color.line}; border-radius: 999px; }
.calendar-tab { min-height: 40px; padding: 2px 14px; border: 1px solid transparent; border-radius: 999px; background: transparent; color: ${tokens.color.inkSoft}; font-family: ${tokens.font.sans}; font-size: 0.82rem; }
.calendar-tab[aria-pressed="true"] { background: ${tokens.color.brand}; border-color: ${tokens.color.brand}; color: #fff; }
.calendar-nav { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.calendar-nav-title { margin: 0; font-size: 0.92rem; line-height: 1.6; min-width: 0; overflow-wrap: anywhere; }
.calendar-nav-button { min-height: 40px; min-width: 40px; padding: 2px 12px; border-radius: 999px; border: 1px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.inkSoft}; font-family: ${tokens.font.sans}; font-size: 0.78rem; }
.calendar-nav-button:hover:not(:disabled) { border-color: ${tokens.color.brand}; color: ${tokens.color.brand}; }
.calendar-nav-button:disabled { opacity: 0.45; cursor: not-allowed; }
.calendar-week { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr); min-width: 0; }
.calendar-day-card { min-width: 0; display: grid; gap: 6px; align-content: start; background: ${tokens.color.surface}; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.lg}; padding: 8px 10px; }
.calendar-day-card[data-today="true"] { border-color: ${tokens.color.brand}; box-shadow: 0 0 0 1px #dbe5ff inset; }
.calendar-day-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.calendar-day-name { font-size: 0.78rem; color: ${tokens.color.inkSoft}; line-height: 1.6; }
.calendar-day-number { font-size: 1rem; font-weight: 700; line-height: 1.4; }
.calendar-day-card[data-today="true"] .calendar-day-number { color: ${tokens.color.brand}; }
.calendar-day-month { font-size: 0.68rem; color: ${tokens.color.inkSoft}; }
.calendar-quick { display: flex; gap: 4px; min-width: 0; }
.calendar-quick input { flex: 1; min-width: 0; box-sizing: border-box; font-family: ${tokens.font.sans}; font-size: 0.82rem; min-height: 38px; padding: 4px 8px; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.md}; color: ${tokens.color.ink}; background: ${tokens.color.surface}; }
.calendar-quick button { flex: none; font-family: ${tokens.font.sans}; font-size: 0.76rem; min-height: 38px; padding: 3px 10px; border-radius: ${tokens.radius.md}; border: 1px solid ${tokens.color.brand}; background: ${tokens.color.brand}; color: #fff; }
.calendar-quick button:disabled { opacity: 0.55; }
.calendar-tasks { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.calendar-task { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 5px; min-width: 0; padding: 2px 0; }
.calendar-task-check { inline-size: 32px; block-size: 32px; flex: none; border-radius: 50%; border: 1.5px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.inkSoft}; font-size: 0.86rem; display: grid; place-items: center; }
.calendar-task-check:hover { border-color: ${tokens.color.accent}; color: ${tokens.color.accent}; }
.calendar-task-body { min-width: 0; display: grid; gap: 1px; }
.calendar-task-title { color: ${tokens.color.ink}; font-size: 0.84rem; line-height: 1.6; text-decoration: none; overflow-wrap: anywhere; }
.calendar-task-title:hover { text-decoration: underline; }
.calendar-task[data-priority="high"] .calendar-task-title { color: #8a3a12; }
.calendar-task-badge { justify-self: start; font-size: 0.62rem; line-height: 1.5; color: ${tokens.color.brand}; background: #eef4ff; border: 1px solid #d7e2ff; border-radius: 999px; padding: 0 6px; }
.calendar-task-projected { display: grid; gap: 1px; min-width: 0; }
.calendar-task-projected .calendar-task-title { color: ${tokens.color.inkSoft}; }
.calendar-lanes { list-style: none; margin: 0; padding: 4px 0 0; display: grid; gap: 0; border-top: 1px dashed ${tokens.color.line}; }
.calendar-lane { font-size: 0.62rem; line-height: 1.6; color: #8b95a7; }
.calendar-empty { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.76rem; line-height: 1.7; }
.calendar-planning { display: grid; gap: 8px; background: ${tokens.color.surface}; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.lg}; padding: 8px 10px; }
.calendar-planning h2 { margin: 0; font-size: 0.94rem; line-height: 1.5; }
.calendar-planning-hint { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.72rem; line-height: 1.7; }
.calendar-plan-day { display: grid; gap: 4px; }
.calendar-plan-date { margin: 0; font-size: 0.76rem; color: ${tokens.color.inkSoft}; }
.calendar-plan-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.calendar-plan-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px; min-width: 0; padding: 4px 0; border-top: 1px solid ${tokens.color.line}; }
.calendar-plan-row:first-child { border-top: 0; }
.calendar-plan-title { min-width: 0; font-size: 0.82rem; line-height: 1.6; overflow-wrap: anywhere; }
.calendar-plan-controls { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.calendar-plan-controls select { font-family: ${tokens.font.sans}; font-size: 0.72rem; min-height: 34px; padding: 2px 6px; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.md}; background: ${tokens.color.surface}; color: ${tokens.color.ink}; }
.calendar-plan-move { font-family: ${tokens.font.sans}; font-size: 0.68rem; min-height: 34px; padding: 2px 8px; border-radius: 999px; border: 1px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.inkSoft}; }
.calendar-plan-move:hover:not(:disabled) { border-color: ${tokens.color.brand}; color: ${tokens.color.brand}; }
.calendar-plan-move:disabled { opacity: 0.4; cursor: not-allowed; }
.calendar-month-head { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; }
.calendar-month-weekday { text-align: center; font-size: 0.64rem; color: ${tokens.color.inkSoft}; line-height: 1.7; }
.calendar-month { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; min-width: 0; }
.calendar-month-cell { min-width: 0; }
.calendar-month-day { inline-size: 100%; min-width: 0; box-sizing: border-box; display: grid; justify-items: center; align-content: start; gap: 2px; min-height: 44px; padding: 3px 1px; border: 1px solid transparent; border-radius: ${tokens.radius.md}; background: ${tokens.color.surface}; color: ${tokens.color.ink}; font-family: ${tokens.font.sans}; }
.calendar-month-day[data-outside="true"] { background: #f2f4f9; color: #98a1b3; }
.calendar-month-day[data-busy="true"] { border-color: #dbe5ff; }
.calendar-month-day[aria-pressed="true"] { border-color: ${tokens.color.brand}; background: #eef4ff; }
.calendar-month-day[data-today="true"] { box-shadow: 0 0 0 1px ${tokens.color.brand} inset; }
.calendar-month-number { font-size: 0.8rem; line-height: 1.5; }
.calendar-month-dots { display: flex; gap: 2px; min-height: 4px; }
.calendar-month-dot { inline-size: 4px; block-size: 4px; border-radius: 50%; background: ${tokens.color.brand}; opacity: 0.75; }
.calendar-occasion-chips { display: grid; gap: 1px; inline-size: 100%; min-width: 0; justify-items: stretch; }
.calendar-occasion-chip { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.52rem; line-height: 1.5; padding: 0 3px; border-radius: 999px; background: #fff1f4; color: #9f1239; }
.calendar-occasion-chip[data-more="true"] { text-align: center; background: transparent; color: ${tokens.color.inkSoft}; }
.calendar-detail { display: grid; gap: 6px; background: ${tokens.color.surface}; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.lg}; padding: 8px 10px; }
.calendar-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.calendar-detail-head h2 { margin: 0; font-size: 0.94rem; line-height: 1.5; }
.calendar-detail-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.calendar-detail .calendar-quick { margin-top: 2px; }
.calendar-event-add { border: 1px dashed ${tokens.color.line}; border-radius: ${tokens.radius.md}; padding: 2px 6px; }
.calendar-event-add summary { cursor: pointer; font-size: 0.68rem; color: ${tokens.color.inkSoft}; line-height: 1.9; list-style: none; }
.calendar-event-add summary::-webkit-details-marker { display: none; }
.calendar-event-add[open] summary { color: ${tokens.color.brand}; }
.calendar-event-form { display: grid; gap: 4px; padding-block: 4px; min-width: 0; }
.calendar-event-form input:not([type="checkbox"]):not([type="radio"]) { width: 100%; box-sizing: border-box; font-family: ${tokens.font.sans}; font-size: 0.78rem; min-height: 34px; padding: 2px 6px; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.md}; color: ${tokens.color.ink}; background: ${tokens.color.surface}; }
.calendar-event-form button[type="submit"] { font-family: ${tokens.font.sans}; font-size: 0.72rem; min-height: 34px; padding: 2px 8px; border-radius: ${tokens.radius.md}; border: 1px solid ${tokens.color.brand}; background: ${tokens.color.brand}; color: #fff; }
.calendar-event-form button[type="submit"]:disabled { opacity: 0.55; }
.calendar-event-check { display: inline-flex; align-items: center; gap: 4px; font-size: 0.7rem; color: ${tokens.color.inkSoft}; }
.calendar-event-times { display: flex; gap: 6px; flex-wrap: wrap; }
.calendar-event-times label { display: inline-flex; align-items: center; gap: 3px; font-size: 0.68rem; color: ${tokens.color.inkSoft}; }
.calendar-event-hint { margin: 0; font-size: 0.66rem; line-height: 1.7; color: ${tokens.color.inkSoft}; }
.calendar-allday { display: grid; gap: 2px; }
.calendar-event-chip { display: flex; align-items: center; gap: 3px; min-width: 0; inline-size: 100%; box-sizing: border-box; padding: 1px 5px; border: 0; border-radius: ${tokens.radius.md}; background: #eef7f1; color: #14532d; font-family: ${tokens.font.sans}; font-size: 0.66rem; line-height: 1.7; text-align: start; }
.calendar-event-chip[data-allday="true"] { background: #e8f1ff; color: #1e3a8a; }
.calendar-event-chip-month { padding: 0 3px; border-radius: 999px; font-size: 0.5rem; }
.calendar-event-chip-time { flex: none; font-variant-numeric: tabular-nums; opacity: 0.85; }
.calendar-event-chip-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.calendar-event-chip[data-more="true"] { justify-content: center; background: transparent; color: ${tokens.color.inkSoft}; }
.calendar-event-chips { display: grid; gap: 1px; inline-size: 100%; min-width: 0; justify-items: stretch; }
.calendar-events { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.calendar-event-row { min-width: 0; }
.calendar-event-open { display: flex; align-items: center; gap: 5px; inline-size: 100%; min-width: 0; padding: 3px 4px; border: 1px solid transparent; border-radius: ${tokens.radius.md}; background: transparent; color: ${tokens.color.ink}; font-family: ${tokens.font.sans}; text-align: start; }
.calendar-event-open:hover { border-color: ${tokens.color.line}; background: #f7f9fd; }
.calendar-event-time { flex: none; font-size: 0.66rem; color: ${tokens.color.inkSoft}; font-variant-numeric: tabular-nums; }
.calendar-event-title { min-width: 0; font-size: 0.8rem; line-height: 1.6; overflow-wrap: anywhere; }
.calendar-time-grid { position: relative; margin-block: 2px; border-inline-start: 1px solid ${tokens.color.line}; }
.calendar-hour { block-size: 40px; border-top: 1px solid #eef1f7; }
.calendar-hour:first-child { border-top: 0; }
.calendar-hour-label { position: absolute; inset-inline-start: -30px; font-size: 0.56rem; color: #98a1b3; font-variant-numeric: tabular-nums; transform: translateY(-0.6em); }
.calendar-time-grid { padding-inline-start: 34px; }
.calendar-time-event { position: absolute; inset-inline-start: 34px; inset-inline-end: 2px; display: grid; align-content: start; gap: 0; overflow: hidden; padding: 1px 5px; border: 1px solid #bfd7c7; border-radius: ${tokens.radius.md}; background: #eef7f1; color: #14532d; font-family: ${tokens.font.sans}; text-align: start; }
.calendar-time-event-time { font-size: 0.6rem; font-variant-numeric: tabular-nums; }
.calendar-time-event-title { font-size: 0.7rem; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.calendar-occasions-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.calendar-occasion-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.calendar-occasion-date { font-size: 0.68rem; color: ${tokens.color.inkSoft}; }
.calendar-occasion-chip-week { inline-size: 100%; box-sizing: border-box; font-size: 0.64rem; }
.calendar-lane-line { margin: 0; }
.calendar-dialog-backdrop { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 12px; background: rgba(15, 23, 42, 0.38); }
.calendar-dialog { inline-size: min(440px, 100%); max-block-size: calc(100dvh - 24px); overflow-y: auto; box-sizing: border-box; display: grid; gap: 8px; padding: 14px; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.lg}; background: ${tokens.color.surface}; color: ${tokens.color.ink}; box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22); }
.calendar-dialog h2 { margin: 0; font-size: 1rem; line-height: 1.5; outline: none; }
.calendar-dialog-hint { margin: 0; font-size: 0.76rem; line-height: 1.8; color: ${tokens.color.inkSoft}; }
.calendar-dialog-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.calendar-field { display: grid; gap: 2px; font-size: 0.7rem; color: ${tokens.color.inkSoft}; }
.calendar-primary { font-family: ${tokens.font.sans}; font-size: 0.78rem; min-height: 38px; padding: 3px 14px; border-radius: ${tokens.radius.md}; border: 1px solid ${tokens.color.brand}; background: ${tokens.color.brand}; color: #fff; }
.calendar-primary:disabled { opacity: 0.55; }
.calendar-danger { font-family: ${tokens.font.sans}; font-size: 0.76rem; min-height: 38px; padding: 3px 12px; border-radius: ${tokens.radius.md}; border: 1px solid #f0c6cf; background: #fff5f7; color: #9f1239; }
.calendar-danger:disabled { opacity: 0.55; }
.calendar-scope-options { display: grid; gap: 6px; }
.calendar-scope-option { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 6px; padding: 8px; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.md}; background: ${tokens.color.surface}; cursor: pointer; }
.calendar-scope-option[data-selected="true"] { border-color: ${tokens.color.brand}; background: #eef4ff; }
.calendar-scope-option span { display: grid; gap: 2px; min-width: 0; }
.calendar-scope-option strong { font-size: 0.82rem; line-height: 1.6; }
.calendar-scope-option small { font-size: 0.68rem; line-height: 1.75; color: ${tokens.color.inkSoft}; }
.calendar-trend { display: grid; gap: 2px; background: ${tokens.color.surface}; border: 1px dashed ${tokens.color.line}; border-radius: ${tokens.radius.lg}; padding: 8px 10px; }
.calendar-trend h2 { margin: 0; font-size: 0.88rem; line-height: 1.5; }
.calendar-trend p { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.72rem; line-height: 1.7; }
.calendar-alert { margin: 0; padding: 6px 10px; border-radius: ${tokens.radius.md}; background: #fdecef; color: #9f1239; font-size: 0.78rem; line-height: 1.7; }
.calendar-sr { position: absolute; inline-size: 1px; block-size: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (min-width: 860px) {
  .calendar-week { grid-template-columns: repeat(7, minmax(0, 1fr)); align-items: start; }
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
