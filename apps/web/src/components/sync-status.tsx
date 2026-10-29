import { Show } from "solid-js"
import { useLocalStore } from "../lib/local-store"

const faNumber = new Intl.NumberFormat("fa-IR")

/**
 * The one place the app answers "am I offline, and is anything waiting?".
 *
 * Deliberately quiet: a dot plus a short label. It reads the local store's
 * state, not the network, so it stays truthful while a request is in flight.
 */
export function SyncStatus() {
  const local = useLocalStore()

  const tone = (): "success" | "warning" | "error" => {
    if (local.status() === "error") return "error"
    // A rejected push is durable and needs the user, unlike a queue that is
    // merely waiting or a network that may come back on its own.
    if (local.failed() > 0) return "error"
    if (!local.online()) return "warning"
    if (local.pending() > 0) return "warning"
    return "success"
  }

  const label = () => {
    if (local.status() === "opening") return "در حال آماده‌سازی…"
    if (local.status() === "error") return "حافظه‌ی محلی در دسترس نیست"
    if (local.failed() > 0) {
      return `${faNumber.format(local.failed())} تغییر ذخیره نشد`
    }
    if (!local.online()) return "آفلاین"
    if (local.pending() > 0) {
      return `${faNumber.format(local.pending())} تغییر در انتظار ارسال`
    }
    return local.canSync() ? "همگام" : "حافظه‌ی محلی فعال"
  }

  const hint = () =>
    local.error() ??
    (local.failed() > 0
      ? "این تغییرات روی سرور ذخیره نشدند؛ از داخل یادداشت دوباره تلاش کنید."
      : undefined)

  const dot = () => {
    const value = tone()
    if (value === "error") return "bg-error"
    if (value === "warning") return "bg-warning"
    return "bg-success"
  }

  return (
    <span
      role="status"
      aria-live="polite"
      title={hint()}
      class="badge badge-sm h-7 gap-1.5 border-base-300 bg-base-100 px-2.5 text-[0.72rem] whitespace-nowrap text-base-content/65"
    >
      <span aria-hidden="true" class={`size-1.5 rounded-full ${dot()}`} />
      {label()}
      <Show when={local.syncing()}>
        <span aria-hidden="true" class="leading-none">
          …
        </span>
      </Show>
    </span>
  )
}
