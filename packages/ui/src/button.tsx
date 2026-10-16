import { splitProps, type JSX } from "solid-js"
import { tokens } from "./tokens"

export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost"
}

/**
 * Minimal design-system button. Solid components never import Effect services —
 * they only receive props and render. (See the map §3 boundary rule.)
 */
export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "children"])
  const variant = local.variant ?? "primary"

  return (
    <button
      {...rest}
      style={{
        "font-family": tokens.font.sans,
        "border-radius": tokens.radius.md,
        padding: `${tokens.space.sm} ${tokens.space.md}`,
        border: "1px solid transparent",
        cursor: "pointer",
        "background-color": variant === "primary" ? tokens.color.brand : "transparent",
        color: variant === "primary" ? "#fff" : tokens.color.ink,
        "border-color": variant === "ghost" ? tokens.color.line : "transparent"
      }}
    >
      {local.children}
    </button>
  )
}
