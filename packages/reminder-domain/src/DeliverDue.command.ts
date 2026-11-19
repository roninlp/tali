import * as Domain from '@alchemy.run/domain'
import { Schema } from 'effect'
import {
  DELIVERY_HORIZON_MINUTES,
  ReminderDispatchId,
  ReminderId,
  ReminderTier,
  ReminderType,
  TimestampUtc,
} from '@tali/domain'
import { DispatchFacts, ExpireReason } from './Dispatch.js'
import { ReminderOwnerId } from './ReminderOwner.id.js'

/**
 * `DeliverDue` — the sweep's delivery half (ADR-0005 §2/§4; the glossary's
 * **Sweep**: "pushes every owed dispatch whose Deliver At has arrived").
 *
 * The tick sends one command per owner, with the fresh facts it read from the
 * synced rows: what the push shows, and whether the dispatch's reminder is
 * silenced or deleted. The command asks exactly one question of every owed
 * dispatch — *has its `deliverAt` arrived?* — plus the two facts that close a
 * row without pushing, the 15-minute horizon and the attempt budget. A held
 * row is not touched; a deliverable row the caller did not vouch for is held
 * (the projection's row was not visible at the read), and the next tick
 * carries it.
 *
 * `DispatchDueForPush` is both the decision to deliver and the attempt
 * taking: it consumes one of the three attempts, exactly where the old
 * `takeAttempts` compare-and-set used to run, so a policy crash between this
 * event and its outcome still leaves a bounded, retryable row.
 */

/** The mechanical per-tick push bound (ADR-0005 §9: ten fetches, not a cap on policy). */
export const SWEEP_MAX_PUSHES = 10
/** Transient failures are retried this many times before the dispatch expires. */
export const SWEEP_MAX_ATTEMPTS = 3

/** The delivery horizon from ADR-0005 §4 (owned here, shared with the api). */
export const SWEEP_HORIZON_MS = DELIVERY_HORIZON_MINUTES * 60_000

/**
 * The sweep decided this dispatch may be pushed now. Carries the words the
 * notification shows; the push policy is the only consumer.
 */
export class DispatchDueForPush extends Domain.Event('DispatchDueForPush', {
  dispatchId: ReminderDispatchId,
  reminderId: ReminderId,
  title: Schema.String,
  note: Schema.NullOr(Schema.String),
  kind: ReminderType,
  tier: ReminderTier,
  deliverAt: TimestampUtc,
  /** The attempt being spent (already counted in the ledger by `evolve`). */
  attempts: Schema.Int,
  /** The tick's nominal clock; the outcome's `lastAttemptAt`. */
  dueAt: TimestampUtc,
}) {}

/** The dispatch closed without ever pushing. Inbox-only; the row is never deleted. */
export class DispatchExpired extends Domain.Event('DispatchExpired', {
  dispatchId: ReminderDispatchId,
  reason: ExpireReason,
}) {}

export class DeliverDue extends Domain.Command(
  'DeliverDue',
  {
    target: ReminderOwnerId,
    input: {
      /** The tick's nominal clock (`controller.scheduledTime`). */
      now: TimestampUtc,
      /** Fresh per-dispatch facts from the synced rows, deliverable first. */
      facts: Schema.Array(DispatchFacts),
    },
    events: [DispatchDueForPush, DispatchExpired],
  },
  {
    description:
      'One sweep delivery pass for the owner: push every owed dispatch whose deliver-at has arrived (bounded by the fetch budget), and expire the rows the facts closed — a silenced or deleted reminder, the 15-minute horizon, or a spent attempt budget. Overflow rolls to the next tick.',
  },
) {}
