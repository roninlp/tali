import { describe, expect, it } from 'vite-plus/test'
import { Story } from '@alchemy.run/domain/Story'
import type { ReminderDispatchId, ReminderId } from '@tali/domain'
import {
  AnswerDone,
  DispatchAnswered,
  Dismiss,
  Snooze,
} from '../src/Answer.command.js'
import { DispatchOpened } from '../src/ClaimFire.command.js'
import { RecordPushOutcome } from '../src/RecordPushOutcome.command.js'
import {
  AlreadyAnswered,
  DispatchNotFound,
  NotOwed,
  SnoozeMinutesNotPreset,
} from '../src/dispatch.rejection.js'
import type { AnswerReply } from '../src/Dispatch.js'
import { resetStores } from './memory-stores.js'
import {
  T,
  after,
  claimFire,
  dispatchId,
  owner,
  run,
  story,
  thenClaim,
} from './harness.js'

/**
 * The answer half (ADR-0005 §6): one fire is one answer, decided one command
 * at a time; the on-time grace stays rooted at the original fire across
 * snoozes; and a snooze child is never held by quiet hours (#79).
 */

/** The ledger row as an answer command's reply returns it. */
const repliedRow = (
  id: ReminderDispatchId,
  over: Partial<AnswerReply['dispatch']> = {},
): AnswerReply['dispatch'] => ({
  id,
  reminderId: '0197f100-7000-7000-8000-700000000101' as ReminderId,
  scheduledFor: T('09:00'),
  deliverAt: T('09:00'),
  rootScheduledFor: T('09:00'),
  origin: 'schedule',
  pushOutcome: 'pending',
  attempts: 0,
  lastAttemptAt: null,
  parentDispatchId: null,
  response: null,
  respondedAt: null,
  snoozedUntil: null,
  createdAt: T('09:00'),
  ...over,
})

