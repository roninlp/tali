import { omit } from "solid-js"
import type { JSX } from "@solidjs/web"
import { tokens } from "./tokens"

export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost"
}

/**
 * Minimal design-system button. Solid components never import Effect services —
 * they only receive props and render. (See the map §3 boundary rule.)
 */
export function Button(props: ButtonProps) {
  const rest = omit(props, "variant", "children")
  const variant = () => props.variant ?? "primary"
  const style = () => (typeof props.style === "object" && props.style !== null ? props.style : {})

  return (
    <button
      {...rest}
      style={{
        "font-family": tokens.font.sans,
        "border-radius": tokens.radius.md,
        padding: `${tokens.space.sm} ${tokens.space.md}`,
        border: "1px solid transparent",
        cursor: props.disabled ? "not-allowed" : "pointer",
        opacity: props.disabled ? 0.6 : 1,
        "background-color": variant() === "primary" ? tokens.color.brand : "transparent",
        color: variant() === "primary" ? "#fff" : tokens.color.ink,
        "border-color": variant() === "ghost" ? tokens.color.line : "transparent",
        ...style()
      }}
    >
      {props.children}
    </button>
  )
}
