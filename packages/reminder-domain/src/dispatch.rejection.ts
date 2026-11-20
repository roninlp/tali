import { Schema } from 'effect'
import { ReminderDispatchId } from '@tali/domain'
import { DispatchResponseValue } from './Dispatch.js'

/**
 * The firing model's shared rejections (ADR-0005 §6; the glossary's
 * "already answered" no-op and the ledger's ownership rules).
 */

/**
 * The dispatch does not exist on this owner's ledger. The respond route maps
 * it onto the same `404` the unknown-id path always answered.
 */
export class DispatchNotFound extends Schema.TaggedError<DispatchNotFound>()(
  'DispatchNotFound',
  { dispatchId: ReminderDispatchId },
) {}

/**
 * A double tap: this dispatch already carries its one answer, and one fire is
 * one answer (ADR-0005 §6). The respond route treats it as the stored answer,
 * not an error.
 */
export class AlreadyAnswered extends Schema.TaggedError<AlreadyAnswered>()(
  'AlreadyAnswered',
  { response: DispatchResponseValue },
) {}

/**
 * The dispatch is not **owed** — it is answered or closed, so a push outcome
 * has nothing left to record. The push policy treats it as done: an answer
 * that landed mid-push wins, and a late outcome must never reopen it.
 */
export class NotOwed extends Schema.TaggedError<NotOwed>()('NotOwed', {
  dispatchId: ReminderDispatchId,
}) {}

/**
 * A snooze length outside the preset set {5, 10, 15, 30, 60}. Free-form
 * snoozing is out of scope (ADR-0005 §5, settled in #79).
 */
export class SnoozeMinutesNotPreset extends Schema.TaggedError<SnoozeMinutesNotPreset>()(
  'SnoozeMinutesNotPreset',
  { minutes: Schema.Int },
) {}
