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
        background: "#f7f9fd"
      }}
    >
      <AppHeader active="reminders" />

      <main style={{ padding: tokens.space.lg, display: "grid", gap: tokens.space.md, "max-width": "720px" }}>
        <h1 style={{ margin: 0, "font-size": "1.5rem" }}>یادآورها</h1>

        <PushHealthPanel />

        <ReminderInbox />
      </main>
    </div>
  )
}
