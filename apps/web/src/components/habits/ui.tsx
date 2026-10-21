import { tokens } from "@tali/ui"

/**
 * `/habits` and the Today habits lane (ticket #66).
 *
 * Calm, dense and phone-first like `/today`: 44px tap targets, logical
 * properties only (so RTL needs no special case), and colour used for the
 * entry state rather than for decoration. The shared block is what the lane
 * and the screen both need; the screen adds the form, cards and heatmap.
 */

export const HABITS_ROOT = {
  direction: "rtl",
  "min-height": "100dvh",
  "font-family": tokens.font.sans,
  color: tokens.color.ink,
  background: tokens.color.canvas,
  "overflow-x": "clip"
} as const

export const HABITS_MAIN = {
  padding: "clamp(16px, 3vw, 28px) 16px 32px",
  display: "grid",
  gap: "10px",
  width: "100%",
  "max-width": "880px",
  "box-sizing": "border-box",
  "min-width": 0,
  margin: "0 auto"
} as const

const COMMON_CSS = `
.habits-root :focus-visible, .habit-lane :focus-visible { outline: 2px solid ${tokens.color.brand}; outline-offset: 2px; }
.habit-tap { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; min-width: 44px; padding: 4px 14px; border-radius: 999px; border: 1px solid ${tokens.color.line}; background: ${tokens.color.surfaceMuted}; color: ${tokens.color.ink}; font-family: ${tokens.font.sans}; font-size: 0.84rem; cursor: pointer; }
.habit-tap:disabled { opacity: 0.55; cursor: not-allowed; }
.habit-tap[data-status="done"] { border-color: #2e9d57; background: #eaf7ee; color: #1e6b3a; }
.habit-tap[data-status="partial"] { border-color: #d9822b; background: #fff4e6; color: #8a5a12; }
.habit-tap[data-status="missed"] { border-color: #c94f7c; background: #fdf2f4; color: #9f1239; }
.habit-badge { display: inline-flex; align-items: center; gap: 4px; flex: none; padding: 2px 10px; border-radius: 999px; background: #fff4e6; color: #8a5a12; font-size: 0.76rem; line-height: 1.9; }
.habit-stat { display: grid; gap: 1px; margin-inline-start: auto; text-align: end; min-width: 0; }
.habit-stat-label { color: ${tokens.color.inkSoft}; font-size: 0.68rem; line-height: 1.6; }
.habit-stat-value { font-size: 0.86rem; line-height: 1.7; }
.habit-stat-value[data-kind="progress"] { color: #8a5a12; }
.habit-stat-value[data-kind="none"] { color: ${tokens.color.inkSoft}; }
.habit-stat-note { color: ${tokens.color.inkSoft}; font-size: 0.66rem; line-height: 1.6; }
.habit-lane-empty { display: grid; gap: 6px; }
.habit-lane-empty p { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.8rem; line-height: 1.8; }
.habit-lane-empty a { color: ${tokens.color.brand}; font-size: 0.8rem; }
.habit-lane-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.habit-lane-windows { display: flex; gap: 4px; flex-wrap: wrap; }
.habit-lane-windows button { font-family: ${tokens.font.sans}; font-size: 0.78rem; min-height: 38px; padding: 2px 12px; border-radius: 999px; border: 1px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.inkSoft}; cursor: pointer; }
.habit-lane-windows button[aria-pressed="true"] { border-color: ${tokens.color.brand}; background: #eaf0ff; color: ${tokens.color.brand}; font-weight: 600; }
.habit-lane-list { list-style: none; margin: 0; padding: 0; display: grid; }
.habit-lane-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; align-items: center; padding: 6px 0; border-top: 1px solid ${tokens.color.line}; }
.habit-lane-row:first-child { border-top: 0; }
.habit-lane-main { min-width: 0; display: grid; gap: 2px; }
.habit-lane-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.habit-lane-title strong { font-size: 0.9rem; font-weight: 600; line-height: 1.6; overflow-wrap: anywhere; }
.habit-lane-meta { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.68rem; line-height: 1.6; overflow-wrap: anywhere; }
.habit-lane-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.habit-lane-alert { margin: 0; color: #9f1239; font-size: 0.74rem; line-height: 1.7; }
.habit-lane-sr { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); }
.habit-lane { display: grid; gap: 6px; }
`

