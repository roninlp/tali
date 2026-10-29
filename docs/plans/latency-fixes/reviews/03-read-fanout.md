# Review — P0-03 Read-model fan-out + prune off the poll

- **Base:** `3070c7807`
- **Head:** `b8e8c15a1` (`perf(api): parallelise read models and prune the feed nightly`)
- **Verdict:** approve with nits

No blockers, no `should-fix`. The fan-out is genuinely safe, the prune move
preserves the sync semantics, and the new tests fail on the old code. Four nits
below are documentation/coverage/observability sharp edges, none of which change
runtime behavior or put a limit at risk.

---

## 1. Independence — confirmed

Every fanned-out lane reads only `scope` (household + user) and bounds computed
*before* the `Effect.all`; no lane's result feeds another's inputs.

- `task-service.buckets()` (`task-service.ts:1175-1198`): five reads —
  `listDueDateRange` (overdue/upcoming dates), `listDueInstantRange`
  (overdue/upcoming instants), `listNoDue` — each depends only on
  `taskBucketBounds(timeZone, now)` and `scope`. No ordering or cross-feed.
- `today-service.get()` (`today-service.ts:58-74`): `buckets()` and
  `noteService.listPinned()` are disjoint reads (task repo vs note repo).
- `calendar-service.week()` (`calendar-service.ts:187-194`): `loadRangeTasks`,
  `loadRangeEvents`, `loadOccasions` are three independent lanes.
- `calendar-service.month()` (`calendar-service.ts:229-243`): the drill range is
  computed as `singleDayRange(day)` **before** the fan-out (line 221-224) and is
  null (a no-op `Effect.succeed([])`) when `day` is inside the grid, so the drill
  lanes never read the grid bounds. `[...rows, ...drillRows]` at line 245 is the
  identical concatenation the old code performed — no new de-dup/sort interaction.

No effect only *looks* independent. `loadRangeTasks`/`loadRangeEvents` internally
run their own sub-queries sequentially (see §2), but those are private to each
lane and don't cross lanes.

## 2. Concurrency safety — confirmed (one comment nit)

`Effect.all(array, { concurrency: 4 })` **does** honor the cap: an array is an
`Iterable`, so `Effect.all` routes through `forEach` → `forEachConcurrent`, which
hard-caps in-flight fibers (`repos/effect/.../internal/effect.ts:5167`:
`if (fibers!.size < concurrency) continue; paused = true`). It caps, it does not
suggest. `resolveConcurrency(4) = 4`. Result order is preserved (results are
written to `out[i]`).

Worst-case concurrent D1 calls, per request (Workers allows ~6 simultaneous
outgoing subrequests):

| Endpoint | Lanes | Peak concurrent D1 |
| --- | --- | --- |
| `/week` | tasks(3 seq) + events(2 seq) + occasions(1) | **3** |
| `/month` | 5 lanes @ concurrency 4, each ≤1 in-flight | **4** |
| `/today` | buckets (5 @ concurrency 4) + notes (1) | **5** |

None exceeds 6. `loadRangeTasks` (3 sub-queries) and `loadRangeEvents`
(2 sub-queries) do **not** fan out internally — they run `yield*` sequentially
inside each lane — so they contribute one in-flight query each at any instant.
Auth/session lookups complete before the fan-out and never overlap it.

- **nit** — `today-service.ts:54-57` (and the matching `task-service.ts:1170-1174`
  comment) says "concurrency 4 leaves headroom", but the `/today` peak is **5**:
  `buckets()`'s own `concurrency: 4` (4 in-flight) runs concurrently with the
  `listPinned` lane (1 in-flight) because the outer `Effect.all` holds two
  effects, not four. Still inside the ~6-connection limit, so no action is
  required beyond making the comment honest.

## 3. Semantics — confirmed

The old code ran the reads sequentially with `Effect.orDie` applied per query;
the new code applies `.pipe(Effect.orDie)` to the whole `Effect.all`
(`task-service.ts:1198`, `today-service.ts:101`, `calendar-service.ts:203/254`).
Every underlying error is a repo `SqlError`, converted to a defect either way, so
the declared error channel is unchanged (`never` on the service boundary) and
there is **no recoverable error path** where partial work becomes observable.

The only difference is *which* read-only SELECTs have executed when a defect is
raised: the old code stopped at the first failure; the new code may start up to 4
lanes and interrupt the siblings on the first failure (fail-fast + interrupt, per
`Effect.all` docs). SELECTs have no side effects, so this is unobservable to the
caller. Result order, the `seen` de-dup set and the `compareTasks` sorts
(`task-service.ts:1207-1224`) are all unchanged.

## 4. Prune move — confirmed (one observability nit)

- **`pull()` now does zero writes.** `pull()` (`sync-service.ts:941-1022`) runs
  only `repo.minSeq`, `repo.pullFeed`, `repo.findEntities` (all reads) and builds
  the response in memory. The removed `repo.prune(cutoff)` was its only write.
