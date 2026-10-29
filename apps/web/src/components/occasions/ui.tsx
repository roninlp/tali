import type { JSX } from "@solidjs/web"

/**
 * Occasions panel styles (ticket #59). Logical properties only, so RTL needs no
 * special case; the panel sits inside the calendar screen's existing column.
 * Colours resolve from the active daisyUI theme.
 */

export const OCCASIONS_CARD: JSX.CSSProperties = {
  background: "var(--color-base-100)",
  border: "1px solid var(--color-base-300)",
  "border-radius": "var(--radius-box)",
  padding: "1rem",
  display: "grid",
  gap: "0.5rem",
  "min-width": 0
}

export const OCCASIONS_HEAD: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  gap: "0.5rem",
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
  color: "color-mix(in oklch, var(--color-base-content) 55%, transparent)"
}

export const OCCASIONS_INPUT: JSX.CSSProperties = {
  "font-family": "inherit",
  "font-size": "0.9rem",
  padding: "8px 10px",
  border: "1px solid var(--color-base-300)",
  "border-radius": "var(--radius-field)",
  color: "inherit",
  background: "var(--color-base-100)",
  width: "100%",
  "box-sizing": "border-box",
  "min-height": "42px"
}

export const OCCASIONS_ROW: JSX.CSSProperties = {
  display: "grid",
  gap: "4px",
  padding: "10px 0",
  "border-block-start": "1px solid var(--color-base-300)",
  "min-width": 0
}

export const OCCASIONS_ROW_ACTIONS: JSX.CSSProperties = {
  display: "flex",
  gap: "6px",
  "flex-wrap": "wrap",
  "align-items": "center"
}

export const OCCASIONS_SMALL_BUTTON = (active = false): JSX.CSSProperties => ({
  "font-family": "inherit",
  "font-size": "0.76rem",
  "min-height": "32px",
  padding: "2px 10px",
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

export const OCCASIONS_PRIMARY_BUTTON: JSX.CSSProperties = {
  ...OCCASIONS_SMALL_BUTTON(true),
  background: "var(--color-primary)",
  color: "var(--color-primary-content)",
  border: "1px solid var(--color-primary)"
}

export const OCCASIONS_DANGER_BUTTON: JSX.CSSProperties = {
  ...OCCASIONS_SMALL_BUTTON(),
  color: "var(--color-error)",
  "border-color": "color-mix(in oklch, var(--color-error) 30%, var(--color-base-300))",
  background: "color-mix(in oklch, var(--color-error) 8%, var(--color-base-100))"
}

export const OCCASIONS_META: JSX.CSSProperties = {
  "font-size": "0.8rem",
  color: "color-mix(in oklch, var(--color-base-content) 55%, transparent)"
}

export const OCCASIONS_ALERT: JSX.CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  "border-radius": "var(--radius-field)",
  background: "color-mix(in oklch, var(--color-error) 10%, var(--color-base-100))",
  color: "var(--color-error)",
  "font-size": "0.82rem"
}
