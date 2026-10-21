import type { JSX } from "@solidjs/web"
import { tokens } from "@tali/ui"

/**
 * Occasions panel styles (ticket #59). Logical properties only, so RTL needs no
 * special case; the panel sits inside the calendar screen's existing column.
 */

export const OCCASIONS_CARD: JSX.CSSProperties = {
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.line}`,
  "border-radius": tokens.radius.lg,
  padding: tokens.space.md,
  display: "grid",
  gap: tokens.space.sm,
  "min-width": 0
}

export const OCCASIONS_HEAD: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  gap: tokens.space.sm,
  "flex-wrap": "wrap"
}

export const OCCASIONS_FORM: JSX.CSSProperties = {
  display: "grid",
  gap: "8px",
  "grid-template-columns": "minmax(0, 1fr)",
  "align-items": "end"
}

export const OCCASIONS_FIELD: JSX.CSSProperties = {
  display: "grid",
  gap: "4px",
  "min-width": 0
}

export const OCCASIONS_LABEL: JSX.CSSProperties = {
  "font-size": "0.78rem",
  color: tokens.color.inkSoft
}

export const OCCASIONS_INPUT: JSX.CSSProperties = {
  "font-family": tokens.font.sans,
  "font-size": "0.9rem",
  padding: "8px 10px",
  border: `1px solid ${tokens.color.line}`,
  "border-radius": tokens.radius.md,
  color: tokens.color.ink,
  background: tokens.color.surface,
  width: "100%",
  "box-sizing": "border-box",
  "min-height": "42px"
}

export const OCCASIONS_ROW: JSX.CSSProperties = {
  display: "grid",
  gap: "4px",
  padding: "10px 0",
  "border-block-start": `1px solid ${tokens.color.line}`,
  "min-width": 0
}

export const OCCASIONS_ROW_ACTIONS: JSX.CSSProperties = {
  display: "flex",
  gap: "6px",
  "flex-wrap": "wrap",
  "align-items": "center"
}

export const OCCASIONS_SMALL_BUTTON = (active = false): JSX.CSSProperties => ({
  "font-family": tokens.font.sans,
  "font-size": "0.76rem",
  "min-height": "34px",
  padding: "2px 10px",
  "border-radius": "999px",
  border: `1px solid ${active ? tokens.color.brand : tokens.color.line}`,
  background: active ? "#eaf0ff" : tokens.color.surface,
  color: active ? tokens.color.brand : tokens.color.inkSoft,
  cursor: "pointer",
  flex: "none"
})

export const OCCASIONS_PRIMARY_BUTTON: JSX.CSSProperties = {
  ...OCCASIONS_SMALL_BUTTON(true),
  background: tokens.color.brand,
  color: "#fff",
  border: `1px solid ${tokens.color.brand}`
}

export const OCCASIONS_DANGER_BUTTON: JSX.CSSProperties = {
  ...OCCASIONS_SMALL_BUTTON(),
  color: "#9f1239",
  "border-color": "#f3cbd4",
  background: "#fdf2f4"
}

export const OCCASIONS_META: JSX.CSSProperties = {
  "font-size": "0.8rem",
  color: tokens.color.inkSoft
}

export const OCCASIONS_ALERT: JSX.CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  "border-radius": tokens.radius.md,
  background: "#fdf2f4",
  color: "#9f1239",
  "font-size": "0.82rem"
}
