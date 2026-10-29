# Review — Item 05: Background work (scans, poll cadence, push boot)

- **Verdict:** approve with nits
- **Base:** `d95304263` — **Head:** `b33f06d25` (`perf(web): stop per-pass mirror scans and slow the idle poll`)
- **Reviewer:** independent review thread

## Scope

8 files, all client-web, no dependency/API/router/screen/service-worker changes:

```
apps/web/src/components/sync-runner.test.tsx   (comment)
apps/web/src/lib/lists/model.ts                (comment)
apps/web/src/lib/local-store/context.test.tsx  (+1 test)
apps/web/src/lib/local-store/context.tsx
apps/web/src/lib/push/context.test.tsx         (new, +2 tests)
apps/web/src/lib/push/context.tsx
apps/web/src/lib/sync-cadence.test.ts          (+1 test, comment updates)
apps/web/src/lib/sync-cadence.ts
```

`apps/web/src/lib/lists/model.ts` is outside the Item 05 owner list, but Step 2 of the
brief explicitly says to update "any copy that mentions 3.5 s", and the changed comment
("every sync ack (3.5s)" → "every sync ack (each poll)") is the only such copy outside the
owned files. Comment-only, justified.

## Verification (run by reviewer)

```
$ pnpm --filter @tali/web test
 RUN  v5.0.4 .../apps/web
 Test Files  38 passed (38)
      Tests  276 passed (276)

$ pnpm typecheck
 Tasks:    10 successful, 10 total
 Cached:    10 cached, 10 total   (FULL TURBO)

# forced fresh web typecheck (bypasses turbo):
$ (cd apps/web && pnpm exec tsc --noEmit)   # exit 0

$ pnpm --filter @tali/web build
 ✓ built in 415ms  (client)  /  ✓ built in 17ms  (ssr)
```

All three green.

## Findings

### Correctness of the failure-count signal (Item 1)

The `failed()` signal is `syncError`-marker count. Every way it changes, and whether the
"outbox shrank" heuristic catches it promptly:

- **Mark (push rejected):** `sync-engine.ts:436-441` acks `response.results.map(r =>
  r.clientMutationId)`, i.e. the rejected id leaves the outbox *and* `ack(..., failures)`
  sets `syncError`. Outbox shrinks → `context.tsx:216-221` refreshes. Caught. ✓
- **Resolve via ack (`resolved`):** every non-rejected result's id is also acked, so the
  outbox shrinks and the count refreshes. Caught. ✓
