import type { JSX } from "@solidjs/web"

/**
 * `/lists` layout primitives and the scoped stylesheet (ticket #39).
 *
 * Inline styles cover the ordinary cards; the stylesheet exists for the
 * strike-through animation, drag states, the phone/desktop index grid and the
 * toast. Every colour comes from the active daisyUI theme. Logical properties
 * only, so RTL needs no special cases and the 390px layout has no horizontal
 * overflow.
 */

export const LISTS_ROOT_CLASS =
  "lists-root min-h-dvh overflow-x-clip bg-base-200 text-base-content"

export const listsScreenClass = "page-wrap mx-auto grid w-full max-w-5xl gap-4"

export const listsCardStyle: JSX.CSSProperties = {
  background: "var(--color-base-100)",
  border: "1px solid var(--color-base-300)",
  "border-radius": "var(--radius-box)",
  padding: "1rem",
  display: "grid",
  gap: "0.5rem",
  "min-width": 0
}

export const listsInputStyle: JSX.CSSProperties = {
  "font-family": "inherit",
  "font-size": "0.95rem",
  padding: "0.5rem 0.75rem",
  border: "1px solid var(--color-base-300)",
  "border-radius": "var(--radius-field)",
  color: "inherit",
  background: "var(--color-base-100)",
  width: "100%",
  "box-sizing": "border-box",
  "min-width": 0,
  "min-height": "2.5rem"
}

export const listsSelectStyle: JSX.CSSProperties = {
  ...listsInputStyle,
  "min-height": "2.5rem",
  padding: "0.375rem 0.625rem"
}

export const listsSmallButtonStyle = (active = false): JSX.CSSProperties => ({
  "font-family": "inherit",
  "font-size": "0.78rem",
  "min-height": "2rem",
  padding: "0.125rem 0.625rem",
  "border-radius": "999px",
  border: `1px solid ${active ? "var(--color-primary)" : "var(--color-base-300)"}`,
  background: active
    ? "color-mix(in oklch, var(--color-primary) 12%, var(--color-base-100))"
    : "var(--color-base-100)",
  color: active
    ? "var(--color-primary)"
    : "color-mix(in oklch, var(--color-base-content) 65%, transparent)",
  cursor: "pointer",
  flex: "none"
})

export const listsDangerButtonStyle: JSX.CSSProperties = {
  ...listsSmallButtonStyle(),
  color: "var(--color-error)",
  "border-color": "color-mix(in oklch, var(--color-error) 30%, var(--color-base-300))",
  background: "color-mix(in oklch, var(--color-error) 8%, var(--color-base-100))"
}

export const COLOR_CHOICES = [
  "#3558b5",
  "#0f9d8f",
  "#b45309",
  "#9f1239",
  "#6d28d9",
  "#0369a1",
  "#4d7c0f",
  "#a21caf"
] as const

export const ICON_CHOICES = ["🛒", "🏠", "🧳", "🧹", "🎉", "💊", "📚", "✨"] as const

export function ListsStyles() {
  return <style>{LISTS_CSS}</style>
}

