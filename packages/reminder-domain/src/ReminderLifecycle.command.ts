import * as Domain from '@alchemy.run/domain'
import { Schema } from 'effect'
import { ReminderId, TimestampUtc } from '@tali/domain'
import { ReminderOwnerId } from './ReminderOwner.id.js'
import { DispatchExpired } from './DeliverDue.command.js'

/**
 * `SilenceReminder` / `DeleteReminder` — the write path's change of mind
 * (ADR-0005 §5: "setting a silence or deleting a reminder also expires any
 * dispatch already owed, so a held row cannot push after the owner has
 * changed their mind").
 *
 * The api sends one of these right after the synced row commits, with the
 * row's post-write version in its command id so a re-set after a clear is a
 * fresh command, not a replayed receipt. The sweep's fresh facts are the
 * backstop for the sync path, which never sees the model; together every owed
 * row of a silenced or deleted reminder — held overnight, mid-retry, or a
 * snooze child — closes without pushing.
 */

/** The reminder's silence changed. The event records the fact; expiry is separate. */
export class ReminderSilenced extends Domain.Event('ReminderSilenced', {
  reminderId: ReminderId,
  until: Schema.NullOr(TimestampUtc),
}) {}

export class SilenceReminder extends Domain.Command(
  'SilenceReminder',
  {
    target: ReminderOwnerId,
    input: {
      reminderId: ReminderId,
      /** The silence's end, or `null` to clear it (clearing expires nothing). */
      until: Schema.NullOr(TimestampUtc),
    },
    events: [ReminderSilenced, DispatchExpired],
  },
  {
    description:
      'Set or clear a reminder series silence. Setting it expires every dispatch the reminder still owes — a held row must not push after the owner changed their mind.',
  },
) {}

/** The reminder was deleted (tombstoned in the synced rows). */
export class ReminderDeleted extends Domain.Event('ReminderDeleted', {
  reminderId: ReminderId,
}) {}

export class DeleteReminder extends Domain.Command(
  'DeleteReminder',
  {
    target: ReminderOwnerId,
    input: { reminderId: ReminderId },
    events: [ReminderDeleted, DispatchExpired],
  },
  {
    description:
      'Record a reminder deletion on the owner ledger and expire every dispatch it still owes.',
  },
) {}
