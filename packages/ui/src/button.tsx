import { omit } from "solid-js"
import type { JSX } from "@solidjs/web"
import { classNames } from "./class-names"

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "accent"
  | "neutral"
  | "ghost"
  | "outline"
  | "soft"
  | "error"
  | "success"

export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: "xs" | "sm" | "md" | "lg"
  /** Square icon-only button. */
  square?: boolean
  /** Show a spinner and disable the button. */
  loading?: boolean
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  accent: "btn-accent",
  neutral: "btn-neutral",
  ghost: "btn-ghost",
  outline: "btn-outline",
  soft: "btn-soft",
  error: "btn-error",
  success: "btn-success"
}

/**
 * Design-system button built on daisyUI's `btn`. Solid components never import
 * Effect services — they only receive props and render.
 */
export function Button(props: ButtonProps) {
  const rest = omit(props, "variant", "size", "square", "loading", "children", "class")

  const variant = () => props.variant ?? "primary"
  const style = () => (typeof props.style === "object" && props.style !== null ? props.style : {})

  const classes = () =>
    classNames(
      "btn",
      VARIANT_CLASS[variant()],
      props.size === undefined || props.size === "md" ? undefined : `btn-${props.size}`,
      props.square === true ? "btn-square" : undefined,
      props.loading === true ? "btn-disabled" : undefined,
      props.class
    )

  return (
    <button
      {...rest}
      class={classes()}
      disabled={props.disabled === true || props.loading === true}
      aria-busy={props.loading === true ? "true" : undefined}
      style={style()}
    >
      {props.loading === true ? <span class="loading loading-spinner loading-xs" /> : null}
      {props.children}
    </button>
  )
}
