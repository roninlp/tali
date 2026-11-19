import { Effect, Layer } from 'effect'
import type { UserId } from '@tali/domain'
import type { SubscriptionRow } from '../src/Dispatch.js'
import {
  DispatchLedgerStore,
  type DispatchLedgerChange,
  type ScheduleAdvance,
  ReminderScheduleStore,
} from '../src/D1Feed.projection.js'
import { PushSubscriptionStore } from '../src/PushService.external.js'

/**
 * In-memory store implementations for stories: the same ports the worker's
 * D1 adapters implement, over module-level mutable state the test seeds
 * before each story.
 *
 * The arrays double as the assertions for the projection feed: what the
 * ledger and schedule stores received is exactly what D1 would write.
 */

const subscriptions = new Map<string, ReadonlyArray<SubscriptionRow>>()

/** Seed the owner's devices before a story that pushes. */
export const seedSubscriptions = (
  userId: UserId,
  ...rows: ReadonlyArray<SubscriptionRow>
): void => {
  subscriptions.set(userId, rows)
}

/** Reset every store between stories. */
export const resetStores = (): void => {
  subscriptions.clear()
  ledger.length = 0
  advances.length = 0
}

export const MemoryPushSubscriptions = Layer.succeed(PushSubscriptionStore, {
  listByUser: (userId: UserId) =>
    Effect.sync(() => subscriptions.get(userId) ?? []),
  deleteMany: (ids: ReadonlyArray<string>) =>
    Effect.sync(() => {
      for (const [userId, rows] of subscriptions) {
        subscriptions.set(
          userId,
          rows.filter(row => !ids.includes(row.id)),
        )
      }
    }),
})

const ledger: Array<DispatchLedgerChange> = []

/** What the dispatch-ledger projection has written so far, in order. */
export const ledgerChanges = (): ReadonlyArray<DispatchLedgerChange> => [
  ...ledger,
]

export const MemoryDispatchLedger = Layer.succeed(DispatchLedgerStore, {
  apply: (changes: ReadonlyArray<DispatchLedgerChange>) =>
    Effect.sync(() => {
      ledger.push(...changes)
    }),
})

const advances: Array<ScheduleAdvance> = []

/** What the schedule projection has written so far, in order. */
export const scheduleAdvances = (): ReadonlyArray<ScheduleAdvance> => [
  ...advances,
]

export const MemoryReminderSchedule = Layer.succeed(ReminderScheduleStore, {
  apply: (rows: ReadonlyArray<ScheduleAdvance>) =>
    Effect.sync(() => {
      advances.push(...rows)
    }),
})

/** Every handler the stories host, over the memory stores. */
export const MemoryStores = Layer.mergeAll(
  MemoryPushSubscriptions,
  MemoryDispatchLedger,
  MemoryReminderSchedule,
)
