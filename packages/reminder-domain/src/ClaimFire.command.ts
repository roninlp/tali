import * as Domain from '@alchemy.run/domain'
import { Schema } from 'effect'
import {
  ReminderId,
  ReminderRepeat,
  ReminderTier,
  ReminderType,
  TimestampUtc,
} from '@tali/domain'
import { DispatchSnapshot } from './Dispatch.js'
import { ReminderOwnerId } from './ReminderOwner.id.js'

/**
 * `ClaimFire` — one due fire becomes this sweep's responsibility (ADR-0005
 * §3/§5; the glossary's **Claim**).
 *
 * The cron tick reads due fires from the synced `reminders` rows (the only
 * scheduling state, ADR-0005 §Consequences) and sends one command per fire
 * to the owner's instance, carrying everything the claim decides on. The
 * command is a *fact report*, not a request: an already-claimed fire is an
 * accepted no-op, never a rejection, because a repeated, late or overlapping
 * tick is the normal case the ledger's unique key used to absorb. That key —
 * one claim per (reminder, fire instant, origin) — is now the instance's own
 * `claims` map, decided one command at a time.
 *
 * **The policy runs here, at claim time** (ADR-0005 §5): a fire inside a
 * **Silence** is suppressed with no dispatch row at all, the medication tier
 * bypasses **Quiet Hours**, and a normal fire inside the window is held by
 * writing its **Deliver At** as the next local 07:00. The sweep's delivery
 * half only ever compares that instant.
 *
 * `nextFireAt` on the events is the series' advance, computed with the same
 * pure functions the write path uses, so the schedule projection can move the
 * synced row with one compare-and-set.
 */

/** The fire was claimed: its dispatch row is the ledger's next owed work. */
export class FireClaimed extends Domain.Event('FireClaimed', {
  reminderId: ReminderId,
  scheduledFor: TimestampUtc,
  /** The series' next fire after this claim; `null` when there is none. */
  nextFireAt: Schema.NullOr(TimestampUtc),
}) {}

/**
 * The fire fell inside a **Silence**: no dispatch row exists. Silence is not
 * a hold — the series simply advances past it.
 */
export class FireSuppressed extends Domain.Event('FireSuppressed', {
  reminderId: ReminderId,
  scheduledFor: TimestampUtc,
  /** Where the series resumes (the silence's end or the next occurrence). */
  nextFireAt: Schema.NullOr(TimestampUtc),
}) {}

/**
 * One ledger row was opened — by this claim, or by a **Snooze** opening its
 * child. One row per (reminder, fire instant, origin); the row is written
 * before anything is sent and never deleted.
 */
export class DispatchOpened extends Domain.Event('DispatchOpened', {
  ...DispatchSnapshot.fields,
}) {}

export class ClaimFire extends Domain.Command(
  'ClaimFire',
  {
    target: ReminderOwnerId,
    input: {
      /** The tick's nominal clock (`controller.scheduledTime`), never wall time. */
      now: TimestampUtc,
      reminderId: ReminderId,
      /** The claimed fire instant (`reminders.fire_at` at the tick's read). */
      scheduledFor: TimestampUtc,
      /** The reminder's own zone: the series advance is computed in it. */
      timeZone: Schema.String,
      /** The owner's IANA zone (preferences, falling back to the profile). */
      ownerTimeZone: Schema.String,
      tier: ReminderTier,
      /** The synced row's version, so a re-armed edit claims again. */
      version: Schema.Int,
      repeat: ReminderRepeat,
      silencedUntil: Schema.NullOr(TimestampUtc),
      /** The words the eventual push shows; not ledger state. */
      title: Schema.String,
      note: Schema.NullOr(Schema.String),
      kind: ReminderType,
    },
    events: [FireClaimed, FireSuppressed, DispatchOpened],
  },
  {
    description:
      'Claim one due fire on the owner ledger: open its dispatch (quiet hours and the medication tier decided here), or suppress it inside a silence. A repeated claim of the same fire does nothing.',
  },
) {}
