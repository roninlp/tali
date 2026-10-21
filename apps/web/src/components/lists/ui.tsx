import type { JSX } from "@solidjs/web"
import { tokens } from "@tali/ui"

/**
 * `/lists` layout primitives and the scoped stylesheet (ticket #39).
 *
 * Inline styles cover the ordinary cards; the stylesheet exists for the
 * strike-through animation, drag states, the phone/desktop index grid and the
 * toast. Logical properties only, so RTL needs no special cases and the
 * 390px layout has no horizontal overflow.
 */

export const LISTS_ROOT = {
  direction: "rtl",
  "min-height": "100dvh",
  "font-family": tokens.font.sans,
  color: tokens.color.ink,
  background: "#f7f9fd",
  "overflow-x": "hidden"
} as const

export const listsScreenStyle = {
  padding: tokens.space.lg,
  display: "grid",
  gap: tokens.space.md,
  width: "100%",
  "max-width": "920px",
  "box-sizing": "border-box",
  "min-width": 0,
  margin: "0 auto"
} as const

export const listsCardStyle = {
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.line}`,
  "border-radius": tokens.radius.lg,
  padding: tokens.space.md,
  display: "grid",
  gap: tokens.space.sm,
  "min-width": 0
} as const

export const listsInputStyle: JSX.CSSProperties = {
  "font-family": tokens.font.sans,
  "font-size": "0.95rem",
  padding: `${tokens.space.sm} 12px`,
  border: `1px solid ${tokens.color.line}`,
  "border-radius": tokens.radius.md,
  color: tokens.color.ink,
  background: tokens.color.surface,
  width: "100%",
  "box-sizing": "border-box",
  "min-width": 0,
  "min-height": "44px"
}

export const listsSelectStyle: JSX.CSSProperties = {
  ...listsInputStyle,
  "min-height": "40px",
  padding: "6px 10px"
}

export const listsSmallButtonStyle = (active = false): JSX.CSSProperties => ({
  "font-family": tokens.font.sans,
  "font-size": "0.78rem",
  "min-height": "36px",
  padding: "2px 10px",
  "border-radius": "999px",
  border: `1px solid ${active ? tokens.color.brand : tokens.color.line}`,
  background: active ? "#eaf0ff" : tokens.color.surface,
  color: active ? tokens.color.brand : tokens.color.inkSoft,
  cursor: "pointer",
  flex: "none"
})

export const listsDangerButtonStyle: JSX.CSSProperties = {
  ...listsSmallButtonStyle(),
  color: "#9f1239",
  "border-color": "#f3cbd4",
  background: "#fdf2f4"
}

export const COLOR_CHOICES = [
  "#2f5fe0",
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
.lists-root :focus-visible { outline: 2px solid ${tokens.color.brand}; outline-offset: 2px; }
.lists-index-grid { display: grid; gap: ${tokens.space.sm}; min-width: 0; }
.lists-index-card { min-width: 0; background: ${tokens.color.surface}; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.lg}; padding: 10px ${tokens.space.md}; display: grid; gap: 6px; }
.lists-index-card[data-pending="true"] { border-color: #ecd9b0; background: #fffdf7; }
.lists-index-link { all: unset; box-sizing: border-box; display: grid; gap: 4px; min-width: 0; cursor: pointer; border-radius: ${tokens.radius.md}; }
.lists-index-link:hover .lists-title { text-decoration: underline; }
.lists-title { margin: 0; font-size: 1.02rem; line-height: 1.7; overflow-wrap: anywhere; display: flex; align-items: center; gap: 8px; min-width: 0; }
.lists-title-icon { flex: none; }
.lists-sub { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.8rem; line-height: 1.8; overflow-wrap: anywhere; }
.lists-preview { margin: 0; padding-inline-start: 1.1em; color: ${tokens.color.inkSoft}; font-size: 0.8rem; line-height: 1.8; }
.lists-preview li { overflow-wrap: anywhere; }
.lists-index-actions { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.lists-detail { display: grid; gap: ${tokens.space.md}; min-width: 0; }
.lists-header { display: grid; gap: 8px; min-width: 0; }
.lists-header-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; min-width: 0; }
.lists-header-actions { display: flex; gap: 4px; flex-wrap: wrap; }
.lists-controls { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr); }
.lists-control { display: grid; gap: 4px; min-width: 0; }
.lists-control > span { font-size: 0.78rem; color: ${tokens.color.inkSoft}; }
.lists-items { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; min-width: 0; }
.lists-item { display: flex; align-items: flex-start; gap: 8px; min-width: 0; padding: 6px 10px; background: ${tokens.color.surface}; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.md}; }
.lists-item[data-dragging="true"] { opacity: 0.45; }
.lists-item[data-over="true"] { border-color: ${tokens.color.brand}; border-style: dashed; background: #f3f7ff; }
.lists-check { width: 44px; height: 44px; flex: none; border-radius: 50%; border: 1.5px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.inkSoft}; font-size: 1rem; cursor: pointer; display: grid; place-items: center; transition: background 140ms ease, border-color 140ms ease, transform 100ms ease; }
.lists-check:hover { border-color: ${tokens.color.accent}; color: ${tokens.color.accent}; }
.lists-check:active { transform: scale(0.92); }
.lists-check[aria-checked="true"] { background: ${tokens.color.accent}; border-color: ${tokens.color.accent}; color: #fff; }
.lists-item-body { display: grid; gap: 2px; flex: 1; min-width: 0; }
.lists-item-name { position: relative; display: inline; min-width: 0; overflow-wrap: anywhere; line-height: 1.8; transition: color 220ms ease; }
.lists-item-name::after { content: ""; position: absolute; inset-inline-start: 0; top: 52%; height: 1.5px; width: 0; background: currentColor; transition: width 240ms ease; }
.lists-item[data-done="true"] .lists-item-name { color: ${tokens.color.inkSoft}; }
.lists-item[data-done="true"] .lists-item-name::after { width: 100%; }
.lists-item-meta { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; font-size: 0.72rem; color: ${tokens.color.inkSoft}; min-width: 0; }
.lists-item-actions { display: flex; gap: 2px; flex-wrap: wrap; justify-content: flex-end; flex: none; }
.lists-add { display: flex; gap: 8px; align-items: center; min-width: 0; }
.lists-add input { flex: 1; }
.lists-toast { position: fixed; inset-inline: 12px; bottom: 12px; margin-inline: auto; max-width: 420px; z-index: 40; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-radius: ${tokens.radius.lg}; background: #10251f; color: #fff; box-shadow: 0 10px 30px rgba(16, 37, 31, 0.28); animation: lists-toast-in 180ms ease-out; }
.lists-toast p { margin: 0; font-size: 0.86rem; line-height: 1.7; overflow-wrap: anywhere; }
.lists-toast button { font-family: ${tokens.font.sans}; font-size: 0.84rem; min-height: 40px; padding: 4px 14px; border-radius: 999px; border: 1px solid #7fd3bd; background: transparent; color: #b8f0e2; cursor: pointer; flex: none; }
@keyframes lists-toast-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.lists-empty { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.86rem; line-height: 1.9; }
.lists-hint { margin: 0; padding: 10px 12px; border-radius: ${tokens.radius.md}; background: #eef4ff; color: ${tokens.color.inkSoft}; font-size: 0.82rem; line-height: 1.8; }
@media (min-width: 720px) {
  .lists-index-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .lists-controls { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (prefers-reduced-motion: reduce) {
  .lists-item-name, .lists-item-name::after, .lists-check, .lists-toast { transition: none !important; animation: none !important; }
}
`
