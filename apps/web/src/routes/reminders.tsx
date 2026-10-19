import { Title } from "@solidjs/meta"
import { tokens } from "@tali/ui"
import { AppHeader } from "../components/app-header"
import { Guard } from "../components/guard"
import { PushHealthPanel } from "../components/push-health"

/**
 * `/reminders` — the reminder screen starts as the notification health panel
 * plus the inbox placeholder (ticket #20). Reminder CRUD, the dispatch ledger,
 * and the missed-inbox query arrive with the reminder slice.
 */
export default function RemindersRoute() {
  return (
    <>
      <Title>یادآورها — تالی</Title>
      <Guard access="household">
        <RemindersPage />
      </Guard>
    </>
  )
}

function RemindersPage() {
  return (
    <div
      dir="rtl"
      lang="fa"
      style={{
        "min-height": "100dvh",
        "font-family": tokens.font.sans,
        color: tokens.color.ink,
        background: "#f7f9fd"
      }}
    >
      <AppHeader active="reminders" />

      <main style={{ padding: tokens.space.lg, display: "grid", gap: tokens.space.md, "max-width": "720px" }}>
        <h1 style={{ margin: 0, "font-size": "1.5rem" }}>یادآورها</h1>

        <PushHealthPanel />

        <section
          style={{
            background: tokens.color.surface,
            border: `1px dashed ${tokens.color.line}`,
            "border-radius": tokens.radius.lg,
            padding: tokens.space.lg,
            display: "grid",
            gap: "4px"
          }}
        >
          <h2 style={{ margin: 0, "font-size": "1.05rem" }}>یادآورهای ازدست‌رفته</h2>
          <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.88rem", "line-height": "1.9" }}>
            این فهرست از دفتر ارسال ساخته می‌شود تا هیچ یادآوری بی‌صدا ناپدید نشود. با فعال‌شدن
            زمان‌بندی یادآورها در گام بعدی، موارد پاسخ‌داده‌نشده اینجا نمایش داده می‌شوند.
          </p>
        </section>
      </main>
    </div>
  )
}
