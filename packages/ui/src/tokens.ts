/**
 * Design tokens — the seed of the Solid design-system package (CC-04).
 *
 * Logical-property tokens (start/end) so RTL (Persian) works without flipping
 * left/right. Real token values land with the design-system ticket.
 */
export const tokens = {
  color: {
    brand: "#2f5fe0",
    brandDark: "#22449f",
    accent: "#0f9d8f",
    ink: "#1c2333",
    inkSoft: "#4a5568",
    surface: "#ffffff",
    line: "#e3e7f0"
  },
  radius: {
    md: "8px",
    lg: "14px"
  },
  space: {
    sm: "8px",
    md: "16px",
    lg: "24px"
  },
  font: {
    sans: "'Inter', 'Vazirmatn', system-ui, sans-serif"
  }
} as const

export type Tokens = typeof tokens