describe('AnswerDone / Snooze / Dismiss (ADR-0005 §6)', () => {
  it('answers done on time and replies with the ledger row', async () => {
    resetStores()
    const claim = claimFire()
    const id = dispatchId('0197f100-7000-7000-8000-700000000101', T('09:00'))
    const respondedAt = after(T('09:00'), 5 * 60_000)

    await run(
      story(
        Story.when(owner, claim),
        thenClaim(claim),
        Story.clock(respondedAt),
        Story.when(owner, new AnswerDone({ dispatchId: id })),
        Story.then(
          owner,
          new DispatchAnswered({
            dispatchId: id,
            response: 'done',
            respondedAt,
            snoozedUntil: null,
            onTime: true,
          }),
        ),
        Story.replied({
          dispatch: repliedRow(id, { response: 'done', respondedAt }),
          child: null,
          onTime: true,
        }),
      ),
    )
  })

  it('answers done late: past the 30-minute root grace', async () => {
    resetStores()
    const claim = claimFire()
    const id = dispatchId('0197f100-7000-7000-8000-700000000101', T('09:00'))
    const respondedAt = after(T('09:00'), 31 * 60_000)

    await run(
      story(
        Story.when(owner, claim),
        thenClaim(claim),
        Story.clock(respondedAt),
        Story.when(owner, new AnswerDone({ dispatchId: id })),
        Story.then(
          owner,
          new DispatchAnswered({
            dispatchId: id,
            response: 'done',
            respondedAt,
            snoozedUntil: null,
            onTime: false,
          }),
        ),
      ),
    )
  })

  it('snoozes inside quiet hours: the child fires at its target, never held to 07:00', async () => {
    resetStores()
    const fireAt = T('20:00')
    const claim = claimFire({ scheduledFor: fireAt, now: fireAt })
    const id = dispatchId('0197f100-7000-7000-8000-700000000101', fireAt)
    // "بعداً" at 23:25 → 23:35, inside quiet hours. Asking again is consent
    // (ADR-0005 §5, settled in #79).
    const snoozedAt = T('23:25')
    const target = T('23:35')
    const childId = dispatchId(
      '0197f100-7000-7000-8000-700000000101',
      target,
      `snooze:${id}`,
      snoozedAt,
    )

    await run(
      story(
        Story.when(owner, claim),
        thenClaim(claim),
        Story.clock(snoozedAt),
        Story.when(owner, new Snooze({ dispatchId: id, minutes: 10 })),
        Story.then(
          owner,
          new DispatchAnswered({
            dispatchId: id,
            response: 'snooze',
            respondedAt: snoozedAt,
            snoozedUntil: target,
            onTime: false,
          }),
          new DispatchOpened({
            id: childId,
            reminderId: claim.reminderId,
            // The child's deliver-at is its target as-is: quiet hours never
            // hold a snooze.
            scheduledFor: target,
            deliverAt: target,
            rootScheduledFor: fireAt,
            origin: `snooze:${id}`,
            pushOutcome: 'pending',
            attempts: 0,
            lastAttemptAt: null,
            parentDispatchId: id,
            response: null,
            respondedAt: null,
            snoozedUntil: null,
            createdAt: snoozedAt,
          }),
        ),
      ),
    )
  })

  it('a snooze of a snooze keeps walking, rooted at the original fire', async () => {
    resetStores()
    const fireAt = T('20:00')
    const claim = claimFire({ scheduledFor: fireAt, now: fireAt })
    const id = dispatchId('0197f100-7000-7000-8000-700000000101', fireAt)
    const firstAt = T('20:10')
    const firstTarget = T('20:20')
    const childId = dispatchId(
      '0197f100-7000-7000-8000-700000000101',
      firstTarget,
      `snooze:${id}`,
      firstAt,
    )
    const secondAt = T('20:20')
    const secondTarget = T('20:30')
    const grandchildId = dispatchId(
      '0197f100-7000-7000-8000-700000000101',
      secondTarget,
      `snooze:${childId}`,
      secondAt,
    )

    await run(
      story(
        Story.when(owner, claim),
        thenClaim(claim),
        Story.clock(firstAt),
        Story.when(owner, new Snooze({ dispatchId: id, minutes: 10 })),
        Story.then(
          owner,
          new DispatchAnswered({
            dispatchId: id,
            response: 'snooze',
            respondedAt: firstAt,
            snoozedUntil: firstTarget,
            onTime: false,
          }),
          new DispatchOpened({
            id: childId,
            reminderId: claim.reminderId,
            scheduledFor: firstTarget,
            deliverAt: firstTarget,
            rootScheduledFor: fireAt,
            origin: `snooze:${id}`,
            pushOutcome: 'pending',
            attempts: 0,
            lastAttemptAt: null,
            parentDispatchId: id,
            response: null,
            respondedAt: null,
            snoozedUntil: null,
            createdAt: firstAt,
          }),
        ),
        Story.clock(secondAt),
        Story.when(owner, new Snooze({ dispatchId: childId, minutes: 10 })),
        Story.then(
          owner,
          new DispatchAnswered({
            dispatchId: childId,
            response: 'snooze',
            respondedAt: secondAt,
            snoozedUntil: secondTarget,
            onTime: false,
          }),
          new DispatchOpened({
            id: grandchildId,
            reminderId: claim.reminderId,
            scheduledFor: secondTarget,
            deliverAt: secondTarget,
            // The grandchild still roots at the original fire.
            rootScheduledFor: fireAt,
            origin: `snooze:${childId}`,
            pushOutcome: 'pending',
            attempts: 0,
            lastAttemptAt: null,
            parentDispatchId: childId,
            response: null,
            respondedAt: null,
            snoozedUntil: null,
            createdAt: secondAt,
          }),
        ),
      ),
    )
  })

  it('snoozed-then-done is on time only inside the root grace', async () => {
    resetStores()
    const fireAt = T('09:00')
    const claim = claimFire()
    const id = dispatchId('0197f100-7000-7000-8000-700000000101', fireAt)
    const snoozedAt = after(fireAt, 10 * 60_000)
    const target = after(fireAt, 20 * 60_000)
    const childId = dispatchId(
      '0197f100-7000-7000-8000-700000000101',
      target,
      `snooze:${id}`,
      snoozedAt,
    )
    // 25 minutes after the ROOT fire is still within the grace, even though
    // the child was answered minutes ago.
    const doneAt = after(fireAt, 25 * 60_000)

    await run(
      story(
        Story.when(owner, claim),
        thenClaim(claim),
        Story.clock(snoozedAt),
        Story.when(owner, new Snooze({ dispatchId: id, minutes: 10 })),
        Story.then(
          owner,
          new DispatchAnswered({
            dispatchId: id,
            response: 'snooze',
            respondedAt: snoozedAt,
            snoozedUntil: target,
            onTime: false,
          }),
          new DispatchOpened({
            id: childId,
            reminderId: claim.reminderId,
            scheduledFor: target,
            deliverAt: target,
            rootScheduledFor: fireAt,
            origin: `snooze:${id}`,
            pushOutcome: 'pending',
            attempts: 0,
            lastAttemptAt: null,
            parentDispatchId: id,
            response: null,
            respondedAt: null,
            snoozedUntil: null,
            createdAt: snoozedAt,
          }),
        ),
        Story.clock(doneAt),
        Story.when(owner, new AnswerDone({ dispatchId: childId })),
        Story.then(
          owner,
          new DispatchAnswered({
            dispatchId: childId,
            response: 'done',
            respondedAt: doneAt,
            snoozedUntil: null,
            onTime: true,
          }),
        ),
      ),
    )
  })

  it('a double tap is refused with the stored answer, never a second row', async () => {
    resetStores()
    const claim = claimFire()
    const id = dispatchId('0197f100-7000-7000-8000-700000000101', T('09:00'))

    await run(
      story(
        Story.when(owner, claim),
        thenClaim(claim),
        Story.clock(T('09:00')),
        Story.when(owner, new AnswerDone({ dispatchId: id })),
        Story.then(
          owner,
          new DispatchAnswered({
            dispatchId: id,
            response: 'done',
            respondedAt: T('09:00'),
            snoozedUntil: null,
            onTime: true,
          }),
        ),
        // The second tap of a racing double tap.
        Story.when(owner, new Snooze({ dispatchId: id, minutes: 5 })),
        Story.rejected(new AlreadyAnswered({ response: 'done' })),
        Story.state(owner, state => {
          expect(Object.keys(state.dispatches)).toHaveLength(1)
          expect(state.snoozeChildren).toEqual({})
        }),
      ),
    )
  })

  it('refuses a snooze length outside the preset set', async () => {
    resetStores()
    const claim = claimFire()
    const id = dispatchId('0197f100-7000-7000-8000-700000000101', T('09:00'))

    await run(
      story(
        Story.when(owner, claim),
        thenClaim(claim),
        Story.clock(T('09:00')),
        Story.when(owner, new Snooze({ dispatchId: id, minutes: 7 })),
        Story.rejected(new SnoozeMinutesNotPreset({ minutes: 7 })),
      ),
    )
  })

  it('refuses an answer for an unknown dispatch', async () => {
    resetStores()
    const id = dispatchId('0197f100-7000-7000-8000-700000000101', T('09:00'))

    await run(
      story(
        Story.clock(T('09:00')),
        Story.when(owner, new Dismiss({ dispatchId: id })),
        Story.rejected(new DispatchNotFound({ dispatchId: id })),
      ),
    )
  })

  it('dismisses: answered, and never on time', async () => {
    resetStores()
    const claim = claimFire()
    const id = dispatchId('0197f100-7000-7000-8000-700000000101', T('09:00'))
    const respondedAt = after(T('09:00'), 60_000)

    await run(
      story(
        Story.when(owner, claim),
        thenClaim(claim),
        Story.clock(respondedAt),
        Story.when(owner, new Dismiss({ dispatchId: id })),
        Story.then(
          owner,
          new DispatchAnswered({
            dispatchId: id,
            response: 'dismiss',
            respondedAt,
            snoozedUntil: null,
            onTime: false,
          }),
        ),
      ),
    )
  })

  it('refuses the push outcome once the answer won the race', async () => {
    resetStores()
    const claim = claimFire()
    const id = dispatchId('0197f100-7000-7000-8000-700000000101', T('09:00'))

    await run(
      story(
        Story.when(owner, claim),
        thenClaim(claim),
        Story.clock(after(T('09:00'), 60_000)),
        Story.when(owner, new AnswerDone({ dispatchId: id })),
        Story.then(
          owner,
          new DispatchAnswered({
            dispatchId: id,
            response: 'done',
            respondedAt: after(T('09:00'), 60_000),
            snoozedUntil: null,
            onTime: true,
          }),
        ),
        // The push was in flight when the answer landed; its late outcome
        // has nothing left to record.
        Story.when(
          owner,
          new RecordPushOutcome({
            dispatchId: id,
            outcome: 'accepted',
            at: after(T('09:00'), 61_000),
          }),
        ),
        Story.rejected(new NotOwed({ dispatchId: id })),
      ),
    )
  })
})