const LISTS_CSS = `
.lists-root { direction: rtl; }
.lists-root :focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.lists-index-grid { display: grid; gap: 10px; min-width: 0; }
.lists-index-card { min-width: 0; background: var(--color-base-100); border: 1px solid var(--color-base-300); border-radius: var(--radius-box); padding: 12px 16px; display: grid; gap: 8px; box-shadow: 0 1px 2px oklch(0% 0 0 / 0.04); }
.lists-index-card[data-pending="true"] { border-color: color-mix(in oklch, var(--color-warning) 40%, var(--color-base-300)); background: color-mix(in oklch, var(--color-warning) 5%, var(--color-base-100)); }
.lists-index-link { all: unset; box-sizing: border-box; display: grid; gap: 4px; min-width: 0; cursor: pointer; border-radius: var(--radius-field); }
.lists-index-link:hover .lists-title { color: var(--color-primary); text-decoration: underline; text-underline-offset: 3px; }
.lists-title { margin: 0; font-size: 1.02rem; font-weight: 600; line-height: 1.7; overflow-wrap: anywhere; display: flex; align-items: center; gap: 8px; min-width: 0; }
.lists-title-icon { flex: none; }
.lists-sub { margin: 0; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); font-size: 0.8rem; line-height: 1.8; overflow-wrap: anywhere; }
.lists-preview { margin: 0; padding-inline-start: 1.1em; color: color-mix(in oklch, var(--color-base-content) 50%, transparent); font-size: 0.8rem; line-height: 1.8; }
.lists-preview li { overflow-wrap: anywhere; }
.lists-index-actions { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; align-items: center; }
.lists-detail { display: grid; gap: 16px; min-width: 0; }
.lists-header { display: grid; gap: 8px; min-width: 0; }
.lists-header-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; min-width: 0; }
.lists-header-actions { display: flex; gap: 4px; flex-wrap: wrap; }
.lists-controls { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr); }
.lists-control { display: grid; gap: 4px; min-width: 0; }
.lists-control > span { font-size: 0.78rem; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); }
.lists-items { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; min-width: 0; }
.lists-item { display: flex; align-items: flex-start; gap: 8px; min-width: 0; padding: 6px 10px; background: var(--color-base-100); border: 1px solid var(--color-base-300); border-radius: var(--radius-field); }
.lists-item[data-dragging="true"] { opacity: 0.45; }
.lists-item[data-over="true"] { border-color: var(--color-primary); border-style: dashed; background: color-mix(in oklch, var(--color-primary) 6%, var(--color-base-100)); }
.lists-check { width: 40px; height: 40px; flex: none; border-radius: 50%; border: 1.5px solid var(--color-base-300); background: var(--color-base-100); color: transparent; font-size: 1rem; cursor: pointer; display: grid; place-items: center; transition: background 140ms ease, border-color 140ms ease, color 140ms ease, transform 100ms ease; }
.lists-check:hover { border-color: var(--color-secondary); color: var(--color-secondary); background: color-mix(in oklch, var(--color-secondary) 8%, var(--color-base-100)); }
.lists-check:active { transform: scale(0.92); }
.lists-check[aria-checked="true"] { background: var(--color-secondary); border-color: var(--color-secondary); color: var(--color-secondary-content); }
.lists-item-body { display: grid; gap: 2px; flex: 1; min-width: 0; }
.lists-item-name { position: relative; display: inline; min-width: 0; overflow-wrap: anywhere; line-height: 1.8; transition: color 220ms ease; }
.lists-item-name::after { content: ""; position: absolute; inset-inline-start: 0; top: 52%; height: 1.5px; width: 0; background: currentColor; transition: width 240ms ease; }
.lists-item[data-done="true"] .lists-item-name { color: color-mix(in oklch, var(--color-base-content) 45%, transparent); }
.lists-item[data-done="true"] .lists-item-name::after { width: 100%; }
.lists-item-meta { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; font-size: 0.72rem; color: color-mix(in oklch, var(--color-base-content) 50%, transparent); min-width: 0; }
.lists-item-actions { display: flex; gap: 2px; flex-wrap: wrap; justify-content: flex-end; flex: none; }
.lists-add { display: flex; gap: 8px; align-items: center; min-width: 0; }
.lists-add input { flex: 1; }
.lists-toast { position: fixed; inset-inline: 12px; bottom: 84px; margin-inline: auto; max-width: 420px; z-index: 40; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px 10px 14px; border-radius: var(--radius-box); background: var(--color-neutral); color: var(--color-neutral-content); box-shadow: 0 12px 32px oklch(0% 0 0 / 0.25); animation: lists-toast-in 180ms ease-out; }
.lists-toast p { margin: 0; font-size: 0.86rem; line-height: 1.7; overflow-wrap: anywhere; }
.lists-toast button { font-family: inherit; font-size: 0.82rem; min-height: 36px; padding: 4px 14px; border-radius: 999px; border: 1px solid color-mix(in oklch, var(--color-neutral-content) 40%, transparent); background: transparent; color: var(--color-neutral-content); cursor: pointer; flex: none; }
@keyframes lists-toast-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.lists-empty { margin: 0; color: color-mix(in oklch, var(--color-base-content) 55%, transparent); font-size: 0.86rem; line-height: 1.9; }
.lists-hint { margin: 0; padding: 8px 12px; border-radius: var(--radius-field); background: color-mix(in oklch, var(--color-warning) 10%, var(--color-base-100)); color: var(--color-warning); font-size: 0.82rem; line-height: 1.8; }
@media (min-width: 720px) {
  .lists-index-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .lists-controls { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .lists-toast { bottom: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .lists-item-name, .lists-item-name::after, .lists-check, .lists-toast { transition: none !important; animation: none !important; }
}
`
