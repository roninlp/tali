import { Button, tokens } from "@tali/ui"
import {
  DEFAULT_NOTIFICATION_SNOOZE_MINUTES,
  REMINDER_KIND_LABELS,
  SNOOZE_PRESETS_MINUTES,
  type ReminderInboxItem
} from "@tali/domain"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import {
  fetchReminderInbox,
  respondToReminder,
  type ReminderApiFailure
} from "../lib/reminders/api"
import { flushQueuedReminderActions } from "../lib/push/notification-actions"

/**
 * The missed-reminder inbox (ticket #61; FR-REM-02/03, ADR-0005 §7).
 *
 * "Missed" is a ledger query, not a job: every fire writes a dispatch row at
 * claim time, so a reminder the browser never saw — closed browser, expired or
 * missing subscription, quiet-hours hold, push failure — is here on the next
 * open with the same Done/Snooze affordances as the notification.
 *
 * Opening this screen is also the **queue drain**: a Done/Snooze tapped on a
 * notification while the page was closed is posted to the existing respond
 * route, then the list is re-read so an answered reminder disappears instead of
 * showing up as missed.
 */

const SNOOZE_CHOICES = SNOOZE_PRESETS_MINUTES

const failureCopy = (failure: ReminderApiFailure): string => {
  switch (failure.code) {
    case "Unauthorized":
      return "برای پاسخ به یادآوری باید وارد شوید."
    case "Network":
      return "ارتباط با سرور برقرار نشد؛ پاسخ پس از اتصال دوباره فرستاده می‌شود."
    case "NotFound":
      return "این یادآوری دیگر در دفتر ارسال نیست."
    default:
      return "ثبت پاسخ ناموفق بود؛ دوباره تلاش کنید."
  }
}

const formatInstant = (iso: string): string => {
  const value = Date.parse(iso)
  if (Number.isNaN(value)) return ""
  return new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(value)
}

const tierBadge = (tier: ReminderInboxItem["tier"]): string =>
  tier === "critical" ? "دارو" : ""

