/**
 * Design tokens — the seed of the Solid design-system package (CC-04).
 *
 * Layout uses **logical properties** (start/end) so RTL (Persian) mirrors
 * without flipping physical `left`/`right`. The `ms`/`me`/`ps`/`pe` aliases
 * are the shorthand for margin/padding inline-start and inline-end; they reuse
 * the existing space scale rather than introducing new measurements. Concrete
 * design-system values remain with the design-system ticket.
 */

export const space = {
  none: "0",
  sm: "8px",
  md: "16px",
  lg: "24px"
} as const

export type SpaceScale = typeof space

/** `ms` = margin-inline-start, `me` = margin-inline-end, likewise `ps`/`pe`. */
export const logical = {
  ms: space,
  me: space,
  ps: space,
  pe: space
} as const

export const tokens = {
  color: {
    brand: "#3558b5",
    brandDark: "#25438f",
    accent: "#258777",
    ink: "#202938",
    inkSoft: "#626d7d",
    surface: "#ffffff",
    surfaceMuted: "#f9fafc",
    canvas: "#f5f7fb",
    line: "#e4e8ef"
  },
  radius: {
    md: "10px",
    lg: "16px"
  },
  space,
  /** Logical spacing aliases (direction-neutral, no physical left/right). */
  logical,
  font: {
    // Vazirmatn is self-hosted from `base.css`; the rest is the platform stack.
    sans: "'Vazirmatn', system-ui, -apple-system, 'Segoe UI', sans-serif"
  }
} as const

export type Tokens = typeof tokens
