import { Show, type ParentProps } from "solid-js"
import type { JSX } from "@solidjs/web"
import { classNames } from "@tali/ui"
import { useTheme } from "../lib/theme"
import { Icon } from "./icons"

/**
 * Shared form primitives built on daisyUI's field components. They carry no
 * colour of their own: every surface, border and focus ring comes from the
 * active theme, so light/dark and gallery themes all work unchanged.
 */

const withClass = (base: string, extra: JSX.ClassValue | undefined): string =>
  classNames(base, extra)

export function AuthCard(props: {
  title: string
  subtitle?: string
  children: JSX.Element
  footer?: JSX.Element
}) {
  const theme = useTheme()
  return (
    <main
      dir="rtl"
      lang="fa"
      class="relative grid min-h-dvh place-items-center overflow-hidden bg-base-200 px-4 py-10"
    >
      {/* Theme-tinted wash: purely decorative, keeps the auth screen from
          reading as a blank grey page. */}
      <div
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_40rem_at_100%_0%,color-mix(in_oklch,var(--color-primary)_14%,transparent),transparent_60%),radial-gradient(50rem_30rem_at_0%_100%,color-mix(in_oklch,var(--color-secondary)_12%,transparent),transparent_60%)]"
      />
      <button
        type="button"
        class="btn btn-ghost btn-circle btn-sm absolute end-4 top-4"
        aria-label={theme.dark() ? "حالت روشن" : "حالت تیره"}
        onClick={() => theme.toggle()}
      >
        <Icon name={theme.dark() ? "sun" : "moon"} class="size-5" />
      </button>
      <section class="card relative w-full max-w-sm border border-base-300 bg-base-100 shadow-xl">
        <div class="card-body gap-5 p-6 sm:p-8">
          <header class="grid gap-2">
            <span class="flex items-center gap-2 text-primary">
              <span class="grid size-9 place-items-center rounded-xl bg-primary text-primary-content shadow-sm">
                <Icon name="sparkles" class="size-5" />
              </span>
              <span class="text-sm font-bold tracking-tight">تالی</span>
            </span>
            <h1 class="text-2xl font-bold tracking-tight">{props.title}</h1>
            <Show when={props.subtitle}>
              <p class="text-sm leading-7 text-base-content/60">{props.subtitle}</p>
            </Show>
          </header>
          {props.children}
          {props.footer}
        </div>
      </section>
    </main>
  )
}

export function Field(props: {
  label: string
  for: string
  hint?: string
  children: JSX.Element
  class?: string
}) {
  return (
    <label for={props.for} class={withClass("grid gap-1.5", props.class)}>
      <span class="text-sm font-medium text-base-content/70">{props.label}</span>
      {props.children}
      <Show when={props.hint}>
        <span class="text-xs text-base-content/50">{props.hint}</span>
      </Show>
    </label>
  )
}

export function TextInput(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      class={withClass("input input-bordered w-full", props.class)}
      style={props.style ?? { "min-height": "2.75rem", "font-size": "1rem" }}
    />
  )
}

export function Select(props: JSX.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      class={withClass("select select-bordered w-full", props.class)}
      style={props.style ?? { "min-height": "2.75rem", "font-size": "1rem" }}
    />
  )
}

export function TextArea(props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      class={withClass("textarea textarea-bordered w-full", props.class)}
      style={props.style ?? { "font-size": "1rem" }}
    />
  )
}

export function FormError(props: { message?: string }) {
  return (
    <Show when={props.message}>
      <div role="alert" class="alert alert-error items-start gap-2 py-2.5 text-sm leading-7">
        <Icon name="bell" class="mt-1 size-4 shrink-0" />
        <span>{props.message}</span>
      </div>
    </Show>
  )
}

export function FormSuccess(props: { message?: string; children?: JSX.Element }) {
  return (
    <Show when={props.message ?? props.children}>
      <div role="status" class="alert alert-success py-2.5 text-sm leading-7">
        <Icon name="check" class="size-4 shrink-0" />
        <span>{props.message ?? props.children}</span>
      </div>
    </Show>
  )
}

export function FormActions(props: ParentProps) {
  return <div class="grid gap-2">{props.children}</div>
}

export function AuthFooterLink(props: { href: string; text: string; linkText: string }) {
  return (
    <nav class="text-center text-sm text-base-content/60">
      {props.text}{" "}
      <a href={props.href} class="link link-primary font-medium">
        {props.linkText}
      </a>
    </nav>
  )
}

export function Splash(props: { message?: string; action?: JSX.Element }) {
  return (
    <main
      dir="rtl"
      lang="fa"
      aria-busy="true"
      class="grid min-h-dvh place-items-center bg-base-200 px-4 text-base-content/60"
    >
      <div class="grid justify-items-center gap-4 text-center">
        <span class="loading loading-spinner loading-lg text-primary" />
        <p class="m-0 text-sm">{props.message ?? "در حال بارگذاری…"}</p>
        {props.action}
      </div>
    </main>
  )
}

/** Inline "nothing here yet" block used by list/board screens. */
export function EmptyState(props: {
  title: string
  hint?: string
  icon?: JSX.Element
  action?: JSX.Element
}) {
  return (
    <div class="grid justify-items-center gap-2 rounded-box border border-dashed border-base-300 bg-base-200/50 px-4 py-8 text-center">
      <Show when={props.icon}>{props.icon}</Show>
      <p class="m-0 font-medium">{props.title}</p>
      <Show when={props.hint}>
        <p class="m-0 max-w-md text-sm leading-7 text-base-content/55">{props.hint}</p>
      </Show>
      {props.action}
    </div>
  )
}
