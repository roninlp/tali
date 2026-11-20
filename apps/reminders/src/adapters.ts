import { Effect, Layer } from 'effect'
import { WorkerEnvironment } from '@alchemy.run/cloudflare'
import {
  DispatchLedgerStore,
  type DispatchLedgerChange,
  type ScheduleAdvance,
  ReminderScheduleStore,
} from '@tali/reminder-domain'
import {
  PushService,
  PushSubscriptionStore,
  type SubscriptionRow,
} from '@tali/reminder-domain'
import type { PushSubscriptionId, UserId } from '@tali/domain'
import { makePushGateway, vapidConfigOf } from '@tali/push'
import { remindersEnvOf, type RemindersEnv } from './env.js'

/**
 * The model's D1 adapters, built once per Worker from the runtime
 * environment: the dispatch ledger, the schedule compare-and-set, and the
 * push subscriptions. Every write is idempotent (ADR-0005 §3's projection
 * feeds run at least once), and failures die — the platform keeps each
 * projection key's input log and retries it.
 */

const d1 = (env: RemindersEnv): Effect.Effect<D1Database> =>
  Effect.sync(() => env.DB)

const run = (
  statement: D1PreparedStatement,
): Effect.Effect<D1Result, never, never> =>
  Effect.tryPromise({
    try: () => statement.run(),
    catch: cause => new Error(String(cause)),
  }).pipe(Effect.orDie)

const batch = (
  db: D1Database,
  statements: ReadonlyArray<D1PreparedStatement>,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      await db.batch([...statements])
    },
    catch: cause => new Error(String(cause)),
  }).pipe(Effect.orDie)

const bindAll = (
  db: D1Database,
  sqlText: string,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): Array<D1PreparedStatement> =>
  rows.map(values => db.prepare(sqlText).bind(...values))

/** The dispatch-ledger store: idempotent writes keyed by dispatch id. */
export const DispatchLedgerStoreLive = Layer.effect(
  DispatchLedgerStore,
  Effect.gen(function* () {
    const env = remindersEnvOf(yield* WorkerEnvironment)

    const apply = (changes: ReadonlyArray<DispatchLedgerChange>) =>
      Effect.gen(function* () {
        const db = yield* d1(env)
        const statements: Array<D1PreparedStatement> = []
        for (const change of changes) {
          switch (change._tag) {
            case 'Opened':
              statements.push(
                db
                  .prepare(
                    `INSERT INTO reminder_dispatches
                       (id, reminder_id, user_id, scheduled_for, deliver_at,
                        root_scheduled_for, origin, push_outcome, attempts,
                        last_attempt_at, parent_dispatch_id, response,
                        responded_at, snoozed_until, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT DO NOTHING`,
                  )
                  .bind(
                    change.dispatch.id,
                    change.dispatch.reminderId,
                    change.userId,
                    change.dispatch.scheduledFor,
                    change.dispatch.deliverAt,
                    change.dispatch.rootScheduledFor,
                    change.dispatch.origin,
                    change.dispatch.pushOutcome,
                    change.dispatch.attempts,
                    change.dispatch.lastAttemptAt,
                    change.dispatch.parentDispatchId,
                    change.dispatch.response,
                    change.dispatch.respondedAt,
                    change.dispatch.snoozedUntil,
                    change.dispatch.createdAt,
                  ),
              )
              break
            case 'Answered':
              statements.push(
                db
                  .prepare(
                    `UPDATE reminder_dispatches SET
                       response = ?, responded_at = ?, snoozed_until = ?
                     WHERE id = ?`,
                  )
                  .bind(
                    change.response,
                    change.respondedAt,
                    change.snoozedUntil,
                    change.dispatchId,
                  ),
              )
              break
            case 'DueForPush':
              statements.push(
                db
                  .prepare(
                    `UPDATE reminder_dispatches SET attempts = ?, last_attempt_at = ?
                      WHERE id = ? AND response IS NULL AND push_outcome IN ('pending', 'failed')`,
                  )
                  .bind(
                    change.attempts,
                    change.lastAttemptAt,
                    change.dispatchId,
                  ),
              )
              break
            case 'Pushed':
              // An answer that landed mid-push wins: never overwrite it.
              statements.push(
                db
                  .prepare(
                    `UPDATE reminder_dispatches SET
                       push_outcome = ?, last_attempt_at = ?
                     WHERE id = ? AND response IS NULL`,
                  )
                  .bind(
                    change.pushOutcome,
                    change.lastAttemptAt,
                    change.dispatchId,
                  ),
              )
              break
            case 'Expired':
              statements.push(
                db
                  .prepare(
                    `UPDATE reminder_dispatches SET push_outcome = 'expired'
                     WHERE id = ? AND response IS NULL`,
                  )
                  .bind(change.dispatchId),
              )
              break
          }
        }
        if (statements.length > 0) yield* batch(db, statements)
      })

    return { apply }
  }),
)

