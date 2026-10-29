# Latency P0 — plan, implementation and review protocol

Status: active
Base: `6bda4f209` (main, 2026-10-29)
Branch: `perf/latency-p0`
Scope: in-place fixes to the current Cloudflare + D1 + Solid stack. **No**
re-platform, **no** schema rewrite, **no** deploy, **no** push.

Context and evidence: `docs/research/deploy-latency/00-synthesis.md`.
Measured baseline on this checkout: `/today` = 11 D1 statements, `/week` and
`/month` = 11 each (calendar fetches both), `/sync/pull` = 8 (including a prune
write), `/auth/me` = 4 (including a session write), ~35 statements before the
first live screen, plus a 3.5 s poll and no immutable asset caching.

Definition of done for the whole P0: after all five items and a deploy, from the
target city:

- `/today` p50 < 150 ms warm, < 350 ms cold.
- in-app navigation < 150 ms warm, no full-screen splash.
- boot-to-interactive < 800 ms on a mid-range phone.
- zero DB writes on a read-only poll.
- `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.

If measurement still misses after P0, the next lever is DO-SQLite per household
(not Convex) — see the synthesis, §4.

---

## Workflow

Each item is implemented in **one new top-level thread**, then reviewed
**thoroughly in another new top-level thread**. Items run **in order**, in the
shared checkout, on `perf/latency-p0`. No worktrees, no parallel edits.

Implementation thread:

1. Read this file and the item brief.
2. Change only the files the item owns (plus tests it must update).
3. Run the item's verification commands.
4. Commit with the item's commit message. Do not push, do not deploy.
5. Reply with: commit SHA, files changed, commands run + results, and anything
   the reviewer should know.

Review thread:

1. `git diff <base>..<head>` and read the changed files in context.
2. Check: correctness, regressions, security (auth/session/cookie), performance
   goal, test quality, style, and scope creep.
3. Run the relevant tests and typecheck yourself; paste the real output.
4. Write `docs/plans/latency-fixes/reviews/NN-<slug>.md` with severity-tagged
   findings (`blocker` / `should-fix` / `nit`), file:line evidence, and a
   verdict: **approve**, **approve with nits**, or **changes requested**.
5. Do **not** modify code.

Small review findings are fixed by the orchestrator before the next item;
blockers get a rework thread.

---

## Item 01 — Edge placement + asset caching

Owner files: `infra/alchemy.run.ts` only.

Steps:

1. Add `placement: { mode: "smart" }` to the `Cloudflare.Worker("TaliApi", …)`
   props. This moves the API isolate near the D1 primary, so each of the ~11
   sequential statements stops paying a cross-region RTT. Confirm the Alchemy
   type accepts it (`WorkerPlacement`).
2. Add immutable caching for hashed assets through the `StaticSite` assets
   config (`AssetsConfig.headers`, raw `_headers` content):
   ```
   /assets/*
     Cache-Control: public, max-age=31536000, immutable
   ```
   Do not cache `index.html`; the default SPA handling stays.
3. Do not change the `/api` proxy, the build, or any Worker code.

Acceptance:

- `pnpm typecheck` passes.
- `alchemy plan` is not required; a static check that the props are present is.
- No runtime code change.

Commit: `perf(infra): place api near d1 and cache hashed assets`

Verify: `pnpm typecheck`.

---

## Item 02 — Auth hot path: stop writing on every read

Owner files: `apps/api/src/auth-service.ts`, `apps/api/test/*auth*`,
`apps/api/test/boundary/auth.boundary.test.ts`.
May touch `packages/sql/src/session-repo.ts` only if a repo helper is needed.

Problem: `me()` runs `sessions.extend(...)` on **every** authenticated request
(`auth-service.ts:218-220`), i.e. a D1 write on every read model, every poll,
and every RPC call. D1 writes are the expensive, serialized path.

Important: the browser cookie is set with `maxAge: "30 days"` only at
login/register/household (`auth-routes.ts:74-85`), while the DB row is slid on
every request. A DB-only extension therefore **cannot** keep the browser signed
in past the cookie's 30 days — the write buys nothing today.

Steps (pick one, prefer A):

- **A. Read-only session (preferred for P0).** Remove the `extend` write from
  `me()`; the session lifetime becomes fixed at login and matches the cookie.
  Update the doc comment ("renewing… so an active household never has to
  re-login") because it is not true while the cookie is fixed. Keep expired /
  unknown-token behavior (delete + `Unauthorized`) unchanged.
- **B. True sliding.** Extend only when the remaining lifetime is below a named
  threshold (e.g. 7 days), **and** re-set the session cookie in the `/auth/me`
  response in the same request. Extending the DB row without re-setting the
  cookie is rejected.

Whichever option: do not change the TTL, cookie attributes, token hashing, or
the `SessionContext` shape. Add a test proving two consecutive `/auth/me` calls
on a fresh session leave `expires_at` unchanged / perform no session write. If
B, add a near-expiry test that asserts both the DB row and the `Set-Cookie`
header move.

Acceptance:

- Two consecutive `/auth/me` calls: no session write, same `expires_at`.
- Expired/unknown token behavior unchanged (delete + `Unauthorized`).
- `pnpm --filter @tali/api test`, `pnpm typecheck`.

Commit: `perf(api): renew the session only when it is close to expiry`

Verify: `pnpm --filter @tali/api test && pnpm typecheck`.

---

## Item 03 — Read-model fan-out + prune off the poll

Owner files: `apps/api/src/task-service.ts`, `apps/api/src/today-service.ts`,
`apps/api/src/calendar-service.ts`, `apps/api/src/sync-service.ts`,
`apps/api/src/trash-purge-runner.ts` (or the nightly purge entry),
`apps/api/src/index.ts` (cron wiring only if needed), plus tests.

Problem: independent reads run one after another (5 task queries per bucket
read, 4 task + 2 event + 1 occasion queries per calendar read), and
`GET /sync/pull` runs `repo.prune()` — two DELETEs — on every 3.5 s poll
(`sync-service.ts:944`).

Steps:

1. Run independent reads concurrently with `Effect.all(..., { concurrency: 4 })`
   in:
   - `task-service.buckets()` (the five list queries),
   - `calendar-service` week/month loaders (tasks, events, occasions),
   - `today-service.get()` (task buckets and pinned notes).
   Preserve error mapping (`Effect.orDie` where it already is) and result order.
   These reads are independent; do not merge or change SQL semantics.
2. Move feed pruning out of `pull()` into the nightly maintenance path (the
   purge runner), using the same cutoff (`FEED_RETENTION_MS`). The pull must do
   no writes. Keep the stale-cursor detection semantics unchanged.
3. Add/adjust tests:
   - pull performs no DELETE / no prune,
   - nightly purge prunes the feed,
   - a statement-count or query-count regression test for `buckets()` if the
     harness makes it cheap.
4. Do not add new SQL, indexes, or change the sync protocol.

Acceptance:

- `/today`, `/week`, `/month` statement count does not increase; wall time for
  the local harness drops (record before/after numbers).
- `GET /sync/pull` no longer writes.
- `pnpm --filter @tali/api test`, `pnpm typecheck`.

Commit: `perf(api): parallelise read models and prune the feed nightly`

Verify: `pnpm --filter @tali/api test && pnpm typecheck`.

---

## Item 04 — Boot and navigation UX

Owner files: `apps/web/src/lib/auth.tsx`,
`apps/web/src/components/guard.tsx`, `apps/web/src/App.tsx`,
`apps/web/src/components/app-header.tsx`, router/dev-entry files if required,
plus tests.

Problem: the shell blocks on `/auth/me` behind a full-screen `Splash`, the
cached session is only used on failure, route chunks are lazy, and navigation
does not prefetch.

Steps:

1. Optimistic boot: when `readCachedSession()` returns a session, start
   `signedIn` with it and reconcile `/auth/me` in the background. On
   `Unauthorized`, clear and go to login exactly as today. Keep `bootFailure`
   for a failed reconcile while the cache keeps the shell usable.
2. Guard: a cached session must render the route immediately; do not show the
   boot splash while `/auth/me` is in flight.
3. Replace the full-screen `Splash` fallback used by the router's `Loading`
   boundary with a lightweight route skeleton (no branding, no layout shift).
   Keep the one-time boot splash only if it is genuinely needed.
4. Prefetch route chunks on intent: pointerenter/focus on the main nav items (or
   an idle prefetch of the top routes) using the router's supported preload
   API; do not eagerly import all routes into the entry chunk.
5. Tests: cached session + failed `/auth/me` renders the app and marks
   `bootFailure`; `Unauthorized` clears; guard does not block with a cache;
   no duplicate `/auth/me`.

Acceptance:

- Cold boot with a cache paints the shell before the network settles.
- No full-screen splash on in-app navigation.
- Entry payload does not grow materially.
- `pnpm --filter @tali/web test`, `pnpm typecheck`, `pnpm --filter @tali/web build`.

Commit: `perf(web): boot from the cached session and remove the navigation splash`

Verify: `pnpm --filter @tali/web test && pnpm typecheck && pnpm --filter @tali/web build`.

---

## Item 05 — Background work: scans, poll cadence, push boot

Owner files: `apps/web/src/lib/local-store/context.tsx`,
`apps/web/src/lib/local-store/store.ts` (only if needed),
`apps/web/src/lib/sync-cadence.ts`,
`apps/web/src/components/sync-runner.tsx`,
`apps/web/src/lib/push/context.tsx`, plus tests.

Problem: after every sync pass the client runs `failedCount()` over the whole
mirror (`failedCount` = `getAll()`), the active poll is 3.5 s, and
`PushProvider` fetches `/push/vapid` on boot even when signed out (and again
after sign-in).

Steps:

1. Stop the full-mirror failure scan on every pass. Cheapest correct option:
   refresh the failure count on store open, on an explicit retry, and at a
   bounded interval (≥ 60 s) — not in `syncNow`'s `finally`. Keep the `failed`
   signal accurate enough for the status UI; document the trade-off in a
   comment. A `failures` object store is acceptable only if it is small and
   tested.
2. Cadence: `ACTIVE_INTERVAL_MS` 3.5 s → 10 s (keep `wake()` on local writes),
   idle 15 s → 30 s. Update `sync-cadence.test.ts` and any copy that mentions
   "3.5 s".
3. Push: do not fetch `/push/vapid` while signed out. Register the service
   worker once per boot if needed for installability, but only load the VAPID
   key / reconcile the subscription when signed in (or when the user opens
   settings/reminders). Deduplicate the boot + sign-in `refresh()` calls.
4. Tests: cadence table, no push fetch when signed out, one fetch after
   sign-in, failure count not refreshed on every pass.

Acceptance:

- Cold boot with no session makes no `/push/vapid` request.
- An idle open tab polls at ≥ 10 s.
- No full-mirror scan every pass.
- `pnpm --filter @tali/web test`, `pnpm typecheck`.

Commit: `perf(web): stop per-pass mirror scans and slow the idle poll`

Verify: `pnpm --filter @tali/web test && pnpm typecheck`.

---

## Deferred (documented, not in this round)

- **Read-model IndexedDB cache** for `/today`, `/week`, `/month` (instant
  repeat navigation, background revalidation). Bigger UX change; needs a cache
  keyed by URL + ETag and a stale-while-revalidate policy.
- **Collapse the `/api` proxy hop** (single Worker with an assets binding, or
  route `/api/*` directly on a custom domain). Deploy-only, no local gain, and
  it touches cookie/CORS assumptions.
- **D1 read replication** via the Sessions API. Worth measuring after 01 and 03.
- **DO-SQLite per household** if P0 still misses the target.

---

## Review checklist (every item)

- Scope: only the owned files, no drive-by refactors.
- Correctness: behavior preserved, error paths intact.
- Auth/security: no token/cookie weakening, no cross-user data exposure.
- Performance: the item's cost actually drops; no new N+1 or serialization.
- Tests: a regression test exists for the fixed behavior, and it fails on the
  old code.
- Types/lint/build: real command output, not claims.
- Rollback: the change can be reverted alone.
