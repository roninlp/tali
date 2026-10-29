import { For, Show } from "solid-js"
import type { JSX } from "@solidjs/web"
import { Button, tokens } from "@tali/ui"
import { useAuth } from "../lib/auth"
import { Splash } from "./form"

/**
 * What the app shows before it knows who the user is: a plain splash while the
 * session restores (only on a first boot with no cached session), and a retry
 * when that restore failed for a transient reason (the session is only
 * discarded on an explicit `Unauthorized`).
 */
export function BootScreen() {
  const auth = useAuth()

  return (
    <Show when={auth.status() === "error"} fallback={<Splash />}>
      <Splash
        message={
          auth.bootFailure()?.retryable
            ? "ارتباط با سرور برقرار نشد. دوباره تلاش کنید."
            : "درخواست نامعتبر بود. دوباره تلاش کنید."
        }
        action={
          <Button type="button" onClick={() => void auth.refresh()}>
            تلاش دوباره
          </Button>
        }
      />
    </Show>
  )
}

/** One placeholder block: a surface-coloured bar, no motion and no content. */
const block = (height: string, width = "100%"): JSX.CSSProperties => ({
  "block-size": height,
  "inline-size": width,
  border: `1px solid ${tokens.color.line}`,
  "border-radius": tokens.radius.md,
  background: tokens.color.surface
})

/** Widths of the placeholder nav pills; one per main section. */
const NAV_BLOCK_WIDTHS = [64, 56, 52, 58, 62, 68, 62, 60] as const

/**
 * The router's lazy-route fallback: a static wireframe of the app chrome
 * (header bar, nav strip, a title and a few panels) so a cold route chunk never
 * covers the screen with the boot splash. It mirrors the real header's height
 * and the page gutter so resolving the route does not shift the layout, and it
 * carries no branding or copy.
 */
export function RouteSkeleton() {
  return (
    <div
      dir="rtl"
      lang="fa"
      role="status"
      aria-busy="true"
      aria-label="در حال بارگذاری"
      style={{
        "min-block-size": "100dvh",
        display: "grid",
        "grid-template-rows": "auto 1fr",
        background: tokens.color.canvas,
        color: tokens.color.ink,
        "font-family": tokens.font.sans,
        "overflow-x": "clip"
      }}
    >
      <div
        style={{
          "border-block-end": `1px solid ${tokens.color.line}`,
          background: "rgba(255, 255, 255, 0.96)",
          padding: "10px clamp(14px, 3vw, 24px)"
        }}
      >
        <div
          style={{
            display: "grid",
            gap: "8px",
            "inline-size": "min(100%, 1200px)",
            "margin-inline": "auto"
          }}
        >
          <div
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
              gap: "12px",
              "min-block-size": "44px"
            }}
          >
            <div style={block("32px", "84px")} />
            <div style={{ display: "flex", gap: "6px" }}>
              <div style={block("44px", "120px")} />
              <div style={block("44px", "72px")} />
            </div>
          </div>
          <div style={{ display: "flex", gap: "5px", "min-block-size": "38px" }}>
            <For each={NAV_BLOCK_WIDTHS}>
              {(width) => <div style={block("38px", `${width}px`)} />}
            </For>
          </div>
        </div>
      </div>

      <div
        style={{
          "inline-size": "min(1180px, calc(100% - 32px))",
          "margin-inline": "auto",
          padding: "18px 0 64px",
          display: "grid",
          gap: "14px",
          "align-content": "start"
        }}
      >
        <div style={block("32px", "180px")} />
        <div style={block("132px")} />
        <div style={block("96px")} />
        <div style={block("96px")} />
      </div>
    </div>
  )
}
