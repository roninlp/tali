import { Effect } from 'effect'
import type { UserId } from '@tali/domain'
import {
  ClaimFire,
  DeliverDue,
  type DueFireWire,
  type OwnedFactsWire,
  type SweepRequest,
  type SweepResponse,
  factsOf,
  ReminderOwner,
} from '@tali/reminder-domain'

/**
 * The tick driver: the sweep's in-model half, run where the model lives.
 *
 * The api's cron does what only it can (materialise occasion reminders,
 * read the synced rows) and posts one `SweepRequest`; this turns it into the
 * model's own vocabulary — one `ClaimFire` per due fire with a deterministic
 * command id (so a retried cron invocation replays its stored receipts), then
 * one `DeliverDue` per owner over the api's fresh facts plus the rows the
 * claims just opened (whose D1 projection rows are not visible yet).
 *
 * The tally is for the api's log line; the push outcomes land on the ledger
 * and in the Workers observability spans, where the policy records them.
 */
export const runTick = (
  owners: typeof ReminderOwner.Service,
  request: SweepRequest,
) =>
  Effect.gen(function* () {
    // Mutable for the walk; handed back as the readonly wire shape.
    const tally: { -readonly [K in keyof SweepResponse]: SweepResponse[K] } = {
      claimed: 0,
      suppressed: 0,
      due: 0,
      expired: 0,
    }

    // Group the tick's work by owner: every command goes to one instance.
    const firesByOwner = new Map<UserId, DueFireWire[]>()
    for (const fire of request.fires) {
      const list = firesByOwner.get(fire.ownerId) ?? []
      list.push(fire)
      firesByOwner.set(fire.ownerId, list)
    }
    const factsByOwner = new Map<UserId, OwnedFactsWire[]>()
    for (const fact of request.facts) {
      const list = factsByOwner.get(fact.ownerId) ?? []
      list.push(fact)
      factsByOwner.set(fact.ownerId, list)
    }

    for (const [ownerId, fires] of firesByOwner) {
      // A claim's row is deliverable in the same tick its projection row is
      // still invisible, so the fresh openings ride along as facts.
      const fresh: OwnedFactsWire[] = []
      for (const fire of fires) {
        const receipt = yield* owners.send(
          ownerId,
          new ClaimFire({
            now: fire.now,
            reminderId: fire.reminderId,
            scheduledFor: fire.scheduledFor,
            reminderTimeZone: fire.reminderTimeZone,
            ownerTimeZone: fire.ownerTimeZone,
            tier: fire.tier,
            repeat: fire.repeat,
            silencedUntil: fire.silencedUntil,
          }),
          {
            commandId: `claim:${fire.reminderId}:${fire.scheduledFor}:v${fire.version}`,
          },
        )
        for (const event of receipt.events) {
          if (event._tag === 'FireSuppressed') {
            tally.suppressed += 1
            continue
          }
          if (event._tag !== 'DispatchOpened') continue
          tally.claimed += 1
          if (Date.parse(event.deliverAt) <= Date.parse(request.now)) {
            fresh.push({
              ownerId: fire.ownerId,
              dispatchId: event.id,
              title: fire.title,
              note: fire.note,
              kind: fire.kind,
              tier: fire.tier,
              // The claim just decided: no silence, no deletion this tick.
              silencedUntil: null,
              deletedAt: null,
            })
          }
        }
      }
      if (fresh.length === 0 && !factsByOwner.has(ownerId)) continue
      factsByOwner.set(ownerId, [
        ...(factsByOwner.get(ownerId) ?? []),
        ...fresh,
      ])
    }

    for (const [ownerId, facts] of factsByOwner) {
      if (facts.length === 0) continue
      const receipt = yield* owners.send(
        ownerId,
        new DeliverDue({
          now: request.now,
          facts: facts.map(factsOf),
        }),
        // A retried invocation of the same nominal minute replays its
        // receipts; the per-dispatch attempt state is the real budget.
        { commandId: `deliver:${ownerId}:${request.now}` },
      )
      for (const event of receipt.events) {
        if (event._tag === 'DispatchDueForPush') tally.due += 1
        if (event._tag === 'DispatchExpired') tally.expired += 1
      }
    }

    return tally
  })

export type { UserId }
