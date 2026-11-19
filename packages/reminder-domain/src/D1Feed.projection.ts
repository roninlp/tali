import * as Domain from '@alchemy.run/domain'
import { Context, Effect, Schema } from 'effect'
import type * as RuntimeContext from 'alchemy/RuntimeContext'
import { ReminderDispatchId, ReminderId, TimestampUtc } from '@tali/domain'
import { DispatchAnswered } from './Answer.command.js'
import {
  DispatchOpened,
  FireClaimed,
  FireSuppressed,
} from './ClaimFire.command.js'
import { DispatchDueForPush, DispatchExpired } from './DeliverDue.command.js'
import { DispatchResponseValue, DispatchSnapshot } from './Dispatch.js'
import {
  DispatchPushed,
  DispatchPushFailed,
} from './RecordPushOutcome.command.js'
import { ReminderOwner } from './ReminderOwner.aggregate.js'

/**
 * The two D1 projections that keep the synced tables in step with the model
 * (the pilot's projection-style feed: the client and the Missed Inbox read
 * the same tables as before — nothing below changes shape).
 *
 * - `DispatchLedger` mirrors every ledger row into `reminder_dispatches`, so
 *   the inbox route, the history view and the sweep's owed-facts read keep
 *   answering from D1.
 * - `ReminderSchedule` advances `reminders.fire_at` from each claim, gated
 *   on the claimed instant, so the due read and the synced schedule agree.
 */

/** One ledger write the D1 adapter turns into an idempotent statement. */
export const DispatchLedgerChange = Schema.Union([
  Schema.TaggedStruct('Opened', {
    /** The full row, exactly the columns `reminder_dispatches` stores. */
    dispatch: DispatchSnapshot,
    /** The owner: the aggregate instance the event came from. */
    userId: Schema.String,
  }),
  Schema.TaggedStruct('Answered', {
    dispatchId: ReminderDispatchId,
    response: DispatchResponseValue,
    respondedAt: TimestampUtc,
    snoozedUntil: Schema.NullOr(TimestampUtc),
  }),
  Schema.TaggedStruct('DueForPush', {
    dispatchId: ReminderDispatchId,
    attempts: Schema.Int,
    lastAttemptAt: TimestampUtc,
  }),
  Schema.TaggedStruct('Pushed', {
    dispatchId: ReminderDispatchId,
    pushOutcome: Schema.Literals(['accepted', 'failed', 'expired']),
    lastAttemptAt: TimestampUtc,
  }),
  Schema.TaggedStruct('Expired', {
    dispatchId: ReminderDispatchId,
  }),
])
export type DispatchLedgerChange = Schema.Schema.Type<
  typeof DispatchLedgerChange
>

/**
 * The dispatch-ledger store port. D1 implements it with idempotent upserts
 * keyed by dispatch id; a story implements it with memory.
 */
export interface DispatchLedgerStoreApi {
  /** Apply one ordered batch of ledger changes; at least once per input. */
  readonly apply: (
    changes: ReadonlyArray<DispatchLedgerChange>,
  ) => Effect.Effect<void, never, RuntimeContext.RuntimeContext>
}

export class DispatchLedgerStore extends Context.Service<
  DispatchLedgerStore,
  DispatchLedgerStoreApi
>()('ReminderDomain/DispatchLedgerStore') {}

export class DispatchLedger extends Domain.Projection(
  'DispatchLedger',
  {
    from: [ReminderOwner],
    key: ReminderOwner,
    on: [
      // DispatchOpened is declared by two commands (claim and snooze); the
      // projection reads the event itself, so one entry covers both origins.
      DispatchOpened,
      // The attempt-taking, so `attempts` lands in D1 as ADR-0005 §3's
      // outcome shape expects.
      DispatchDueForPush,
      DispatchAnswered,
      DispatchPushed,
      DispatchPushFailed,
      DispatchExpired,
    ],
  },
  {
    description:
      'The dispatch ledger, mirrored into D1: the inbox and history views read these rows.',
  },
) {}

