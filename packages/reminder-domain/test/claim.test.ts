import { describe, expect, it } from 'vite-plus/test'
import { Story } from '@alchemy.run/domain/Story'
import {
  FireClaimed,
  FireSuppressed,
  DispatchOpened,
} from '../src/ClaimFire.command.js'
import { resetStores } from './memory-stores.js'
import { scheduleAdvances } from './memory-stores.js'
import {
  REMINDER_ID,
  T,
  claimFire,
  dispatchId,
  owner,
  run,
  story,
} from './harness.js'

/**
 * The claim half of the sweep (ADR-0005 §3/§5): one command per due fire,
 * decided against the owner's ledger. The claim mutex is the instance's
 * `claims` map — a repeated, late or overlapping tick records nothing.
 */

describe('ClaimFire — the claim and its policy (ADR-0005 §3/§5)', () => {
  it('claims a due fire into an owed dispatch and advances the series', async () => {
    resetStores()
    const fireAt = T('09:00')

    await run(
      story(
        Story.when(
          owner,
          claimFire({ repeat: { _tag: 'daily', time: '09:00' } }),
        ),
        Story.then(
          owner,
          new FireClaimed({
            reminderId: REMINDER_ID,
            scheduledFor: fireAt,
            nextFireAt: T('09:00', '2026-10-22'),
          }),
          new DispatchOpened({
            id: dispatchId(REMINDER_ID, fireAt),
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
          }),
        ),
      ),
    )

    // The schedule projection fed D1's compare-and-set advance from the event.
    expect(scheduleAdvances()).toEqual([
      {
        reminderId: REMINDER_ID,
        from: fireAt,
        to: T('09:00', '2026-10-22'),
      },
    ])
  })

  it('never claims the same fire twice: a repeated tick records nothing', async () => {
    resetStores()
    const fireAt = T('09:00')

    await run(
      story(
        Story.when(owner, claimFire()),
        Story.then(
          owner,
          new FireClaimed({
            reminderId: REMINDER_ID,
            scheduledFor: fireAt,
            nextFireAt: null,
          }),
          new DispatchOpened({
            id: dispatchId(REMINDER_ID, fireAt),
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
          }),
        ),
        // A later tick re-reads the same due fire (the schedule advance has
        // not landed yet) and asks again — with a fresh command id.
        Story.when(owner, claimFire(), { commandId: 'tick-2' }),
        Story.then(owner),
        Story.state(owner, state => {
          expect(Object.values(state.dispatches)).toHaveLength(1)
        }),
      ),
    )
  })

  it('holds a normal fire inside quiet hours until the next local 07:00', async () => {
    resetStores()
    const fireAt = T('23:30')

    await run(
      story(
        Story.when(owner, claimFire({ scheduledFor: fireAt, now: fireAt })),
        Story.then(
          owner,
          new FireClaimed({
            reminderId: REMINDER_ID,
            scheduledFor: fireAt,
            nextFireAt: null,
          }),
          new DispatchOpened({
            id: dispatchId(REMINDER_ID, fireAt),
            reminderId: REMINDER_ID,
            scheduledFor: fireAt,
            // The ledger row *is* the overnight queue (ADR-0005 §5).
            deliverAt: T('07:00', '2026-10-22'),
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
          }),
        ),
      ),
    )
  })

  it('bypasses quiet hours for the medication (critical) tier', async () => {
    resetStores()
    const fireAt = T('23:30')

    await run(
      story(
        Story.when(
          owner,
          claimFire({
            scheduledFor: fireAt,
            now: fireAt,
            tier: 'critical',
          }),
        ),
        Story.then(
          owner,
          new FireClaimed({
            reminderId: REMINDER_ID,
            scheduledFor: fireAt,
            nextFireAt: null,
          }),
          new DispatchOpened({
            id: dispatchId(REMINDER_ID, fireAt),
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
          }),
        ),
      ),
    )
  })

  it('suppresses a silenced fire with no dispatch and advances past the silence', async () => {
    resetStores()
    const fireAt = T('09:00')

    await run(
      story(
        Story.when(
          owner,
          claimFire({
            silencedUntil: T('12:00'),
            repeat: { _tag: 'daily', time: '09:00' },
          }),
        ),
        Story.then(
          owner,
          new FireSuppressed({
            reminderId: REMINDER_ID,
            scheduledFor: fireAt,
            nextFireAt: T('09:00', '2026-10-22'),
          }),
        ),
        // A repeated tick's suppressed fire is the same no-op a claim is.
        Story.when(owner, claimFire({ silencedUntil: T('12:00') }), {
          commandId: 'tick-2',
        }),
        Story.then(owner),
      ),
    )
  })

  it('a catch-up tick advances the series past the outage it already covered', async () => {
    resetStores()
    const fireAt = T('09:00')
    // The Worker was down for 16 hours; the 09:00 fire is claimed at 01:00
    // the next night: the series must jump past every missed occurrence.
    const catchUpAt = T('01:00', '2026-10-22')

    await run(
      story(
        Story.when(
          owner,
          claimFire({
            scheduledFor: fireAt,
            now: catchUpAt,
            repeat: { _tag: 'daily', time: '09:00' },
          }),
        ),
        Story.then(
          owner,
          new FireClaimed({
            reminderId: REMINDER_ID,
            scheduledFor: fireAt,
            nextFireAt: T('09:00', '2026-10-22'),
          }),
          new DispatchOpened({
            id: dispatchId(REMINDER_ID, fireAt, 'schedule', catchUpAt),
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
            createdAt: catchUpAt,
          }),
        ),
      ),
    )
  })
})
