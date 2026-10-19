import { Show, type ParentProps } from "solid-js"
import type { JSX } from "@solidjs/web"
import { tokens } from "@tali/ui"

/** Shared form primitives for the auth shell (app-local until the design-system tickets land). */

const inputStyle: JSX.CSSProperties = {
  "font-family": tokens.font.sans,
  "font-size": "1rem",
  padding: `${tokens.space.sm} 12px`,
  border: `1px solid ${tokens.color.line}`,
  "border-radius": tokens.radius.md,
  color: tokens.color.ink,
  background: tokens.color.surface,
  width: "100%",
  "box-sizing": "border-box"
}

export function AuthCard(props: {
  title: string
  subtitle?: string
  children: JSX.Element
  footer?: JSX.Element
}) {
  return (
    <main
      dir="rtl"
      lang="fa"
      style={{
        "min-height": "100dvh",
        display: "grid",
        "place-items": "center",
        padding: tokens.space.md,
        background: "linear-gradient(180deg, #f5f8ff 0%, #ffffff 65%)",
        "font-family": tokens.font.sans,
        color: tokens.color.ink
      }}
    >
      <section
        style={{
          width: "min(100%, 390px)",
          display: "grid",
          gap: tokens.space.md,
          padding: tokens.space.lg,
          background: tokens.color.surface,
          border: `1px solid ${tokens.color.line}`,
          "border-radius": tokens.radius.lg,
          "box-shadow": "0 14px 44px rgba(28, 35, 51, 0.08)"
        }}
      >
        <header style={{ display: "grid", gap: "4px" }}>
          <h1 style={{ margin: 0, "font-size": "1.5rem", "line-height": "1.4" }}>{props.title}</h1>
          <Show when={props.subtitle}>
            <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.92rem", "line-height": "1.8" }}>
              {props.subtitle}
            </p>
          </Show>
        </header>
        {props.children}
        {props.footer}
      </section>
    </main>
  )
}

export function Field(props: { label: string; for: string; hint?: string; children: JSX.Element }) {
  return (
    <label for={props.for} style={{ display: "grid", gap: "6px" }}>
      <span style={{ "font-size": "0.9rem", color: tokens.color.inkSoft }}>{props.label}</span>
      {props.children}
      <Show when={props.hint}>
        <span style={{ "font-size": "0.8rem", color: tokens.color.inkSoft, opacity: 0.8 }}>{props.hint}</span>
      </Show>
    </label>
  )
}

export function TextInput(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} style={inputStyle} />
}

export function FormError(props: { message?: string }) {
  return (
    <Show when={props.message}>
      <p
        role="alert"
        style={{
          margin: 0,
          padding: "10px 12px",
          "border-radius": tokens.radius.md,
          background: "#fdecef",
          color: "#9f1239",
          "font-size": "0.88rem",
          "line-height": "1.8"
        }}
      >
        {props.message}
      </p>
    </Show>
  )
}

export function FormActions(props: ParentProps) {
  return <div style={{ display: "grid", gap: tokens.space.sm }}>{props.children}</div>
}

export function AuthFooterLink(props: { href: string; text: string; linkText: string }) {
  return (
    <nav style={{ "font-size": "0.9rem", color: tokens.color.inkSoft, "text-align": "center" }}>
      {props.text}{" "}
      <a href={props.href} style={{ color: tokens.color.brand, "text-decoration": "none" }}>
        {props.linkText}
      </a>
    </nav>
  )
}

export function Splash(props: { message?: string }) {
  return (
    <main
      dir="rtl"
      lang="fa"
      aria-busy="true"
      style={{
        "min-height": "100dvh",
        display: "grid",
        "place-items": "center",
        "font-family": tokens.font.sans,
        color: tokens.color.inkSoft
      }}
    >
      <p>{props.message ?? "در حال بارگذاری…"}</p>
    </main>
  )
}
