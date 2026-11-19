import * as Domain from '@alchemy.run/domain'
import { Schema } from 'effect'
import type * as DateTime from 'effect/DateTime'
import {
  advancePastSilence,
  isOnTime,
  reminderDeliverAt,
  reminderNextFireAfterNow,
  snoozeInstant,
} from '@tali/domain/reminder-policy'
import type { ReminderDispatchId } from '@tali/domain'
import {
  AnswerDone,
  DispatchAnswered,
  Dismiss,
  Snooze,
} from './Answer.command.js'
import {
  ClaimFire,
  DispatchOpened,
  FireClaimed,
  FireSuppressed,
} from './ClaimFire.command.js'
import {
  DeliverDue,
  DispatchDueForPush,
  DispatchExpired,
  SWEEP_HORIZON_MS,
  SWEEP_MAX_ATTEMPTS,
  SWEEP_MAX_PUSHES,
} from './DeliverDue.command.js'
import { AnswerReply, DispatchSnapshot } from './Dispatch.js'
import {
  AlreadyAnswered,
  DispatchNotFound,
  NotOwed,
  SnoozeMinutesNotPreset,
} from './dispatch.rejection.js'
import { dispatchIdFor } from './dispatch-id.js'
import { ReminderOwnerId } from './ReminderOwner.id.js'
import {
  DeleteReminder,
  ReminderDeleted,
  ReminderSilenced,
  SilenceReminder,
} from './ReminderLifecycle.command.js'
import {
  DispatchPushed,
  DispatchPushFailed,
  RecordPushOutcome,
} from './RecordPushOutcome.command.js'

/**
 * `ReminderOwner` — one owner's firing ledger (ADR-0005, restated as an
 * aggregate).
 *
 * Everything D1's no-transactions constraint used to force into compare-and-
 * sets and atomic batches is one object's serialized decision here:
 *
 * - the **claim mutex** — one claim per (reminder, fire instant, origin) —
 *   is the `claims` map, decided one command at a time;
 * - the snooze "close the parent, open one child" pair is one commit, so a
 *   double tap cannot queue two re-fires;
 * - the answered-mid-tick race is queue order: an answer that lands between
 *   the sweep's due decision and the push outcome simply wins, and the late
 *   outcome is refused with `NotOwed`.
 *
 * The state is the dispatch ledger and nothing else: the synced reminder rows
 * (title, repeat, silence) stay in D1 and ride the sync feed; the sweep
 * re-feeds whatever the decisions need each tick, and the projections feed
 * the ledger back into the tables the Missed Inbox reads.
 */

/** The claim mutex key: (reminder, fire instant, origin). */
const claimKey = (reminderId: string, scheduledFor: string, origin: string) =>
  `${reminderId}\u0000${scheduledFor}\u0000${origin}`

/** The ledger state: every dispatch this owner owes, answers and closes. */
const State = Schema.Struct({
  /** Dispatch rows by id — the in-memory dispatch ledger. */
  dispatches: Schema.Record(Schema.String, DispatchSnapshot),
  /** Fires already claimed or suppressed, by (reminder, instant, origin). */
  claims: Schema.Record(Schema.String, Schema.Boolean),
  /** The one snooze child per parent dispatch, by parent id. */
  snoozeChildren: Schema.Record(Schema.String, Schema.String),
})
type State = Schema.Schema.Type<typeof State>

const iso = (value: DateTime.Utc): string =>
  new Date(value.epochMilliseconds).toISOString()

/** Set one ledger field, keeping the snapshot's shape (evolve is total). */
const withDispatch = (
  state: State,
  dispatchId: ReminderDispatchId,
  update: (dispatch: DispatchSnapshot) => DispatchSnapshot,
): State => {
  const dispatch = state.dispatches[dispatchId]
  if (dispatch === undefined) return state
  return {
    ...state,
    dispatches: {
      ...state.dispatches,
      [dispatchId]: update(dispatch),
    },
  }
}

