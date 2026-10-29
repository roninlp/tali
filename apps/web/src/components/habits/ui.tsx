/**
 * `/habits` and the Today habits lane (ticket #66).
 *
 * Calm, dense and phone-first like `/today`: 44px tap targets, logical
 * properties only (so RTL needs no special case), and colour used for the
 * entry state rather than for decoration. Every colour resolves from the active
 * daisyUI theme; the shared block is what the lane and the screen both need.
 */

export const HABITS_ROOT_CLASS =
  "habits-root min-h-dvh overflow-x-clip bg-base-200 text-base-content"

export const HABITS_MAIN_CLASS = "page-wrap mx-auto grid max-w-4xl gap-2.5"

const COMMON_CSS = `
.habits-root :focus-visible, .habit-lane :focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.habit-tap { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; min-width: 44px; padding: 4px 14px; border-radius: 999px; border: 1px solid var(--color-base-300); background: var(--color-base-200); color: inherit; font-family: inherit; font-size: 0.82rem; cursor: pointer; }
.habit-tap:disabled { opacity: 0.55; cursor: not-allowed; }
.habit-tap[data-status="done"] { border-color: color-mix(in oklch, var(--color-success) 45%, transparent); background: color-mix(in oklch, var(--color-success) 14%, var(--color-base-100)); color: var(--color-success); }
.habit-tap[data-status="partial"] { border-color: color-mix(in oklch, var(--color-warning) 45%, transparent); background: color-mix(in oklch, var(--color-warning) 14%, var(--color-base-100)); color: var(--color-warning); }
.habit-tap[data-status="missed"] { border-color: color-mix(in oklch, var(--color-error) 40%, transparent); background: color-mix(in oklch, var(--color-error) 10%, var(--color-base-100)); color: var(--color-error); }
.habit-badge { display: inline-flex; align-items: center; gap: 4px; flex: none; padding: 1px 9px; border-radius: 999px; background: color-mix(in oklch, var(--color-warning) 14%, var(--color-base-100)); color: var(--color-warning); font-size: 0.74rem; line-height: 1.9; }
.habit-stat { display: grid; gap: 1px; margin-inline-start: auto; text-align: end; min-width: 0; }
.habit-stat-label { color: color-mix(in oklch, var(--color-base-content) 50%, transparent); font-size: 0.68rem; line-height: 1.6; }
.habit-stat-value { font-size: 0.86rem; line-height: 1.7; font-weight: 600; }
.habit-stat-value[data-kind="progress"] { color: var(--color-warning); }
.habit-stat-value[data-kind="none"] { color: color-mix(in oklch, var(--color-base-content) 50%, transparent); }
.habit-stat-note { color: color-mix(in oklch, var(--color-base-content) 45%, transparent); font-size: 0.66rem; line-height: 1.6; }
.habit-lane-empty { display: grid; gap: 6px; justify-items: start; }
.habit-lane-empty p { margin: 0; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); font-size: 0.8rem; line-height: 1.8; }
.habit-lane-empty a { color: var(--color-primary); font-size: 0.8rem; }
.habit-lane-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.habit-lane-windows { display: flex; gap: 4px; flex-wrap: wrap; }
.habit-lane-windows button { font-family: inherit; font-size: 0.76rem; min-height: 32px; padding: 2px 11px; border-radius: 999px; border: 1px solid var(--color-base-300); background: var(--color-base-100); color: color-mix(in oklch, var(--color-base-content) 60%, transparent); cursor: pointer; }
.habit-lane-windows button[aria-pressed="true"] { border-color: var(--color-primary); background: color-mix(in oklch, var(--color-primary) 12%, var(--color-base-100)); color: var(--color-primary); font-weight: 600; }
.habit-lane-list { list-style: none; margin: 0; padding: 0; display: grid; }
.habit-lane-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; align-items: center; padding: 7px 0; border-top: 1px solid color-mix(in oklch, var(--color-base-content) 7%, transparent); }
.habit-lane-row:first-child { border-top: 0; }
.habit-lane-main { min-width: 0; display: grid; gap: 2px; }
.habit-lane-title { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.habit-lane-title strong { font-size: 0.88rem; font-weight: 600; line-height: 1.6; overflow-wrap: anywhere; }
.habit-lane-meta { margin: 0; color: color-mix(in oklch, var(--color-base-content) 50%, transparent); font-size: 0.68rem; line-height: 1.6; overflow-wrap: anywhere; }
.habit-lane-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.habit-lane-alert { margin: 0; color: var(--color-error); font-size: 0.74rem; line-height: 1.7; }
.habit-lane-sr { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); }
.habit-lane { display: grid; gap: 6px; }
`

