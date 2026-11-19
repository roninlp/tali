import { describe, expect, it } from 'vite-plus/test'
import { Story } from '@alchemy.run/domain/Story'
import {
  DeleteReminder,
  ReminderDeleted,
  ReminderSilenced,
  SilenceReminder,
} from '../src/ReminderLifecycle.command.js'
import { DispatchExpired } from '../src/DeliverDue.command.js'
import {
  ledgerChanges,
  resetStores,
  scheduleAdvances,
} from './memory-stores.js'
import {
  REMINDER_ID,
  T,
  claimFire,
  claimSteps,
  dispatchId,
  owner,
  run,
  story,
} from './harness.js'

/**
 * The write path's change of mind (ADR-0005 §5): "setting a silence or
 * deleting a reminder also expires any dispatch already owed, so a held row
 * cannot push after the owner has changed their mind."
 *
 * The projection feed is asserted here too: the D1 ledger and schedule stores
 * receive exactly the rows the tables would write.
 */

describe('SilenceReminder / DeleteReminder — the change of mind (ADR-0005 §5)', () => {
  it('setting a silence expires every dispatch the reminder still owes', async () => {
    resetStores()
    const fireAt = T('23:30')
    const claim = claimFire({ scheduledFor: fireAt, now: fireAt })
    const id = dispatchId(REMINDER_ID, fireAt)

    await run(
      story(
        // A held row: claimed at 23:30, deliver-at 07:00.
        ...claimSteps(claim),
        Story.clock(T('23:45')),
        Story.when(
          owner,
          new SilenceReminder({
            reminderId: REMINDER_ID,
            until: T('12:00', '2026-10-22'),
          }),
        ),
        Story.then(
          owner,
          new ReminderSilenced({
            reminderId: REMINDER_ID,
            until: T('12:00', '2026-10-22'),
          }),
          new DispatchExpired({
            dispatchId: id,
            reason: 'silenced',
          }),
        ),
      ),
    )
  })

  it('clearing a silence records the fact and expires nothing', async () => {
    resetStores()
    const claim = claimFire()

    await run(
      story(
        ...claimSteps(claim),
        Story.clock(T('09:05')),
        Story.when(
          owner,
          new SilenceReminder({ reminderId: REMINDER_ID, until: null }),
        ),
        Story.then(
          owner,
          new ReminderSilenced({ reminderId: REMINDER_ID, until: null }),
        ),
        // The owed row is untouched.
        Story.state(owner, state => {
          const owed = Object.values(state.dispatches).filter(
            row =>
              row.response === null &&
              (row.pushOutcome === 'pending' || row.pushOutcome === 'failed'),
          )
          expect(owed).toHaveLength(1)
        }),
      ),
    )
  })

  it('deleting a reminder expires its owed dispatches too', async () => {
    resetStores()
    const fireAt = T('23:30')
    const claim = claimFire({ scheduledFor: fireAt, now: fireAt })
    const id = dispatchId(REMINDER_ID, fireAt)

    await run(
      story(
        ...claimSteps(claim),
        Story.clock(T('23:45')),
        Story.when(owner, new DeleteReminder({ reminderId: REMINDER_ID })),
        Story.then(
          owner,
          new ReminderDeleted({ reminderId: REMINDER_ID }),
          new DispatchExpired({
            dispatchId: id,
            reason: 'reminder-deleted',
          }),
        ),
      ),
    )
  })

  it('feeds the D1 ledger and schedule stores exactly what the tables expect', async () => {
    resetStores()
    const fireAt = T('09:00')
    const claim = claimFire({ repeat: { _tag: 'daily', time: '09:00' } })
    const id = dispatchId(REMINDER_ID, fireAt)

    await run(story(...claimSteps(claim, T('09:00', '2026-10-22'))))

    // The schedule projection advanced the synced row with one compare-and-set.
    expect(scheduleAdvances()).toEqual([
      {
        reminderId: REMINDER_ID,
        from: fireAt,
        to: T('09:00', '2026-10-22'),
      },
    ])

    // The ledger projection mirrored the opened row, user_id included.
    expect(ledgerChanges()).toEqual([
      {
        _tag: 'Opened',
        userId: 'user-a',
        dispatch: {
          id,
          reminderId: REMINDER_ID,
          scheduledFor: fireAt,
          deliverAt: fireAt,
          rootScheduledFor: fireAt,
          origin: 'schedule',
          pushOutcome: 'pending',
          attempts: 0,
          lastAttemptAt: null,
          parentDispatchId: null,
          response: null,
          respondedAt: null,
          snoozedUntil: null,
          createdAt: fireAt,
        },
      },
    ])
  })
})
