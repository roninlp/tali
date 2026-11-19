# ADR-0014: The reminder firing machinery is a domain model on Durable Objects

- **Status:** Proposed (Stage 1 pilot, part-delivered — see "Landed / Deliberately not moved").
- **Deciders:** Tali owner + developer.
- **Related:** ADR-0005 (the firing mechanism this supersedes piece by piece), ADR-0002 (the owner's time zone), #61 (delivery), #13 (scheduling policy), #4 (Web Push).

## Context

ADR-0005 settled *what* the firing machinery does but was shaped throughout by
D1's no-transactions constraint: the claim mutex is a unique ledger key raced
by atomic batches, the snooze child is an `INSERT … SELECT WHERE EXISTS` in
the same batch as the parent's answer, the answered-mid-tick race is closed
by a conditional `takeAttempts` UPDATE, and a busy tick is a ~43-statement
budget exercise under D1's Free-plan ceiling. Those mechanisms are correct but
contorted: every invariant is emulated with compare-and-sets because no
single object ever decides.

`@alchemy.run/domain` (2.0.0-beta.87, hosted on Cloudflare Durable Objects)
offers the missing primitive: **one aggregate instance decides one command at
a time, and its events, new state and reply commit together or not at all.**

## Decision

**1. The firing machinery is a `ReminderOwner` aggregate, one instance per
owner.** ADR-0005 §8 settled "one sweep for both users; isolation is a
`WHERE`"; the model keeps the same shape one level up — every dispatch of
one owner is decided inside that owner's single instance, so the claim mutex
(a `claims` map), the snooze child rule (one commit closes the parent and
opens the child) and the answer-beats-the-push guard (queue order; a late
outcome is `NotOwed`) are one-object invariants instead of compare-and-set
dances. A second household costs rows, not machinery.

Commands map to the glossary's verbs — `ClaimFire`, `DeliverDue`,
`AnswerDone`, `Snooze`, `Dismiss`, `SilenceReminder`, `DeleteReminder`, and
the internal `RecordPushOutcome` the push policy sends. Rejections are typed:
`AlreadyAnswered` (the double tap, answered from the ledger), `NotOwed` (the
push outcome that lost the race), `SnoozeMinutesNotPreset`,
`DispatchNotFound`.

**2. The policy stays at claim time and stays shared.** `ClaimFire`'s decide
evaluates the same pure functions the write path uses (silence suppression,
the medication tier's quiet-hours bypass, the deliver-at that makes the
ledger row the overnight queue). `advancePastSilence` moved into
`@tali/domain`'s `reminder-policy` so both sides share one implementation.

**3. D1 stays the synced store; the model feeds it.** The `reminders` table
rides the sync feed untouched. Two projections keep the existing tables in
step with the model: `DispatchLedger` mirrors ledger rows into
`reminder_dispatches` (so the Missed Inbox route, its 24 h roll and the
sweep's owed-facts read are unchanged for the client), and `ReminderSchedule`
performs the same compare-and-set advance of `fire_at` each claim emits.

**4. Push is a policy behind an External System.** `PushDispatches` reacts
to each `DispatchDueForPush` (the model's attempt-taking, right where
`takeAttempts` used to run), fans out through the unchanged `@tali/push`
gateway behind the `PushService` external system, and reports one coalesced
`RecordPushOutcome`. 404/410 deletes the subscription row; unconfigured
environments stay inbox-only.

**5. The api stays the clock and the auth surface.** Its cron still owns the
nominal clock, the occasion materialisation and the two scheduling reads, and
posts one authenticated `SweepRequest` to the reminders Worker over a service
binding guarded by a shared internal token. The old api-side claim batch,
`takeAttempts` guard and outcome batch are deleted by the platform.

**6. Package placement.** The model lives in `@tali/reminder-domain`, a new
small workspace package: `@tali/domain` is imported by the browser client and
must never see a server framework, so the bounded context sits beside it and
imports the pure policy in. The worker (`apps/reminders`) hosts the model via
`DomainCloudflare.layerDurableObjects()` — the class-based `Cloudflare.Worker`
path — because the api is a plain-module worker by design (#44) and the
domain platform declares its Durable Object classes at worker init.

## Bounds and deviations (against ADR-0005)

**The delivery bound.** ADR-0005 §9 bounds a tick by *fetches* (ten, fan-out
included) and has any dispatch that cannot reach all its devices rolled to the
next tick, so a fan-out is partial. The model bounds *due dispatches* per
`DeliverDue` instead (ten), and every planned dispatch always reaches every
device its owner has — there are no partial fan-outs. A tick's fetch total
therefore scales with owners × devices; it is isolated per owner by that
owner's Durable Object instance, and `DeliverDue`'s bound holds the per-owner
statement count, not the fetch count. Revisit per ADR-0005's own "revisit if"
clause once a third household makes the number measurable.

**The answer's link effect (#13 §2.5).** `AnswerDone` models the ledger's
answer and nothing else. The link effect — completing a task, logging the habit
entry, appending the event log — stays in the api's respond route, which applies
it in its own D1 batch and forwards the answer. The cutover slice must settle
ADR-0005 Consequences' "same batch" question: an idempotent forward plus the
`AlreadyAnswered` no-op is the candidate, and today's route is the behaviour to
preserve until it is decided.

**VAPID.** ADR-0005 §11 wants `Config.Redacted("VAPID_PRIVATE_KEY")` as a
secret binding. The reminders Worker reads plain env vars for now, matching the
current api practice; the alchemy declaration slice moves it to a secret
binding.

## Landed in this pilot

- `@tali/reminder-domain` (new): the aggregate, its commands/events/rejections,
  the push policy, the D1-feed projections and the internal wire schemas.
- `@tali/push` (new): the transport moved verbatim from `apps/api/src`.
- `apps/reminders` (new): the model's Worker — Durable Object hosting, the
  D1 adapters for the store ports, the tick driver, the internal routes.
- 31 story tests (in memory, given/when/then) covering ADR-0005's edge cases
  — double claim, quiet-hours hold and 07:00 flush, medication bypass,
  snooze-of-snooze, silence expiring owed rows, on-time from the root fire,
  the horizon, the attempt budget, the snoozed dispatch's stored reply, the
  answer-beats-the-push race — plus a `Domain.verify` declaration test and a
  wire test.

## Deliberately not moved (this PR)

- The seven CRUD aggregates, the sync engine and the client: untouched.
- The api's D1-based sweep stays the live clock until the reminders Worker is
  declared in `infra/alchemy.run.ts` (the `REMINDERS` binding, the internal
  token, `DomainCloudflare.providers()`); the sweep/respond forwarding seam —
  the wire schemas, `listOwedFacts`, the model-client shape — is in place on
  the model's side; the api-side forwarder is the next slice. The pilot proves
  the model end to end in memory; flipping the api's tick to
  `sweep`/`respond` forwarding is a mechanical follow-up once the Worker is
  on the stack.

## Revisit if

- A third household makes the per-owner instance worth splitting per
  reminder (it is not today: the ledger is the aggregate's own state).
- The api-side forwarding lands and the old D1 claim path can be deleted.
