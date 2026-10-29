# Final sweep — P0 latency fixes, the whole branch as a system

- **Branch:** `perf/latency-p0` (pushed; PR base `main`)
- **Head:** `a7304ba3e`
- **PR:** https://github.com/roninlp/tali/pull/98
- **Plan:** `docs/plans/latency-fixes/PLAN.md`
- **Prior reviews:** `01-edge-cache.md` … `05-background-work.md` (read first; not repeated here)

## Verdict: ship with follow-ups

No blockers. The five items interact correctly: the cached-session boot, the
session epoch, the `LocalStoreProvider` open/close generation guard, the route
guards, and the push boot gating compose into a sound state machine with no
reachable wrong-user flash, no store left open for the wrong user, and no
redirect loop. The auth epoch fix (`d95304263`) and the cookie/row renewal fix
(`3070c7807`) genuinely close the two races the per-item reviews found. The
remaining findings are two operational should-fix items (feed retention now
depends on the nightly cron; the e2e suite is not run by `pnpm test`) plus
documentation/claims nits.

---

## Findings

### 1. `should-fix` — feed retention now depends entirely on the nightly purge cron

`apps/api/src/sync-service.ts:944-946`, `apps/api/src/trash-purge-runner.ts:33-40`, `apps/api/src/index.ts:178-196`

`GET /sync/pull` no longer calls `repo.prune()`. `change_feed` and
`applied_mutations` are now trimmed only by the 03:17 purge cron, which calls
`sync.prune(cutoff)`. That cron runs with `controller.noRetry()` and its own
`.catch` that only `console.error`s `trash.purge.failed` (`index.ts:178-196`) —
a failure is logged, never alerted, never retried.

Before this PR, every poll self-pruned, so the feed stayed bounded even if the
cron was broken or removed. After this PR the *only* thing bounding feed growth
is a cron that can silently stop firing. Concretely: if the cron fails (or a
future infra edit drops `CRON.purge`), `change_feed` and `applied_mutations`
grow without bound until someone notices the D1 size. `minSeq` still answers
correctly (stale detection is fine), so this is an ops risk, not a correctness
bug — but it is a regression in *self-healing* that the diff removes.

**Ask:** before deploy, confirm the 03:17 purge cron is actually registered and
firing on the deployed stage, and add an alert on `trash.purge.failed` (and
`d1.backup.failed`). A bounded fallback (e.g. prune when a pull observes
`max(seq)` beyond some very large threshold) would restore the safety net, but
is not required for P0.

### 2. `should-fix` — `pnpm test` does not run the Playwright e2e suite, which covers flows this PR changes

Root `package.json` (`"test": "turbo run test"` vs `"test:e2e": "pnpm --filter @tali/e2e test:e2e"`), `packages/e2e/package.json` (no `test` script, only `test:e2e`).

The PR body's CI claim (`pnpm test # 11/11 turbo tasks`) exercises only the
`api`/`web`/`conflict-lab`/`domain` vitest suites. The e2e gate flows are the
only thing that drives real browser boot, guard redirects, and live cursor-wake
sync — exactly what Items 04 and 05 change:

- `01-household.spec.ts` — register → household → `/today` (the optimistic boot + guard + `IndexRoute` redirect path).
- `03-shared-list.spec.ts` — a checked item appears *live* on the other device via the poll (cadence now 10 s active / 30 s idle instead of 3.5 s).

I verified flow 3 is still within its `expect` timeout: `playwright.config.ts:24`
sets `expect: { timeout: 20_000 }`, and device B is "active" (its navigation
pulls set `lastActivity`), so it polls at 10 s, comfortably under 20 s. So the
cadence change should not flake flow 3 — but that is reasoning, not a run. The
gap is that nothing in CI re-runs these flows against the changed code.

**Ask:** run `pnpm test:e2e` against a local stack (`packages/e2e/scripts/stack.mjs`)
before deploy, or state explicitly that it is deferred to a staging deploy.

---

### 3. `nit` — PR-body evidence numbers were copied, not measured

PR body "Evidence" table, against `apps/api/test/today.test.ts:581`, `apps/api/test/calendar.test.ts:1042/1046`.

The PR body claims `GET /today` is "11 statements, 5 serial waves → 11
statements, 1–2 waves". That is wrong on the count: removing the per-read
`UPDATE sessions` (Item 02) drops the auth preamble from 4 to 3 statements, so
`/today` is **10** statements after, not 11 — and the tests literally assert
`statementCalls <= 10` (`today.test.ts:581`, `calendar.test.ts:1042/1046`).

