# ADR-0005: One per-minute cron sweep claims each fire in the dispatch ledger

- **Status:** Accepted (2026-10-21) — the mechanism is decided; the snooze-inside-quiet-hours default was confirmed by the owner in #79 (§5).
- **Deciders:** Tali owner + developer (wayfinder #67); delivery details marked _(default)_ are the architect's, amendable until #61 lands. The 07:00 push cap recorded in #67 is **not** adopted here — see §10.
- **Related:** tickets #67 (firing mechanism), #60 (reminder aggregate), #61 (delivery), #13 (scheduling policy), #4 (Web Push research), #3 (Alchemy cron), #44 (`alchemy dev`), #20 (push shell), ADR-0002 (the owner's time zone), ADR-0004 (the reserved `ReminderLink`)

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
| Cron invocations vs requests | 1,440 ticks/day ≈ **1.4 %** of 100 k requests/day | cron invocations count as requests; the sweep is affordable, but not free |
| Cron timing | no guaranteed instant; the handler receives `controller.scheduledTime` (the nominal minute boundary) | a sweep must be idempotent under late and repeated invocation |
| D1 | 5 M rows read, 100 k rows written per day; **50 queries** per invocation; `batch()` is atomic but sequential, and a statement cannot read an earlier statement's result | reads must be indexed and bounded; writes batched, but a claim and its network outcome cannot share a batch |
| DO alarms | allowed on Free (SQLite backend only); one alarm per object; at-least-once; `setAlarm` bills as a row write | an alarm is a per-object clock, not a per-reminder one |
| Queues | 10 k ops/day; **24 h** delay and retention (non-configurable on Free) | a weekly reminder cannot be enqueued ahead |
| `@effect/workflow` | `DurableClock.sleep` delegates the wake-up to a `WorkflowEngine` we would have to implement (`repos/effect/packages/effect/src/workflow/DurableClock.ts`) | it is the retry/durability layer, not the clock |

Four candidates were on the table, plus a hybrid:

- **Per-minute cron sweep** — an indexed scan of due reminders per tick, dispatch inline.
- **Durable Object alarm** — one alarm per reminder, meant to be second-precise.
- **Queues delayed fan-out** — enqueue on write with `delaySeconds = fireAt − now`, consume and send.
- **`@effect/workflow` per reminder** — a durable workflow with a durable clock per reminder.
- **Hybrid** — sweep enqueues, queue retries and fans out.

## Decision

**1. The clock is one cron trigger on the api Worker.** `* * * * *`, declared in
`infra/alchemy.run.ts` on the existing `TaliApi` Worker — same deployable, same
D1 binding, no second Worker and no cross-Worker auth. Its `scheduled()` handler
runs one program, `sweepReminders(scheduledTime)`. The clock is
`controller.scheduledTime`, never `Date.now()`: two invocations for the same
minute compute the same window and the same claim, so a duplicate that arrives
after the outcome is a no-op rather than a second dispatch, and one that arrives
before it converges on the same ledger row (the `Topic`/`tag` handles the rare
re-send). (Only the sweep's notion of *now* is nominal; a response uses the
browser's real `respondedAt`.)

**2. The sweep is a catch-up query, not a scheduler.** A tick runs two bounded,
indexed scheduling reads (the subscription read is the third; §8–§9):

```sql
-- due fires: the next occurrence is at or before this tick
SELECT ... FROM reminders r
WHERE r.fire_at <= ? AND r.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM reminder_dispatches d
                  WHERE d.reminder_id = r.id
                    AND d.scheduled_for = r.fire_at
                    AND d.origin = 'schedule')
ORDER BY r.fire_at LIMIT ?;

-- owed dispatches: claimed rows whose deliver-at has arrived
SELECT ... FROM reminder_dispatches d
JOIN reminders r ON r.id = d.reminder_id
WHERE d.response IS NULL
  AND d.push_outcome IN ('pending', 'failed')
  AND d.deliver_at <= ?
  AND r.deleted_at IS NULL
ORDER BY d.deliver_at LIMIT ?;
```

Both are one indexed read (the unique key and the owed index), not a scan.
Nothing is "pre-scheduled", so a delayed, repeated or skipped tick cannot lose a
fire — the next tick sees it. Because `reminders.fire_at` holds only the *next*
occurrence, a long outage yields one catch-up claim per reminder (expired if it is
past the horizon), not a backlog: after a claim, `fire_at` advances to the first
occurrence strictly after `scheduledTime` (a `once` reminder has none, and its
unique ledger row already excludes the fired occurrence).

**3. The dispatch ledger row is the mutex, and the claim is one atomic batch.**
`reminder_dispatches` carries `UNIQUE (reminder_id, scheduled_for, origin)`, with
`origin` = `schedule` or `snooze:<parentDispatchId>`. A claim is:

1. one `INSERT … ON CONFLICT DO NOTHING RETURNING id` for the due rows (ids are
   generated before the batch), and
2. one compare-and-set per reminder: `UPDATE reminders SET fire_at = ? WHERE id
   = ? AND fire_at = ?` (the claimed instant), in the same `env.DB.batch()`.

The batch is atomic, so the insert and the advance land or roll back together.
Only rows returned by `RETURNING` may send; the CAS is what stops an overlapping
tick whose insert lost the unique race from also advancing the series.
Overlapping ticks, a retried invocation and a duplicated cron delivery all
converge on one row and one claim.

The outcome cannot share that batch: D1 `batch()` runs statements sequentially
and a statement cannot branch on an earlier statement's result, and the outcome
is only known after the push `fetch`. A tick is therefore **claim batch → push →
outcome batch** (update `push_outcome`, `attempts`, `last_attempt_at`). A crash
between the push and the outcome leaves `pending`, and the next tick retries it.
The guarantee is at-most-one **claim** per fire, not at-most-one push across a
crash: the second push is the same claim, coalesced by `Topic` and the service
worker's `tag`. That is the right side of the trade #67 chose — the claim is the
mutex, and a rare re-send is not a second dispatch. Each statement in a batch
counts toward D1's 50-query ceiling.

**4. Never early, normally minute-late, fifteen minutes of redemption.** A
schedule claim is only made at or after the fire instant, and nothing is pushed
before its `deliver_at`: an immediate dispatch goes out in the tick that claims
it, and a held one in the first tick at or after `deliver_at`. Lateness is
measured from **`deliver_at`, not `scheduled_for`**: a quiet-hours hold is on
time when the 07:00 tick carries it, and a snooze is on time when its `now + X`
arrives. In normal operation the first tick at or after `deliver_at` carries it —
a few seconds, bounded by the minute. If the Worker was down or the invocation
was delayed, the catch-up tick may be up to **15 minutes** late and still pushes;
a dispatch whose first deliverable tick is more than 15 minutes past `deliver_at`
is written (or updated) as `expired` and never pushed: it is inbox-only. The same
horizon bounds retrying a failed push (≤3 attempts, in the same invocation or the
next). A four-hour-late "take your medication" is worse than a silent inbox row.
The expiry test belongs to the dispatch step — and to the claim batch only when
`deliver_at` is already in the past — so a deferred row is never expired merely
for being held.

**5. Policy runs at claim time, inside the sweep, before dispatch.** Quiet hours
and the tier are evaluated by the policy service when the fire is claimed — never
at write time, never in the browser, never in the service worker. The policy's
output is either *suppress* (the fire is inside a **Silence**) or the fire's
*deliver-at* instant:

```text
onClaim(reminder, ownerTimeZone, scheduledFor)
  if reminder.silencedUntil > scheduledFor → suppress
                                              // no dispatch; fire_at advances past the silence
  if tier = critical (medication)          → deliverAt = scheduledFor   // quiet hours never apply
  if local(scheduledFor, ownerTimeZone)
       in [23:00, 07:00)                   → deliverAt = next 07:00 in ownerTimeZone
  otherwise                                → deliverAt = scheduledFor
```

The policy reads the owner's IANA zone from `user_preferences.time_zone`
(ADR-0002), falling back to the profile zone, and is a **pure function** with no
D1 or Worker imports. Quiet hours therefore **queue in the ledger**, not in a
queue product: a held dispatch is an ordinary owed row whose `deliver_at` is
07:00, and the ordinary sweep flushes it. The inbox shows a held fire on the next
app open even before 07:00, which is #13's "window's end or next app open" path.
A snooze child is written with its `deliver_at` already set (§6), so it does not
pass through the quiet-hours branch: **quiet hours never hold a snooze**, and a
snooze chain may walk through the night because every link needs a fresh tap
(#79). **Silence is not a hold:** #13's `silencedUntil` pauses the series,
so a fire inside it produces no dispatch and the series advances past it. Setting
a silence or deleting a reminder also expires any dispatch already owed, so a
held row cannot push after the owner has changed their mind.

**6. Snooze is a new ledger row, not a mutation.** The parent row keeps
`response = "snooze"` and `snoozed_until`; a child row is inserted with
`scheduled_for = deliver_at = responded_at + X`, `origin = snooze:<parentId>`,
`parent_dispatch_id = parent`. The parent update is a compare-and-set
(`WHERE id = ? AND response IS NULL`) and the child insert is in the same batch,
so a double tap produces one child and one answer. The series' `fire_at` is
untouched, because snooze is this-occurrence-only (#13 §2.3, §4 #5). One row =
one fire = one answer, which is exactly what the adherence metric needs:
snoozed-then-done reads as *late*, and "snoozed three times" is visible in the
history. The child carries `root_scheduled_for` (the original fire instant, its
own `scheduled_for` for a schedule claim); the on-time check is
`responded_at <= root_scheduled_for + 30 min`, so it does not reset the grace
window at every snooze.

**7. "Missed" is a query, not a job.** Inbox = dispatches with
`response IS NULL AND scheduled_for < now`; older than 24 hours (from
`scheduled_for`) they leave the inbox view for history. There is no second cron
trigger, no nightly roll and no "missed" table: the ledger row is written at claim
and never deleted, which is how "never silently dropped" is guaranteed (PRD
§8.3.1). The inbox is also the app-open path for quiet-hours holds, so a 02:00
app open shows them without waiting for the 07:00 push.

**8. One sweep for both users; no per-household object.** The sweep is a system
actor over its own data. It scopes the push fan-out by the reminder's owner —
`push_subscriptions` is read by `user_id` (the index from `0004`) — and never
crosses a household. Isolation is a `WHERE`, not an instance: a second household
costs rows, not new machinery.

**9. The tick budget is a rule.** Per tick: **three fixed indexed reads** (due
fires with the owner zone; owed dispatches; the push subscriptions of the owners
in this tick), **two atomic write batches** (claim: insert + CAS advance;
outcome: publish result), at most **10 push `fetch`es** — the bound is on
fetches, not dispatches, because one dispatch fans out to every subscription its
owner has — and no query that scales with the number of reminders (both reads are
`ORDER BY … LIMIT`). Overflow rolls to the next tick untouched — "owed" is a
state, not a message. Ten fetches and two batches keep the tick under the
50-query D1 ceiling and the 50-subrequest ceiling: at most 10 claim inserts + 10
CAS advances + 10 outcome updates + 3 reads = 33 statements, plus one fetch per
subscription.

**10. The 07:00 flush is not capped by policy.** Held dispatches become due at
07:00 and the ordinary sweep pushes them, bounded only by the tick's mechanical
fetch cap (§9); overflow rolls to the next tick, so the flush completes within a
few minutes. #13's rule is that quiet-hours reminders are held and then flushed
at the first opportunity, and the inbox is the app-open path; a per-owner push
cap (e.g. 2 per window) would be a product change to that rule, not a delivery
detail. #67 recorded such a cap without a separate owner answer; it is **not
adopted** here. If the owner wants it, it must be decided as a #13 amendment
before #61, and the remainder should still be `expired` (inbox-only), never
dropped.

**11. Declared and exercised through Alchemy.** The trigger is declared in
`infra/alchemy.run.ts` on the existing `TaliApi` Worker. The API is a plain
`async fetch` module (#44), so the plain-module path is the one that applies: add
`crons: ["* * * * *"]` to the `Cloudflare.Worker` declaration and export
`scheduled(controller, env, ctx)` next to `fetch`. (The Effect
`Cloudflare.Workers.cron("* * * * *", …)` + `CronEventSourceLive` path from #3 is
for an Effect worker, which this is not.) `alchemy plan`/`drift` show the
trigger, and a deploy is the only way to change it (cron changes propagate in up
to 15 minutes). The VAPID private key is a secret binding
(`Config.Redacted("VAPID_PRIVATE_KEY")` per #3); the public key and `sub` are
plaintext config. `alchemy dev` boots the stack but **does not run cron
triggers**, so the sweep is `reminders.sweep(scheduledTime)` behind an injectable
clock, exercised three ways: tests call it with a fake clock and a fake push
gateway; a local-only `POST /dev/reminders/sweep?at=<ISO>` drives it by hand
against the running stack (never registered in a deployed Worker); and workerd's
`/cdn-cgi/local/scheduled?time=…` exercises the real `scheduled()` path.

## Consequences

- **#60 must land the reminder aggregate and the ledger.** Concretely:
  - `reminders`: the common contract (`id`, `type`, `title`, `note`, `color`,
    `owner_id`, `household_id`, `visibility`, `version`, `created_at`,
    `updated_at`, `deleted_at`), plus `kind`, `tier` (derived from `kind` at
    write time, never chosen by hand), `repeat`, `fire_at`, `link_type`/`link_id`
    (the `ReminderLink` union; no foreign key yet, per ADR-0004), and
    `silenced_until`. `fire_at` is derived from `repeat` and the link's offset at
    write time and is indexed (`(fire_at) WHERE deleted_at IS NULL`) — the only
    scheduling state, with no per-reminder timer row.
  - `reminder_dispatches`: `id`, `reminder_id` (FK), `user_id`, `scheduled_for`,
    `deliver_at`, `root_scheduled_for`, `origin`, `push_outcome` (`pending |
    accepted | failed | expired`), `attempts`, `last_attempt_at`,
    `parent_dispatch_id`, `response` (`done | snooze | dismiss`), `responded_at`,
    `snoozed_until`, `created_at`. `UNIQUE (reminder_id, scheduled_for, origin)`;
    an owed index `(response, push_outcome, deliver_at)`; an inbox index
    `(user_id, response, scheduled_for)`. Use `last_attempt_at`, not
    `delivered_at`: a `2xx` means *accepted*, not delivered (#4 §5).
  - The policy is a pure function
    `onClaim(reminder, ownerTimeZone, scheduledFor) → { kind: "suppress" } |
    { kind: "claim", deliverAt }`, callable without a Worker. `ownerTimeZone`
    comes from `user_preferences.time_zone` (ADR-0002), defaulting to the
    profile zone.
  - The claim is the two-batch write in §3; the advance is the CAS
    `WHERE fire_at = claimed`. A `once` reminder needs no null `fire_at`: the
    unique ledger key already excludes the fired occurrence.
  - Setting a silence or deleting a reminder expires its owed dispatches in the
    same batch; silence also advances `fire_at` past `silenced_until`, so a
    silenced series emits no rows.
  - Responses: the service worker writes the action to the outbox (never a
    direct `fetch`, #4 §6); the outbox flusher calls
    `POST /reminders/dispatches/:id/respond` with
    `{ response, snoozeMinutes? }`. The route performs the CAS and, for `done`,
    applies the #13 §2.5 link effect (task done, habit entry, event log-only) in
    the same batch. A double tap is a no-op. `GET /reminders/inbox` returns the
    owner's unanswered dispatches (`scheduled_for < now`, last 24 h); the same
    route with `?history=1` returns the rolled-off rows.
  - Reminder CRUD syncs through a new `reminder` entity in the #34 registry.
    Dispatches are server-written (inbox/response routes only), so a client
    cannot forge the ledger.
  - The ticket's "ledger written with the reminder write" is **superseded**:
    only the reminder row is written at reminder-write time; dispatch rows are
    claim-time, and the response write is the only other writer.
- **#61 must land delivery.** Concretely: the sweep entry point, the claim and
  outcome batches, the owed read, and the per-subscription fan-out. VAPID is
  ES256 with `VAPID_PRIVATE_KEY` as a secret binding; payloads are `aes128gcm`
  against `push_subscriptions.p256dh`/`auth` (the table already exists from
  `0004`). Headers: `Urgency: high` for critical, `TTL` = the remaining horizon
  (≤15 min, not one hour — a longer TTL would deliver a stale medication alert
  after the inbox has already covered it), and `Topic` = a ≤32-character
  base64url hash of the dispatch id (RFC 8030 §5.4; the service worker's `tag`
  keeps the full `reminder:<dispatchId>`). Status mapping: `2xx` accepted;
  `404`/`410` delete that subscription row; `400`/`401`/`403`/`413` permanent →
  `expired` (inbox-only, log); `5xx`/`429`/network → `failed` and retry up to three
  rounds or the horizon; no live subscription → `expired`. A dispatch with
  several subscriptions is `accepted` if at least one accepts. Also: the
  local-only dev trigger, the fake push gateway behind the same interface, and
  the response write path above (it is the other half of the notification
  actions).
- **Precision is a product promise:** never early, and in normal operation up to
  about a minute late from `deliver_at`, medication included. The 15-minute
  horizon is the outage allowance, not the promise. The push service may hold an
  accepted message for up to its `TTL` (≤15 min) if the device is offline; beyond
  that the inbox is the recovery path. If seconds are ever required, DO alarms are
  the upgrade path — and they cost the same sweep, re-armed inside an object.
- **An outage is invisible to the data and visible in the inbox.** The next tick
  claims everything overdue; dispatches whose `deliver_at` is within the
  15-minute horizon still push, older ones expire into the inbox. No timer state
  is lost on deploy, because no timer state exists outside D1 — unlike DO alarms
  or queue messages.
- **Quiet hours have one mechanism, not two.** The overnight queue *is* the
  ledger, so "queue, never drop" needs no queue product, no consumer Worker and
  no second delivery path to debug.
- **Cost:** 1,440 ticks/day, ≈1.4 % of the Free request quota (cron invocations
  count as requests); a tick with nothing due costs **two** indexed reads, not
  one. Ten fetches and two batches keep the 10 ms CPU / 50-subrequest ceilings
  and the 50-query D1 ceiling; at two users the write volume is far below 100 k
  rows/day, and the 10-fetch cap is the mechanical bound, not a policy cap. The
  10 ms claim is a design bound, not a measurement: #61 should probe the
  worst-case tick (10 VAPID signatures + 10 `aes128gcm` payloads + the D1 work)
  the way #21 probed the KDF, and lower the fetch cap if it does not fit.
- **Rejected:** DO alarms — one alarm per object means the object keeps a sorted
  schedule and reschedules itself on every wake (the same sweep, plus a binding,
  a migration and `setAlarm` row writes); alarms are at-least-once and not a
  second-precise timer. Queues — 24 h delay and retention on Free cannot hold a
  weekly reminder, at-least-once still needs the ledger, and it adds a second
  path without removing the first. `@effect/workflow` — its durable clock
  delegates the wake-up, so it buys retry semantics that a D1 batch and a bounded
  inline retry already give, at the cost of a second durable store and engine.
  The sweep+queue hybrid — only pays off beyond ~10 devices per tick and is
  recorded, with DO alarms, as the upgrade path.
- **Settled (owner, #79):** a snooze is **not** held by quiet hours, and a
  snooze chain is **not** capped. A snooze target inside [23:00, 07:00) fires at
  its target; the alternative — a snooze whose tap was made outside the window
  holding to the next 07:00 — was rejected because a "5 more minutes" tap at
  22:59 would silently become an eight-hour delay, and the strict-#13
  alternative (every target inside the window moves to 07:00) because it turns
  "remind me in ten minutes" into "remind me tomorrow". The exemption rests on
  consent: the preset set bounds any single snooze to an hour, and every link in
  a chain requires the owner to be awake and answering at that moment, so the
  chain needs no separate cap. The 07:00 push cap in #67 is the other product
  decision — not adopted here (§10);
  reinstating it is a #13 amendment.
- **Revisit if:** a third household makes the 10-fetch cap measurable, a 07:00
  flush proves too noisy (a cap would then be a #13 product amendment, not a
  delivery detail), or medication ever needs second-level precision.
