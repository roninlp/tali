import { Schema } from 'effect'
import {
  ReminderDispatchId,
  ReminderId,
  ReminderRepeat,
  ReminderTier,
  ReminderType,
  TimestampUtc,
  UserId,
} from '@tali/domain'
import {
  AnswerReply,
  DispatchResponseValue,
  type DispatchFacts,
} from './Dispatch.js'
import type { ReminderOwnerId } from './ReminderOwner.id.js'

/**
 * The internal wire between the api Worker and the reminders Worker — the
 * model's only client. One authenticated service binding, four plain-JSON
 * routes; the schemas live with the model so the two sides cannot drift.
 *
 * The api owns auth and the envelope; this Worker trusts the binding and
 * additionally checks a shared secret header, so its routes are unreachable
 * even if a public URL ever appears.
 */

/** A due fire the tick read from the synced rows, ready to be claimed. */
export const DueFireWire = Schema.Struct({
  ownerId: UserId,
  now: TimestampUtc,
  reminderId: ReminderId,
  scheduledFor: TimestampUtc,
  /** The reminder's own zone: the series advance is computed in it. */
  reminderTimeZone: Schema.String,
  /** The owner's IANA zone: quiet hours follow the owner (ADR-0002). */
  ownerTimeZone: Schema.String,
  tier: ReminderTier,
  version: Schema.Int,
  repeat: ReminderRepeat,
  silencedUntil: Schema.NullOr(TimestampUtc),
  title: Schema.String,
  note: Schema.NullOr(Schema.String),
  kind: ReminderType,
})
export type DueFireWire = Schema.Schema.Type<typeof DueFireWire>

/** Fresh facts for one owed dispatch, tagged with its owner. */
export const OwnedFactsWire = Schema.Struct({
  ownerId: UserId,
  dispatchId: ReminderDispatchId,
  title: Schema.String,
  note: Schema.NullOr(Schema.String),
  kind: ReminderType,
  tier: ReminderTier,
  silencedUntil: Schema.NullOr(TimestampUtc),
  deletedAt: Schema.NullOr(TimestampUtc),
})
export type OwnedFactsWire = Schema.Schema.Type<typeof OwnedFactsWire>

/** One tick's whole payload: what the api read, claimed per owner. */
export const SweepRequest = Schema.Struct({
  now: TimestampUtc,
  fires: Schema.Array(DueFireWire),
  facts: Schema.Array(OwnedFactsWire),
})
export type SweepRequest = Schema.Schema.Type<typeof SweepRequest>

/** The tick's tally, for the api's log line. */
export const SweepResponse = Schema.Struct({
  claimed: Schema.Int,
  suppressed: Schema.Int,
  due: Schema.Int,
  expired: Schema.Int,
})
export type SweepResponse = Schema.Schema.Type<typeof SweepResponse>

/** The respond route's forwarded answer. */
export const RespondRequest = Schema.Struct({
  ownerId: UserId,
  dispatchId: ReminderDispatchId,
  response: DispatchResponseValue,
  snoozeMinutes: Schema.optional(Schema.Int),
})
export type RespondRequest = Schema.Schema.Type<typeof RespondRequest>

/** The respond route's answer, unchanged for the client. */
export const RespondResponse = AnswerReply
export type RespondResponse = Schema.Schema.Type<typeof RespondResponse>

/** The write path's silence request. */
export const SilenceRequest = Schema.Struct({
  ownerId: UserId,
  reminderId: ReminderId,
  until: Schema.NullOr(TimestampUtc),
  version: Schema.Int,
})
export type SilenceRequest = Schema.Schema.Type<typeof SilenceRequest>

/** The write path's delete request. */
export const DeleteReminderRequest = Schema.Struct({
  ownerId: UserId,
  reminderId: ReminderId,
  version: Schema.Int,
})
export type DeleteReminderRequest = Schema.Schema.Type<
  typeof DeleteReminderRequest
>

/** Strip the wire's owner tag: the command target already carries it. */
export const factsOf = (wire: OwnedFactsWire): DispatchFacts => ({
  dispatchId: wire.dispatchId,
  title: wire.title,
  note: wire.note,
  kind: wire.kind,
  tier: wire.tier,
  silencedUntil: wire.silencedUntil,
  deletedAt: wire.deletedAt,
})

export type { ReminderOwnerId }
