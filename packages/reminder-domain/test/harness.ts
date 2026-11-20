import { Effect, Layer } from 'effect'
import { Story } from '@alchemy.run/domain/Story'
import { reminderDeliverAt } from '@tali/domain/reminder-policy'
import type { ReminderId, UserId } from '@tali/domain'
import { dispatchIdFor } from '../src/dispatch-id.js'
import {
  ClaimFire,
  DispatchOpened,
  FireClaimed,
} from '../src/ClaimFire.command.js'
import { Reminders, RemindersHandlers } from '../src/Reminders.model.js'
import { ReminderOwner } from '../src/ReminderOwner.aggregate.js'
import { PushService } from '../src/PushService.external.js'
import { MemoryStores } from './memory-stores.js'

/**
 * The stories' shared cast and clock, in the shape the api's delivery suite
 * used: Tehran (UTC+03:30) with pinned instants, so every quiet-hours
 * expectation is exact rather than "roughly when".
 */

export const USER_A = 'user-a' as UserId

/** Tehran is UTC+03:30 (Iran dropped DST in 2022). */
export const T = (localHour: string, day = '2026-10-21'): string =>
  new Date(`${day}T${localHour}+03:30`).toISOString()

export const after = (instant: string, ms: number): string =>
  new Date(Date.parse(instant) + ms).toISOString()

/** The id the ledger mints for one (reminder, fire instant, origin). */
export const dispatchId = (
  reminderId: string,
  scheduledFor: string,
  origin = 'schedule',
  createdAt = scheduledFor,
) => dispatchIdFor(reminderId, scheduledFor, origin, createdAt)

/** The story runner: the model in memory, push stubbed, stores in memory. */
export const story = Story.make(Reminders, {
  layer: RemindersHandlers.pipe(Layer.provide(MemoryStores)),
  stub: [PushService],
})

/** Run one story as a promise; the failure throws with the step report. */
export const run = <E>(effect: Effect.Effect<void, E>): Promise<void> =>
  Effect.runPromise(effect)

export const owner = ReminderOwner.ref(USER_A)

export const REMINDER_ID = '0197f100-7000-7000-8000-700000000101' as ReminderId
export const REMINDER_ID_2 =
  '0197f100-7000-7000-8000-700000000102' as ReminderId

/** The default claim: a general reminder in the owner's zone. */
export const claimFire = (over: Partial<InstanceType<typeof ClaimFire>> = {}) =>
  new ClaimFire({
    now: T('09:00'),
    reminderId: REMINDER_ID,
    scheduledFor: T('09:00'),
    reminderTimeZone: 'Asia/Tehran',
    ownerTimeZone: 'Asia/Tehran',
    tier: 'normal',
    repeat: { _tag: 'once' },
    silencedUntil: null,
    ...over,
  })

export const thenClaim = (
  claim: InstanceType<typeof ClaimFire>,
  nextFireAt: string | null = null,
) => {
  const plan = reminderDeliverAt(claim, claim.ownerTimeZone, claim.scheduledFor)
  return Story.then(
    owner,
    new FireClaimed({
      reminderId: claim.reminderId,
      scheduledFor: claim.scheduledFor,
      nextFireAt,
    }),
    new DispatchOpened({
      id: dispatchIdFor(
        claim.reminderId,
        claim.scheduledFor,
        'schedule',
        claim.now,
      ),
      reminderId: claim.reminderId,
      scheduledFor: claim.scheduledFor,
      deliverAt: plan._tag === 'claim' ? plan.deliverAt : claim.scheduledFor,
      rootScheduledFor: claim.scheduledFor,
      origin: 'schedule',
      pushOutcome: 'pending',
      attempts: 0,
      lastAttemptAt: null,
      parentDispatchId: null,
      response: null,
      respondedAt: null,
      snoozedUntil: null,
      createdAt: claim.now,
    }),
  )
}

/** A claim's `when` and its asserting `then`, spread into a story's steps. */
export const claimSteps = (
  claim: InstanceType<typeof ClaimFire>,
  nextFireAt: string | null = null,
) => [Story.when(owner, claim), thenClaim(claim, nextFireAt)] as const