const SCREEN_CSS = `
.habits-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.habits-head h1 { margin: 0; font-size: 1.35rem; line-height: 1.4; letter-spacing: -0.02em; }
.habits-head p { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.78rem; line-height: 1.8; }
.habits-source { color: #8a5a12; font-size: 0.72rem; }
.habits-form { background: ${tokens.color.surface}; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.lg}; padding: 10px; display: grid; gap: 10px; min-width: 0; }
.habits-form h2 { margin: 0; font-size: 0.94rem; line-height: 1.5; }
.habits-field { display: grid; gap: 4px; min-width: 0; }
.habits-field > .habits-label { color: ${tokens.color.inkSoft}; font-size: 0.76rem; line-height: 1.7; }
.habits-input { font-family: ${tokens.font.sans}; font-size: 0.92rem; min-height: 44px; padding: 4px 10px; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.md}; color: ${tokens.color.ink}; background: ${tokens.color.surface}; width: 100%; box-sizing: border-box; min-width: 0; }
.habits-seg { display: flex; gap: 4px; flex-wrap: wrap; }
.habits-seg button { font-family: ${tokens.font.sans}; font-size: 0.78rem; min-height: 38px; padding: 2px 12px; border-radius: 999px; border: 1px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.inkSoft}; cursor: pointer; }
.habits-seg button[aria-pressed="true"] { border-color: ${tokens.color.brand}; background: #eaf0ff; color: ${tokens.color.brand}; font-weight: 600; }
.habits-days { display: flex; gap: 4px; flex-wrap: wrap; }
.habits-day { inline-size: 38px; block-size: 38px; display: grid; place-items: center; border-radius: ${tokens.radius.md}; border: 1px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.inkSoft}; font-family: ${tokens.font.sans}; font-size: 0.78rem; cursor: pointer; }
.habits-day[aria-pressed="true"] { border-color: ${tokens.color.brand}; background: #eaf0ff; color: ${tokens.color.brand}; font-weight: 700; }
.habits-times { display: flex; align-items: center; gap: 8px; }
.habits-times button { inline-size: 40px; block-size: 40px; display: grid; place-items: center; border-radius: ${tokens.radius.md}; border: 1px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.ink}; font-size: 1rem; cursor: pointer; }
.habits-times output { min-width: 42px; text-align: center; font-size: 0.92rem; }
.habits-swatches, .habits-icons { display: flex; gap: 6px; flex-wrap: wrap; }
.habits-swatch { inline-size: 32px; block-size: 32px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
.habits-swatch[aria-pressed="true"] { border-color: ${tokens.color.ink}; box-shadow: 0 0 0 2px #fff inset; }
.habits-icon { inline-size: 38px; block-size: 38px; display: grid; place-items: center; border-radius: ${tokens.radius.md}; border: 1px solid ${tokens.color.line}; background: ${tokens.color.surface}; font-size: 1.05rem; cursor: pointer; }
.habits-icon[aria-pressed="true"] { border-color: ${tokens.color.brand}; background: #eaf0ff; }
.habits-form-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.habits-primary { min-height: 44px; padding: 4px 18px; border-radius: ${tokens.radius.md}; border: 1px solid ${tokens.color.brand}; background: ${tokens.color.brand}; color: #fff; font-family: ${tokens.font.sans}; font-size: 0.88rem; cursor: pointer; }
.habits-primary:disabled { opacity: 0.55; cursor: not-allowed; }
.habits-ghost { min-height: 44px; padding: 4px 14px; border-radius: ${tokens.radius.md}; border: 1px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.inkSoft}; font-family: ${tokens.font.sans}; font-size: 0.82rem; cursor: pointer; }
.habits-alert { margin: 0; color: #9f1239; font-size: 0.78rem; line-height: 1.7; }
.habits-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.habit-card { background: ${tokens.color.surface}; border: 1px solid ${tokens.color.line}; border-inline-start: 4px solid ${tokens.color.brand}; border-radius: ${tokens.radius.lg}; padding: 10px; display: grid; gap: 8px; min-width: 0; }
.habit-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.habit-card-head h3 { margin: 0; font-size: 0.98rem; line-height: 1.6; overflow-wrap: anywhere; }
.habit-mark { flex: none; inline-size: 1.6rem; display: grid; place-items: center; }
.habit-meta { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.72rem; line-height: 1.7; }
.habit-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.habit-action { min-height: 36px; padding: 2px 10px; border-radius: 999px; border: 1px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.inkSoft}; font-family: ${tokens.font.sans}; font-size: 0.76rem; cursor: pointer; }
.habit-action[aria-pressed="true"] { border-color: ${tokens.color.brand}; background: #eaf0ff; color: ${tokens.color.brand}; }
.habit-action--danger { color: #9f1239; border-color: #f3cbd4; background: #fdf2f4; }
.habits-heat { display: grid; gap: 6px; border-top: 1px dashed ${tokens.color.line}; padding-top: 8px; }
.habits-heat-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.habits-heat-head strong { font-size: 0.82rem; }
.habits-heat-nav { inline-size: 34px; block-size: 34px; display: grid; place-items: center; border-radius: ${tokens.radius.md}; border: 1px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.inkSoft}; font-size: 0.9rem; cursor: pointer; }
.habits-heat-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 3px; }
.habits-heat-weekday { text-align: center; color: ${tokens.color.inkSoft}; font-size: 0.6rem; line-height: 1.8; }
.habits-heat-cell { aspect-ratio: 1; display: grid; place-items: center; border-radius: 6px; border: 1px solid transparent; background: #f1f4fa; color: ${tokens.color.inkSoft}; font-size: 0.66rem; }
.habits-heat-cell[data-status="done"] { background: #2e9d57; color: #fff; }
.habits-heat-cell[data-status="partial"] { background: #e8b25c; color: #3b2a10; }
.habits-heat-cell[data-status="missed"] { background: #f3cbd4; color: #9f1239; }
.habits-heat-cell[data-outside="true"] { opacity: 0.35; }
.habits-heat-cell[aria-current="date"] { border-color: ${tokens.color.brand}; }
.habits-heat-legend { display: flex; gap: 8px; flex-wrap: wrap; color: ${tokens.color.inkSoft}; font-size: 0.68rem; }
.habits-heat-key { display: inline-flex; align-items: center; gap: 4px; }
.habits-heat-dot { inline-size: 10px; block-size: 10px; border-radius: 3px; border: 1px solid ${tokens.color.line}; }
.habits-heat-hint { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.66rem; line-height: 1.7; }
.habits-toast { position: fixed; inset-block-end: 14px; inset-inline: 12px; margin: 0 auto; max-width: 420px; background: ${tokens.color.ink}; color: #fff; border-radius: 999px; padding: 8px 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; z-index: 20; font-size: 0.82rem; }
.habits-toast button { min-height: 34px; padding: 2px 12px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.5); background: transparent; color: #fff; font-family: ${tokens.font.sans}; font-size: 0.8rem; cursor: pointer; }
.habits-sr { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); }
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
