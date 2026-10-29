import { For, Show } from "solid-js"
import { Button } from "@tali/ui"
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
      class="grid min-h-dvh grid-rows-[auto_1fr] overflow-x-clip bg-base-200"
    >
      <div class="border-b border-base-300 bg-base-100/90">
        <div class="mx-auto grid w-full max-w-7xl gap-2 px-4 py-2.5">
          <div class="flex min-h-11 items-center justify-between gap-3">
            <div class="skeleton h-8 w-24 rounded-xl" />
            <div class="flex gap-1.5">
              <div class="skeleton h-8 w-24 rounded-full" />
              <div class="skeleton size-8 rounded-full" />
            </div>
          </div>
          <div class="hidden min-h-9 gap-1.5 md:flex">
            <For each={NAV_BLOCK_WIDTHS}>
              {(width) => <div class="skeleton h-8 rounded-lg" style={{ width: `${width}px` }} />}
            </For>
          </div>
        </div>
      </div>

      <div class="mx-auto grid w-full max-w-6xl content-start gap-3.5 px-4 py-5">
        <div class="skeleton h-8 w-44 rounded-lg" />
        <div class="skeleton h-32 rounded-box" />
        <div class="skeleton h-24 rounded-box" />
        <div class="skeleton h-24 rounded-box" />
      </div>
    </div>
  )
}
