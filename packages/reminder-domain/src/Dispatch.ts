import { Schema } from 'effect'
import {
  ReminderDispatchId,
  ReminderId,
  ReminderTier,
  ReminderType,
  TimestampUtc,
  UserId,
} from '@tali/domain'

/**
 * The firing model's shared value schemas (ADR-0005; the glossary's
 * Dispatch / Tier / Missed Inbox vocabulary).
 *
 * The wire shape mirrors `ReminderDispatch` from `@tali/domain` column for
 * column, so the D1 projection can feed the existing `reminder_dispatches`
 * table — and with it the Missed Inbox — without a migration.
 */

/** The answer a dispatch can receive (the glossary's Dispatch axes). */
export const DispatchResponseValue = Schema.Literals([
  'done',
  'snooze',
  'dismiss',
])
export type DispatchResponseValue = Schema.Schema.Type<
  typeof DispatchResponseValue
>

/**
 * Push lifecycle of a claimed dispatch. `accepted` means the push service
 * took it, not that a device saw it.
 */
export const PushOutcomeValue = Schema.Literals([
  'pending',
  'accepted',
  'failed',
  'expired',
])
export type PushOutcomeValue = Schema.Schema.Type<typeof PushOutcomeValue>

/**
 * Why an owed dispatch closed without ever pushing. Every reason is
 * inbox-only: the ledger row is never deleted (ADR-0005 §7).
 */
export const ExpireReason = Schema.Literals([
  'silenced',
  'reminder-deleted',
  'past-horizon',
  'out-of-attempts',
  'no-subscription',
  'permanent',
  'unconfigured',
  'transient-exhausted',
])
export type ExpireReason = Schema.Schema.Type<typeof ExpireReason>

/**
 * One ledger row as the model holds it: the same fields the D1 projection
 * writes, minus `userId`, which is the owner instance's own id.
 */
export const DispatchSnapshot = Schema.Struct({
  id: ReminderDispatchId,
  reminderId: ReminderId,
  /** The nominal fire instant this row represents. */
  scheduledFor: TimestampUtc,
  /** When the policy says it may be pushed (quiet hours / snooze target). */
  deliverAt: TimestampUtc,
  /** The original fire instant; unchanged across snooze children. */
  rootScheduledFor: TimestampUtc,
  /** `schedule` or `snooze:<parentDispatchId>`. */
  origin: Schema.String,
  pushOutcome: PushOutcomeValue,
  attempts: Schema.Int,
  lastAttemptAt: Schema.NullOr(TimestampUtc),
  parentDispatchId: Schema.NullOr(ReminderDispatchId),
  response: Schema.NullOr(DispatchResponseValue),
  respondedAt: Schema.NullOr(TimestampUtc),
  snoozedUntil: Schema.NullOr(TimestampUtc),
  createdAt: TimestampUtc,
})
export type DispatchSnapshot = Schema.Schema.Type<typeof DispatchSnapshot>

/**
 * What the sweep vouches for one owed dispatch this tick: the reminder words
 * the push payload shows, plus the two facts that close a dispatch without
 * pushing (a live **Silence**, a deleted reminder). The api reads them fresh
 * from D1, so the model never re-reads the synced reminder row.
 */
export const DispatchFacts = Schema.Struct({
  dispatchId: ReminderDispatchId,
  title: Schema.String,
  note: Schema.NullOr(Schema.String),
  kind: ReminderType,
  tier: ReminderTier,
  silencedUntil: Schema.NullOr(TimestampUtc),
  deletedAt: Schema.NullOr(TimestampUtc),
})
export type DispatchFacts = Schema.Schema.Type<typeof DispatchFacts>

/** The respond route's answer shape (`ReminderResponseResult`, unchanged). */
export const AnswerReply = Schema.Struct({
  dispatch: DispatchSnapshot,
  child: Schema.NullOr(DispatchSnapshot),
  onTime: Schema.Boolean,
})
export type AnswerReply = Schema.Schema.Type<typeof AnswerReply>

/**
 * The push policy's contract with the world: the owner's subscriptions, read
 * from the same table the registration route writes.
 */
export interface SubscriptionRow {
  readonly id: string
  readonly userId: UserId
  readonly endpoint: string
  readonly p256dh: string
  readonly auth: string
}
