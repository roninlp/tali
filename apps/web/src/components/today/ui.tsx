import type { JSX } from "@solidjs/web"
import { tokens } from "@tali/ui"

/**
 * `/today` layout — a dense daily workbench: one hairline panel per section,
 * a compact side rail (next-up / at-a-glance / week), a minute-accurate time
 * strip for timed tasks, and a keyboard-first task list.
 *
 * Layout uses logical properties only, so RTL needs no special case.
 */

export const TODAY_ROOT: JSX.CSSProperties = {
  direction: "rtl",
  "min-height": "100dvh",
  "font-family": tokens.font.sans,
  color: tokens.color.ink,
  background: tokens.color.canvas,
  "overflow-x": "clip"
}

export const TODAY_MAIN: JSX.CSSProperties = {
  width: "min(1180px, calc(100% - 32px))",
  margin: "0 auto",
  padding: "18px 0 64px",
  display: "grid",
  gap: "14px",
  "box-sizing": "border-box",
  "min-width": 0
}

export function TodayStyles() {
  return <style>{TODAY_CSS}</style>
}

const TODAY_CSS = `
.today-root :focus-visible { outline: 2px solid ${tokens.color.brand}; outline-offset: 2px; }
.today-root { --today-panel: ${tokens.color.surface}; --today-line: ${tokens.color.line}; --today-muted: ${tokens.color.inkSoft}; --today-soft: #f0f2f5; }

/* ── bar ─────────────────────────────────────────────────────────────── */
.today-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.today-bar-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.today-bar-title h1 { margin: 0; font-size: 1.28rem; font-weight: 700; letter-spacing: -0.02em; }
.today-bar-title p { margin: 0; color: var(--today-muted); font-size: 0.72rem; }
.today-bar-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.today-source { display: inline-flex; align-items: center; gap: 6px; margin: 0; color: var(--today-muted); font-size: 0.7rem; }
.today-source-dot { inline-size: 7px; block-size: 7px; border-radius: 50%; background: ${tokens.color.accent}; box-shadow: 0 0 0 3px rgba(37, 135, 119, 0.14); }
.today-source[data-offline="true"] { color: #8a5a12; }
.today-source[data-offline="true"] .today-source-dot { background: #c98a1e; box-shadow: none; }
.today-order-toggle { flex: none; min-height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--today-line); background: var(--today-panel); color: var(--today-muted); font-family: ${tokens.font.sans}; font-size: 0.7rem; transition: border-color 120ms ease-out, color 120ms ease-out, background-color 120ms ease-out; }
.today-order-toggle:hover { border-color: ${tokens.color.brand}; color: ${tokens.color.brand}; }
.today-order-toggle[aria-expanded="true"] { border-color: #cdd6ef; background: #eef2fb; color: ${tokens.color.brand}; }

/* ── layout ──────────────────────────────────────────────────────────── */
.today-layout { display: grid; grid-template-columns: minmax(0, 1fr) 296px; align-items: start; gap: 16px; }
.today-col { display: grid; gap: 12px; min-width: 0; }
.today-rail { display: grid; gap: 12px; }

/* ── panels ──────────────────────────────────────────────────────────── */
.today-panel { min-width: 0; background: var(--today-panel); border: 1px solid var(--today-line); border-radius: 12px; overflow: clip; }
.today-section { display: grid; }
.today-section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px 10px; }
.today-section-head h2 { margin: 0; font-size: 0.9rem; font-weight: 700; letter-spacing: -0.01em; }
.today-count { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; padding: 0 7px; border-radius: 999px; background: #eef2fa; color: var(--today-muted); font-size: 0.68rem; line-height: 1.9; font-variant-numeric: tabular-nums; }
.today-section-body { display: block; min-width: 0; }

/* ── capture ─────────────────────────────────────────────────────────── */
.today-quick { display: flex; gap: 8px; padding: 0 16px 10px; }
.today-quick input { flex: 1; min-width: 0; font-family: ${tokens.font.sans}; font-size: 0.82rem; min-height: 38px; padding: 4px 12px; border: 1px solid var(--today-line); border-radius: 8px; color: ${tokens.color.ink}; background: #f7f8fa; }
.today-quick input:focus-visible { border-color: ${tokens.color.brand}; box-shadow: 0 0 0 3px rgba(53, 88, 181, 0.12); }
.today-quick input::placeholder { color: #9aa1ad; }
.today-quick button { flex: none; inline-size: 38px; min-height: 38px; padding: 0; border-radius: 8px; border: 1px solid ${tokens.color.brand}; background: ${tokens.color.brand}; color: #fff; font-size: 1.1rem; line-height: 1; transition: opacity 120ms ease-out; }
.today-quick button:disabled { opacity: 0.4; }

/* ── time strip ──────────────────────────────────────────────────────── */
.today-timeline { padding: 0 16px 8px; }
.today-track { position: relative; block-size: 42px; }
.today-axis { position: absolute; inset-inline: 6px; top: 21px; block-size: 1px; background: #eceef2; }
.today-tick { position: absolute; top: 21px; padding-top: 6px; color: #8b93a1; font-size: 0.62rem; line-height: 1; font-variant-numeric: tabular-nums; transform: translateX(50%); }
.today-tick::before { position: absolute; top: 0; inset-inline-start: 50%; inline-size: 1px; block-size: 4px; background: #e2e5ea; content: ""; }
.today-now { position: absolute; top: 7px; inline-size: 1px; block-size: 27px; background: ${tokens.color.ink}; transform: translateX(50%); }
.today-now::before { position: absolute; top: -3px; inset-inline-start: -2px; inline-size: 5px; block-size: 5px; border-radius: 50%; background: ${tokens.color.ink}; content: ""; }
.today-mark { position: absolute; top: 0; display: grid; place-items: center; inline-size: 36px; block-size: 42px; padding: 0; border: 0; background: transparent; transform: translateX(50%); }
.today-mark::before { inline-size: 9px; block-size: 9px; border: 1.5px solid #a3abb8; border-radius: 50%; background: var(--today-panel); content: ""; transition: transform 120ms ease-out, border-color 120ms ease-out, background-color 120ms ease-out; }
.today-mark:hover::before { border-color: ${tokens.color.brand}; transform: scale(1.2); }
.today-mark:active { transform: translateX(50%) scale(0.94); }

/* ── rows ────────────────────────────────────────────────────────────── */
.today-list { list-style: none; margin: 0; padding: 0; display: grid; }
.today-row { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 6px; min-height: 48px; padding: 2px 16px; border-top: 1px solid var(--today-soft); scroll-margin-block: 80px; transition: background-color 120ms ease-out; }
.today-row:first-child { border-top: 0; }
.today-row:hover { background: #fafbfd; }
.today-row[data-cursor="true"] { background: #f1f4fc; }
.today-check { inline-size: 44px; block-size: 44px; display: grid; place-items: center; border: 0; background: transparent; padding: 0; color: transparent; font-size: 0; }
.today-check::before { inline-size: 18px; block-size: 18px; border: 1.5px solid #ccd2db; border-radius: 5px; content: ""; transition: border-color 120ms ease-out, background-color 120ms ease-out; }
.today-check:hover:not(:disabled)::before { border-color: ${tokens.color.brand}; background: #eef2fb; }
.today-row-main { min-width: 0; display: grid; gap: 1px; }
.today-row-title { color: ${tokens.color.ink}; font-size: 0.82rem; font-weight: 500; line-height: 1.7; text-decoration: none; overflow-wrap: anywhere; }
.today-row-title:hover { text-decoration: underline; }
.today-row[data-overdue="true"] .today-row-title { color: #8a5a12; }
.today-row-meta { margin: 0; color: var(--today-muted); font-size: 0.68rem; line-height: 1.7; overflow-wrap: anywhere; }
.today-row[data-overdue="true"] .today-row-meta { color: #a06a14; }
.today-note-dot { inline-size: 7px; block-size: 7px; border-radius: 50%; background: #c9d0dc; justify-self: center; }
.today-note-excerpt { margin: 0; color: var(--today-muted); font-size: 0.7rem; line-height: 1.7; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
.today-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.today-action { min-height: 34px; padding: 0 10px; border-radius: 7px; border: 1px solid var(--today-line); background: var(--today-panel); color: var(--today-muted); font-family: ${tokens.font.sans}; font-size: 0.68rem; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; transition: border-color 120ms ease-out, color 120ms ease-out; }
.today-action:hover { border-color: ${tokens.color.brand}; color: ${tokens.color.brand}; }
.today-check:disabled, .today-action:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── hints & empty ───────────────────────────────────────────────────── */
.today-hints { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; padding: 9px 16px; border-top: 1px solid var(--today-soft); color: #9aa1ad; font-size: 0.64rem; }
.today-hints kbd { display: inline-grid; place-items: center; min-inline-size: 18px; min-block-size: 18px; margin-inline-end: 4px; padding: 0 4px; border: 1px solid #e2e5ea; border-bottom-width: 2px; border-radius: 4px; background: #fafbfc; color: var(--today-muted); font-family: ${tokens.font.sans}; font-size: 0.62rem; }
.today-empty { padding: 4px 16px 14px; display: grid; gap: 4px; }
.today-empty p { margin: 0; color: var(--today-muted); font-size: 0.76rem; line-height: 1.8; }
.today-empty button, .today-empty a { justify-self: start; min-height: 34px; padding: 0 12px; border-radius: 7px; border: 1px solid #cdd6ef; background: #eef2fb; color: ${tokens.color.brand}; font-family: ${tokens.font.sans}; font-size: 0.7rem; text-decoration: none; display: inline-flex; align-items: center; }
.today-quiet { margin: 0; padding: 0 16px 14px; color: var(--today-muted); font-size: 0.76rem; line-height: 1.8; }

/* ── rail ────────────────────────────────────────────────────────────── */
.today-card { background: var(--today-panel); border: 1px solid var(--today-line); border-radius: 12px; padding: 13px 16px 14px; }
.today-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
.today-eyebrow { color: #8b93a1; font-size: 0.66rem; font-weight: 600; }
.today-next-title { margin: 0; font-size: 0.84rem; font-weight: 600; line-height: 1.7; }
.today-next-meta { margin: 3px 0 0; color: var(--today-muted); font-size: 0.68rem; line-height: 1.7; }
.today-pill { padding: 2px 8px; border-radius: 999px; background: #eef2fb; color: ${tokens.color.brand}; font-size: 0.64rem; font-variant-numeric: tabular-nums; }
.today-card-empty { margin: 0; color: #9aa1ad; font-size: 0.72rem; line-height: 1.8; }
.today-glance { display: grid; }
.today-glance-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 30px; border-top: 1px solid #f2f4f7; font-size: 0.72rem; }
.today-glance-row:first-child { border-top: 0; }
.today-glance-row span:last-child { color: var(--today-muted); font-variant-numeric: tabular-nums; }
.today-glance-row[data-alert="true"] span { color: #a06a14; }
.today-week { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; }
.today-week li { display: grid; justify-items: center; gap: 1px; padding: 4px 0; border: 1px solid transparent; border-radius: 7px; }
.today-week li[aria-current="date"] { border-color: #cdd6ef; background: #eef2fb; }
.today-week .today-weekday { font-size: 0.58rem; color: var(--today-muted); line-height: 1.5; }
.today-week .today-day { font-size: 0.8rem; line-height: 1.4; font-variant-numeric: tabular-nums; }
.today-week li[aria-current="date"] .today-day { font-weight: 700; color: ${tokens.color.brand}; }

/* ── order panel / alerts ────────────────────────────────────────────── */
.today-order { padding: 12px 16px 14px; display: grid; gap: 6px; }
.today-order-title { margin: 0; font-size: 0.86rem; line-height: 1.6; }
.today-order-hint { margin: 0 0 4px; color: var(--today-muted); font-size: 0.7rem; line-height: 1.8; }
.today-order-list { list-style: none; margin: 0; padding: 0; display: grid; }
.today-order-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 40px; border-top: 1px solid #f2f4f7; }
.today-order-row:first-child { border-top: 0; }
.today-order-name { min-width: 0; font-size: 0.76rem; line-height: 1.7; }
.today-order-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.today-order-move { inline-size: 34px; block-size: 34px; display: grid; place-items: center; border-radius: 7px; border: 1px solid var(--today-line); background: var(--today-panel); color: var(--today-muted); font-size: 0.9rem; }
.today-order-move:hover:not(:disabled) { border-color: ${tokens.color.brand}; color: ${tokens.color.brand}; }
.today-order-move:disabled { opacity: 0.35; cursor: not-allowed; }
.today-order-status { margin: 0; color: var(--today-muted); font-size: 0.7rem; }
.today-alert { margin: 0; padding: 8px 12px; border-radius: 8px; background: #fdecef; color: #9f1239; font-size: 0.74rem; line-height: 1.7; }
.today-sr { position: absolute; inline-size: 1px; block-size: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.today-habits { padding: 0 16px 12px; }

@media (max-width: 1020px) {
  .today-layout { grid-template-columns: 1fr; }
  .today-rail { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .today-rail > :last-child { grid-column: 1 / -1; }
}

@media (max-width: 560px) {
  .today-shell { width: calc(100% - 20px) !important; padding-top: 12px !important; }
  .today-bar { align-items: start; flex-direction: column; gap: 8px; }
  .today-rail { grid-template-columns: 1fr; }
  .today-timeline { display: none; }
  .today-hints { display: none; }
  .today-row { padding-inline: 12px; }
  .today-quick { padding-inline: 12px; }
  .today-section-head { padding-inline: 12px; }
  .today-empty, .today-quiet { padding-inline: 12px; }
}

@media (prefers-reduced-motion: reduce) {
  .today-check::before, .today-mark::before, .today-mark { transition: none; }
}
`
