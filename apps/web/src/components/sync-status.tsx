import { Show } from "solid-js"
import { tokens } from "@tali/ui"
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

  const tone = () => {
    if (local.status() === "error") return "#b91c1c"
    // A rejected push is durable and needs the user, unlike a queue that is
    // merely waiting or a network that may come back on its own.
    if (local.failed() > 0) return "#b91c1c"
    if (!local.online()) return "#b45309"
    if (local.pending() > 0) return "#b45309"
    return tokens.color.accent
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

  return (
    <span
      role="status"
      aria-live="polite"
      title={hint()}
      style={{
        display: "inline-flex",
        "align-items": "center",
        gap: "6px",
        padding: "4px 10px",
        "border-radius": "999px",
        border: `1px solid ${tokens.color.line}`,
        background: tokens.color.surface,
        color: tokens.color.inkSoft,
        "font-size": "0.78rem",
        "white-space": "nowrap"
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: "7px",
          height: "7px",
          "border-radius": "50%",
          background: tone()
        }}
      />
      {label()}
      <Show when={local.syncing()}>
        <span aria-hidden="true">…</span>
      </Show>
    </span>
  )
}
