import {
  DEFAULT_NOTIFICATION_SNOOZE_MINUTES,
  REMINDER_KIND_LABELS,
} from '@tali/domain'
import type { ReminderDispatch } from '@tali/domain'

/**
 * The reminder notification body (moved from the api's sweep, ticket #61;
 * ADR-0005's delivery half now runs in the reminders model's push policy).
 *
 * The payload is a pointer plus the reminder's own words; the full state is
 * re-synced on app open, and the inbox is the recovery path (#4 §7).
 *
 * `id` is the **dispatch id**: one fire is one row and one answer, so the
 * service worker can post the action back without guessing which occurrence
 * it was showing.
 */
export const reminderPushPayload = (input: {
  readonly dispatch: Pick<ReminderDispatch, 'id' | 'reminderId'>
  readonly title: string
  readonly note: string | null
  readonly kind: keyof typeof REMINDER_KIND_LABELS
  readonly tier: 'normal' | 'critical'
}): string =>
  JSON.stringify({
    type: 'reminder',
    id: input.dispatch.id,
    reminderId: input.dispatch.reminderId,
    title: input.title,
    body: input.note ?? REMINDER_KIND_LABELS[input.kind],
    tier: input.tier,
    url: '/reminders',
    actions: [
      { action: 'done', title: 'انجام شد' },
      {
        action: 'snooze',
        title: 'بعداً',
        minutes: DEFAULT_NOTIFICATION_SNOOZE_MINUTES,
      },
    ],
  })
