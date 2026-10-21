import { Title } from "@solidjs/meta"
import { tokens } from "@tali/ui"
import { AppHeader } from "../components/app-header"
import { Guard } from "../components/guard"
import { PushHealthPanel } from "../components/push-health"
import { ReminderInbox } from "../components/reminder-inbox"

/**
 * `/reminders` — the notification health panel plus the missed-reminder inbox
 * (tickets #20, #61).
 *
 * The inbox is the recovery path for every reason a reminder did not reach the
 * device (closed browser, expired subscription, quiet-hours hold, failed push)
 * and the place a queued notification answer is drained into the ledger.
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
        background: tokens.color.canvas
      }}
    >
      <AppHeader active="reminders" />

      <main style={{ padding: "clamp(16px, 3vw, 28px) 16px 32px", display: "grid", gap: tokens.space.md, "max-width": "752px", width: "100%", "box-sizing": "border-box", margin: "0 auto" }}>
        <h1 style={{ margin: 0, "font-size": "1.35rem", "letter-spacing": "-0.02em" }}>یادآورها</h1>

        <PushHealthPanel />

        <ReminderInbox />
      </main>
    </div>
  )
}
