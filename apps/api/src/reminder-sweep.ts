import { Context, Effect, Layer } from "effect"
import { SqlError } from "effect/sql"
import {
  DELIVERY_HORIZON_MINUTES,
  DEFAULT_NOTIFICATION_SNOOZE_MINUTES,
  REMINDER_KIND_LABELS,
  type LocalDate,
  type PushOutcome,
  type ReminderDispatch,
  type ReminderDispatchId,
  type ReminderId,
  type UserId
} from "@tali/domain"
import type { PushSubscription } from "@tali/domain"
import { PushSubscriptionRepo, ReminderDispatchRepo, SyncRepo } from "@tali/sql"
import { pushTopic, pushTtlSeconds } from "./push-crypto.js"
import { PushGateway } from "./push-gateway.js"
import { OccasionService } from "./occasion-service.js"
import { ReminderService, type ReminderServiceApi } from "./reminder-service.js"

/**
 * The per-minute reminder sweep (ticket #61; ADR-0005).
 *
 * The sweep is a **catch-up query, not a scheduler**: each tick
 *
 * 0. materialises due occasion advance reminders (#59/#74's production trigger),
 * 1. claims every live reminder whose `fire_at <= scheduledTime` in one batch
 *    (policy at claim, inside `ReminderService.claimMany` — quiet hours and the
 *    medication tier are never re-evaluated here), then
 * 2. pushes every owed dispatch whose `deliver_at` has arrived, and
 * 3. publishes the outcomes in one batch.
 *
 * The ledger row is the mutex: the claim INSERT + `fire_at` CAS is one atomic
 * batch, so overlapping, repeated or late ticks converge on one row. The
 * outcome cannot share that batch (D1 `batch()` cannot branch on an earlier
 * statement) — a crash between push and outcome leaves `pending`, and the next
 * tick retries it. That is at-most-one *claim*, not at-most-once delivery:
 * `Topic` + the service worker `tag` coalesce the rare duplicate.
 *
 * Budget (ADR-0005 §9): five fixed indexed reads (three scheduling + two for
 * occasion materialisation), one claim batch, one take-attempts statement, one
 * outcome batch, and at most `SWEEP_MAX_FETCHES` pushes. Overflow rolls to the
 * next tick untouched — "owed" is a state, not a message.
 */

/** Claim at most this many fires per tick. */
export const SWEEP_MAX_DISPATCHES = 10
/** Push at most this many times per tick (a dispatch fans out per device). */
export const SWEEP_MAX_FETCHES = 10
/** Transient failures are retried this many times before the dispatch expires. */
export const SWEEP_MAX_ATTEMPTS = 3
/** A dispatch first deliverable later than this never pushes (inbox-only). */
export const SWEEP_HORIZON_MS = DELIVERY_HORIZON_MINUTES * 60_000
/**
 * New occasion reminders one tick may create. Two reads discover every
 * household's due drafts; each create is ~7 statements, so this cap keeps the
 * whole tick inside D1's Free-plan 50-queries-per-invocation ceiling. The rest
 * are still due on the next tick.
 */
export const SWEEP_MAX_OCCASION_CREATES = 1
/**
 * Days of slack before/after the tick's UTC date for the materialise window.
 *
 * The back window is a week so a multi-day outage (or the first deploy of this
 * ticket) still materialises the missed advance reminders: they are created with
 * a past `fire_at`, claimed on the next tick and expired into the inbox instead
 * of never existing (ADR-0005 §4/§7 — never silently dropped). The forward day
 * covers zones ahead of UTC. The window costs the same two reads either way.
 */
const OCCASION_WINDOW_BACK_DAYS = 7
const OCCASION_WINDOW_FORWARD_DAYS = 1

const DAY_MS = 24 * 60 * 60 * 1000

const shiftDay = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10)

/**
 * The local-date window whose advance reminders this tick must materialise.
 *
 * `#59`/`#74` leaves the production trigger to this ticket: the sweep is the
 * only thing that runs when no browser is open, so it must create the advance
 * reminder rows before claiming them. The window is anchored on the tick's
 * nominal instant and padded both ways: forward for time zones ahead of UTC (a
 * reminder due "today" can already be yesterday in UTC), and backwards so a
 * multi-day outage still materialises the missed reminder and lands it in the
 * inbox instead of never creating it (ADR-0005 §4/§7 — never silently dropped).
 */
