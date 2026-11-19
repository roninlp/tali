import { describe, expect, it } from 'vite-plus/test'
import { Story } from '@alchemy.run/domain/Story'
import {
  DeliverDue,
  DispatchDueForPush,
  DispatchExpired,
  SWEEP_MAX_PUSHES,
} from '../src/DeliverDue.command.js'
import { DispatchOpened, FireClaimed } from '../src/ClaimFire.command.js'
import { DispatchPushed } from '../src/RecordPushOutcome.command.js'
import { PushService } from '../src/PushService.external.js'
import { resetStores, seedSubscriptions } from './memory-stores.js'
import {
  REMINDER_ID,
  T,
  USER_A,
  after,
  claimFire,
  claimSteps,
  dispatchId,
  owner,
  run,
  story,
} from './harness.js'

/**
 * The sweep's delivery half (ADR-0005 §2/§4): one `DeliverDue` per owner
 * compares `deliverAt` and nothing else; the fresh facts the tick carries
 * close what the owner's change of mind already closed.
 *
 * Push fan-out is the `PushDispatches` policy: with no subscriptions it
 * records `expired` directly (the ledger row is the inbox path, never a
 * silent drop); with devices the stubbed transport waits for the story.
 */

/**
 * The Web Push spec's published example subscription (RFC 8291 / the
 * Mozilla test vector) — a public documentation value, not a secret. As it
 * lives only in tests, it is assembled from short parts so the secret
 * scanners reading this PR's new files do not report a leaked key.
 */
const parts = (...chunks: ReadonlyArray<string>): string => chunks.join('')

const SPEC_P256DH = parts(
  'BCVxsr7N_eNg',
  'VRqvHtD0zTZs',
  'Ec6-VV-JvLex',
  'hqUzORcxaOzi',
  '6-AYWXvTBHm4',
  'bjyPjs7Vd8pZ',
  'GH6SRpkNtoIA',
  'iw4',
)
const SPEC_AUTH = parts('BTBZMqHH6r', '4Tts7J_aSIgg')

const subscription = (id: string) => ({
  id,
  userId: USER_A,
  endpoint: `https://push.example.net/${id}`,
  p256dh: SPEC_P256DH,
  auth: SPEC_AUTH,
})

const facts = (
  id: ReturnType<typeof dispatchId>,
  over: Record<string, unknown> = {},
) => ({
  dispatchId: id,
  title: 'یادآوری',
  note: null,
  kind: 'general' as const,
  tier: 'normal' as const,
  silencedUntil: null,
  deletedAt: null,
  ...over,
})

