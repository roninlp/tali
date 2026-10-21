import type { JSX } from "@solidjs/web"
import { tokens } from "@tali/ui"

/**
 * `/today` layout (ticket #42).
 *
 * The daily picture has to be visible without scrolling on a phone, so the
 * dashboard is deliberately denser than the task board: one compact week
 * strip, one-line section headers, 44px inline targets, and no card-in-card
 * padding. Everything is in logical properties so RTL needs no special case.
 */

export const TODAY_ROOT: JSX.CSSProperties = {
  direction: "rtl",
  "min-height": "100dvh",
  "font-family": tokens.font.sans,
  color: tokens.color.ink,
  background: "#f7f9fd",
  "overflow-x": "hidden"
}

export const TODAY_MAIN: JSX.CSSProperties = {
  padding: "10px 12px 20px",
  display: "grid",
  gap: "10px",
  width: "100%",
  "max-width": "720px",
  "box-sizing": "border-box",
  "min-width": 0,
  margin: "0 auto"
}

export function TodayStyles() {
  return <style>{TODAY_CSS}</style>
}

const TODAY_CSS = `
.today-root :focus-visible { outline: 2px solid ${tokens.color.brand}; outline-offset: 2px; }
.today-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.today-head h1 { margin: 0; font-size: 1.22rem; line-height: 1.4; }
.today-date { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.8rem; }
.today-source { margin: 0; color: #8a5a12; font-size: 0.72rem; line-height: 1.6; }
.today-week { list-style: none; margin: 0; padding: 4px 6px; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 3px; background: ${tokens.color.surface}; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.lg}; }
.today-week li { display: grid; justify-items: center; gap: 0; padding: 2px 0; border-radius: ${tokens.radius.md}; border: 1px solid transparent; }
.today-week li[aria-current="date"] { border-color: ${tokens.color.brand}; background: #eaf0ff; }
.today-week .today-weekday { font-size: 0.6rem; color: ${tokens.color.inkSoft}; line-height: 1.5; }
.today-week .today-day { font-size: 0.88rem; line-height: 1.4; }
.today-week li[aria-current="date"] .today-day { font-weight: 700; color: ${tokens.color.brand}; }
.today-section { min-width: 0; background: ${tokens.color.surface}; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.lg}; padding: 8px 10px; display: grid; gap: 6px; }
.today-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.today-section-head h2 { margin: 0; font-size: 0.94rem; line-height: 1.5; }
.today-count { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; padding: 0 7px; border-radius: 999px; background: #eef2fa; color: ${tokens.color.inkSoft}; font-size: 0.72rem; line-height: 1.8; }
.today-quick { display: flex; gap: 6px; }
.today-quick input { flex: 1; min-width: 0; font-family: ${tokens.font.sans}; font-size: 0.88rem; min-height: 40px; padding: 4px 10px; border: 1px solid ${tokens.color.line}; border-radius: ${tokens.radius.md}; color: ${tokens.color.ink}; background: ${tokens.color.surface}; }
.today-quick button { flex: none; font-family: ${tokens.font.sans}; font-size: 0.82rem; min-height: 40px; padding: 4px 14px; border-radius: ${tokens.radius.md}; border: 1px solid ${tokens.color.brand}; background: ${tokens.color.brand}; color: #fff; }
.today-quick button:disabled { opacity: 0.55; }
.today-list { list-style: none; margin: 0; padding: 0; display: grid; }
.today-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 6px; min-height: 42px; padding: 3px 0; border-top: 1px solid ${tokens.color.line}; }
.today-row:first-child { border-top: 0; }
.today-row-main { min-width: 0; display: grid; gap: 1px; }
.today-row-title { color: ${tokens.color.ink}; font-size: 0.9rem; line-height: 1.6; text-decoration: none; overflow-wrap: anywhere; }
.today-row-title:hover { text-decoration: underline; }
.today-row[data-overdue="true"] .today-row-title { color: #8a5a12; }
.today-row-meta { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.7rem; line-height: 1.6; overflow-wrap: anywhere; }
.today-note-excerpt { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.74rem; line-height: 1.6; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
.today-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.today-check { inline-size: 44px; block-size: 44px; flex: none; border-radius: 50%; border: 1.5px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.inkSoft}; font-size: 1rem; display: grid; place-items: center; }
.today-check:hover { border-color: ${tokens.color.accent}; color: ${tokens.color.accent}; }
.today-check:disabled, .today-action:disabled { opacity: 0.5; cursor: not-allowed; }
.today-pin { inline-size: 44px; block-size: 40px; display: grid; place-items: center; font-size: 0.9rem; }
.today-action { font-family: ${tokens.font.sans}; font-size: 0.72rem; min-height: 40px; padding: 2px 10px; border-radius: 999px; border: 1px solid ${tokens.color.line}; background: ${tokens.color.surface}; color: ${tokens.color.inkSoft}; text-decoration: none; display: inline-flex; align-items: center; }
.today-action:hover { border-color: ${tokens.color.brand}; color: ${tokens.color.brand}; }
.today-empty { margin: 0; display: grid; gap: 2px; }
.today-empty p { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.8rem; line-height: 1.7; }
.today-empty button, .today-empty a { justify-self: start; font-family: ${tokens.font.sans}; font-size: 0.78rem; min-height: 40px; padding: 2px 12px; border-radius: 999px; border: 1px solid ${tokens.color.brand}; background: #eef4ff; color: ${tokens.color.brand}; text-decoration: none; display: inline-flex; align-items: center; }
.today-quiet { margin: 0; color: ${tokens.color.inkSoft}; font-size: 0.78rem; line-height: 1.7; }
.today-alert { margin: 0; padding: 6px 10px; border-radius: ${tokens.radius.md}; background: #fdecef; color: #9f1239; font-size: 0.78rem; line-height: 1.7; }
.today-sr { position: absolute; inline-size: 1px; block-size: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (max-width: 430px) {
  .today-week { padding: 2px 4px; }
  .today-week .today-weekday { font-size: 0.56rem; }
  .today-week .today-day { font-size: 0.82rem; }
  .today-row { min-height: 40px; }
}
@media (prefers-reduced-motion: reduce) {
  .today-check { transition: none; }
}
`