export const occasionWindow = (now: string): { readonly from: LocalDate; readonly to: LocalDate } => {
  const today = new Date(now).toISOString().slice(0, 10)
  return {
    from: shiftDay(today, -OCCASION_WINDOW_BACK_DAYS) as LocalDate,
    to: shiftDay(today, OCCASION_WINDOW_FORWARD_DAYS) as LocalDate
  }
}

export interface SweepResult {
  /** Fires this tick claimed (the unique ledger key is the mutex). */
  readonly claimed: number
  /** Dispatches this tick attempted to push. */
  readonly pushed: number
  readonly accepted: number
  readonly failed: number
  readonly expired: number
  /** Dead endpoints removed after `404`/`410`. */
  readonly subscriptionsDeleted: number
}

export interface ReminderSweepApi {
  /**
   * One tick at `now`.
   *
   * `now` is the tick's **nominal** clock (`controller.scheduledTime` in
   * production, an explicit instant in tests and the dev trigger), never
   * `Date.now()`: two invocations for the same minute compute the same
   * window, so a duplicate is a no-op rather than a second dispatch.
   */
  readonly sweep: (now: string) => Effect.Effect<SweepResult>
  /**
   * Enforce the `change_feed` retention window from a maintenance tick. The
   * sweep already owns a `SyncRepo`, so the fallback does not need a second D1
   * layer; the caller decides whether a failure fails the tick.
   */
  readonly pruneFeed: (cutoff: string) => Effect.Effect<void, SqlError.SqlError>
}

interface OutcomeWrite {
  readonly dispatchId: ReminderDispatchId
  readonly pushOutcome: PushOutcome
  readonly attempts: number
  readonly lastAttemptAt: string | null
}

const emptyResult = (): {
  claimed: number
  pushed: number
  accepted: number
  failed: number
  expired: number
  subscriptionsDeleted: number
} => ({
  claimed: 0,
  pushed: 0,
  accepted: 0,
  failed: 0,
  expired: 0,
  subscriptionsDeleted: 0
})

const normalizeInstant = (value: string): string => new Date(value).toISOString()

const isPastHorizon = (now: string, deliverAt: string): boolean =>
  Date.parse(now) - Date.parse(deliverAt) > SWEEP_HORIZON_MS

/**
 * The notification body is a pointer plus the reminder's own words; the full
 * state is re-synced on app open, and the inbox is the recovery path (#4 §7).
 *
 * `id` is the **dispatch id**: one fire is one row and one answer, so the
 * service worker can post the action back without guessing which occurrence
 * it was showing.
 */
export const reminderPushPayload = (input: {
  readonly dispatch: ReminderDispatch
  readonly title: string
  readonly note: string | null
  readonly kind: keyof typeof REMINDER_KIND_LABELS
  readonly tier: "normal" | "critical"
}): string =>
  JSON.stringify({
    type: "reminder",
    id: input.dispatch.id,
    reminderId: input.dispatch.reminderId,
    title: input.title,
    body: input.note ?? REMINDER_KIND_LABELS[input.kind],
    tier: input.tier,
    url: "/reminders",
    actions: [
      { action: "done", title: "انجام شد" },
      {
        action: "snooze",
        title: "بعداً",
        minutes: DEFAULT_NOTIFICATION_SNOOZE_MINUTES
      }
    ]
  })

