import * as Domain from '@alchemy.run/domain'
import type * as PolicyModule from '@alchemy.run/domain/Policy'
import { Effect } from 'effect'
import { pushTopic, pushTtlSeconds, reminderPushPayload } from '@tali/push'
import {
  DispatchDueForPush,
  SWEEP_HORIZON_MS,
  SWEEP_MAX_ATTEMPTS,
} from './DeliverDue.command.js'
import type { ExpireReason } from './Dispatch.js'
import { PushService, PushSubscriptionStore } from './PushService.external.js'
import { RecordPushOutcome } from './RecordPushOutcome.command.js'
import { ReminderOwner } from './ReminderOwner.aggregate.js'

/**
 * `PushDispatches` — the delivery reaction (ADR-0005's outcome half).
 *
 * Whenever the sweep marks a dispatch due for push, this policy fans it out
 * to every subscription its owner has, classifies the results exactly the way
 * the old sweep loop did, and reports one coalesced outcome back to the
 * ledger:
 *
 * - `accepted` if at least one push service took it;
 * - `failed` (retryable) only when every attempt was transient, the
 *   environment is configured, and the attempt budget is not spent;
 * - `expired` otherwise — permanent errors, a spent budget, no live
 *   subscription, or no VAPID keys. Inbox-only, never a silent drop.
 *
 * `404`/`410` delete the dead subscription row; a dispatch reaches every
 * device it has, and the coalesced verdict is the row's outcome.
 *
 * Safe to run twice: the outcome command's id is derived from the event that
 * caused it, and `NotOwed` — an answer that landed mid-push — is treated as
 * done, never recorded over it.
 */
export class PushDispatches extends Domain.Policy('PushDispatches', {
  from: ReminderOwner,
  on: [DispatchDueForPush],
}) {}

export const PushDispatchesLive = PushDispatches.toLayer(
  Effect.gen(function* () {
    const owners = yield* ReminderOwner
    const subscriptions = yield* PushSubscriptionStore
    const push = yield* PushService

    return Effect.fn(function* (
      trigger: PolicyModule.TriggerOf<typeof PushDispatches>,
    ) {
      const { event, source } = trigger
      const targets = yield* subscriptions.listByUser(source.id)

      // Nobody to push to (no subscription, or all just failed): the ledger
      // row is the inbox path, never a silent drop.
      if (targets.length === 0) {
        yield* owners
          .send(
            source,
            new RecordPushOutcome({
              dispatchId: event.dispatchId,
              outcome: 'expired',
              reason: 'no-subscription',
              at: event.dueAt,
            }),
            { commandId: `push-outcome:${event.dispatchId}:${event.dueAt}` },
          )
          .pipe(Effect.catchTag('NotOwed', () => Effect.void))
        return
      }

      const payload = reminderPushPayload({
        dispatch: { id: event.dispatchId, reminderId: event.reminderId },
        title: event.title,
        note: event.note,
        kind: event.kind,
        tier: event.tier,
      })
      const topic = yield* Effect.promise(() => pushTopic(event.dispatchId))
      const ttlSeconds = pushTtlSeconds({
        now: event.dueAt,
        horizonEnd: new Date(
          Date.parse(event.deliverAt) + SWEEP_HORIZON_MS,
        ).toISOString(),
      })

      let accepted = false
      let transient = false
      let unconfigured = false
      const dead: Array<string> = []
      for (const device of targets) {
        const sent = yield* push.send({
          subscription: {
            id: device.id,
            userId: device.userId,
            endpoint: device.endpoint,
            p256dh: device.p256dh,
            auth: device.auth,
          },
          payload,
          now: event.dueAt,
          ttlSeconds,
          urgency: event.tier === 'critical' ? 'high' : 'normal',
          topic,
        })
        switch (sent._tag) {
          case 'accepted':
            accepted = true
            break
          case 'gone':
            dead.push(device.id)
            break
          case 'transient':
            transient = true
            break
          case 'permanent':
            break
          case 'unconfigured':
            unconfigured = true
            break
        }
      }

      if (dead.length > 0) {
        yield* subscriptions.deleteMany(dead)
      }

      // The same classification the old sweep loop used: a transient
      // failure is retryable only while keys exist and the budget is not
      // spent.
      const outcome: 'accepted' | 'failed' | 'expired' = accepted
        ? 'accepted'
        : transient && !unconfigured && event.attempts < SWEEP_MAX_ATTEMPTS
          ? 'failed'
          : 'expired'
      const reason: ExpireReason =
        outcome !== 'expired'
          ? 'no-subscription' // unused below; the outcome decides
          : unconfigured
            ? 'unconfigured'
            : transient
              ? 'transient-exhausted'
              : 'permanent'

      // The observability the ops log used to carry: what this push produced
      // (recorded on the engine's span for the policy, per Domain's tracing).
      yield* Effect.annotateCurrentSpan({
        'reminders.push.outcome': outcome,
        'reminders.push.devices': targets.length,
      })

      yield* owners
        .send(
          source,
          new RecordPushOutcome({
            dispatchId: event.dispatchId,
            outcome,
            // A reason only matters when the row closes without pushing.
            ...(outcome === 'expired' ? { reason } : {}),
            at: event.dueAt,
          }),
          { commandId: `push-outcome:${event.dispatchId}:${event.dueAt}` },
        )
        .pipe(
          Effect.catchTag('NotOwed', () => Effect.void),
          // The policy's Effect completes with nothing; the receipt is not
          // the handler's value.
          Effect.asVoid,
        )
    })
  }),
)