/** Close a dispatch's push lifecycle without touching its answer. */
const withOutcome = (
  dispatch: DispatchSnapshot,
  pushOutcome: DispatchSnapshot['pushOutcome'],
): DispatchSnapshot => ({ ...dispatch, pushOutcome })

/** Is this dispatch owed — unanswered and still pushable? */
const isOwed = (dispatch: DispatchSnapshot): boolean =>
  dispatch.response === null &&
  (dispatch.pushOutcome === 'pending' || dispatch.pushOutcome === 'failed')

/** Every owed dispatch of one reminder, oldest claim first. */
const owedOf = (
  state: State,
  reminderId: string,
): ReadonlyArray<DispatchSnapshot> =>
  Object.values(state.dispatches)
    .filter(dispatch => dispatch.reminderId === reminderId && isOwed(dispatch))
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt),
    )

/**
 * The answer route's reply, read from the committed state. Takes the two maps
 * it reads structurally, so a caller outside this module can build the reply
 * without the aggregate's state type (the ledger's shape stays private).
 */
export const answerReplyOf = (
  state: {
    readonly dispatches: { readonly [id: string]: DispatchSnapshot }
    readonly snoozeChildren: { readonly [id: string]: string }
  },
  dispatchId: ReminderDispatchId,
): AnswerReply => {
  const dispatch = state.dispatches[dispatchId]!
  const childId = state.snoozeChildren[dispatchId]
  return {
    dispatch,
    child: childId === undefined ? null : (state.dispatches[childId] ?? null),
    onTime: isOnTime(dispatch),
  }
}

/** The dispatch an answer command committed to (its `DispatchAnswered`). */
const answeredDispatchOf = (
  events: ReadonlyArray<{ readonly _tag: string }>,
): ReminderDispatchId => {
  for (const event of events) {
    if (event._tag === 'DispatchAnswered') {
      return (event as DispatchAnswered).dispatchId
    }
  }
  // A committed snooze answers before it opens; the parent is the answer.
  for (const event of events) {
    if (event._tag === 'DispatchOpened') {
      const opened = event as DispatchOpened
      if (opened.parentDispatchId !== null) return opened.parentDispatchId
    }
  }
  // Unreachable on a committed answer; total for the reply's types.
  return (events[0] as DispatchAnswered).dispatchId
}