Two related inaccuracies:

- The fan-out (Item 03) changes *waves*, not *statement count*. The "-1
  statement" win belongs to Item 02, not Item 03. `docs/research/deploy-latency/00-synthesis.md:106`
  ("11 → ~4 statements; 22 → ~6 per nav") makes the same error — batching reads
  collapses round trips, it does not reduce the number of SQL statements.
- `GET /sync/pull` "8 statements … → 8 reads, 0 writes" is internally
  inconsistent: the poll lost its two `DELETE`s, so the statement count falls
  (auth 4→3, minus 2 DELETEs), it is not flat at 8.

None of this changes the correctness of the code — the wins are real, they are
just slightly larger (statement count) and slightly narrower (waves) than the
table says. Worth correcting so the deploy-measurement notes don't inherit the
wrong baseline.

Also: `GET /auth/me` "3 reads, 0 writes" is true only when the session is not
within 7 days of expiry; the renewal path (`auth-service.ts:231-235`) still
writes one `extend`. Common case only.

### 4. `nit` — stale "3.5 s" copy was never globally swept

Item 05 updated the cadence constants and the web-side copy it owns, but four
"3.5 s" references outside its owner list remain:

- `apps/api/src/sync-service.ts:946` — "the 3.5 s poll"
- `apps/api/src/trash-purge-runner.ts:14` — "two DELETEs every 3.5 s"
- `apps/api/test/sync.test.ts:737` — "two DELETEs every 3.5 s"
- `packages/e2e/tests/03-shared-list.spec.ts:6` — "The live update is the 3.5 s cursor-wake pull"

All are comments, so no functional impact, but they contradict the 10 s cadence
and will mislead the next reader.

### 5. `nit` — `isolate: false` test hygiene (mostly pre-existing, one new leak)

`apps/web/vite.config.ts:25` (`isolate: false`). The new `push/context.test.tsx`
sets `globalThis.fetch` in `beforeEach` (`:83`) but its `afterEach` only
`Reflect.deleteProperty(navigator, "serviceWorker")` (`:86-88`) — the fetch mock
leaks to later files. It is currently benign: every other fetch-using suite
installs its own mock in `beforeEach`, and only `push/context.tsx` calls
`loadVapidPublicKey`, whose module cache (`push/config.ts:20`) is therefore the
only test that populates it. Latent order-dependence: a future test that loads
the VAPID key before `push/context.test.tsx` would make its "exactly one
`/push/vapid`" assertion flake. Same pattern review 05 already flagged; I confirm
it is real and currently harmless. Recommend restoring `globalThis.fetch` and
resetting `cachedPublicKey` in `afterEach` when this file is next touched.

### 6. `nit` — "up to a minute" stale-badge bound is now up to ~90 s when idle

`apps/web/src/lib/local-store/context.tsx:109-112` (comment) vs `:65`, `:133-134`, `:216-222`.

The 60 s gate is wall-clock, checked in `syncNow`'s `finally`. An idle tab polls
every 30 s, so the first pass *after* the 60 s gate opens can be up to 30 s
later: worst case ~90 s of stale `failed()`. The comment says "up to a minute".
The badge is advisory and this was already slightly understated at the old 15 s
idle cadence (~74 s); the idle change widens it. Comment nit only.

### 7. `nit` — `git diff --check` is not clean (research docs only)

Trailing whitespace in `docs/research/deploy-latency/beam.md` and
`.../iceman.md`. Implementation code is clean; these are the pre-P0 research
notes. Cosmetic, but it means `git diff --check` cannot be used as a gate on
this branch without first trimming the research files.

### 8. `nit` — signed-out `pushsubscriptionchange` is now a deliberate no-op

`apps/web/public/sw.js:213-233` (`resubscribe()` broadcasts `tali:push-subscription-change`
when no VAPID key is cached) → `apps/web/src/lib/push/context.tsx:161-190`
(`refresh()` returns before `shareConfigWithWorker` while signed out).

After Item 05, a `pushsubscriptionchange` while signed out no longer loads the
key or shares it with the worker, so a signed-out device that still holds a
subscription will not autonomously resubscribe after a rotation. This is the
intended trade-off ("no `/push/vapid` while signed out") and self-heals on the
next sign-in (the auth-status effect re-runs `refresh`, which re-reads the
subscription and re-registers it). Consistent with review 05; documenting the
asymmetry only.

---