const SCREEN_CSS = `
.habits-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.habits-head h1 { margin: 0; font-size: 1.45rem; line-height: 1.4; letter-spacing: -0.02em; font-weight: 800; }
.habits-head p { margin: 0; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); font-size: 0.8rem; line-height: 1.8; }
.habits-source { color: var(--color-warning); font-size: 0.72rem; }
.habits-form { background: var(--color-base-100); border: 1px solid var(--color-base-300); border-radius: var(--radius-box); padding: 14px; display: grid; gap: 12px; min-width: 0; box-shadow: 0 1px 2px oklch(0% 0 0 / 0.04); }
.habits-form h2 { margin: 0; font-size: 0.94rem; line-height: 1.5; }
.habits-field { display: grid; gap: 4px; min-width: 0; }
.habits-field > .habits-label { color: color-mix(in oklch, var(--color-base-content) 55%, transparent); font-size: 0.76rem; line-height: 1.7; }
.habits-input { font-family: inherit; font-size: 0.9rem; min-height: 40px; padding: 4px 10px; border: 1px solid var(--color-base-300); border-radius: var(--radius-field); color: inherit; background: var(--color-base-100); width: 100%; box-sizing: border-box; min-width: 0; }
.habits-seg { display: flex; gap: 4px; flex-wrap: wrap; }
.habits-seg button { font-family: inherit; font-size: 0.76rem; min-height: 34px; padding: 2px 12px; border-radius: 999px; border: 1px solid var(--color-base-300); background: var(--color-base-100); color: color-mix(in oklch, var(--color-base-content) 60%, transparent); cursor: pointer; }
.habits-seg button[aria-pressed="true"] { border-color: var(--color-primary); background: color-mix(in oklch, var(--color-primary) 12%, var(--color-base-100)); color: var(--color-primary); font-weight: 600; }
.habits-days { display: flex; gap: 4px; flex-wrap: wrap; }
.habits-day { inline-size: 38px; block-size: 38px; display: grid; place-items: center; border-radius: var(--radius-field); border: 1px solid var(--color-base-300); background: var(--color-base-100); color: color-mix(in oklch, var(--color-base-content) 60%, transparent); font-family: inherit; font-size: 0.78rem; cursor: pointer; }
.habits-day[aria-pressed="true"] { border-color: var(--color-primary); background: color-mix(in oklch, var(--color-primary) 12%, var(--color-base-100)); color: var(--color-primary); font-weight: 700; }
.habits-times { display: flex; align-items: center; gap: 8px; }
.habits-times button { inline-size: 40px; block-size: 40px; display: grid; place-items: center; border-radius: var(--radius-field); border: 1px solid var(--color-base-300); background: var(--color-base-100); color: inherit; font-size: 1rem; cursor: pointer; }
.habits-times output { min-width: 42px; text-align: center; font-size: 0.92rem; }
.habits-swatches, .habits-icons { display: flex; gap: 6px; flex-wrap: wrap; }
.habits-swatch { inline-size: 32px; block-size: 32px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
.habits-swatch[aria-pressed="true"] { border-color: var(--color-base-content); box-shadow: 0 0 0 2px var(--color-base-100) inset; }
.habits-icon { inline-size: 38px; block-size: 38px; display: grid; place-items: center; border-radius: var(--radius-field); border: 1px solid var(--color-base-300); background: var(--color-base-100); font-size: 1.05rem; cursor: pointer; }
.habits-icon[aria-pressed="true"] { border-color: var(--color-primary); background: color-mix(in oklch, var(--color-primary) 12%, var(--color-base-100)); }
.habits-form-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.habits-primary { min-height: 40px; padding: 4px 18px; border-radius: var(--radius-field); border: 1px solid var(--color-primary); background: var(--color-primary); color: var(--color-primary-content); font-family: inherit; font-size: 0.86rem; cursor: pointer; }
.habits-primary:disabled { opacity: 0.55; cursor: not-allowed; }
.habits-ghost { min-height: 40px; padding: 4px 14px; border-radius: var(--radius-field); border: 1px solid var(--color-base-300); background: var(--color-base-100); color: color-mix(in oklch, var(--color-base-content) 65%, transparent); font-family: inherit; font-size: 0.82rem; cursor: pointer; }
.habits-alert { margin: 0; color: var(--color-error); font-size: 0.78rem; line-height: 1.7; }
.habits-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.habit-card { background: var(--color-base-100); border: 1px solid var(--color-base-300); border-inline-start: 4px solid var(--color-primary); border-radius: var(--radius-box); padding: 12px 14px; display: grid; gap: 8px; min-width: 0; box-shadow: 0 1px 2px oklch(0% 0 0 / 0.04); }
.habit-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.habit-card-head h3 { margin: 0; font-size: 0.98rem; line-height: 1.6; overflow-wrap: anywhere; }
.habit-mark { flex: none; inline-size: 1.6rem; display: grid; place-items: center; }
.habit-meta { margin: 0; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); font-size: 0.72rem; line-height: 1.7; }
.habit-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.habit-action { min-height: 32px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--color-base-300); background: var(--color-base-100); color: color-mix(in oklch, var(--color-base-content) 65%, transparent); font-family: inherit; font-size: 0.74rem; cursor: pointer; }
.habit-action[aria-pressed="true"] { border-color: var(--color-primary); background: color-mix(in oklch, var(--color-primary) 12%, var(--color-base-100)); color: var(--color-primary); }
.habit-action--danger { color: var(--color-error); border-color: color-mix(in oklch, var(--color-error) 30%, var(--color-base-300)); background: color-mix(in oklch, var(--color-error) 8%, var(--color-base-100)); }
.habits-heat { display: grid; gap: 6px; border-top: 1px dashed var(--color-base-300); padding-top: 8px; }
.habits-heat-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.habits-heat-head strong { font-size: 0.82rem; }
.habits-heat-nav { inline-size: 32px; block-size: 32px; display: grid; place-items: center; border-radius: var(--radius-field); border: 1px solid var(--color-base-300); background: var(--color-base-100); color: color-mix(in oklch, var(--color-base-content) 65%, transparent); font-size: 0.9rem; cursor: pointer; }
.habits-heat-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 3px; }
.habits-heat-weekday { text-align: center; color: color-mix(in oklch, var(--color-base-content) 45%, transparent); font-size: 0.6rem; line-height: 1.8; }
.habits-heat-cell { aspect-ratio: 1; display: grid; place-items: center; border-radius: 6px; border: 1px solid transparent; background: var(--color-base-200); color: color-mix(in oklch, var(--color-base-content) 50%, transparent); font-size: 0.66rem; }
.habits-heat-cell[data-status="done"] { background: color-mix(in oklch, var(--color-success) 75%, var(--color-base-100)); color: var(--color-success-content); }
.habits-heat-cell[data-status="partial"] { background: color-mix(in oklch, var(--color-warning) 60%, var(--color-base-100)); color: var(--color-warning-content); }
.habits-heat-cell[data-status="missed"] { background: color-mix(in oklch, var(--color-error) 30%, var(--color-base-100)); color: var(--color-error); }
.habits-heat-cell[data-outside="true"] { opacity: 0.35; }
.habits-heat-cell[aria-current="date"] { border-color: var(--color-primary); border-width: 2px; }
.habits-heat-legend { display: flex; gap: 8px; flex-wrap: wrap; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); font-size: 0.68rem; }
.habits-heat-key { display: inline-flex; align-items: center; gap: 4px; }
.habits-heat-dot { inline-size: 10px; block-size: 10px; border-radius: 3px; border: 1px solid var(--color-base-300); background: var(--color-base-200); }
.habits-heat-hint { margin: 0; color: color-mix(in oklch, var(--color-base-content) 45%, transparent); font-size: 0.66rem; line-height: 1.7; }
.habits-toast { position: fixed; inset-block-end: 84px; inset-inline: 12px; margin: 0 auto; max-width: 420px; background: var(--color-neutral); color: var(--color-neutral-content); border-radius: var(--radius-box); padding: 8px 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; z-index: 20; font-size: 0.82rem; box-shadow: 0 12px 32px oklch(0% 0 0 / 0.25); }
.habits-toast button { min-height: 32px; padding: 2px 12px; border-radius: 999px; border: 1px solid color-mix(in oklch, var(--color-neutral-content) 40%, transparent); background: transparent; color: var(--color-neutral-content); font-family: inherit; font-size: 0.8rem; cursor: pointer; }
.habits-sr { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); }
@media (min-width: 640px) { .habits-toast { inset-block-end: 20px; } }
`

const LANE_CSS = `
.habit-lane { display: grid; gap: 6px; }
`

export function HabitStyles() {
  return <style>{COMMON_CSS + SCREEN_CSS + LANE_CSS}</style>
}

export function HabitLaneStyles() {
  return <style>{COMMON_CSS + LANE_CSS}</style>
}
