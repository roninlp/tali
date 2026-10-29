import { createSignal, Show } from "solid-js"
import { Button } from "@tali/ui"
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

const TONE_CLASS: Record<Tone, { text: string; dot: string }> = {
  ok: { text: "text-success", dot: "bg-success" },
  warn: { text: "text-warning", dot: "bg-warning" },
  bad: { text: "text-error", dot: "bg-error" },
  muted: { text: "text-base-content/55", dot: "bg-base-content/35" }
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
  const tone = () => TONE_CLASS[props.tone]
  return (
    <div class="grid gap-0.5 border-b border-base-300 py-2 last:border-b-0">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[0.9rem]">{props.label}</span>
        <span class={`inline-flex items-center gap-1.5 whitespace-nowrap text-[0.85rem] ${tone().text}`}>
          <span aria-hidden="true" class={`size-1.5 rounded-full ${tone().dot}`} />
          {props.value}
        </span>
      </div>
      <Show when={props.hint}>
        <span class="text-[0.78rem] leading-7 text-base-content/50">{props.hint}</span>
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
    <section aria-labelledby="push-health-title" class="panel grid gap-4 p-4 sm:p-5">
      <header class="grid gap-1">
        <h2 id="push-health-title" class="m-0 text-lg font-bold">
          وضعیت اعلان‌ها
        </h2>
        <p class="m-0 text-sm leading-7 text-base-content/55">
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
              : "کلید عمومی از سرور خوانده می‌شود (GET /push/vapid). اگر تنظیم نشده باشد، VAPID_* را در محیط API بگذارید (docs/web-push-local.md)."
          }
        />
        <Show when={push.lastAction()}>
          {(action) => (
            <StatusRow
              label="آخرین پاسخ اعلان (آزمایشی)"
              value={`${actionCopy(action().action)} · ${formatTime(action().at)}`}
              tone="ok"
              hint="دکمه‌های انجام شد/بعداً نخست در صف محلی دستگاه ذخیره و سپس به دفتر ارسال فرستاده می‌شوند؛ پس از ثبت، از صف پاک می‌شوند."
            />
          )}
        </Show>
      </div>

      <Show when={push.error()}>
        <p role="alert" class="alert alert-error m-0 py-2 text-sm leading-7">
          {push.error()}
        </p>
      </Show>

      <div class="flex flex-wrap gap-2">
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

      <p class="m-0 text-[0.78rem] leading-7 text-base-content/45">
        راهنمای ارسال یک اعلان آزمایشی روی همین دستگاه: <code dir="ltr">docs/web-push-local.md</code>
      </p>
    </section>
  )
}