## What the per-item reviews could not see

Each of the five reviews scoped itself to the files its item owned. Three things
fall out only when the branch is read as a whole:

1. **The state machine composes.** The cached-session seed (`auth.tsx:59-63`),
   the epoch guard (`auth.tsx:70, 102-106`), `LocalStoreProvider`'s generation
   ticket (`context.tsx:232, 239-241` + `closeStore` at `:136-150`), the
   `Guard`/`IndexRoute` redirects, and the push auth-status effect
   (`push/context.tsx:292-297`) all advance on the same events and terminate in
   the same order. I traced sign-out-during-boot, revoked-cookie-during-boot,
   and rapid A→B hand-off: no wrong-user flash, no store left open, no redirect
   loop, exactly one `/auth/me` per boot. This was invisible to any single-item
   review because each touched only part of the chain.

2. **The statement-count vs wave-count confusion spans three artifacts.** The
   PR body, the plan's results, and the research synthesis all conflate the
   Item 02 win (fewer statements) with the Item 03 win (fewer serial waves).
   Individually each review got its item right; only a cross-cut shows the
   "11 → 11, 1–2 waves" row is wrong on the count.

3. **The "3.5 s" string and the e2e coupling.** Item 05's owner list stopped at
   the web cadence files, so the API-side comments, the sync test comment, and
   the e2e spec comment all still say "3.5 s", and the e2e suite that exercises
   the changed boot/sync flows is not in the `pnpm test` gate. A per-item review
   has no reason to grep `packages/e2e` or `apps/api` for cadence copy.

---

## Commands and results

Run from `/home/ronin/Projects/tali` on `a7304ba3e` (no deploy, no push).

### `pnpm test`

```
@tali/web:test:  Test Files  38 passed (38)
@tali/web:test:       Tests  276 passed (276)
 Tasks:    11 successful, 11 total
 Cached:    11 cached, 11 total
  Time:    15ms >>> FULL TURBO
```

FULL TURBO — cached, so I forced the two changed suites fresh (below).

### `pnpm --filter @tali/api test` (fresh, uncached)

```
 RUN  v5.0.4 /home/ronin/Projects/tali/apps/api
 Test Files  38 passed (38)
      Tests  387 passed (387)
   Start at  17:40:10
   Duration  5.64s
    Isolate  38 workers spawned
```

### `pnpm --filter @tali/web test` (fresh, uncached)

```
 RUN  v5.0.4 /home/ronin/Projects/tali/apps/web
 Test Files  38 passed (38)
      Tests  276 passed (276)
   Start at  17:40:09
   Duration  4.61s
```

Both suites pass fresh (not a cache-only pass).

### `pnpm typecheck`

```
 Tasks:    10 successful, 10 total
 Cached:    10 cached, 10 total
  Time:    10ms >>> FULL TURBO
```

Forced fresh for the changed packages:

```
$ pnpm --filter @tali/api exec tsc --noEmit   # EXIT 0
$ pnpm --filter @tali/web exec tsc --noEmit   # EXIT 0
$ pnpm --filter @tali/infra exec tsc --noEmit # EXIT 0
```

### `pnpm build`

```
 Tasks:    7 successful, 7 total
 Cached:    7 cached, 7 total
```

Forced fresh web build:

```
dist/client/assets/virtual_solid-ssr-entry-client-Ej5OYw2G.js    45.93 kB │ gzip: 15.89 kB
dist/client/assets/routing-Ds49OlHR.js                          256.02 kB │ gzip: 86.03 kB
✓ built in 474ms  /  ✓ built in 21ms
```

Entry chunk ≈ 15.89 kB gzip — consistent with review 04's +1.5 kB gzip over base.

### `pnpm --filter @tali/web lint` (oxlint; no root `lint` script exists)

```
$ oxlint src
… (warnings only: unused-vars, solid(reactivity) notes in pre-existing files)
```

Exits 0. The warnings are pre-existing; none are introduced by this PR's lines
(the one in `sync-runner.test.tsx` is in an async tracked scope that predates
the comment-only change).

### `git diff --check main..a7304ba3e`

Trailing whitespace reported, but only in `docs/research/deploy-latency/{beam,iceman}.md`.
Implementation and test files are clean.

---

## Verified correct (checked, not assumed)