export class ReminderSweep extends Context.Service<ReminderSweep>()("ReminderSweep", {
  make: Effect.gen(function*() {
    const reminders: ReminderServiceApi = yield* ReminderService
    const dispatches = yield* ReminderDispatchRepo
    const subscriptions = yield* PushSubscriptionRepo
    const gateway = yield* PushGateway
    const sync = yield* SyncRepo
    const occasions = yield* OccasionService

    const sweep = (nowInput: string): Effect.Effect<SweepResult> =>
      Effect.gen(function*() {
        const now = normalizeInstant(nowInput)
        const result = emptyResult()

        // 0. Turn due occasion advance reminders into real reminder rows before
        //    claiming. #59 materialises only when the UI asks; the sweep is the
        //    production trigger #74 left to this ticket, and it is the only
        //    writer when no browser is open. No viewer: the service scopes by
        //    household and inherits each occasion's own/shared visibility.
        //    Idempotent by (link, fire instant), so a repeated tick creates
        //    nothing; a failure here must not cost the tick its claims.
        yield* occasions
          .materialiseDue({ range: occasionWindow(now), limit: SWEEP_MAX_OCCASION_CREATES })
          .pipe(Effect.ignore)

        // 1. Claim every due fire in one batch. Policy (quiet hours, medication
        //    tier, silence) runs inside the claim — the worker never overrides
        //    it. The due read carries the policy's fields, so the tick costs two
        //    statements per fire instead of a read/batch/read (ADR-0005 §9).
        const due = yield* dispatches.listDueFires({
          now,
          limit: SWEEP_MAX_DISPATCHES
        }).pipe(Effect.orDie)
        if (due.length > 0) {
          result.claimed = yield* reminders
            .claimMany({
              fires: due.map((fire) => ({
                reminderId: fire.reminderId as ReminderId,
                scheduledFor: fire.fireAt,
                ownerId: fire.ownerId as UserId,
                ownerTimeZone: fire.ownerTimeZone,
                tier: fire.tier,
                repeat: fire.repeat,
                timeZone: fire.timeZone,
                silencedUntil: fire.silencedUntil
              })),
              now
            })
            .pipe(Effect.orDie)
        }

        // 2. Every owed dispatch whose deliver-at has arrived (including the
        //    ones just claimed, and snooze children written by `respond`).
        const owed = yield* dispatches.listOwed({
          now,
          limit: SWEEP_MAX_DISPATCHES
        }).pipe(Effect.orDie)

        const owners: ReadonlyArray<UserId> = [
          ...new Set(owed.map((row) => row.dispatch.userId as UserId))
        ]
        const devices = owners.length === 0
          ? []
          : yield* subscriptions.listByUsers(owners).pipe(Effect.orDie)
        const byOwner = new Map<string, Array<PushSubscription>>()
        for (const device of devices) {
          const list = byOwner.get(device.userId) ?? []
          list.push(device)
          byOwner.set(device.userId, list)
        }

        const outcomes: Array<OutcomeWrite> = []
        const deadSubscriptions: Array<string> = []
        const planned: Array<{
          readonly row: (typeof owed)[number]
          readonly targets: ReadonlyArray<PushSubscription>
          readonly tier: "normal" | "critical"
        }> = []
        let fetchBudget = SWEEP_MAX_FETCHES

        // 2a. Decide what this tick can deliver inside the fetch cap. Rows that
        //     are past the horizon, out of attempts, or have no device are
        //     expired into the inbox here; everything else is planned.
        for (const row of owed) {
          const dispatch = row.dispatch

          // Lateness is measured from `deliver_at`, not `scheduled_for`: a
          // quiet-hours hold is on time when its 07:00 tick carries it. A row
          // left over at the attempt budget (e.g. after a crash between push and
          // outcome) is closed here rather than retried.
          if (
            isPastHorizon(now, dispatch.deliverAt) ||
            dispatch.attempts >= SWEEP_MAX_ATTEMPTS
          ) {
            result.expired += 1
            outcomes.push({
              dispatchId: dispatch.id,
              pushOutcome: "expired",
              attempts: dispatch.attempts,
              lastAttemptAt: dispatch.lastAttemptAt
            })
            continue
          }

          const targets = byOwner.get(dispatch.userId) ?? []
          if (targets.length === 0) {
            // Nobody to push to (no subscription, or all just failed): the
            // ledger row is the inbox path, never a silent drop.
            result.expired += 1
            outcomes.push({
              dispatchId: dispatch.id,
              pushOutcome: "expired",
              attempts: dispatch.attempts,
              lastAttemptAt: dispatch.lastAttemptAt
            })
            continue
          }
          // Ten fetches is the mechanical cap. A dispatch that cannot reach
          // *all* its devices rolls to the next tick untouched rather than
          // expiring on a partial fan-out.
          if (fetchBudget < targets.length) break
          fetchBudget -= targets.length
          planned.push({
            row,
            targets,
            tier: row.tier === "critical" ? "critical" : "normal"
          })
        }

        // 2b. Last look at the row's own state before the network (ADR-0005 §3):
        //     the owed read is a snapshot, and the owner may have answered since.
        //     One conditional UPDATE for every planned dispatch — it increments
        //     the attempt only while the row is unanswered and retryable and
        //     returns the ids that may send, so the answered-mid-tick race is
        //     closed to the single in-flight POST. The outcome write is gated
        //     the same way, so an answer that lands during the fetch can never be
        //     overwritten.
        const allowed = new Set(
          planned.length === 0
            ? []
            : yield* dispatches.takeAttempts({
              dispatchIds: planned.map((entry) => entry.row.dispatch.id),
              now
            }).pipe(Effect.orDie)
        )

        // 2c. Send. The budget was reserved in 2a, so the loop cannot overshoot.
        for (const { row, targets, tier } of planned) {
          const dispatch = row.dispatch
          if (!allowed.has(dispatch.id)) continue

          const payload = reminderPushPayload({
            dispatch,
            title: row.title,
            note: row.note,
            kind: row.kind,
            tier
          })
          const topic = yield* Effect.promise(() => pushTopic(dispatch.id))
          const ttlSeconds = pushTtlSeconds({
            now,
            horizonEnd: new Date(Date.parse(dispatch.deliverAt) + SWEEP_HORIZON_MS).toISOString()
          })
          const attempts = dispatch.attempts + 1

          let accepted = false
          let transient = false
          let unconfigured = false
          let attempted = false

          for (const device of targets) {
            attempted = true
            const sent = yield* gateway.send({
              subscription: device,
              payload,
              now,
              ttlSeconds,
              urgency: tier === "critical" ? "high" : "normal",
              topic
            })
            switch (sent._tag) {
              case "accepted":
                accepted = true
                break
              case "gone":
                deadSubscriptions.push(device.id)
                break
              case "transient":
                transient = true
                break
              case "permanent":
                break
              case "unconfigured":
                unconfigured = true
                break
            }
          }

          const pushOutcome: PushOutcome = accepted
            ? "accepted"
            : transient && !unconfigured && attempts < SWEEP_MAX_ATTEMPTS
              ? "failed"
              : "expired"

          result.pushed += attempted ? 1 : 0
          if (pushOutcome === "accepted") result.accepted += 1
          else if (pushOutcome === "failed") result.failed += 1
          else result.expired += 1

          outcomes.push({
            dispatchId: dispatch.id,
            pushOutcome,
            attempts,
            lastAttemptAt: now
          })
        }

        // 3. One outcome batch: publish every result and drop dead endpoints.
        //    Boundary: 10 claims × 2 + 1 due read + 1 owed read + 1
        //    subscriptions read + 1 take-attempts + 10 outcome updates + 1
        //    delete + occasion discovery/dedupe (2) + one create (~7) = ~43,
        //    inside D1's Free-plan ceiling of 50 per invocation (ADR-0005 §9).
        //    `reminder-delivery.test.ts` asserts the real count.
        const uniqueDead = [...new Set(deadSubscriptions)]
        result.subscriptionsDeleted = uniqueDead.length
        yield* sync.commit([
          ...outcomes.map((outcome) =>
            dispatches.outcomeStatement({
              dispatchId: outcome.dispatchId,
              pushOutcome: outcome.pushOutcome,
              attempts: outcome.attempts,
              lastAttemptAt: outcome.lastAttemptAt
            })
          ),
          ...(uniqueDead.length === 0 ? [] : [subscriptions.deleteManyStatement(uniqueDead)])
        ]).pipe(Effect.orDie)

        return result
      })

    const pruneFeed = (cutoff: string): Effect.Effect<void, SqlError.SqlError> =>
      sync.prune(cutoff)

    return { sweep, pruneFeed } as const
  })
}) {}

export const ReminderSweepLive = Layer.effect(ReminderSweep, ReminderSweep.make)