- **Stale-cursor detection stays correct.** `minSeq` (`sync-repo.ts:302-308`) is
  `MIN(seq)` over `change_feed`; `resetRequired` is still
  `cursor < min - 1` (or `min` is `None` and `cursor > 0`). Deferring prune from
  every pull to nightly makes `minSeq` *lower* during the day (fewer rows
  removed), so stale detection is strictly **more conservative** — a cursor that
  would have been flagged stale can instead incrementally catch up on rows that
  are still present. No gap can be introduced by pruning *less* often.
- **"Keep newest feed row" guard unchanged.** `sync.prune`
  (`sync-repo.ts:318-329`) still runs `... AND seq < (SELECT MAX(seq) FROM
  change_feed)` and the `applied_mutations` DELETE with the same 90-day cutoff.
  The guard's edge case (newest row older than the window) is covered by the
  existing `sync.test.ts:676` test, which this change correctly drives through
  the explicit `pruneFeed(h)` helper.
- **Return value / logging shape unchanged.** `runTrashPurge`
  (`trash-purge-runner.ts:28-45`) still returns the `TrashPurgeResult` from
  `purge.purge(now)`; `index.ts:181-183` logs `{ event: "trash.purge", ...result }`
  exactly as before.
- **Statement limit — no real risk.** `sync.prune` is two `yield* sql` DELETEs,
  each one D1 query, run **after** `purge.purge` and outside its
  `PURGE_MAX_STATEMENTS_PER_TICK = 48` budget (`trash-purge-repo.ts:46`). The
  actual D1 ceiling is *queries per invocation* (50 Free / 1000 Paid), and a
  `db.batch()` counts as **one** query; the purge tick issues ~a dozen queries
  (one SELECT per aggregate + one batch per chunk), so the two extra queries are
  nowhere near the limit.
- **Purge runner still needs only D1.** `purgeLayer`
  (`trash-purge-runner.ts:22-25`) provides `TrashPurgeRepoLive` + `SyncRepoLive`
  over `D1Client.layer({ db })`; neither repo reads a session or makes HTTP calls.

- **nit** — the two `sync.prune` statements are not counted in the returned
  `result.statements` (logged as `trash.purge`), so the tick's logged statement
  count under-reports by 2, and the "stops before D1's per-invocation query
  ceiling" framing (`trash-purge-repo.ts:45-46`) is now slightly imprecise since
  the prune runs unconditionally after the budget is exhausted. No functional
  risk (see above); if `statements` feeds any alerting, fold the 2 in or note the
  exclusion in a comment.

## 5. Tests — confirmed

- **Pull test fails on old code.** `sync.test.ts` "does not prune the feed on a
  pull" seeds an `updated_at` 100 days ago (outside the 90-day window) with `seq`
  below the fresh push's `MAX(seq)`, exactly the row the old `repo.prune` deleted.
  The old pull would prune it → `feedCount`/`appliedCount` drop and
  `resetRequired` flips to `true`; the test asserts `false` + both counts
  unchanged, so it fails on the old code.
- **Purge test fails on old code.** `maintenance-cron.test.ts:127-154` runs the
  purge cron against a feed with an aged row + a newer row; the old runner never
  called `sync.prune`, so the aged row would survive and `expect(...).toBe(0)`
  fails.
- **Statement-count assertions are deterministic, not timing-based.**
  `FakeD1.statementCalls` is incremented synchronously in `prepare()`'s
  `onExecute` callback (`fake-d1.ts:103-110`), so the count is exact regardless of
  fan-out scheduling. The modified stale-cursor tests correctly add
  `await pruneFeed(h)` to set up the aged state that a pull no longer creates.
- **nit** — the calendar/today "D1 budget" guards assert `<= 10` (week/month) and
  `<= 15` (drill) against a real baseline around 7–9, so a +1/+2 statement
  regression slips through; they only catch gross N+1. Not flaky, just loose.

## 6. Scope / style — confirmed

Only the five owned source files and the four test files changed; no SQL,
migration, schema, index, or dependency changes. `FEED_RETENTION_MS` is exported
from `sync-service.ts` and imported by `trash-purge-runner.ts` (no import cycle —
`sync-service.ts` does not import the runner). Comments are accurate except the
two "concurrency 4" headroom notes in §2 and the budget framing in §4, both nits.

---

## Commands and results

```
$ pnpm --filter @tali/api test
 Test Files  38 passed (38)
      Tests  387 passed (387)
   Duration  3.56s
```

```
$ pnpm typecheck
 Tasks:    10 successful, 10 total
 Cached:    10 cached, 10 total
```

```
$ (cd apps/api && pnpm exec tsc --noEmit)
 EXIT: 0
```

```
$ git diff --check 3070c7807..b8e8c15a1
 EXIT: 0   (no output)
```

## Could not be verified

- **Before/after wall-time numbers.** The plan's acceptance asks for a measured
  drop; the local test harness records no latency, and I did not start a dev
  server or run a benchmark. Concurrency reduction (5→1 round-trip for buckets,
  3→1 for week, 5→1 for month) follows from the fan-out but was not timed.
- **Production D1/Workers limits.** The ~6 concurrent subrequests per request and
  the 50/1000 queries-per-invocation ceiling are taken from Cloudflare docs, not
  exercised against `workerd` here. The statement-budget reasoning in §4 rests on
  `db.batch()` counting as a single query, per the D1 limits documentation.