- **`headers` prop is actually emitted, not just typechecked.** Alchemy's
  `AssetsConfig.headers` ("Raw contents of a `_headers` file") is folded into
  `metadata.assets.config` via `mergeAssetsConfigFiles` (`alchemy/lib/Cloudflare/Workers/Assets.ts`
  `readAssets`), and the wire schema `PutScriptAssetsConfig` has `headers?: string`
  (camelCase, no underscore) in `@distilled.cloud/cloudflare` `workers.d.ts:4124`.
  So `/assets/* Cache-Control: … immutable` reaches Cloudflare's asset layer.
- **Secure cookie survives the web-worker proxy.** `apps/web/worker.ts:33-37`
  rebuilds the request from `new URL(request.url)` (scheme `https:` preserved),
  so the API worker's `secure: request.url.startsWith("https://")`
  (`auth-routes.ts:84`) is true in production.
- **Cookie/row renewal is in step.** Mutation routes use
  `authenticateWithRenewal` → `meWithRenewal` (`resolveSession(true)`) and only
  re-stamp when `renewed` (`auth-routes.ts:172, 220, 240, 262`), so the row and
  cookie move together; malformed `expires_at` fails closed
  (`auth-service.ts:227` `!Number.isFinite`).
- **Backup remains a valid restore point.** Purge (03:17) → backup (03:47)
  means the dump captures the post-prune DB; clients with cursors inside the
  90-day window continue incrementally, older cursors re-bootstrap
  (`resetRequired`, `sync-service.ts:955-966`). This matches pre-PR behavior;
  the move to nightly only *widens* the retention window during the day.
- **Parallel reads stay under the subrequest limit.** Peak concurrent D1 is 5
  (`/today`: buckets' 4 + pinned notes' 1; `today-service.ts:54-74`), 4
  (`/month`, 5 lanes capped), 3 (`/week`). Auth/session lookups complete before
  the fan-out and never overlap it. `Effect.orDie` on the whole `get()`
  (`today-service.ts:101`) preserves the `never` error channel; fail-fast on a
  defect interrupts read-only SELECTs only, which is unobservable.

---

## Rollback and ops

- **Each commit reverts independently.** 01 (infra only), 02 (+ fix `3070c7807`),
  03 (+ nit `8c887fdb1`), 04 (+ fix `d95304263`), 05 (+ nit `e6676b377`) each
  confine their edits to disjoint file sets. The two fix commits are interleaved
  with their parent item's files, so reverting an item reverts its fix too —
  which is the correct unit.
- **Reverting the infra commit alone is safe.** Removing `placement` and the
  `headers` rule touches no runtime code; nothing depends on either. The only
  loss is the (unmeasured) placement and asset-caching win.
- **What breaks if only 03 is reverted but 02 stays:** nothing — pull() would
  resume pruning on every poll (old, correct behavior), and the purge runner
  reverts to trash-only. The one *non*-revertable coupling is operational (see
  finding 1): as long as 03 is deployed, the feed's boundedness lives entirely
  in the purge cron.
- **Missing verification step:** there is no committed curl script and no
  `Server-Timing`/`cf-placement` probe. The plan's "remaining proof" paragraph
  (`PLAN.md:323-326`) lists the post-deploy measurements but nothing encodes
  them as a runnable check. Follow-up: a `scripts/measure-latency.mjs` that
  curls `/health`, `/auth/me`, `/today`, `/week` cold+warm and asserts the
  `cf-placement` header is `remote-*` would make the P0's definition-of-done
  repeatable.
- **The "not yet deployed" caveat is visible enough.** It appears in both the
  PR body ("Not yet deployed…") and `PLAN.md:3` ("awaiting a deploy
  measurement"). The risk is the evidence table's numbers (finding 3) being
  read as measured; correct them alongside the deploy measurement.

---

## Prioritized follow-ups

Before deploy:

1. Confirm the 03:17 purge cron fires on the deployed stage and add an alert on
   `trash.purge.failed` / `d1.backup.failed` (finding 1).
2. Run `pnpm test:e2e` against a local stack, or explicitly defer it to staging
   (finding 2).

After deploy (no rush):

3. Correct the PR-body / plan evidence numbers (finding 3).
4. Sweep the four stale "3.5 s" references (finding 4).
5. Restore `globalThis.fetch` + reset the VAPID cache in `push/context.test.tsx`
   `afterEach` (finding 5).
6. Tighten the "up to a minute" comment to "up to ~90 s idle" (finding 6).
7. Trim trailing whitespace in the research docs so `git diff --check` is usable
   as a gate (finding 7).
8. Commit a `scripts/measure-latency.mjs` probe for the definition-of-done
   (rollback/ops).