- **Resolve via pull (`mergeServer`):** the authoritative row replaces the marker without
  touching the outbox. **Not** caught by the shrink heuristic; the badge stays stale until
  the 60 s gate. This is exactly the trade-off documented at `context.tsx:109-112`
  ("a marker resolved by a pull while the outbox is empty can leave `failed()` stale for up
  to a minute"). A pull only replaces a row when that entity has no pending entry
  (`store.ts:365-368`), and a failed entry is already acked, so this path is realistic.
  Bounded by the gate (≤ ~60 s + one poll), and the badge is advisory. Acceptable. ✓
- **Retry (`retryFailed`):** clears the marker *and* appends a fresh outbox entry
  (`store.ts:443-454`), so the outbox grows. The next push (woken immediately by the
  `pending > 0` effect in `sync-runner.tsx:63-73`) acks it and shrinks → refresh. The
  badge corrects within one pass. ✓
- **Logout/store close:** `closeStore` resets `failedRefreshedAt = 0` and `setFailed(0)`
  (`context.tsx:140-145`), and open reseeds both counts (`context.tsx:257`). ✓

**nit** — concurrent-write masking. `queuedBefore` is read *before* the handler
(`context.tsx:188`); a local write that lands *during* the pass appends a new outbox entry,
which can net the shrink to zero and delay the badge refresh by one trailing pass. Not a
correctness bug: the trailing pass that the write wakes re-shrinks and refreshes, and I
could not construct a case where the badge stays wrong past one extra pass. But the doc
comment's "a rejected write still appears as soon as its push result lands"
(`context.tsx:111-112`) is slightly overclaimed in this one race. Nit only.

**nit** — `failedRefreshedAt = Date.now()` is set *before* the read
(`context.tsx:118`). This is intentional and safe: a throw inside `failedCount()` (store
closed mid-read) still advances the throttle so the next 60 s of passes don't retry a
failing scan, and the catch swallows the error. Good; noting only because the brief asked.

**nit** — `context.tsx:188` `current.pendingCount().catch(() => pending())`. Here `pending`
is the *signal* (`createSignal` getter, `context.tsx:73`), not the store's `pending()`
method, so the fallback reads the last-known in-memory count, not the array. The name
shadowing makes this easy to misread (I initially read it as the store method, which would
have been `number | ReadonlyArray<OutboxRecord>`). Type-checks clean and the fallback is
semantically fine, but a rename or a comment would remove the ambiguity.

### Cadence (Item 2)

`ACTIVE_INTERVAL_MS 10_000`, `IDLE_INTERVAL_MS 30_000`, `HIDDEN_INTERVAL_MS 30_000`
(`sync-cadence.ts:25-27`). Wake-on-write is unchanged: `sync-runner.tsx:63-73` still
`wake()`s on `pending > 0`, so a local edit is immediate. Worst-case *perceived* remote-edit
latency is ~30 s (idle visible tab); a hidden tab wakes on `visibilitychange`
(`sync-cadence.ts:156-163`), so returning tabs pay nothing.

**nit** — `sync-cadence.ts:9-10` "the poll only pays for *remote* edits, where 10s is
imperceptible next to typing." 10 s for a second device's edit is genuinely perceptible;
"imperceptible" overclaims. The substance (own edits instant, remote edits bounded) is
correct.

### Push boot (Item 3)

Traced: boot effect now calls `ensureRegistration()` + `refreshLastAction()`
(`push/context.tsx:271-272`) — registers the SW, no VAPID. `refresh()` gates
`loadVapidPublicKey` + `shareConfigWithWorker` + `syncRegistration` behind
`auth.status() !== "signedIn"` (`push/context.tsx:178`). The auth effect
(`push/context.tsx:292-297`) is the only boot-time `refresh()`, and Solid's `createEffect`
runs the effect on the initial value (verified against `@solidjs/signals@2.0.0-rc.15`
`effect()` → `recompute(node, true)` + unconditional first run), so a cached-session boot
fires exactly one refresh, and a fresh boot fires one when `/auth/me` lands. `ensureRegistration`
caches the promise and forgets a failed attempt so a user gesture can retry
(`push/context.tsx:132-138`); the permission panel's `enable()` re-loads the key itself if
`configured()` is false (`push/context.tsx:198-204`), and `loadVapidPublicKey` only caches
on success (`push/config.ts:23-36`), so failure resets cleanly. Signed-out mounts make zero
`/push/vapid` requests even via the `pushsubscriptionchange` message path, because `refresh()`
returns before loading the key when signed out. No stale/empty-key path found.

**nit** — the `loadVapidPublicKey` module-level cache (`push/config.ts:20`) is shared across
test files under `isolate: false` and is not reset. Currently safe (only `context.test.tsx`
exercises it, and its signed-out test runs first), but a future test that loads the key
before it would make the "exactly one" assertion flake. Pre-existing module design, not
introduced here.

### Tests (Item 4)

All three new/changed tests are real regressions, not "no throw" assertions:

- `sync-cadence.test.ts:26-33` pins the exact table (`10_000/30_000/30_000`) — fails on the
  old `3_500/15_000`.
- `context.test.tsx:242-309` asserts `failedCount` is **not** called across two no-op passes,
  then once past the minute gate, then again on a drained pass — fails on the old
  every-pass `refreshCountsOf`.
- `push/context.test.tsx` counts requests precisely (`vapidRequests()` filters by the
  `/push/vapid` suffix) and asserts exactly 0 signed-out / exactly 1 after sign-in, with a
  `setTimeout(0)` settle to catch a duplicate. Fails on the old unconditional boot `refresh()`.

No fake-timer/act issues: the push test uses real timers + `waitFor`; `@solidjs/testing-library`
has no React act warnings.

**nit** — `push/context.test.tsx` stubs `globalThis.fetch` in `beforeEach` but only
deletes `navigator.serviceWorker` in `afterEach`; the fetch mock leaks to later files under
`isolate: false`. Consistent with the repo's existing convention (other suites do the same),
so nit only.

### Style/scope (Item 5)

`model.ts:124-126` — the rewritten comment is grammatical, but the wrap leaves a dangling
"and" alone on a line: "…every sync ack (each poll),\n * and\n * `<For>` keys…". Cosmetic;
also "each poll" is slightly imprecise (acks also happen on wake/reconnect/retry, not only a
poll). No new dependency, no router/API/screen/SW changes.

## Not verified

- End-to-end request counts in a real browser (the push assertions are against a stubbed
  `navigator.serviceWorker` + `fetch`, not the live SW or a running API).
- Real-world wall-clock latency deltas (the brief's perf gain is reasoned from the cadence
  constants and the removed per-pass `getAll()`, not measured on device).
- "Fails on old code" was confirmed by inspection of the assertions (they reference the new
  constants/behavior directly); I did not re-run the suite against `d95304263` in a throwaway
  worktree.