export const DispatchLedgerLive = DispatchLedger.toLayer(
  Effect.gen(function* () {
    const store = yield* DispatchLedgerStore
    return Effect.fn(function* (batch) {
      yield* store.apply(
        batch.map(({ event, key }): DispatchLedgerChange => {
          switch (event._tag) {
            case 'DispatchOpened':
              return {
                _tag: 'Opened',
                userId: key.id,
                dispatch: {
                  id: event.id,
                  reminderId: event.reminderId,
                  scheduledFor: event.scheduledFor,
                  deliverAt: event.deliverAt,
                  rootScheduledFor: event.rootScheduledFor,
                  origin: event.origin,
                  pushOutcome: event.pushOutcome,
                  attempts: event.attempts,
                  lastAttemptAt: event.lastAttemptAt,
                  parentDispatchId: event.parentDispatchId,
                  response: event.response,
                  respondedAt: event.respondedAt,
                  snoozedUntil: event.snoozedUntil,
                  createdAt: event.createdAt,
                },
              }
            case 'DispatchAnswered':
              return {
                _tag: 'Answered',
                dispatchId: event.dispatchId,
                response: event.response,
                respondedAt: event.respondedAt,
                snoozedUntil: event.snoozedUntil,
              }
            case 'DispatchDueForPush':
              return {
                _tag: 'DueForPush',
                dispatchId: event.dispatchId,
                attempts: event.attempts,
                lastAttemptAt: event.dueAt,
              }
            case 'DispatchPushed':
              return {
                _tag: 'Pushed',
                dispatchId: event.dispatchId,
                pushOutcome: 'accepted',
                lastAttemptAt: event.at,
              }
            case 'DispatchPushFailed':
              return {
                _tag: 'Pushed',
                dispatchId: event.dispatchId,
                pushOutcome: 'failed',
                lastAttemptAt: event.at,
              }
            case 'DispatchExpired':
              return { _tag: 'Expired', dispatchId: event.dispatchId }
          }
        }),
      )
    })
  }),
  { batch: { size: 50, wait: '500 millis' } },
)

// ── The schedule advance ───────────────────────────────────────────────────

/** One schedule advance: a compare-and-set on the synced row. */
export interface ScheduleAdvance {
  readonly reminderId: ReminderId
  /** The claimed (or suppressed) instant the row must still hold. */
  readonly from: string
  /** The series' next fire, or `null` when there is none to move to. */
  readonly to: string | null
}

/** The reminders schedule store port, implemented with the same CAS as ever. */
export interface ReminderScheduleStoreApi {
  /** Advance `reminders.fire_at`, gated on the claimed instant. */
  readonly apply: (
    advances: ReadonlyArray<ScheduleAdvance>,
  ) => Effect.Effect<void, never, RuntimeContext.RuntimeContext>
}

export class ReminderScheduleStore extends Context.Service<
  ReminderScheduleStore,
  ReminderScheduleStoreApi
>()('ReminderDomain/ReminderScheduleStore') {}

export class ReminderSchedule extends Domain.Projection(
  'ReminderSchedule',
  {
    from: [ReminderOwner],
    key: ReminderOwner,
    on: [FireClaimed, FireSuppressed],
  },
  {
    description:
      'The series advance, mirrored into D1: each claim moves the synced reminder past the fire it claimed.',
  },
) {}

export const ReminderScheduleLive = ReminderSchedule.toLayer(
  Effect.gen(function* () {
    const store = yield* ReminderScheduleStore
    return Effect.fn(function* (batch) {
      yield* store.apply(
        batch
          .map(({ event }): ScheduleAdvance | null => {
            if (
              (event._tag === 'FireClaimed' ||
                event._tag === 'FireSuppressed') &&
              event.nextFireAt !== null
            ) {
              return {
                reminderId: event.reminderId,
                from: event.scheduledFor,
                to: event.nextFireAt,
              }
            }
            return null
          })
          .filter((advance): advance is ScheduleAdvance => advance !== null),
      )
    })
  }),
  { batch: { size: 50, wait: '500 millis' } },
)
