import { createSignal, Show } from "solid-js"
import { Button, tokens } from "@tali/ui"
import { usePush, type PushPermission } from "../lib/push"

/**
 * Notification permission / subscription health, shown on `/reminders` and
 * `/settings` (ticket #20).
 *
 * This is the honest diagnostic surface for a feature whose failure modes are
 * mostly environmental: unsupported browser, insecure origin, denied
 * permission, missing VAPID key, or an installed-PWA requirement on iOS. It
 * also proves the notification-action stub is wired by showing the last
 * Done/Snooze the service worker queued.
 */

type Tone = "ok" | "warn" | "bad" | "muted"

const TONE_COLOR: Record<Tone, string> = {
  ok: tokens.color.accent,
  warn: "#b45309",
  bad: "#b91c1c",
  muted: tokens.color.inkSoft
}

const permissionCopy = (permission: PushPermission): {
  label: string
  tone: Tone
} => {
  switch (permission) {
    case "granted":
      return { label: "فعال", tone: "ok" }
    case "denied":
      return { label: "مسدود شده", tone: "bad" }
    case "default":
      return { label: "داده نشده", tone: "warn" }
    default:
      return { label: "پشتیبانی نمی‌شود", tone: "muted" }
  }
}

const actionCopy = (action: string): string => (action === "done" ? "انجام شد" : "بعداً")

const formatTime = (iso: string): string => {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ""
  return new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit" }).format(time)
}

function StatusRow(props: { label: string; value: string; tone: Tone; hint?: string }) {
  return (
    <div
      style={{
        display: "grid",
        gap: "2px",
        padding: `${tokens.space.sm} 0`,
        "border-bottom": `1px solid ${tokens.color.line}`
      }}
    >
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "8px" }}>
        <span style={{ "font-size": "0.9rem", color: tokens.color.ink }}>{props.label}</span>
        <span
          style={{
            display: "inline-flex",
            "align-items": "center",
            gap: "6px",
            "font-size": "0.85rem",
            color: TONE_COLOR[props.tone],
            "white-space": "nowrap"
          }}
        >
          <span
            aria-hidden="true"
            style={{ width: "7px", height: "7px", "border-radius": "50%", background: TONE_COLOR[props.tone] }}
          />
          {props.value}
        </span>
      </div>
      <Show when={props.hint}>
        <span style={{ "font-size": "0.78rem", color: tokens.color.inkSoft, "line-height": "1.7" }}>
          {props.hint}
        </span>
      </Show>
    </div>
  )
}

export function PushHealthPanel() {
  const push = usePush()
  const [copied, setCopied] = createSignal(false)

  const permission = () => permissionCopy(push.permission())

  const copySubscription = async () => {
    const json = push.subscriptionJson()
    if (json === undefined) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(json, null, 2))
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section
      aria-labelledby="push-health-title"
      style={{
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.line}`,
        "border-radius": tokens.radius.lg,
        padding: tokens.space.lg,
        display: "grid",
        gap: tokens.space.md
      }}
    >
      <header style={{ display: "grid", gap: "4px" }}>
        <h2 id="push-health-title" style={{ margin: 0, "font-size": "1.05rem" }}>
          وضعیت اعلان‌ها
        </h2>
        <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.85rem", "line-height": "1.8" }}>
          یادآورها از طریق Web Push به همین دستگاه می‌رسند. این بخش آمادگی دستگاه را نشان می‌دهد؛
          زمان‌بندی و ارسال یادآورها در گام بعدی ساخته می‌شود.
        </p>
      </header>

      <div>
        <StatusRow
          label="پشتیبانی مرورگر"
          value={push.supported() ? "پشتیبانی می‌شود" : "پشتیبانی نمی‌شود"}
          tone={push.supported() ? "ok" : "bad"}
        />
        <StatusRow
          label="بستر امن (HTTPS یا localhost)"
          value={push.secure() ? "بله" : "خیر"}
          tone={push.secure() ? "ok" : "bad"}
        />
        <StatusRow
          label="نصب‌شده به‌عنوان برنامه"
          value={push.installed() ? "بله" : "نه"}
          tone={push.installed() ? "ok" : "warn"}
          hint={
            push.installed()
              ? undefined
              : "برای اعلان در iOS، تالی را از «افزودن به صفحه‌ی خانه» نصب کنید. در اندروید نصب توصیه می‌شود."
          }
        />
        <StatusRow
          label="مجوز اعلان"
          value={permission().label}
          tone={permission().tone}
          hint={
            push.permission() === "denied"
              ? "مجوز را از تنظیمات سایت در مرورگر باز کنید؛ دوباره درخواست دادن از این صفحه ممکن نیست."
              : undefined
          }
        />
        <StatusRow
          label="اشتراک این دستگاه"
          value={push.subscribed() ? "ثبت شده" : "ثبت نشده"}
          tone={push.subscribed() ? "ok" : "muted"}
        />
        <StatusRow
          label="کلید عمومی VAPID"
          value={push.configured() ? "تنظیم شده" : "تنظیم نشده"}
          tone={push.configured() ? "ok" : "bad"}
          hint={
            push.configured()
              ? undefined
              : "برای آزمون محلی، مقدار VITE_VAPID_PUBLIC_KEY را در apps/web/.env.local بگذارید (docs/web-push-local.md)."
          }
        />
        <Show when={push.lastAction()}>
          {(action) => (
            <StatusRow
              label="آخرین پاسخ اعلان (آزمایشی)"
              value={`${actionCopy(action().action)} · ${formatTime(action().at)}`}
              tone="ok"
              hint="دکمه‌های انجام شد/بعداً در صف محلی دستگاه ذخیره می‌شوند تا زنجیره‌ی یادآور آن را مصرف کند."
            />
          )}
        </Show>
      </div>

      <Show when={push.error()}>
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
          {push.error()}
        </p>
      </Show>

      <div style={{ display: "flex", gap: tokens.space.sm, "flex-wrap": "wrap" }}>
        <Button
          type="button"
          disabled={push.busy() || !push.supported() || !push.configured() || !push.secure()}
          onClick={() => void push.enable()}
        >
          {push.busy()
            ? "در حال آماده‌سازی…"
            : push.subscribed()
              ? "بررسی و ثبت دوباره"
              : "فعال‌سازی اعلان‌ها"}
        </Button>
        <Button variant="ghost" type="button" disabled={push.busy()} onClick={() => void push.refresh()}>
          تازه‌سازی وضعیت
        </Button>
        <Show when={push.subscribed()}>
          <Button variant="ghost" type="button" disabled={push.busy()} onClick={() => void push.disable()}>
            لغو اشتراک این دستگاه
          </Button>
        </Show>
        <Show when={import.meta.env.DEV && push.subscriptionJson() !== undefined}>
          <Button variant="ghost" type="button" onClick={() => void copySubscription()}>
            {copied() ? "رونوشت شد" : "رونوشت اشتراک برای آزمون"}
          </Button>
        </Show>
      </div>

      <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.78rem", "line-height": "1.8" }}>
        راهنمای ارسال یک اعلان آزمایشی روی همین دستگاه: <code dir="ltr">docs/web-push-local.md</code>
      </p>
    </section>
  )
}