/** The schedule store: one compare-and-set per claim/suppress advance. */
export const ReminderScheduleStoreLive = Layer.effect(
  ReminderScheduleStore,
  Effect.gen(function* () {
    const env = remindersEnvOf(yield* WorkerEnvironment)

    const apply = (advances: ReadonlyArray<ScheduleAdvance>) =>
      Effect.gen(function* () {
        const db = yield* d1(env)
        const statements = bindAll(
          db,
          `UPDATE reminders SET fire_at = ?
             WHERE id = ? AND fire_at = ? AND deleted_at IS NULL`,
          advances.map(advance => [
            advance.to,
            advance.reminderId,
            advance.from,
          ]),
        )
        if (statements.length > 0) yield* batch(db, statements)
      })

    return { apply }
  }),
)

/** The subscriptions the push policy fans out to. */
export const PushSubscriptionStoreLive = Layer.effect(
  PushSubscriptionStore,
  Effect.gen(function* () {
    const env = remindersEnvOf(yield* WorkerEnvironment)

    const listByUser = (userId: UserId) =>
      Effect.gen(function* () {
        const db = yield* d1(env)
        const rows = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT id, user_id, endpoint, p256dh, auth
                   FROM push_subscriptions WHERE user_id = ?`,
              )
              .bind(userId)
              .all<SubscriptionRow>(),
          catch: cause => new Error(String(cause)),
        }).pipe(Effect.orDie)
        return rows.results ?? []
      })

    const deleteMany = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (ids.length === 0) return
        const db = yield* d1(env)
        yield* run(
          db
            .prepare(
              `DELETE FROM push_subscriptions WHERE id IN (${ids.map(() => '?').join(', ')})`,
            )
            .bind(...ids),
        )
      })

    return { listByUser, deleteMany }
  }),
)

/** What the model's PushService.send hands this adapter, not restated. */
type SendArgs = Parameters<(typeof PushService.Service)['send']>[0]

/**
 * The Web Push transport behind the model's external system: the unchanged
 * @tali/push gateway over this environment's VAPID identity. With no keys
 * (local dev without secrets) every send answers `unconfigured` and the
 * dispatch lands in the inbox instead of being dropped.
 */
export const PushServiceLive = Layer.effect(
  PushService,
  Effect.gen(function* () {
    const env = remindersEnvOf(yield* WorkerEnvironment)
    const gateway = makePushGateway(vapidConfigOf(env))
    return {
      send: (input: SendArgs) =>
        gateway.send({
          subscription: {
            ...input.subscription,
            // The row type brands the id the model's port carries unbranded,
            // and the row's remaining columns are not part of the model's
            // port.
            id: input.subscription.id as PushSubscriptionId,
            expirationTime: null,
            userAgent: null,
            createdAt: input.now,
            updatedAt: input.now,
          },
          payload: input.payload,
          now: input.now,
          ttlSeconds: input.ttlSeconds,
          urgency: input.urgency,
          topic: input.topic,
        }),
    }
  }),
)