export class ReminderOwner extends Domain.Aggregate(
  'ReminderOwner',
  {
    id: ReminderOwnerId,
    state: State,
    initial: { dispatches: {}, claims: {}, snoozeChildren: {} },

    commands: [
      ClaimFire,
      DeliverDue,
      AnswerDone,
      Snooze,
      Dismiss,
      SilenceReminder,
      DeleteReminder,
      RecordPushOutcome,
    ],

    decide: {
      // ── Claim (ADR-0005 §3/§5) ─────────────────────────────────────────
      ClaimFire: (state, cmd) => {
        // The ledger's unique key, decided: a repeated, late or overlapping
        // tick does nothing, never a second dispatch.
        if (
          state.claims[claimKey(cmd.reminderId, cmd.scheduledFor, 'schedule')]
        ) {
          return []
        }

        // Policy at claim time. Silence is not a hold: no dispatch row at
        // all, and the series advances past the silence (a one-off moves to
        // the silence's end rather than vanishing).
        const plan = reminderDeliverAt(cmd, cmd.ownerTimeZone, cmd.scheduledFor)
        if (plan._tag === 'suppress') {
          const next = advancePastSilence(
            cmd.repeat,
            cmd.scheduledFor,
            cmd.reminderTimeZone,
            cmd.silencedUntil ?? cmd.scheduledFor,
          )
          return [
            new FireSuppressed({
              reminderId: cmd.reminderId,
              scheduledFor: cmd.scheduledFor,
              nextFireAt: next === cmd.scheduledFor ? null : next,
            }),
          ]
        }

        // A claimed fire advances the series past the tick — a catch-up tick
        // after an outage jumps past every occurrence it already covered.
        const nextFireAt = reminderNextFireAfterNow(
          cmd.repeat,
          cmd.reminderTimeZone,
          cmd.scheduledFor,
          cmd.now,
        )
        return [
          new FireClaimed({
            reminderId: cmd.reminderId,
            scheduledFor: cmd.scheduledFor,
            nextFireAt,
          }),
          new DispatchOpened({
            id: dispatchIdFor(
              cmd.reminderId,
              cmd.scheduledFor,
              'schedule',
              cmd.now,
            ),
            reminderId: cmd.reminderId,
            scheduledFor: cmd.scheduledFor,
            // The policy's one output: the fire instant (critical tier, or
            // outside the window) or the next local 07:00 — the ledger row
            // *is* the overnight queue.
            deliverAt: plan.deliverAt,
            rootScheduledFor: cmd.scheduledFor,
            origin: 'schedule',
            pushOutcome: 'pending',
            attempts: 0,
            lastAttemptAt: null,
            parentDispatchId: null,
            response: null,
            respondedAt: null,
            snoozedUntil: null,
            createdAt: cmd.now,
          }),
        ]
      },

      // ── Deliver (ADR-0005 §2/§4) ──────────────────────────────────────
      DeliverDue: (state, cmd) => {
        const factOf = new Map(cmd.facts.map(fact => [fact.dispatchId, fact]))
        const deliverable = Object.values(state.dispatches)
          .filter(dispatch => isOwed(dispatch))
          .filter(
            dispatch => Date.parse(dispatch.deliverAt) <= Date.parse(cmd.now),
          )
          .sort((a, b) =>
            a.deliverAt === b.deliverAt
              ? a.id.localeCompare(b.id)
              : a.deliverAt.localeCompare(b.deliverAt),
          )

        const due: Array<DispatchDueForPush> = []
        const expired: Array<DispatchExpired> = []
        for (const dispatch of deliverable) {
          // No fresh vouch this tick (the projection row was not visible at
          // the read): hold, and the next tick carries it.
          const fact = factOf.get(dispatch.id)
          if (fact === undefined) continue

          // The two facts that close a row without pushing.
          if (fact.deletedAt !== null) {
            expired.push(
              new DispatchExpired({
                dispatchId: dispatch.id,
                reason: 'reminder-deleted',
              }),
            )
            continue
          }
          if (fact.silencedUntil !== null) {
            expired.push(
              new DispatchExpired({
                dispatchId: dispatch.id,
                reason: 'silenced',
              }),
            )
            continue
          }

          // The 15-minute outage allowance, measured from `deliverAt`: a
          // quiet-hours hold is on time when its 07:00 tick carries it.
          if (
            Date.parse(cmd.now) - Date.parse(dispatch.deliverAt) >
            SWEEP_HORIZON_MS
          ) {
            expired.push(
              new DispatchExpired({
                dispatchId: dispatch.id,
                reason: 'past-horizon',
              }),
            )
            continue
          }
          // The attempt budget was spent without an outcome (a crash between
          // the due decision and the outcome): close it here.
          if (dispatch.attempts >= SWEEP_MAX_ATTEMPTS) {
            expired.push(
              new DispatchExpired({
                dispatchId: dispatch.id,
                reason: 'out-of-attempts',
              }),
            )
            continue
          }

          // The mechanical fetch bound: overflow rolls to the next tick
          // untouched — "owed" is a state, not a message.
          if (due.length >= SWEEP_MAX_PUSHES) continue

          due.push(
            new DispatchDueForPush({
              dispatchId: dispatch.id,
              reminderId: dispatch.reminderId,
              title: fact.title,
              note: fact.note,
              kind: fact.kind,
              tier: fact.tier,
              deliverAt: dispatch.deliverAt,
              attempts: dispatch.attempts + 1,
              dueAt: cmd.now,
            }),
          )
        }
        return [...due, ...expired]
      },

      // ── Answer (ADR-0005 §6) ──────────────────────────────────────────
      AnswerDone: (state, cmd, { now }) => {
        const dispatch = state.dispatches[cmd.dispatchId]
        if (dispatch === undefined) {
          return new DispatchNotFound({ dispatchId: cmd.dispatchId })
        }
        // One fire is one answer; a double tap returns the stored answer.
        if (dispatch.response !== null) {
          return new AlreadyAnswered({ response: dispatch.response })
        }
        const respondedAt = iso(now)
        return [
          new DispatchAnswered({
            dispatchId: cmd.dispatchId,
            response: 'done',
            respondedAt,
            snoozedUntil: null,
            onTime: isOnTime({
              response: 'done',
              rootScheduledFor: dispatch.rootScheduledFor,
              respondedAt,
            }),
          }),
        ]
      },

      Snooze: (state, cmd, { now }) => {
        const dispatch = state.dispatches[cmd.dispatchId]
        if (dispatch === undefined) {
          return new DispatchNotFound({ dispatchId: cmd.dispatchId })
        }
        // The parent closes in the same commit that opens the child, so a
        // double tap can never open a second one.
        if (dispatch.response !== null) {
          return new AlreadyAnswered({ response: dispatch.response })
        }
        // The preset set bounds any single snooze to an hour (#79).
        const target = snoozeInstant(iso(now), cmd.minutes)
        if (target === null) {
          return new SnoozeMinutesNotPreset({ minutes: cmd.minutes })
        }
        const respondedAt = iso(now)
        return [
          new DispatchAnswered({
            dispatchId: cmd.dispatchId,
            response: 'snooze',
            respondedAt,
            snoozedUntil: target,
            onTime: false,
          }),
          new DispatchOpened({
            id: dispatchIdFor(
              dispatch.reminderId,
              target,
              `snooze:${cmd.dispatchId}`,
              respondedAt,
            ),
            reminderId: dispatch.reminderId,
            // The child's deliver-at is its target as-is: quiet hours never
            // hold a snooze, and a chain may walk through the night.
            scheduledFor: target,
            deliverAt: target,
            // The on-time grace stays rooted at the original fire.
            rootScheduledFor: dispatch.rootScheduledFor,
            origin: `snooze:${cmd.dispatchId}`,
            pushOutcome: 'pending',
            attempts: 0,
            lastAttemptAt: null,
            parentDispatchId: cmd.dispatchId,
            response: null,
            respondedAt: null,
            snoozedUntil: null,
            createdAt: respondedAt,
          }),
        ]
      },

      Dismiss: (state, cmd, { now }) => {
        const dispatch = state.dispatches[cmd.dispatchId]
        if (dispatch === undefined) {
          return new DispatchNotFound({ dispatchId: cmd.dispatchId })
        }
        if (dispatch.response !== null) {
          return new AlreadyAnswered({ response: dispatch.response })
        }
        return [
          new DispatchAnswered({
            dispatchId: cmd.dispatchId,
            response: 'dismiss',
            respondedAt: iso(now),
            snoozedUntil: null,
            onTime: false,
          }),
        ]
      },

      // ── Change of mind (ADR-0005 §5) ──────────────────────────────────
      SilenceReminder: (state, cmd) => [
        new ReminderSilenced({
          reminderId: cmd.reminderId,
          until: cmd.until,
        }),
        // Setting a silence expires every dispatch the reminder still owes —
        // a held row must not push after the owner changed their mind.
        // Clearing one expires nothing.
        ...(cmd.until === null
          ? []
          : owedOf(state, cmd.reminderId).map(
              dispatch =>
                new DispatchExpired({
                  dispatchId: dispatch.id,
                  reason: 'silenced',
                }),
            )),
      ],

      DeleteReminder: (state, cmd) => [
        new ReminderDeleted({ reminderId: cmd.reminderId }),
        ...owedOf(state, cmd.reminderId).map(
          dispatch =>
            new DispatchExpired({
              dispatchId: dispatch.id,
              reason: 'reminder-deleted',
            }),
        ),
      ],

      // ── The push outcome (ADR-0005 §3) ────────────────────────────────
      RecordPushOutcome: (state, cmd) => {
        const dispatch = state.dispatches[cmd.dispatchId]
        // An answer that landed mid-push wins; a closed row has nothing left
        // to record, and the caller treats the refusal as done.
        if (dispatch === undefined || !isOwed(dispatch)) {
          return new NotOwed({ dispatchId: cmd.dispatchId })
        }
        switch (cmd.outcome) {
          case 'accepted':
            return [
              new DispatchPushed({ dispatchId: cmd.dispatchId, at: cmd.at }),
            ]
          case 'failed':
            return [
              new DispatchPushFailed({
                dispatchId: cmd.dispatchId,
                at: cmd.at,
              }),
            ]
          case 'expired':
            return [
              new DispatchExpired({
                dispatchId: cmd.dispatchId,
                reason: cmd.reason ?? 'no-subscription',
              }),
            ]
        }
      },
    },

    evolve: {
      FireClaimed: (state, event) => ({
        ...state,
        claims: {
          ...state.claims,
          [claimKey(event.reminderId, event.scheduledFor, 'schedule')]: true,
        },
      }),
      FireSuppressed: (state, event) => ({
        ...state,
        claims: {
          ...state.claims,
          [claimKey(event.reminderId, event.scheduledFor, 'schedule')]: true,
        },
      }),
      DispatchOpened: (state, event) => ({
        ...state,
        dispatches: {
          ...state.dispatches,
          [event.id]: {
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
        },
        snoozeChildren:
          event.parentDispatchId === null
            ? state.snoozeChildren
            : {
                ...state.snoozeChildren,
                [event.parentDispatchId]: event.id,
              },
      }),
      // Taking the send slot, exactly where the old `takeAttempts`
      // compare-and-set used to run: the attempt is spent before the fetch,
      // so a crashed outcome still leaves a bounded, retryable row.
      DispatchDueForPush: (state, event) =>
        withDispatch(state, event.dispatchId, dispatch => ({
          ...dispatch,
          attempts: event.attempts,
          lastAttemptAt: event.dueAt,
        })),
      DispatchPushed: (state, event) =>
        withDispatch(state, event.dispatchId, dispatch =>
          withOutcome(dispatch, 'accepted'),
        ),
      DispatchPushFailed: (state, event) =>
        withDispatch(state, event.dispatchId, dispatch =>
          withOutcome(dispatch, 'failed'),
        ),
      DispatchExpired: (state, event) =>
        withDispatch(state, event.dispatchId, dispatch =>
          withOutcome(dispatch, 'expired'),
        ),
      DispatchAnswered: (state, event) =>
        withDispatch(state, event.dispatchId, dispatch => ({
          ...dispatch,
          response: event.response,
          respondedAt: event.respondedAt,
          snoozedUntil: event.snoozedUntil,
        })),
      ReminderSilenced: state => state,
      ReminderDeleted: state => state,
    },

    reply: {
      AnswerDone: (state, events) =>
        answerReplyOf(state, answeredDispatchOf(events)),
      Snooze: (state, events) =>
        answerReplyOf(state, answeredDispatchOf(events)),
      Dismiss: (state, events) =>
        answerReplyOf(state, answeredDispatchOf(events)),
    },
  },
  {
    description:
      "One owner's reminder firing ledger: the dispatches owed, pushed, answered and closed. The claim mutex, the snooze child rule and the answer-beats-the-push guard are all invariants of this one instance.",
  },
) {}
