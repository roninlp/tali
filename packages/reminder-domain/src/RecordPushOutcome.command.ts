import * as Domain from '@alchemy.run/domain'
import { Schema } from 'effect'
import { ReminderDispatchId, TimestampUtc } from '@tali/domain'
import { ExpireReason } from './Dispatch.js'
import { NotOwed } from './dispatch.rejection.js'
import { ReminderOwnerId } from './ReminderOwner.id.js'
import { DispatchExpired } from './DeliverDue.command.js'

/**
 * `RecordPushOutcome` — the push policy reports what the push service said
 * (ADR-0005 §3's outcome half: "a crash between the push and the outcome
 * leaves `pending`, and the next tick retries it").
 *
 * Only the `PushDispatches` policy sends this, with a command id derived from
 * the event that caused it, so a re-run takes effect once. The guarantee is
 * at-most-one *claim*, not at-most-once push: the attempt was already spent
 * by `DispatchDueForPush`, so a crashed outcome leaves a bounded, retryable
 * row.
 *
 * An answer that landed mid-push wins: the row is no longer **owed**, and the
 * command is refused with `NotOwed` rather than recording over the answer.
 */

/** The push service took it — accepted, not delivered (#4 §5). */
export class DispatchPushed extends Domain.Event('DispatchPushed', {
  dispatchId: ReminderDispatchId,
  at: TimestampUtc,
}) {}

/** A transient failure (429/5xx/network): retryable inside the attempt budget. */
export class DispatchPushFailed extends Domain.Event('DispatchPushFailed', {
  dispatchId: ReminderDispatchId,
  at: TimestampUtc,
}) {}

export class RecordPushOutcome extends Domain.Command(
  'RecordPushOutcome',
  {
    target: ReminderOwnerId,
    input: {
      dispatchId: ReminderDispatchId,
      /** The coalesced result of fanning out to every subscription. */
      outcome: Schema.Literals(['accepted', 'failed', 'expired']),
      /** Why an `expired` outcome closed the row. */
      reason: Schema.optional(ExpireReason),
      at: TimestampUtc,
    },
    events: [DispatchPushed, DispatchPushFailed, DispatchExpired],
    rejects: [NotOwed],
  },
  {
    description:
      "Record one push attempt's outcome on the ledger. Internal: only the push policy sends it.",
  },
) {}