export function ReminderInbox() {
  const [items, setItems] = createSignal<ReadonlyArray<ReminderInboxItem>>([])
  const [history, setHistory] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal<string>()
  const [snoozeMinutes, setSnoozeMinutes] = createSignal<number>(
    DEFAULT_NOTIFICATION_SNOOZE_MINUTES
  )

  const load = async (withHistory = history()): Promise<void> => {
    setLoading(true)
    const result = await fetchReminderInbox({ history: withHistory })
    setLoading(false)
    if (!result.ok) {
      setError(failureCopy(result.error))
      return
    }
    setError(undefined)
    setItems(result.value)
  }

  /** Post every queued notification answer, then re-read the ledger. */
  const drainAndLoad = async (): Promise<void> => {
    let drained = false
    try {
      const result = await flushQueuedReminderActions(async (record) => {
        const answer = await respondToReminder({
          dispatchId: record.dispatchId,
          response: record.action,
          snoozeMinutes: record.action === "snooze" ? record.snoozeMinutes : undefined
        })
        // Keep network/server failures for the next open; a dispatch that no
        // longer exists can never succeed, so it is not retried forever.
        return answer.ok || answer.error.code === "NotFound" || answer.error.code === "BadRequest"
      })
      drained = result.drained > 0
    } catch {
      // The queue is a device convenience; the ledger stays authoritative.
    }
    if (drained) setError(undefined)
    await load()
  }

  const respond = async (
    item: ReminderInboxItem,
    response: "done" | "snooze" | "dismiss"
  ): Promise<void> => {
    if (busy() !== undefined) return
    setBusy(item.dispatch.id)
    const answer = await respondToReminder({
      dispatchId: item.dispatch.id,
      response,
      snoozeMinutes: response === "snooze" ? snoozeMinutes() : undefined
    })
    setBusy(undefined)
    if (!answer.ok) {
      setError(failureCopy(answer.error))
      return
    }
    setError(undefined)
    // Optimistic removal: the server already holds the answer.
    setItems((current) => current.filter((row) => row.dispatch.id !== item.dispatch.id))
    await load()
  }

  createEffect(
    () => null,
    () => {
      void drainAndLoad()

      const onVisible = () => {
        if (document.visibilityState === "visible") void drainAndLoad()
      }
      const onMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string } | undefined
        if (data?.type === "tali:reminder-action") void drainAndLoad()
      }
      document.addEventListener("visibilitychange", onVisible)
      if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
        navigator.serviceWorker.addEventListener("message", onMessage)
      }
      onCleanup(() => {
        document.removeEventListener("visibilitychange", onVisible)
        if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
          navigator.serviceWorker.removeEventListener("message", onMessage)
        }
      })
    }
  )

  return (
    <section
      aria-labelledby="reminder-inbox-heading"
      style={{
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.line}`,
        "border-radius": tokens.radius.lg,
        padding: tokens.space.lg,
        display: "grid",
        gap: tokens.space.md
      }}
    >
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "8px", "flex-wrap": "wrap" }}>
        <h2 id="reminder-inbox-heading" style={{ margin: 0, "font-size": "1.05rem" }}>
          {history() ? "تاریخچه‌ی یادآوری‌ها" : "یادآورهای ازدست‌رفته"}
        </h2>
        <Button
          variant="ghost"
          type="button"
          onClick={() => {
            const next = !history()
            setHistory(next)
            void load(next)
          }}
        >
          {history() ? "بازگشت به صندوق" : "تاریخچه"}
        </Button>
      </div>

      <Show when={error()}>
        <p
          role="alert"
          style={{
            margin: 0,
            padding: "8px 10px",
            "border-radius": tokens.radius.md,
            background: "#fdf2f2",
            border: "1px solid #f3c6c6",
            color: "#8f1d1d",
            "font-size": "0.85rem",
            "line-height": "1.8"
          }}
        >
          {error()}
        </p>
      </Show>

      <Show when={loading() && items().length === 0}>
        <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.88rem" }}>
          در حال خواندن دفتر ارسال…
        </p>
      </Show>

      <Show when={!loading() && items().length === 0}>
        <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.88rem", "line-height": "1.9" }}>
          {history()
            ? "هنوز یادآوری پاسخ‌داده‌شده‌ای ثبت نشده است."
            : "یادآوری بی‌پاسخی نیست. هر یادآوری که مرورگر آن را ندیده باشد اینجا می‌آید، نه اینکه ناپدید شود."}
        </p>
      </Show>

      <ul style={{ "list-style": "none", margin: 0, padding: 0, display: "grid", gap: tokens.space.sm }}>
        <For each={items()}>
          {(item) => (
            <li
              style={{
                display: "grid",
                gap: "6px",
                padding: "10px 12px",
                "border-radius": tokens.radius.md,
                border: `1px solid ${item.tier === "critical" ? "#f0c9c9" : tokens.color.line}`,
                background: item.tier === "critical" ? "#fff7f7" : "#fbfcff"
              }}
            >
              <div style={{ display: "flex", "align-items": "baseline", "justify-content": "space-between", gap: "8px" }}>
                <strong style={{ "font-size": "0.95rem" }}>{item.title}</strong>
                <span style={{ color: tokens.color.inkSoft, "font-size": "0.78rem" }}>
                  {formatInstant(item.dispatch.scheduledFor)}
                </span>
              </div>

              <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap", "align-items": "center" }}>
                <span
                  style={{
                    "font-size": "0.75rem",
                    color: tokens.color.inkSoft,
                    border: `1px solid ${tokens.color.line}`,
                    "border-radius": "999px",
                    padding: "1px 8px"
                  }}
                >
                  {REMINDER_KIND_LABELS[item.kind]}
                </span>
                <Show when={tierBadge(item.tier) !== ""}>
                  <span
                    style={{
                      "font-size": "0.75rem",
                      color: "#8f1d1d",
                      border: "1px solid #f0c9c9",
                      "border-radius": "999px",
                      padding: "1px 8px"
                    }}
                  >
                    {tierBadge(item.tier)}
                  </span>
                </Show>
                <Show when={item.note !== null && item.note !== ""}>
                  <span style={{ color: tokens.color.inkSoft, "font-size": "0.8rem" }}>{item.note}</span>
                </Show>
              </div>

              <Show
                when={item.state === "inbox"}
                fallback={
                  <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.78rem" }}>
                    {item.dispatch.response === "done"
                      ? "انجام شد"
                      : item.dispatch.response === "snooze"
                        ? "به بعد موکول شد"
                        : "کنار گذاشته شد"}
                    {" · "}
                    {item.dispatch.respondedAt === null ? "" : formatInstant(item.dispatch.respondedAt)}
                  </p>
                }
              >
                <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap", "align-items": "center" }}>
                  <Button
                    type="button"
                    disabled={busy() !== undefined}
                    onClick={() => void respond(item, "done")}
                  >
                    انجام شد
                  </Button>
                  <select
                    aria-label="مدت به تعویق انداختن"
                    value={String(snoozeMinutes())}
                    onChange={(event) => setSnoozeMinutes(Number(event.currentTarget.value))}
                    style={{
                      "font-family": tokens.font.sans,
                      "border-radius": tokens.radius.md,
                      border: `1px solid ${tokens.color.line}`,
                      padding: "8px 10px",
                      background: tokens.color.surface,
                      color: tokens.color.ink
                    }}
                  >
                    <For each={SNOOZE_CHOICES}>
                      {(minutes) => <option value={String(minutes)}>{`${minutes} دقیقه`}</option>}
                    </For>
                  </select>
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={busy() !== undefined}
                    onClick={() => void respond(item, "snooze")}
                  >
                    بعداً
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={busy() !== undefined}
                    onClick={() => void respond(item, "dismiss")}
                  >
                    کنار گذاشتن
                  </Button>
                </div>
              </Show>
            </li>
          )}
        </For>
      </ul>

      <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.78rem", "line-height": "1.8" }}>
        این فهرست از دفتر ارسال سرور خوانده می‌شود؛ اگر مرورگر بسته باشد یا اعلان نرسد،
        یادآوری پس از ۲۴ ساعت به تاریخچه می‌رود و هرگز حذف نمی‌شود.
      </p>
    </section>
  )
}
