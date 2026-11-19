import * as Domain from '@alchemy.run/domain'
import { Schema } from 'effect'
import { ReminderDispatchId, ReminderId, TimestampUtc } from '@tali/domain'
import { AnswerReply, DispatchResponseValue } from './Dispatch.js'
import {
  AlreadyAnswered,
  DispatchNotFound,
  SnoozeMinutesNotPreset,
} from './dispatch.rejection.js'
import { ReminderOwnerId } from './ReminderOwner.id.js'
import { DispatchOpened } from './ClaimFire.command.js'

/**
 * The answer commands — Done / Snooze / Dismiss (ADR-0005 §6; the glossary's
 * Dispatch answer axis, one command per intent).
 *
 * One fire is one answer, decided one command at a time on the owner's
 * instance: the double tap the old compare-and-set used to absorb is now the
 * typed `AlreadyAnswered` rejection, and the respond route answers it with
 * the stored answer, exactly as before.
 *
 * On-time is measured from the **root** fire instant (`rootScheduledFor`),
 * never from a snooze: the 30-minute grace does not restart, so
 * snoozed-then-done reads as late once the root window has passed
 * (ADR-0005 §6).
 */

/** The one answer a dispatch can receive; the adherence metric reads it. */
export class DispatchAnswered extends Domain.Event('DispatchAnswered', {
  dispatchId: ReminderDispatchId,
  response: DispatchResponseValue,
  respondedAt: TimestampUtc,
  /** Set on a snooze: the parent's target, also the child's fire instant. */
  snoozedUntil: Schema.NullOr(TimestampUtc),
  /** `done` within 30 minutes of the root fire (early counts). */
  onTime: Schema.Boolean,
}) {}

/** `AnswerDone` — the owner did the thing (the inbox's primary action). */
export class AnswerDone extends Domain.Command(
  'AnswerDone',
  {
    target: ReminderOwnerId,
    input: { dispatchId: ReminderDispatchId },
    events: [DispatchAnswered],
    rejects: [DispatchNotFound, AlreadyAnswered],
    reply: AnswerReply.fields,
  },
  {
    description:
      'Answer one dispatch as done. On time when the answer lands within 30 minutes of the root fire; a double tap returns the stored answer.',
  },
) {}

/**
 * `Snooze` — "tell me again in X minutes", for one occurrence only
 * (5/10/15/30/60; ADR-0005 §5, #79).
 *
 * The child row is opened in the same commit as the parent's answer, so a
 * double tap produces one child and one answer. Its `deliverAt` **is** the
 * target: quiet hours never hold a snooze, and a chain may walk through the
 * night because every link needs a fresh tap. The series' schedule never
 * moves, and the child keeps the parent's `rootScheduledFor`.
 */
export class Snooze extends Domain.Command(
  'Snooze',
  {
    target: ReminderOwnerId,
    input: {
      dispatchId: ReminderDispatchId,
      minutes: Schema.Int,
    },
    events: [DispatchAnswered, DispatchOpened],
    rejects: [DispatchNotFound, AlreadyAnswered, SnoozeMinutesNotPreset],
    reply: AnswerReply.fields,
  },
  {
    description:
      'Answer one dispatch with a snooze and open its child at now + minutes (5, 10, 15, 30 or 60). Quiet hours never hold a snooze; the series schedule never moves.',
  },
) {}

/** `Dismiss` — the owner saw it and chose to close it. */
export class Dismiss extends Domain.Command(
  'Dismiss',
  {
    target: ReminderOwnerId,
    input: { dispatchId: ReminderDispatchId },
    events: [DispatchAnswered],
    rejects: [DispatchNotFound, AlreadyAnswered],
    reply: AnswerReply.fields,
  },
  {
    description:
      'Answer one dispatch as dismissed. Not on time, but the ledger keeps the answer forever.',
  },
) {}