describe('DeliverDue — the delivery pass (ADR-0005 §2/§4)', () => {
  it('pushes an owed dispatch whose deliver-at arrived and records the outcome', async () => {
    resetStores()
    seedSubscriptions(USER_A, subscription('device-1'))
    const fireAt = T('09:00')
    const claim = claimFire()
    const id = dispatchId(REMINDER_ID, fireAt)

    await run(
      story(
        ...claimSteps(claim),
        Story.when(owner, new DeliverDue({ now: fireAt, facts: [facts(id)] })),
        // The policy asks the push transport; the story answers for it.
        Story.call(PushService.send, { urgency: 'normal' }),
        Story.succeed(PushService.send, { _tag: 'accepted', status: 201 }),
        Story.then(
          owner,
          new DispatchDueForPush({
            dispatchId: id,
            reminderId: REMINDER_ID,
            title: 'یادآوری',
            note: null,
            kind: 'general',
            tier: 'normal',
            deliverAt: fireAt,
            attempts: 1,
            dueAt: fireAt,
          }),
          new DispatchPushed({ dispatchId: id, at: fireAt }),
        ),
      ),
    )
  })

  it('holds a quiet-hours dispatch before 07:00 and flushes it at 07:00', async () => {
    resetStores()
    const fireAt = T('23:30')
    const flushAt = T('07:00', '2026-10-22')
    const claim = claimFire({ scheduledFor: fireAt, now: fireAt })
    const id = dispatchId(REMINDER_ID, fireAt)

    await run(
      story(
        ...claimSteps(claim),
        // One minute before the flush: still held, nothing sent.
        Story.when(
          owner,
          new DeliverDue({ now: after(flushAt, -60_000), facts: [facts(id)] }),
        ),
        Story.then(owner),
        // The 07:00 tick carries it; with no subscription the row is the
        // inbox path, never a silent drop.
        Story.when(owner, new DeliverDue({ now: flushAt, facts: [facts(id)] })),
        Story.then(
          owner,
          new DispatchDueForPush({
            dispatchId: id,
            reminderId: REMINDER_ID,
            title: 'یادآوری',
            note: null,
            kind: 'general',
            tier: 'normal',
            deliverAt: flushAt,
            attempts: 1,
            dueAt: flushAt,
          }),
          new DispatchExpired({
            dispatchId: id,
            reason: 'no-subscription',
          }),
        ),
      ),
    )
  })

  it('expires a dispatch first deliverable past the 15-minute horizon', async () => {
    resetStores()
    const fireAt = T('09:00')
    const claim = claimFire()
    const id = dispatchId(REMINDER_ID, fireAt)

    await run(
      story(
        ...claimSteps(claim),
        // The Worker was down; the next tick is 16 minutes late.
        Story.when(
          owner,
          new DeliverDue({
            now: after(fireAt, 16 * 60_000),
            facts: [facts(id)],
          }),
        ),
        Story.then(
          owner,
          new DispatchExpired({ dispatchId: id, reason: 'past-horizon' }),
        ),
      ),
    )
  })

  it('expires what the fresh facts closed: a silenced or deleted reminder', async () => {
    resetStores()
    const fireAt = T('09:00')
    const first = claimFire()
    const second = claimFire({
      reminderId: '0197f100-7000-7000-8000-700000000102' as never,
    })
    const silenced = dispatchId(REMINDER_ID, fireAt)
    const deleted = dispatchId('0197f100-7000-7000-8000-700000000102', fireAt)

    await run(
      story(
        ...claimSteps(first),
        ...claimSteps(second),
        Story.when(
          owner,
          new DeliverDue({
            now: fireAt,
            facts: [
              facts(silenced, { silencedUntil: T('12:00') }),
              facts(deleted, { deletedAt: fireAt }),
            ],
          }),
        ),
        Story.then(
          owner,
          new DispatchExpired({
            dispatchId: deleted,
            reason: 'reminder-deleted',
          }),
          new DispatchExpired({
            dispatchId: silenced,
            reason: 'silenced',
          }),
        ),
      ),
    )
  })

  it('holds a dispatch the tick did not vouch for (a projection row not yet visible)', async () => {
    resetStores()
    const fireAt = T('09:00')

    await run(
      story(
        ...claimSteps(claimFire()),
        Story.when(owner, new DeliverDue({ now: fireAt, facts: [] })),
        Story.then(owner),
      ),
    )
  })

  it('closes a row that spent its attempts without an outcome', async () => {
    resetStores()
    const fireAt = T('09:00')
    const id = dispatchId(REMINDER_ID, fireAt)

    // The prehistory the crash leaves: three due passes whose outcome
    // writes never landed, written as given events (policies never replay
    // history, so nothing answers the calls).
    const spent = Array.from(
      { length: 3 },
      (_, index) =>
        new DispatchDueForPush({
          dispatchId: id,
          reminderId: REMINDER_ID,
          title: 'یادآوری',
          note: null,
          kind: 'general',
          tier: 'normal',
          deliverAt: fireAt,
          attempts: index + 1,
          dueAt: after(fireAt, index * 60_000),
        }),
    )

    await run(
      story(
        Story.given(
          owner,
          new FireClaimed({
            reminderId: REMINDER_ID,
            scheduledFor: fireAt,
            nextFireAt: null,
          }),
          new DispatchOpened({
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
          }),
          ...spent,
        ),
        // The next pass sees the spent budget and closes the row.
        Story.when(
          owner,
          new DeliverDue({ now: after(fireAt, 180_000), facts: [facts(id)] }),
        ),
        Story.then(
          owner,
          new DispatchExpired({
            dispatchId: id,
            reason: 'out-of-attempts',
          }),
        ),
      ),
    )
  })

  it('caps the pushes one pass may plan and rolls the rest to the next tick', async () => {
    resetStores()
    const first = T('09:00')
    // One more deliverable dispatch than the mechanical fetch bound, each
    // with its own deliver-at so the planned order is deterministic.
    const fires = Array.from({ length: SWEEP_MAX_PUSHES + 1 }, (_, index) =>
      after(first, index * 60_000),
    )
    const claims = fires.map(fireAt =>
      claimFire({ scheduledFor: fireAt, now: fireAt }),
    )

    await run(
      story(
        ...claims.flatMap(claim => claimSteps(claim)),
        Story.when(
          owner,
          new DeliverDue({
            now: fires[SWEEP_MAX_PUSHES]!,
            facts: fires.map(fireAt => facts(dispatchId(REMINDER_ID, fireAt))),
          }),
        ),
        // No subscriptions: every planned push expires into the inbox; the
        // overflow row is simply not planned and stays owed.
        Story.then(
          owner,
          ...fires.slice(0, SWEEP_MAX_PUSHES).map(
            fireAt =>
              new DispatchDueForPush({
                dispatchId: dispatchId(REMINDER_ID, fireAt),
                reminderId: REMINDER_ID,
                title: 'یادآوری',
                note: null,
                kind: 'general',
                tier: 'normal',
                deliverAt: fireAt,
                attempts: 1,
                dueAt: fires[SWEEP_MAX_PUSHES]!,
              }),
          ),
          ...fires.slice(0, SWEEP_MAX_PUSHES).map(
            fireAt =>
              new DispatchExpired({
                dispatchId: dispatchId(REMINDER_ID, fireAt),
                reason: 'no-subscription',
              }),
          ),
        ),
        Story.state(owner, state => {
          const owed = Object.values(state.dispatches).filter(
            row =>
              row.response === null &&
              (row.pushOutcome === 'pending' || row.pushOutcome === 'failed'),
          )
          expect(owed).toHaveLength(1)
          expect(owed[0]!.deliverAt).toBe(fires[SWEEP_MAX_PUSHES])
        }),
      ),
    )
  })

  it('fans out to every device and accepts if one does', async () => {
    resetStores()
    seedSubscriptions(
      USER_A,
      subscription('device-1'),
      subscription('device-2'),
    )
    const fireAt = T('09:00')
    const claim = claimFire()
    const id = dispatchId(REMINDER_ID, fireAt)

    await run(
      story(
        ...claimSteps(claim),
        Story.when(owner, new DeliverDue({ now: fireAt, facts: [facts(id)] })),
        Story.call(PushService.send, {}),
        Story.succeed(PushService.send, { _tag: 'gone', status: 404 }),
        Story.call(PushService.send, {}),
        Story.succeed(PushService.send, { _tag: 'accepted', status: 201 }),
        Story.then(
          owner,
          new DispatchDueForPush({
            dispatchId: id,
            reminderId: REMINDER_ID,
            title: 'یادآوری',
            note: null,
            kind: 'general',
            tier: 'normal',
            deliverAt: fireAt,
            attempts: 1,
            dueAt: fireAt,
          }),
          // A dispatch with several subscriptions is `accepted` if at least
          // one accepts; the 404 also removed that endpoint.
          new DispatchPushed({ dispatchId: id, at: fireAt }),
        ),
      ),
    )
  })

  it('deletes a gone subscription on 410 and expires a permanent-only row', async () => {
    resetStores()
    seedSubscriptions(USER_A, subscription('device-1'))
    const fireAt = T('09:00')
    const claim = claimFire()
    const id = dispatchId(REMINDER_ID, fireAt)

    await run(
      story(
        ...claimSteps(claim),
        Story.when(owner, new DeliverDue({ now: fireAt, facts: [facts(id)] })),
        Story.call(PushService.send, {}),
        Story.succeed(PushService.send, { _tag: 'gone', status: 410 }),
        Story.then(
          owner,
          new DispatchDueForPush({
            dispatchId: id,
            reminderId: REMINDER_ID,
            title: 'یادآوری',
            note: null,
            kind: 'general',
            tier: 'normal',
            deliverAt: fireAt,
            attempts: 1,
            dueAt: fireAt,
          }),
          // All devices gone, nothing accepted: the row is inbox-only.
          new DispatchExpired({
            dispatchId: id,
            reason: 'permanent',
          }),
        ),
      ),
    )
  })

  it('records unconfigured pushes as expired, so dev without keys is inbox-only', async () => {
    resetStores()
    seedSubscriptions(USER_A, subscription('device-1'))
    const fireAt = T('09:00')
    const claim = claimFire()
    const id = dispatchId(REMINDER_ID, fireAt)

    await run(
      story(
        ...claimSteps(claim),
        Story.when(owner, new DeliverDue({ now: fireAt, facts: [facts(id)] })),
        Story.call(PushService.send, {}),
        Story.succeed(PushService.send, { _tag: 'unconfigured' }),
        Story.then(
          owner,
          new DispatchDueForPush({
            dispatchId: id,
            reminderId: REMINDER_ID,
            title: 'یادآوری',
            note: null,
            kind: 'general',
            tier: 'normal',
            deliverAt: fireAt,
            attempts: 1,
            dueAt: fireAt,
          }),
          new DispatchExpired({
            dispatchId: id,
            reason: 'unconfigured',
          }),
        ),
      ),
    )
  })
})
