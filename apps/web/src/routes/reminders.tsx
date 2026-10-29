import { Title } from "@solidjs/meta"
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
    <div class="min-h-dvh overflow-x-clip bg-base-200 text-base-content" dir="rtl" lang="fa">
      <AppHeader active="reminders" />

      <main class="page-wrap mx-auto grid max-w-3xl gap-4">
        <header>
          <h1 class="m-0 text-2xl font-bold tracking-tight sm:text-3xl">یادآورها</h1>
          <p class="mt-1 mb-0 text-sm text-base-content/55">
            اعلان‌های این دستگاه و یادآورهایی که مرورگر آن‌ها را ندیده است.
          </p>
        </header>

        <PushHealthPanel />

        <ReminderInbox />
      </main>
    </div>
  )
}
