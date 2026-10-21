# ADR-0005: One per-minute cron sweep claims each fire in the dispatch ledger

- **Status:** Accepted (2026-10-21)
- **Deciders:** Tali owner + developer (wayfinder #67); the delivery-detail defaults marked _(default)_ are the architect's, open to amendment until #61 lands
- **Related:** tickets #67 (firing mechanism), #60 (reminder aggregate), #61 (delivery), #13 (scheduling policy), #4 (Web Push research), #3 (Alchemy cron), #44 (`alchemy dev`), #20 (push shell), ADR-0004 (the reserved `ReminderLink`)

## Context

`docs/reminder-policy-draft.md` settled *what* a reminder does — quiet hours
23:00–07:00 per user, the medication tier bypassing them, snooze
{5,10,15,30,60} for one occurrence, unanswered = missed with a 24 h roll, and
"never silently dropped" as a hard Must constraint. Nothing in it says what
*wakes the Worker up* at 08:00, and the answer decides more than the schedule:
it decides where the queue lives, what happens during an outage, and how a fire
that no browser ever saw still reaches the inbox.

The constraint set is narrow, because the app is designed to the Workers **Free**
plan (the same reasoning as #21's hashing decision):

| Limit | Free plan | Why it binds |
|---|---|---|
| Cron granularity | `* * * * *` (one minute) | there is no sub-minute calendar trigger at any price |
| Cron CPU / subrequests | **10 ms** / **50** per invocation | one tick must be cheap and fixed-size |
| Cron triggers per account | 5 | budget for a second, non-reminder trigger |
| Cron invocations vs requests | 1,440 ticks/day ≈ **1.4 %** of 100 k requests/day | the sweep is affordable, but not free |
| Cron timing | no guaranteed instant; the handler receives `controller.scheduledTime` (the nominal minute boundary) | a sweep must be idempotent under late and repeated invocation |
| D1 | 5 M rows read, 100 k rows written per day; 50 queries per invocation | reads must be indexed, writes batched |
| DO alarms | allowed on Free (SQLite backend only); one alarm per object; at-least-once; `setAlarm` bills as a row write | an alarm is a per-object clock, not a per-reminder one |
| Queues | 10 k ops/day; **24 h** delay and retention (non-configurable on Free) | a weekly reminder cannot be enqueued ahead |
| `@effect/workflow` | `DurableClock.sleep` delegates the wake-up to a `WorkflowEngine` we would have to implement (`repos/effect/packages/effect/src/workflow/DurableClock.ts`) | it is the retry/durability layer, not the clock |

Four candidates were on the table, plus a hybrid:

- **Per-minute cron sweep** — one indexed read of due reminders per tick, dispatch inline.
- **Durable Object alarm** — one alarm per reminder, "exact to the second".
- **Queues delayed fan-out** — enqueue on write with `delaySeconds = fireAt − now`, consume and send.
- **`@effect/workflow` per reminder** — a durable workflow with a durable clock per reminder.
- **Hybrid** — sweep enqueues, queue retries and fans out.

## Decision

**1. The clock is one cron trigger on the api Worker.** `* * * * *`, declared in
`infra/alchemy.run.ts` on the existing `TaliApi` Worker — same deployable, same
D1 binding, no second Worker and no cross-Worker auth. Its `scheduled()` handler
runs one program, `sweepReminders(scheduledTime)`. The clock is
`controller.scheduledTime`, never `Date.now()`: two invocations for the same
minute compute the same window, so a retry or a duplicated delivery is a no-op
rather than a second send.

**2. The sweep is a catch-up query, not a scheduler.** A tick claims every fire
whose `fire_at <= scheduledTime` and which has no dispatch row, plus every
dispatch still owed a push. Nothing is "pre-scheduled", so a delayed, repeated or
skipped tick cannot lose a fire — the next tick sees it. This is the whole answer
to "what happens when the Worker is down at the firing minute".

**3. The dispatch ledger row is the mutex.** `reminder_dispatches` carries
`UNIQUE (reminder_id, scheduled_for, origin)`, with `origin` = `schedule` or
`snooze:<parentDispatchId>`. A claim is
`INSERT … ON CONFLICT DO NOTHING RETURNING id`; only the invocation that got a row
back sends the push. Overlapping ticks, a retried invocation and a duplicated
cron delivery all converge on one row and at most one notification. The ledger is
the source of truth for "did this happen"; the push is a best-effort annotation
on it (research #4).

**4. Never early, minute-late, fifteen minutes of redemption.** A fire is only
claimed at or after its instant, so nothing is delivered early; the tick that
carries it is the first tick at or after it — typically a few seconds, bounded by
the minute. A fire first seen more than **15 minutes** late is written to the
ledger as expired and never pushed: it is inbox-only. The same horizon bounds
retrying a failed push (≤3 attempts, same invocation or the next). A four-hour-late
"take your medication" is worse than a silent inbox row.

**5. Policy runs at claim time, inside the sweep, before dispatch.** Quiet hours
and the tier are evaluated by the policy service when the fire is claimed — never
at write time, never in the browser, never in the service worker. The policy's
output is the fire's *deliver-at* instant:

```text
onClaim(reminder, scheduledFor, owner, now)
  if reminder.silencedUntil > now           → hold until silencedUntil
  if tier = critical (medication)           → deliverAt = scheduledFor   // quiet hours never apply
  if scheduledFor is inside 23:00–07:00     → deliverAt = next 07:00 in the owner's zone
    in the owner's zone
  otherwise                                 → deliverAt = scheduledFor
```

Quiet hours therefore **queue in the ledger**, not in a queue product: a held
dispatch is an ordinary owed row whose `deliver_at` is 07:00, and the ordinary
sweep flushes it. A snooze re-fire is exempt from quiet hours — the owner's
explicit "remind me in 10 minutes" at 23:00 is the consent #13 §4.3 asks for.

**6. Snooze is a new ledger row, not a mutation.** The parent row keeps
`response = "snooze"` and `snoozed_until`; a child row is inserted with
`scheduled_for = deliver_at = responded_at + X`,
`origin = snooze:<parentId>`, `parent_dispatch_id = parent`. The series'
`fire_at` is untouched, because snooze is this-occurrence-only (#13). One row =
one fire = one answer, which is exactly what the adherence metric needs:
snoozed-then-done reads as *late*, and "snoozed three times" is visible in the
history.

**7. "Missed" is a query, not a job.** Inbox = dispatches with
`response IS NULL AND scheduled_for < now`; older than 24 hours they leave the
inbox view for history. There is no second cron trigger, no nightly roll and no
"missed" table: the ledger row is written at claim and never deleted, which is how
"never silently dropped" is guaranteed (PRD §8.3.1).

**8. One sweep for both users; no per-household object.** The sweep is a system
actor over its own data, scoping subscriptions by the reminder's owner and never
crossing a household. Isolation is a `WHERE`, not an instance: a second household
costs rows, not new machinery.

**9. The tick budget is a rule.** Per tick: at most **two fixed indexed reads**
(due fires; owed dispatches), **one D1 batch** for the tick's writes, at most
**10 dispatches** (each dispatch is one push `fetch`, one subrequest), and no
query that scales with the number of reminders. Overflow rolls to the next tick
untouched — "owed" is a state, not a message.

**10. _(default)_ The 07:00 flush is bounded per owner.** Held dispatches become
due at 07:00. Critical ones push individually; normal-tier pushes are capped at
**2 per owner per window**, and the remainder are marked expired (inbox-only)
rather than pushed a minute later. The inbox always shows every held fire, so the
cap loses no information, and a rough night does not become a wall of
notifications at 07:01 (principle 4 «احترام به تمرکز»).

**11. Declared and exercised through Alchemy.** The trigger is declared in
`infra/alchemy.run.ts` (`Cloudflare.Workers.cron("* * * * *", …)`, or the
plain-module `crons: ["* * * * *"]` plus an exported `scheduled()` that #44's
plain `async fetch` Worker takes); `alchemy plan`/`drift` show it, and a deploy is
the only way to change it (cron changes propagate in up to 15 minutes).
`alchemy dev` boots the stack but **does not run cron triggers**, so the sweep is
`reminders.sweep(now)` behind an injectable clock, exercised three ways: tests
call it with a fake clock and a fake push gateway; a dev-only
`POST /dev/reminders/sweep?at=<ISO>` drives it by hand against the running stack;
and workerd's `/cdn-cgi/local/scheduled?time=…` exercises the real `scheduled()`
path.

## Consequences

- **#60 must land** `reminders.fire_at` (indexed — the only scheduling state; no
  per-reminder timer row), `reminder_dispatches` with the unique key above,
  `deliver_at`, `push_outcome` (`pending | accepted | failed | expired`),
  `attempts`, `parent_dispatch_id`, the response columns and an inbox index; and
  the policy service as a **pure function** returning `deliverAt`, callable
  without a Worker. Advancing the series' `fire_at` after a claim is idempotent
  and repairable: a lost advance is re-derived, and the unique key stops a second
  dispatch for the same occurrence meanwhile.
- **#61 must land** the sweep entry point, the ES256/aes128gcm send
  (`Urgency: high` for critical, `TTL` ~1 hour, `Topic` = the dispatch id so the
  service worker's `tag: reminder:<dispatchId>` coalesces a re-delivery), the
  dev trigger, and a fake push gateway behind the same interface.
- **Precision is a product promise:** never early, up to about a minute late,
  medication included. If seconds are ever required, DO alarms are the upgrade
  path — and they cost the same sweep, re-armed inside an object.
- **An outage is invisible to the data and visible in the inbox.** The next tick
  claims everything overdue; fires inside the 15-minute horizon still push, older
  ones expire into the inbox. No timer state is lost on deploy, because no timer
  state exists outside D1 — unlike DO alarms or queue messages.
- **Quiet hours have one mechanism, not two.** The overnight queue *is* the
  ledger, so "queue, never drop" needs no queue product, no consumer Worker and
  no second delivery path to debug.
- **Cost:** 1,440 ticks/day, ≈1.4 % of the Free request quota; a tick with nothing
  due costs one indexed read. The 10 ms CPU ceiling is respected by keeping the
  tick fixed-size rather than by hoping.
- **Rejected:** DO alarms — one alarm per object means the object keeps a sorted
  schedule and reschedules itself on every wake (the same sweep, plus a binding,
  a migration and `setAlarm` row writes); Queues — 24 h delay and retention on
  Free cannot hold a weekly reminder, at-least-once still needs the ledger, and it
  adds a second path without removing the first; `@effect/workflow` — its durable
  clock delegates the wake-up, so it buys retry semantics that a D1 batch and a
  bounded inline retry already give, at the cost of a second durable store and
  engine; the sweep+queue hybrid — only pays off beyond ~10 devices per tick and is
  recorded, with DO alarms, as the upgrade path.
- **Revisit if:** a third household makes the 10-per-tick cap measurable, the
  07:00 cap proves to lose something the owner wanted pushed, or medication ever
  needs second-level precision.
