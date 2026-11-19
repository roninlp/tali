/**
 * `@tali/reminder-domain` — Tali's reminder **firing** bounded context
 * (ADR-0005's machinery on `@alchemy.run/domain`; Stage 1 pilot).
 *
 * Commands map to the glossary's verbs — `ClaimFire`, `DeliverDue`,
 * `AnswerDone`, `Snooze`, `Dismiss`, `SilenceReminder`, `DeleteReminder` —
 * decided by one `ReminderOwner` aggregate per owner, hosted on Cloudflare
 * Durable Objects. The pure scheduling policy (quiet hours, the medication
 * tier, silence, snooze presets, on-time) stays in `@tali/domain`'s
 * `reminder-policy`, shared with the write path so the two cannot drift.
 *
 * The package is server-only by construction: it depends on
 * `@alchemy.run/domain`, so `@tali/domain` (which the browser imports) never
 * sees it.
 */

export * from './ReminderOwner.id.js'
export * from './Dispatch.js'
export * from './dispatch.rejection.js'
export * from './dispatch-id.js'
export * from './ClaimFire.command.js'
export * from './DeliverDue.command.js'
export * from './Answer.command.js'
export * from './ReminderLifecycle.command.js'
export * from './RecordPushOutcome.command.js'
export * from './ReminderOwner.aggregate.js'
export * from './PushService.external.js'
export * from './PushDispatches.policy.js'
export * from './D1Feed.projection.js'
export * from './Reminders.model.js'
