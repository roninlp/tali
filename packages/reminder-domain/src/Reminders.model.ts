import * as Domain from '@alchemy.run/domain'
import { Layer } from 'effect'
import {
  DispatchLedger,
  DispatchLedgerLive,
  ReminderSchedule,
  ReminderScheduleLive,
} from './D1Feed.projection.js'
import { PushDispatches, PushDispatchesLive } from './PushDispatches.policy.js'
import { ReminderOwner } from './ReminderOwner.aggregate.js'

/**
 * `Reminders` — the firing bounded context (ADR-0005's machinery, Stage 1).
 *
 * What is here: the claim, the dispatch ledger, the quiet-hours/tier policy
 * at claim time, the snooze child rule, silence and delete expiry, the push
 * fan-out, and the projections that keep D1's synced tables in step.
 *
 * What is deliberately not here: the reminder *rows*. They ride the sync
 * feed in D1 (the Reminders screen depends on them), and the sweep re-reads
 * them every tick; the model only ever sees the facts its commands carry.
 */
export class Reminders extends Domain.Model(
  'Reminders',
  {
    aggregates: [ReminderOwner],
    policies: [PushDispatches],
    projections: [DispatchLedger, ReminderSchedule],
  },
  {
    description:
      "Tali's reminder firing: claims due fires onto a per-owner dispatch ledger, holds them through quiet hours, pushes them, and records every answer.",
  },
) {}

/** Every handler the hosted model requires. */
export const RemindersHandlers = Layer.mergeAll(
  PushDispatchesLive,
  DispatchLedgerLive,
  ReminderScheduleLive,
)

/** The in-memory hosting stories use; the worker swaps in Durable Objects. */
export const RemindersInMemory = Reminders.layer(RemindersHandlers).pipe(
  Layer.provide(Domain.InMemory),
)
