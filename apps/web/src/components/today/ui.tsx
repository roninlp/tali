/**
 * `/today` layout — a dense daily workbench: one panel per section, a compact
 * side rail (next-up / at-a-glance / week), a minute-accurate time strip for
 * timed tasks, and a keyboard-first task list.
 *
 * Colours come from the active daisyUI theme (`--color-*`), so the same sheet
 * works in light, dark and every gallery theme. Layout uses logical properties
 * only, so RTL needs no special case.
 */

export function TodayStyles() {
  return <style>{TODAY_CSS}</style>
}

const TODAY_CSS = `
.today-root {
  --panel: var(--color-base-100);
  --line: var(--color-base-300);
  --muted: color-mix(in oklch, var(--color-base-content) 58%, transparent);
  --soft: color-mix(in oklch, var(--color-base-content) 7%, transparent);
  --brand: var(--color-primary);
  --brand-soft: color-mix(in oklch, var(--color-primary) 12%, var(--color-base-100));
  --ok: var(--color-secondary);
  background: var(--color-base-200);
  color: var(--color-base-content);
  overflow-x: clip;
}

.today-root :focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

/* ── bar ─────────────────────────────────────────────────────────────── */
.today-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.today-bar-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; flex-wrap: wrap; }
.today-bar-title h1 { margin: 0; font-size: 1.45rem; font-weight: 800; letter-spacing: -0.02em; }
.today-bar-title p { margin: 0; color: var(--muted); font-size: 0.8rem; }
.today-bar-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.today-source { display: inline-flex; align-items: center; gap: 6px; margin: 0; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--muted); font-size: 0.72rem; }
.today-source-dot { inline-size: 7px; block-size: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-secondary) 18%, transparent); }
.today-source[data-offline="true"] { color: var(--color-warning); border-color: color-mix(in oklch, var(--color-warning) 35%, var(--line)); background: color-mix(in oklch, var(--color-warning) 8%, var(--panel)); }
.today-source[data-offline="true"] .today-source-dot { background: var(--color-warning); box-shadow: none; }
.today-order-toggle { flex: none; min-height: 34px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--muted); font-family: inherit; font-size: 0.75rem; transition: border-color 120ms ease-out, color 120ms ease-out, background-color 120ms ease-out; }
.today-order-toggle:hover { border-color: var(--brand); color: var(--brand); }
.today-order-toggle[aria-expanded="true"] { border-color: color-mix(in oklch, var(--brand) 40%, var(--line)); background: var(--brand-soft); color: var(--brand); }

/* ── layout ──────────────────────────────────────────────────────────── */
.today-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; align-items: start; gap: 16px; }
.today-col { display: grid; gap: 12px; min-width: 0; }
.today-rail { display: grid; gap: 12px; }

/* ── panels ──────────────────────────────────────────────────────────── */
.today-panel { min-width: 0; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-box); overflow: clip; box-shadow: 0 1px 2px oklch(0% 0 0 / 0.04); }
.today-section { display: grid; }
.today-section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px 10px; }
.today-section-head h2 { margin: 0; font-size: 0.92rem; font-weight: 700; letter-spacing: -0.01em; }
.today-count { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; padding: 0 8px; border-radius: 999px; background: var(--brand-soft); color: var(--brand); font-size: 0.7rem; font-weight: 600; line-height: 1.9; font-variant-numeric: tabular-nums; }
.today-section-body { display: block; min-width: 0; }

/* ── capture ─────────────────────────────────────────────────────────── */
.today-quick { display: flex; gap: 8px; padding: 0 16px 12px; }
.today-quick input { flex: 1; min-width: 0; font: inherit; font-size: 0.85rem; min-height: 38px; padding: 4px 12px; border: 1px solid var(--line); border-radius: var(--radius-field); color: inherit; background: var(--color-base-200); }
.today-quick input:focus-visible { border-color: var(--brand); box-shadow: 0 0 0 3px color-mix(in oklch, var(--brand) 18%, transparent); outline: none; }
.today-quick input::placeholder { color: color-mix(in oklch, var(--color-base-content) 40%, transparent); }
.today-quick button { flex: none; inline-size: 38px; min-height: 38px; padding: 0; border-radius: var(--radius-field); border: 1px solid var(--brand); background: var(--brand); color: var(--color-primary-content); font-size: 1.1rem; line-height: 1; transition: opacity 120ms ease-out, transform 100ms ease-out; }
.today-quick button:hover:not(:disabled) { opacity: 0.9; }
.today-quick button:active:not(:disabled) { transform: scale(0.96); }
.today-quick button:disabled { opacity: 0.4; }

/* ── time strip ──────────────────────────────────────────────────────── */
.today-timeline { padding: 0 16px 8px; }
.today-track { position: relative; block-size: 42px; }
.today-axis { position: absolute; inset-inline: 6px; top: 21px; block-size: 1px; background: var(--soft); }
.today-tick { position: absolute; top: 21px; padding-top: 6px; color: var(--muted); font-size: 0.62rem; line-height: 1; font-variant-numeric: tabular-nums; transform: translateX(50%); }
.today-tick::before { position: absolute; top: 0; inset-inline-start: 50%; inline-size: 1px; block-size: 4px; background: var(--soft); content: ""; }
.today-now { position: absolute; top: 7px; inline-size: 2px; block-size: 27px; border-radius: 2px; background: var(--brand); transform: translateX(50%); }
.today-now::before { position: absolute; top: -3px; inset-inline-start: -2px; inline-size: 6px; block-size: 6px; border-radius: 50%; background: var(--brand); content: ""; }
.today-mark { position: absolute; top: 0; display: grid; place-items: center; inline-size: 36px; block-size: 42px; padding: 0; border: 0; background: transparent; transform: translateX(50%); }
.today-mark::before { inline-size: 10px; block-size: 10px; border: 1.5px solid color-mix(in oklch, var(--color-base-content) 30%, transparent); border-radius: 50%; background: var(--panel); content: ""; transition: transform 120ms ease-out, border-color 120ms ease-out, background-color 120ms ease-out; }
.today-mark:hover::before { border-color: var(--brand); background: var(--brand-soft); transform: scale(1.2); }
.today-mark:active { transform: translateX(50%) scale(0.94); }

/* ── rows ────────────────────────────────────────────────────────────── */
.today-list { list-style: none; margin: 0; padding: 0; display: grid; }
.today-row { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 6px; min-height: 50px; padding: 2px 16px; border-top: 1px solid var(--soft); scroll-margin-block: 80px; transition: background-color 120ms ease-out; }
.today-row:first-child { border-top: 0; }
.today-row:hover { background: color-mix(in oklch, var(--color-base-content) 4%, transparent); }
.today-row[data-cursor="true"] { background: var(--brand-soft); }
.today-check { inline-size: 44px; block-size: 44px; display: grid; place-items: center; border: 0; background: transparent; padding: 0; color: transparent; font-size: 0; }
.today-check::before { inline-size: 19px; block-size: 19px; border: 1.5px solid color-mix(in oklch, var(--color-base-content) 25%, transparent); border-radius: 6px; content: ""; transition: border-color 120ms ease-out, background-color 120ms ease-out; }
.today-check:hover:not(:disabled)::before { border-color: var(--brand); background: var(--brand-soft); }
.today-row-main { min-width: 0; display: grid; gap: 1px; }
.today-row-title { color: inherit; font-size: 0.85rem; font-weight: 500; line-height: 1.75; text-decoration: none; overflow-wrap: anywhere; }
.today-row-title:hover { color: var(--brand); text-decoration: underline; text-underline-offset: 3px; }
.today-row[data-overdue="true"] .today-row-title { color: var(--color-warning); }
.today-row-meta { margin: 0; color: var(--muted); font-size: 0.7rem; line-height: 1.7; overflow-wrap: anywhere; }
.today-row[data-overdue="true"] .today-row-meta { color: color-mix(in oklch, var(--color-warning) 80%, var(--color-base-content)); }
.today-note-dot { inline-size: 8px; block-size: 8px; border-radius: 50%; background: color-mix(in oklch, var(--color-base-content) 25%, transparent); justify-self: center; }
.today-note-excerpt { margin: 0; color: var(--muted); font-size: 0.72rem; line-height: 1.7; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
.today-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.today-action { min-height: 34px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--muted); font-family: inherit; font-size: 0.72rem; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; transition: border-color 120ms ease-out, color 120ms ease-out, background-color 120ms ease-out; }
.today-action:hover { border-color: var(--brand); color: var(--brand); background: var(--brand-soft); }
.today-check:disabled, .today-action:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── hints & empty ───────────────────────────────────────────────────── */
.today-hints { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; padding: 9px 16px; border-top: 1px solid var(--soft); color: var(--muted); font-size: 0.66rem; }
.today-hints kbd { display: inline-grid; place-items: center; min-inline-size: 18px; min-block-size: 18px; margin-inline-end: 4px; padding: 0 4px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; background: var(--color-base-200); color: var(--muted); font-family: inherit; font-size: 0.62rem; }
.today-empty { padding: 4px 16px 14px; display: grid; gap: 6px; }
.today-empty p { margin: 0; color: var(--muted); font-size: 0.8rem; line-height: 1.8; }
.today-empty button, .today-empty a { justify-self: start; min-height: 34px; padding: 0 12px; border-radius: 999px; border: 1px solid color-mix(in oklch, var(--brand) 35%, var(--line)); background: var(--brand-soft); color: var(--brand); font-family: inherit; font-size: 0.76rem; text-decoration: none; display: inline-flex; align-items: center; }
.today-quiet { margin: 0; padding: 0 16px 14px; color: var(--muted); font-size: 0.8rem; line-height: 1.8; }

/* ── rail ────────────────────────────────────────────────────────────── */
.today-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-box); padding: 13px 16px 14px; box-shadow: 0 1px 2px oklch(0% 0 0 / 0.04); }
.today-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
.today-eyebrow { color: var(--muted); font-size: 0.68rem; font-weight: 600; }
.today-next-title { margin: 0; font-size: 0.88rem; font-weight: 600; line-height: 1.7; }
.today-next-meta { margin: 3px 0 0; color: var(--muted); font-size: 0.7rem; line-height: 1.7; }
.today-pill { padding: 2px 8px; border-radius: 999px; background: var(--brand-soft); color: var(--brand); font-size: 0.66rem; font-variant-numeric: tabular-nums; }
.today-card-empty { margin: 0; color: var(--muted); font-size: 0.76rem; line-height: 1.8; }
.today-glance { display: grid; }
.today-glance-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 32px; border-top: 1px solid var(--soft); font-size: 0.76rem; }
.today-glance-row:first-child { border-top: 0; }
.today-glance-row span:last-child { color: var(--muted); font-variant-numeric: tabular-nums; }
.today-glance-row[data-alert="true"] span { color: var(--color-warning); }
.today-week { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; }
.today-week li { display: grid; justify-items: center; gap: 1px; padding: 4px 0; border: 1px solid transparent; border-radius: 8px; }
.today-week li[aria-current="date"] { border-color: color-mix(in oklch, var(--brand) 30%, var(--line)); background: var(--brand-soft); }
.today-week .today-weekday { font-size: 0.58rem; color: var(--muted); line-height: 1.5; }
.today-week .today-day { font-size: 0.82rem; line-height: 1.4; font-variant-numeric: tabular-nums; }
.today-week li[aria-current="date"] .today-day { font-weight: 700; color: var(--brand); }

/* ── order panel / alerts ────────────────────────────────────────────── */
.today-order { padding: 12px 16px 14px; display: grid; gap: 6px; }
.today-order-title { margin: 0; font-size: 0.9rem; line-height: 1.6; }
.today-order-hint { margin: 0 0 4px; color: var(--muted); font-size: 0.72rem; line-height: 1.8; }
.today-order-list { list-style: none; margin: 0; padding: 0; display: grid; }
.today-order-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 40px; border-top: 1px solid var(--soft); }
.today-order-row:first-child { border-top: 0; }
.today-order-name { min-width: 0; font-size: 0.78rem; line-height: 1.7; }
.today-order-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.today-order-move { inline-size: 34px; block-size: 34px; display: grid; place-items: center; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--muted); font-size: 0.9rem; }
.today-order-move:hover:not(:disabled) { border-color: var(--brand); color: var(--brand); background: var(--brand-soft); }
.today-order-move:disabled { opacity: 0.35; cursor: not-allowed; }
.today-order-status { margin: 0; color: var(--muted); font-size: 0.72rem; }
.today-alert { margin: 0; padding: 8px 12px; border-radius: var(--radius-field); background: color-mix(in oklch, var(--color-error) 12%, var(--color-base-100)); color: var(--color-error); font-size: 0.78rem; line-height: 1.7; }
.today-sr { position: absolute; inline-size: 1px; block-size: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.today-habits { padding: 0 16px 12px; }

@media (max-width: 1020px) {
  .today-layout { grid-template-columns: 1fr; }
  .today-rail { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .today-rail > :last-child { grid-column: 1 / -1; }
}

@media (max-width: 560px) {
  .today-shell { padding-top: 12px; }
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
