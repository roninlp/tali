# Tali on Cloudflare: why navigation feels slow, and whether to leave

**Scope.** Independent architecture research for the Tali repo (`/home/ronin/Projects/tali`), dated 2026-10-29. No application code was changed. Everything below is either a file:line citation from this repo or an external fact with a URL.

**Question.** The deployed app "feels very laggy" and navigation "is super low in cold starts". Is Cloudflare + D1 + Workers viable for a local-first household planner, or should this move to Convex / ElectricSQL + TanStack DB / plain Node?

**Answer in one line.** Cloudflare is not the problem and Convex is the wrong fix. The lag is ~80% self-inflicted: roughly **35 sequential D1 statements and 6 HTTP requests before the first screen is painted**, a **write on every read** (sliding session renewal), a **DELETE on every 3.5-second sync poll**, **full-table IndexedDB scans every poll**, and a **full-page splash on every route change**. Fix those and the app is fast on the current stack; re-platform only if it grows past a household.

---

## 0. Method, and what I could and could not measure

| Did | How |
| --- | --- |
| Read the full request path | `apps/web` routing/boot/data, `apps/api` entry + layers, `packages/rpc`, `packages/sql` repos + migrations, `infra/alchemy.run.ts`, `wrangler.test.jsonc` |
| Counted round trips | Statement-by-statement trace of `/auth/me`, `/preferences`, `/sync/pull`, `/today`, `/push/register` (see §2.4) |
| Measured bundle weight | `apps/web/dist/client/assets/*` (built output already in the repo), gzip + brotli |
| Measured API bundle | `infra/.alchemy/bundles/*/index.js` → **777 KB** |
| Verified platform facts | Cloudflare docs (placement, D1 read replication, D1 limits/pricing, Workers pricing, static-asset headers), vendor pricing pages (Convex, Electric, Zero, PowerSync, InstantDB, Neon, Supabase, Fly, Railway, Render, Vercel, Turso, Hetzner) |

**Not measured:** the live deployment. I cannot see its D1 primary region, its `cf-placement` header, or real timings. Every millisecond figure below is a **model with stated assumptions**, not a benchmark, and §8 gives the 30-minute measurement recipe that would replace the model with numbers.

**Assumption set (used for all latency arithmetic):**

- A1. Users are in Iran/Europe; Cloudflare terminates TLS at the nearest PoP (Frankfurt/Dubai-class), 30–60 ms from the client.
- A2. D1's primary lives in one region (Cloudflare: "each individual D1 database is inherently single-threaded… queries route to a specific database instance in one location" — [D1 read replication docs](https://developers.cloudflare.com/d1/best-practices/read-replication/); [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). The stack sets **no `primaryLocationHint`** (`infra/alchemy.run.ts:40-42`), so the location is whatever D1 chose at creation.
- A3. No `placement` is configured on the API Worker (`infra/alchemy.run.ts:190-215`), so the Worker runs at the user's PoP and **every D1 statement pays a Worker→D1 round trip**. Cloudflare's own placement docs frame this as "reducing round-trip latency from 20 to 30 milliseconds per query to 1 to 3 milliseconds" ([placement docs](https://developers.cloudflare.com/workers/configuration/placement/)).
- A4. Statement cost = RTT + SQL duration; D1 docs give <1 ms for an indexed read and "several milliseconds" for a write ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)).
- A5. Two scenarios: **S1** "Worker and D1 in the same region" (15 ms/statement) and **S2** "Worker at the user's PoP, D1 on another continent" (90 ms/statement) — the common misconfiguration.

---

## 1. What the app actually does on navigation

### 1.1 The stack as built

| Piece | Fact | Evidence |
| --- | --- | --- |
| Client | Solid v2 RC, client-only SPA, file-based routes, **no SSR at runtime** (the shell is prerendered at build) | `apps/web/src/App.tsx:12-34`, `apps/web/vite.config.ts:9-14`, `apps/web/src/Document.tsx:1-36` |
| Shell | 6 providers wrap the router: auth → preferences → push → local store → sync runner → router | `apps/web/src/App.tsx:14-18` |
| Routes | Lazy per-route chunks; a **full-page `<Splash/>` is the suspense fallback** | `apps/web/src/App.tsx:23-26`, `router.ts:1-5`, `file-routes.d.ts` (`FileRouteLazyRef`) |
| Nav links | Plain `<a href>` + `preventDefault()` + `navigate()` — **no router preloading, no `<A>`** | `apps/web/src/components/app-header.tsx:158-166` |
| Data | IndexedDB mirror (`tali.mirror.v1.<userId>`) + outbox; screens read the mirror and *also* refetch server read models | `apps/web/src/lib/local-store/store.ts:28-36`, `routes/today.tsx:184-228` |
| Sync | Cursor pull + outbox push over plain HTTP, **polled every 3.5 s / 15 s / 30 s** | `apps/web/src/lib/sync-engine.ts:181-194`, `lib/sync-cadence.ts:24-66` |
| RPC | Effect RPC over NDJSON at `/rpc`; **a fresh `RpcClient` + 4 layers per call** | `apps/web/src/lib/rpc.ts:61-76` |
| Server | One Worker, `/api/*` proxied by the web Worker over a service binding | `apps/web/worker.ts:28-41`, `infra/alchemy.run.ts:231-256` |
| Server app | **The entire Effect app layer is built per request** (`makeAppLayer` → `HttpRouter.toWebHandler` → `dispose`), 15 services + 15 repos | `apps/api/src/index.ts:126-146`, `apps/api/src/http-layer.ts:62-139` |
| DB | D1, SQLite, FTS5 for notes, no interactive transactions; `batch()` + `changes()` CAS | `packages/sql/migrations/*`, `packages/sql/src/sync-repo.ts:334-395` |
| Cron | 3 triggers on the API Worker: `* * * * *`, `17 3 * * *`, `47 3 * * *` | `packages/config/src/index.ts:23-27`, `apps/api/src/index.ts:171-235` |
| Assets | Workers Static Assets, SPA fallback, `/api/*` worker-first, **no `_headers` file** | `infra/alchemy.run.ts:231-247`, `apps/web/public/` (only icons/manifest/sw.js) |
| Service worker | **`fetch` handler is a no-op** `() => {}` | `apps/web/public/sw.js:40` |

### 1.2 A hard load of `/today` (signed in, one existing push subscription)

```
1  GET /                       edge → index.html (prerendered shell)          ~1 RTT to PoP
2  GET /assets/… (6-8 files)   entry 42 KB + routing 255 KB + rpc 44 KB
                               + tokens 68 KB + css 5 KB + today chunk 39 KB   ~136 KB gzip JS
3  GET /api/auth/me            4 D1 statements (SELECT session, UPDATE session, SELECT user, SELECT membership)
4  GET /api/push/vapid         0 D1 (unauthenticated)                            ← PushProvider boot
5  GET /api/preferences        4 auth + 1 prefs SELECT = 5
6  GET /api/sync/pull          4 auth + prune (2 DELETEs) + minSeq + pullFeed + findEntities = 10
7  GET /api/today              4 auth + 1 prefs + 5 bucket SELECTs + 1 pinned-notes SELECT = 11
8  POST /api/push/register     4 auth + upsert = 5      ← PushProvider again on `signedIn`
    + /api/push/vapid a second time (Provider runs `refresh()` twice: boot + auth change)
```

**Totals per boot: 6–7 API requests, ~35 D1 statements, 3 of them writes, 4 sequential HTTP phases.**

Sources for each line: `apps/web/src/lib/auth.tsx:104-106` (boot `/auth/me`), `lib/preferences.tsx:123-170` (GET on identity), `components/sync-runner.tsx:39-56` + `lib/sync-cadence.ts:169-176` (immediate first pull), `routes/today.tsx:266-280` (GET `/today`), `lib/push/context.tsx:238-267` (twice), `apps/web/src/lib/rpc.ts:68` (cookie), `apps/api/src/auth-service.ts:205-227` (the 4-statement `me`), `packages/sql/src/session-repo.ts:29-33` (the UPDATE), `apps/api/src/sync-service.ts:935-975` (prune inside pull), `apps/api/src/task-service.ts:1162-1206` (5 sequential bucket queries), `apps/api/src/today-routes.ts:45-67` (auth + prefs).

### 1.3 In-app navigation (`/today` → `/tasks`)

```
click <a> → navigate() → router suspends on the lazy chunk
        → <Loading fallback={<Splash/>}> paints a full-screen "در حال بارگذاری…"
        → chunk arrives (tasks 50 KB raw / 14 KB gz)
        → screen mounts → store.list("task") + store.list("project") + store.list("tag")
          (full IndexedDB getAll per type, no pagination, no cursor)
        → AppHeader is a *new* instance (each route renders its own)
```

- Splash on every nav: `apps/web/src/App.tsx:25` + `apps/web/src/components/form.tsx:123-143`.
- Full-table reads: `apps/web/src/routes/today.tsx:196` (`list("task")`, `list("note")`, `pending()`), `components/tasks/tasks-screen.tsx:169-171`, `components/notes/notes-screen.tsx:185`, `components/lists/lists-screen.tsx:74`.
- The note read includes **every note's full body** (`store.list("note")` → `data` blob) and then filters to pinned ones in the view (`lib/today/model.ts:243-265`).
- `/today` and `/calendar` refetch on mount because the read model + ETag live only in component state (`routes/today.tsx:112-114`, `components/calendar/calendar-screen.tsx:439-505`). So returning to Today = another **11 D1 statements**; returning to Calendar = `auth.me` + prefs + week/month queries.

### 1.4 The background loop (this is the one nobody notices)

Every 3.5 s while the tab is visible and recently active (`sync-cadence.ts:24-30`):

1. `GET /sync/pull` → 4 auth statements + **2 DELETEs (`prune`)** + `minSeq` + `pullFeed` + `findEntities` ≈ **10 statements, 2 of them writes**.
2. `store.mergeServer()` → `notify()` → provider calls `pendingCount()`; screen reloads `list("task") + list("note") + list("pending")`.
3. `syncNow`'s `finally` → `refreshCountsOf` → **`failedCount()` does `mirror.getAll()`** — a full scan of every mirrored row, every pass (`local-store/store.ts:175-180`, `context.tsx:97-108,174-182`).

A 2-tab household therefore issues **~34 sync passes/minute**, ~340 D1 statements, ~68 of them writes, plus ~2 full mirror scans per tab per pass. On a phone with a few thousand notes this is the *interaction* jank the user probably reads as "laggy" even when the network is fine.

### 1.5 The cron

`* * * * *` reminder sweep (`apps/api/src/index.ts:171-235`, `packages/config/src/index.ts:23`) = 1,440 invocations/day against the same D1 database. It does **not** keep the user's isolate warm — cron invocations land in whichever PoP, and Workers does not pin isolates across a minute. Cost is nil (100k req/day free), latency benefit is nil.

---

## 2. Diagnosis, ranked

Severity = expected contribution to perceived lag, given A1–A5.

### (a) Worker cold start — real, but small; **not the cause**

Cloudflare's own position: isolate startup is single-digit ms and ~99.99% of requests hit a warm isolate after sharding ([eliminating cold starts](https://blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers), [cold starts 2](https://blog.cloudflare.com/eliminating-cold-starts-2-shard-and-conquer)); the remaining cost is **module evaluation of your bundle**. Tali's API bundle is **777 KB** (`infra/.alchemy/bundles/tali-dev_ronin-TaliApi/index.js`), mostly Effect + schemas. Expect **20–60 ms** of startup CPU on a cold isolate, not 500 ms.

Two things make the cold-start story *feel* worse than it is:

- **The app layer is rebuilt per request**, not memoised per isolate (`apps/api/src/index.ts:126-140`). `Layer.mergeAll` over 30 layers + `HttpRouter.toWebHandler` + `dispose` runs on every request, warm or cold. That is per-request CPU and allocation, on top of ~35 statements.
- The **first** request after idle pays cold start *and* 4 sequential auth statements *and* the sync pull *and* `/today`, so the user experiences "cold start + 700 ms" and attributes all of it to cold start.

**Verdict: cold starts ≈ 5% of the problem. Moving to a container host would make this worse, not better.**

### (b) D1 round trips, write-on-read, and N+1 — **the dominant cost (~55–65%)**

| Anti-pattern | Evidence | Cost per occurrence |
| --- | --- | --- |
| **Every authenticated request re-authenticates with 4 sequential queries**, one of which is a write | `apps/api/src/auth-service.ts:205-227`; `packages/sql/src/session-repo.ts:29-33`; 9 call sites (`grep "auth.me("` = 9) | 4 RTT + 1 write; ×6 on boot = 24 statements |
| **Sliding session renewal as an UPDATE on every request** | `auth-service.ts:218-220` | turns every read into a primary-database write; defeats read replication; ~68 writes/min for 2 tabs from the poll alone |
| **`prune()` (2 DELETEs over `change_feed` + `applied_mutations`) inside `GET /sync/pull`** | `apps/api/src/sync-service.ts:944`; `packages/sql/src/sync-repo.ts:317-329` | 2 writes per poll, i.e. every 3.5 s, forever. The nightly purge cron already exists — this is redundant |
| **5 sequential queries to build one dashboard** (`listDueDateRange`, `listDueInstantRange` ×2, `listNoDue`) — independent of each other | `apps/api/src/task-service.ts:1170-1190` | 5 RTT where 1 `batch()` would do; D1 docs: "a `db.batch()` call counts as a single query… reduce the number of requests rather than only the duration" ([limits](https://developers.cloudflare.com/d1/platform/limits/)) |
| **`/today` calls `auth.me()` *and* re-reads preferences** even though `SessionContext` already carries timezone/weekstart/digits | `apps/api/src/today-routes.ts:51-66`; `auth-service.ts:223-226` | +5 statements |
| **`/sync/pull` re-auths, then does 4+ more queries** including `MIN(seq)` and a `findEntities` pass | `apps/api/src/sync-service.ts:934-1020` | 10 statements per poll |
| **No `primaryLocationHint`, no `placement`** | `infra/alchemy.run.ts:40-42`, `190-215` | multiplies *every* statement above by the Worker→D1 RTT |

**Model:**

| Scenario | Statements/boot | RTT/statement | D1 time | + 4 sequential HTTP phases | Boot-to-data (server) |
| --- | --- | --- | --- | --- | --- |
| S1 same-region, no placement | 35 | 15 ms | 525 ms | ~140 ms | **~0.67 s** |
| S2 cross-continent D1 | 35 | 90 ms | 3.15 s | ~200 ms | **~3.4 s** |
| Warm container host, same box as Postgres (for comparison) | 35 | 0.2–1 ms | ~20 ms | ~4×20 ms | **~0.1 s** |

That S1→S2 spread is exactly the "sometimes it's fine, sometimes it's unusable" report, and it is decided by two config lines that are currently absent.

### (c) Client SPA issues — **~25–30%, and the most visible part**

1. **A full-page splash on every navigation.** The router's async route components suspend into `<Loading fallback={<Splash/>}>` (`App.tsx:25`), and `Splash` is a `100dvh` centred "loading" screen (`form.tsx:123-143`). Even a 20 ms chunk fetch blanks the entire UI. This alone reads as "the app reloads every time I tap".
2. **No route prefetch.** Nav uses plain `<a>` + `navigate` (`app-header.tsx:100-104,158-166`), so the chunk for the destination is fetched *after* the click. Solid Router only prefetches for `<A>` / `router.preload`.
3. **No persistent shell.** `AppHeader` is rendered *by each route* (`routes/today.tsx:727`, `routes/tasks.tsx`, …), so every nav destroys and rebuilds the chrome, the 8-item nav, `SyncStatus`, and re-subscribes its effects.
4. **First paint JS ≈ 136 KB gzip** before the app can run:

   | Chunk | raw | gzip | brotli | what |
   | --- | --- | --- | --- | --- |
   | `routing-*.js` | 255 KB | **84 KB** | 74 KB | Effect + `@tali/domain` schemas (preloaded) |
   | `tokens-*.js` | 68 KB | 24.5 KB | 22 KB | shared runtime |
   | `virtual_solid-ssr-entry-client-*.js` | 42 KB | 14 KB | 12.7 KB | app entry |
   | `rpc-*.js` | 44 KB | 14 KB | 12.6 KB | Effect RPC client |
   | `ui-*.js` ×2 | 34 KB | 10.4 KB | 9.2 KB | components |
   | CSS | 4.9 KB | 1.7 KB | 1.4 KB | |
   | `vazirmatn-variable.woff2` | 111 KB | — | — | font (already compressed) |
   | route chunk (`today`) | 39 KB | 11.3 KB | 10 KB | |

   ~136 KB gzip is not catastrophic, but **84 KB of it is Effect Schema pulled in eagerly** for a screen that only needs `Task` and `Note`. On a mid-range Android over a 3G-class link this is 700–1200 ms of parse+eval before the first pixel of app chrome.
5. **IndexedDB work scales with journal size and runs on every poll.** `failedCount()` = full mirror scan (`store.ts:175-180`); screens re-`getAll` whole entity types on every `notify()` (`today.tsx:196`); `list()` filters after materialising (`store.ts:160-166`). A bullet journal is exactly the workload that grows: 5k notes × 1 KB = ~5 MB cloned and filtered every 3.5 s.
6. **Auth boot is a hard gate.** Nothing renders until `/auth/me` settles (`auth.tsx:104`, `guard.tsx:24-46`), even though a cached session exists in localStorage (`session-cache.ts:27-44`) and the mirror is per-user. The cache is only used when the network *fails* (`auth.tsx:92-98`), not to paint immediately.
7. **`withClient` builds the RPC client and 4 layers on every call** (`rpc.ts:61-76`) — measurable client CPU per mutation, plus a fresh `Effect.scoped` scope. It also makes each RPC a separate HTTP request with no batching.
8. **Push boot runs twice** (`push/context.tsx:238-245` + `262-267`), so `/push/vapid` is requested twice and `/push/register` once on every boot.

### (d) Deployment / asset serving — **~5–10%, cheap to fix**

- Workers Static Assets default to **`Cache-Control: public, max-age=0, must-revalidate`** ([headers docs](https://developers.cloudflare.com/workers/static-assets/headers/)), i.e. every hashed asset is revalidated on every navigation/reload. There is **no `_headers` file** in `apps/web/public/`, so the correct rule (`/assets/* → max-age=31556952, immutable`) is not applied.
- `assetsInlineLimit: 0` (`vite.config.ts:29`) forces even sub-KB assets into separate requests.
- The service worker is a **no-op fetch handler** (`sw.js:40`), so it neither helps (no app-shell cache) nor hurts (no interception cost). Keep it: it exists for Web Push.
- `/api/*` costs one extra Worker invocation via the service binding (`worker.ts:37`). That is 1–3 ms and buys same-origin cookies; it is not worth changing.
- Cors is inert in production (`apps/api/src/index.ts:73-82`) — preflights are not the issue.

### (e) What is *not* the problem

- **Service worker interference**: none (`sw.js:40`).
- **Missing indexes**: the schema is unusually well indexed (`idx_tasks_due_date`, `idx_tasks_status_due`, `idx_notes_pinned`, `idx_change_feed_household_seq`, `idx_sessions_token` unique, …). This is not a scan problem.
- **D1 storage size / 10 GB limit**: irrelevant at household scale.
- **Cron load**: 1,440 cheap invocations/day.

### Scoreboard

| Driver | Share of perceived lag (est.) | Confidence | Fix effort |
| --- | --- | --- | --- |
| D1 round-trip multiplication (35 stmts, no placement) | 40% | High | **1–3 days** |
| Write-on-read (session extend) + prune-on-poll | 15% | High | **hours** |
| Splash-on-nav + no prefetch + no shell | 15% | High | **1–2 days** |
| IndexedDB full scans every poll | 12% | Medium-high | **1–2 days** |
| Eager 136 KB JS (Effect Schema) | 8% | Medium | 2–4 days |
| Cold start / bundle eval | 5% | Medium | 1 day (trim imports) |
| Asset caching headers | 3% | High | **10 minutes** |
| Auth boot gate | 2% | High | hours |

---

## 3. Is Cloudflare/D1 viable? Yes, with four caveats

Tali's shape — one household, 2 users, <100 MB of data, a client that already holds a full mirror, a per-minute reminder clock, push, nightly backups — is close to the *best* case for Workers + D1. What is not viable is the current *query discipline*, and two D1 properties:

1. **D1 is single-threaded per database** ("processes queries one at a time", [limits](https://developers.cloudflare.com/d1/platform/limits/)). Every unnecessary statement is both latency *and* throughput. `batch()` is the escape hatch and is used for writes but not for the read fan-out.
2. **D1 read replication only works through the Sessions API** — enabling it in the dashboard does nothing for `env.DB.prepare()` ([read replication docs](https://developers.cloudflare.com/d1/best-practices/read-replication/)). `@effect/sql-d1` does not expose `withSession`, so replication is currently a non-option without a custom client. Moreover, the sliding-session UPDATE would force every request to the primary anyway.
3. **No interactive transactions.** The codebase works around it correctly (`batch()` + `changes()` CAS, `sync-repo.ts:334-395`), but every future multi-row feature pays that tax.
4. **Placement is not automatic.** The old docs line "Workers with a D1 binding will always be placed near the D1 database" was ambiguous and is not in the current placement page; community reports call co-placement unreliable ([issue #14883](https://github.com/cloudflare/cloudflare-docs/issues/14883), [community thread](https://community.cloudflare.com/t/worker-co-placement-with-d1-is-unreliable/672074)). Treat placement as something you configure and verify with the `cf-placement` header.

**Bottom line:** the platform is fine. The bill for 2 households is ~$0–5/month and the ops burden is genuinely zero. Leaving Cloudflare is a large, risky change that fixes maybe 20% of the user-visible problem.

---

## 4. Hosting options compared

Assumptions for cost: 2 households / ~6 devices, ~60k API requests/month after the polling fix, <100 MB DB, <5 GB egress, always-on.

### 4.1 Cloudflare, fixed (recommended)

**What changes:** `placement: { region: "aws:eu-central-1" }` or `mode: "smart"` on `TaliApi` (supported: `Worker.d.ts:670` in Alchemy 2.0.0-beta.83); a session cookie that carries the principal (or a KV cache of `tokenHash → SessionContext`) so `/auth/me` is 0–1 statements; renewal at most hourly; `prune` moved to the nightly cron; the 5 bucket queries in one `d1.batch()`; a single `/bootstrap` endpoint; `_headers` for `/assets/*`; no splash; route prefetch.

**Expected result** (S1 assumptions, all fixes): 6–9 statements per boot in 2 requests, ~30–60 ms server time + ~1 RTT; boot-to-interactive ~350–600 ms on mid-range mobile; in-app nav <100 ms with zero splash. **Effort: 3–6 days.** Cost stays $0–5.

| Pro | Con |
| --- | --- |
| Zero migration, keeps Effect domain/RPC, D1 schema, Alchemy, push, cron, R2 backups | Still SQLite-without-transactions |
| Cheapest at near-zero traffic (~$0–5) | Single-region D1: placement must be configured *and* verified |
| No cold-start problem worth the name | No read replication without a custom Sessions client |
| Already-tested conflict semantics stay | Senior-level Cloudflare knowledge needed to keep it fast |

### 4.2 Cloudflare + one Durable Object per household (the "right" Cloudflare shape)

Move the household DB from D1 into a Durable Object using SQLite storage. Effect v4 already ships the client (`repos/effect/packages/sql/sqlite-do/src/SqliteClient.ts`, `@effect/sql-sqlite-do`), so the repository/service layer is portable with a layer swap. Queries then execute **in the same process as the data** — Cloudflare describes DO SQLite as "effectively zero-latency" ([placement docs, Durable Objects section](https://developers.cloudflare.com/workers/configuration/placement/)). The DO also gives you free WebSocket fan-out for sync (replacing the 3.5 s poll) and `setAlarm()` instead of the per-minute cron.

**Effort: 3–5 weeks.** Work: per-household migrations on first open, DO-side dump for backups (D1's export path and the FTS5 caveat in ADR-0009 disappear, but you need a replacement), cron → alarms, the reminder sweep becomes per-household, and the sync feed moves with the data.

| Pro | Con |
| --- | --- |
| Removes the RTT term entirely — the root cause | Real rewrite of the storage layer + backup + cron |
| Realtime sync via WebSocket, no polling | DOs are single-threaded per object (fine here) |
| Still Cloudflare, still cheap (<$2/mo at this scale) | DO storage billing (rows read/written, Jan 2026) is a new meter to watch |
| Keeps Effect, domain, RPC | Debuggability of DO storage is weaker than D1's SQL console |

### 4.3 Cloudflare + Hyperdrive + Postgres (Neon/Supabase)

Keeps Alchemy and the edge, swaps D1 for Postgres through Hyperdrive (connection pooling, included on Workers Paid; 100k queries/day free). Fixes transactions and gives real FTS (`tsvector`), but **reintroduces a cross-region hop** unless you pin placement to the DB's region and put Neon in `eu-central-1`. Cost $5 + $0–19 (Neon Launch) or $25 (Supabase Pro). Effort 1–2 weeks (repos → `@effect/sql-pg`, CAS via rowCount, FTS rewrite).

### 4.4 Plain Node/VPS (Hetzner + Docker + Postgres or SQLite)

Hetzner Cloud from **€5.99/mo** (cost-optimised) / **€6.49** (regular) excl. VAT ([hetzner.com/cloud](https://www.hetzner.com/cloud/)); add Cloudflare in front for TLS/CDN/DDoS at $0. Run the Effect app under `@effect/platform-node`, Postgres in the same box, `pg_dump` + R2/S3 for backups, `systemd` timers or `node-cron` for the sweep.

| Pro | Con |
| --- | --- |
| No cold start, ever; DB on localhost → ~0.2 ms queries | You own patching, TLS renewal, disk, monitoring, restores |
| **Cheapest predictable bill** (~$7/mo all-in) | Single point of failure; no HA unless you pay for it |
| Postgres: real transactions, better FTS, no 10 GB cap | Postgres migration cost (FTS5 → tsvector with Persian folding, `changes()` CAS → rowCount) |
| Fully reversible, no vendor lock-in | Loses Alchemy's one-command deploy + preview stacks |

**Migration surface (measured):** `D1Client` appears in 13 API files and 9 SQL files (39 references), all of it behind the `SqlClient` tag except `batch()` and `changes()`. The domain model, RPC contract, services, and UI are untouched. That is a **1–3 week** port for someone who knows the codebase, with the Persian FTS5 work (`0009_note_search.sql`, `packages/domain/src/persian.ts`) as the risky part.

### 4.5 Fly.io

Machines from **$2.19/mo** (shared-cpu-1x/256 MB), volumes $0.15/GB, no free tier, **Managed Postgres $38/mo** — self-hosting Postgres (or using SQLite on a volume) is what makes it cheap ([fly.io pricing](https://fly.io/docs/about/pricing/)). `auto_stop` gives scale-to-zero but reintroduces cold starts (container boot, hundreds of ms to seconds) — wrong trade for this app.

### 4.6 Railway

Hobby **$5/mo including $5 of usage**; per-second CPU/memory ($20/vCPU-month, $10/GB-month), egress $0.05/GB ([railway.com/pricing](https://railway.com/pricing)). A small Node service + Postgres realistically lands **$8–15/mo**. No cold start while running, low ops, good DX. Postgres plugin adds a real DB with transactions.

### 4.7 Render

Web service **$7/mo** (0.5 CPU/512 MB) + Postgres **$6/mo** (0.1 CPU/256 MB) = **$13/mo**; free tiers exist but free web services spin down (bad), and the Hobby plan has 5 GB egress ([render.com/pricing](https://render.com/pricing)). Equivalent to Railway with slightly higher floor pricing and no per-second billing.

### 4.8 Vercel/Netlify + Neon/Supabase

Vercel Pro **$20/seat** (Hobby is non-commercial only) with Fluid compute; Neon Free (0.5 GB, **scale-to-zero after 5 min, wake in "a few hundred milliseconds"**) or Launch from $19 ([neon pricing](https://neon.com/pricing), [Neon cold starts](https://neon.com/docs/connect/connection-latency)); Supabase Free pauses after a week of inactivity, Pro $25 ([supabase pricing](https://supabase.com/pricing)).

Fine for a static SPA + functions, but **you re-create the p99 problem you are trying to escape**: function cold start + DB autosuspend, unless you disable scale-to-zero and pay for always-on compute (~$77/mo per CU at Neon's $0.106/CU-hour). Hobby is technically $0 for a personal household app if you accept the cold starts.

### 4.9 AWS

Lightsail $5–7/mo, or Lambda + API Gateway + RDS. RDS is the cost floor problem: the smallest always-on instance is ~$15–30/mo, and RDS Proxy/Lambda cold starts add complexity for zero benefit at this scale. Highest operational and cognitive cost of every option. **Not recommended.**

### 4.10 Hosting summary

| Target | $/mo @ near-zero traffic | Cold start | Ops burden | Effort from today | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Cloudflare + fixes** | **$0–5** | ~0 (isolate, 20–60 ms bundle eval) | none | **3–6 days** | **Recommended** |
| Cloudflare + DO SQLite | $1–6 | ~0 | low | 3–5 weeks | Best long-term CF shape |
| CF + Hyperdrive + Postgres | $5–24 | ~0 (PG always-on) | low | 1–2 weeks | Good if D1 limits bite |
| Hetzner + Docker + Postgres | ~$7 | none | **medium** (you own it) | 1–3 weeks | Best non-CF option |
| Railway | $8–15 | none while running | low | 1–3 weeks | Fine, pricier |
| Render | ~$13 | none (paid tier) | low | 1–3 weeks | Fine, pricier |
| Fly.io | $4–6 (SQLite) / $44 (managed PG) | container boot if auto-stop | medium | 1–3 weeks | Not compelling |
| Vercel/Netlify + Neon | $0–39 | function + DB suspend | low | 1–3 weeks | Recreates the problem |
| AWS | $7–40 | Lambda ~100–400 ms | **high** | 2–4 weeks | No |

---

## 5. Data/sync architectures compared

Current design is already sophisticated: per-user IndexedDB mirror, outbox with coalescing, replay-safe `clientMutationId`, tombstone-wins, version CAS, 90-day feed window, offline boot from a cached session. **None of the alternatives below is a strict upgrade on that; most are a rewrite of it.**

### 5.1 Option-by-option

#### Keep Effect RPC + cursor sync + IndexedDB mirror (fixed)
Already local-first: reads never touch the network once the mirror is warm. The problems are implementation, not architecture (§2). **Solid fit: perfect.** Migration: none.

#### Convex
Reactive server database with WebSocket subscriptions; queries are TS functions, mutations are serializable transactions; crons, scheduled functions and auth are built in. Pricing: Free/Starter $0 (0.5 GB, 1M calls), Professional **$25/dev/mo** ([convex.dev/pricing](https://www.convex.dev/pricing)).
**Solid support: community only.** Convex's own docs say "there's no official `convex-solid` package as of early 2026" ([convex SolidJS guide](https://www.convex.dev/typescript/ecosystems-integrations/frameworks/solidjs-typescript)); `convex-solid@2.0.0-beta.1` and `convex-solidjs` exist ([npm](https://www.npmjs.com/package/convex-solid)).
**Offline: server-first.** Mutations queue in memory while offline and replay on reconnect (idempotent), but there is no persisted offline write log or local-first read cache across reloads; Convex's own local-first answer is "bolt Automerge on" ([stack.convex.dev](https://stack.convex.dev/automerge-and-convex)). **This would lose Tali's offline story.**
Migration: total. Domain services (19k lines of Effect), `packages/sql`, the sync protocol, the conflict lab, and the backup/restore drill all become dead code. Lock-in: high (proprietary DB + functions).

#### ElectricSQL (Postgres Sync) + TanStack DB
Electric is a **read-path** sync engine: logical replication → Shapes → HTTP shape log, CDN-friendly, GA since 1.0 (March 2025), open source Apache-2.0 ([electric.ax/docs](https://electric.ax/docs/sync/)). Writes stay on *your* API — which means **Tali keeps Effect RPC and its whole write path**.
TanStack DB is the client store: live queries, optimistic mutations, and as of 0.6 (March 2026) **SQLite persistence + offline transactions** ([TanStack DB 0.6](https://electric.ax/blog/2026/03/25/tanstack-db-0.6-app-ready-with-persistence-and-includes)). **Official Solid adapter**: `@tanstack/solid-db` 0.3.x with `useLiveQuery` and signal-aware queries ([tanstack.com/db Solid](https://tanstack.com/db/latest/docs/framework/solid/overview), [npm](https://www.npmjs.com/package/@tanstack/solid-db)). TanStack DB is still **BETA**.
Pricing: PAYG $0 + $1/M writes (+$2/M for Postgres Sync), under $5/mo waived; Pro $249 ([electric.ax/pricing](https://electric.ax/pricing)).
Cost: Tali would need Postgres (D1 goes away) + an Electric service (self-host Elixir, or Cloud). Migration: 3–6 weeks: Postgres port **plus** replacing the hand-rolled mirror with collections, **plus** keeping the outbox semantics somewhere (TanStack's `@tanstack/offline-transactions` is new). This is the best *incremental* re-platform if you ever outgrow D1 — but it does not remove the need for the fixes in §2, because navigation latency today is client-side and auth-side, not sync-side.

#### Rocicorp Zero
General-purpose sync engine, **1.0 in June 2026** ([InfoQ](https://www.infoq.com/news/2026/06/zero-version-1)), Postgres + `zero-cache` (self-host or Cloud Zero Hobby **$30/mo**). **Built-in Solid bindings** (`@rocicorp/zero/solid`, `ZeroProvider`, `useQuery`, `useZero` — [zero.rocicorp.dev/docs/solidjs](https://zero.rocicorp.dev/docs/solidjs)) and a real Solid example repo. Best-in-class instant reads via query-driven partial sync. **But: no offline writes** — the docs are explicit, offline is read-only ([when to use](https://zero.rocicorp.dev/docs/when-to-use)). For a bullet journal used on a phone in a lift, that is a regression. Also ZQL replaces SQL on the read path, so the Effect read services don't survive.

#### LiveStore
Event-sourced local-first layer over SQLite (WASM/OPFS in the browser), reactive queries, custom merge, ships a Cloudflare adapter (Durable Objects + D1) ([docs](https://docs.livestore.dev/)). **Solid is experimental** ("packages for Solid & web components are experimental" — [Expo blog](https://expo.dev/blog/local-first-application-development-with-livestore)); the web adapter examples list SolidJS. Version 0.4.0 stable / 0.5.0-dev, breaking changes between minors ([changelog](https://docs.livestore.dev/changelog)). Nice fit conceptually (Effect Schema table definitions!), wrong maturity for a "just make it work" moment.

#### PowerSync
Postgres/Mongo/MySQL/SQL Server → SQLite on the client, with sync rules for partial replication, offline writes, and a TanStack DB collection adapter. Framework-agnostic **JS web SDK** (no Solid-specific package; you bind it yourself). Free tier: 2 GB synced/month, 500 MB hosted, 50 concurrent; Pro $49; self-host Open Edition free ([powersync.com/pricing](https://powersync.com/pricing)). Very credible if you want a hosted sync engine and can live with a second service to operate.

#### InstantDB
Client-side DB with an **official SolidJS SDK** (`@instantdb/solidjs`, `create-instant-app -b solidjs-vite` — [docs](https://www.instantdb.com/docs/start-solidjs.md)), realtime by default, permissions, auth, storage, "offline mode with local caching and reconciliation". Free 1 GB, Pro **$30/mo** ([pricing](https://www.instantdb.com/pricing)). Hosted-only, opinionated schema, high lock-in. Genuinely the fastest path to "reactive app with Solid" — and the fastest way to delete the Effect domain model.

#### Supabase Realtime
Postgres + logical replication broadcast to clients. `supabase-js` works in Solid (framework-agnostic) but you build the local cache/sync yourself — it is a transport, not a sync engine. $0 free (pauses after 1 week idle) / $25 Pro ([pricing](https://supabase.com/pricing)).

#### Turso / libSQL embedded replicas
SQLite with embedded replicas (local reads, remote writes, periodic sync) and a newer "Turso Sync" with explicit push/pull for offline writes ([embedded replicas](https://docs.turso.tech/features/embedded-replicas/introduction), [turso.tech](https://turso.tech/)). Free 5 GB/500M rows read, paid from ~$5 ([pricing](https://turso.tech/pricing)). Attractive because it is *the same SQL dialect as D1* — but the web client story is weaker than native (WASM/OPFS), and the sync semantics would still be yours to design. Effect has `@effect/sql-libsql`.

#### PGlite
Embedded Postgres (WASM) for the client, usually paired with Electric. Interesting for "Postgres everywhere" but adds ~3 MB of WASM to a bundle that is already 136 KB gzip. Not a sync engine by itself.

#### Neon
Serverless Postgres with branching and scale-to-zero: Free (0.5 GB, 100 CU-hours, suspend after 5 min, wake in a few hundred ms), Launch pay-as-you-go (~$0.106/CU-hour) ([neon docs](https://neon.com/docs/introduction/plans)). A DB, not a sync engine — pair with the existing client.

#### Plain Postgres + existing typed RPC + optimistic UI
This is the honest non-CF baseline: keep Effect RPC, keep the mirror, keep optimistic writes, move the DB to Postgres. No new vendor, no new paradigm, real transactions. The only thing you *don't* get is push-based realtime (you keep the poll, or add SSE).

#### Firebase / Firestore
Offline persistence is built in and mature, but Solid support is community, the data model is a document store with no SQL, security rules replace your auth service, and lock-in is total. Wrong fit for a relational planner with FTS.

### 5.2 Data/sync summary table

| Option | Solid support | Offline writes | Nav latency model | Keeps Effect domain/RPC | Keeps SQL | Effort | Maturity (late 2026) | Lock-in |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Current (fixed)** | native | yes (outbox) | local IDB + 1 poll | — | yes (SQLite) | 0 | yours | none |
| Electric + TanStack DB | **official** (`@tanstack/solid-db`) | yes (0.6 persistence + offline tx) | local store, CDN stream | **yes (writes)** | Postgres | 3–6 wks | TDB beta / Electric GA | low |
| PowerSync | framework-agnostic JS | yes | local SQLite | yes | Postgres | 3–6 wks | mature | low-med |
| Zero | **built-in** | **no** (read-only offline) | local cache, server-authoritative | partly (ZQL reads) | Postgres | 4–8 wks | 1.0 since 6/2026 | med |
| Convex | community beta | queued mutations, no persisted cache | one WS subscription | **no** | no (own DB) | total | GA | **high** |
| InstantDB | **official** | "offline mode" | local cache + WS | no | no | total | GA | **high** |
| LiveStore | experimental | yes | local SQLite | partly (Effect Schema tables) | SQLite | 4–8 wks | 0.4 stable / 0.5 dev | low |
| Supabase Realtime | framework-agnostic | no (build it) | you build cache | yes | Postgres | 3–5 wks | mature | low |
| Turso embedded replicas | framework-agnostic | partial | local SQLite | partly | SQLite | 3–6 wks | maturing | med |
| PGlite | n/a (client lib) | n/a | local PG | yes | Postgres | 3–6 wks | maturing | low |
| Neon | n/a (DB) | n/a | server RTT | yes | Postgres | 2–3 wks | mature | low |
| Postgres + existing RPC | native | yes (outbox) | local IDB + poll | **yes** | Postgres | 1–3 wks | — | none |
| Firebase | community | yes | WS + local cache | no | no | total | mature | **high** |

---

## 6. Scored comparison

Scores 1–5 (5 = best). Weights chosen for "a 1–2 household app that must not feel slow and must not eat a month of my life".

### 6.1 Hosting

| Criterion | Weight | CF+fixes | CF+DO | CF+PG | Hetzner | Railway | Render | Fly | Vercel+Neon | AWS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Latency after fixes | 25% | 4 | 5 | 4 | 5 | 5 | 4 | 4 | 3 | 4 |
| Migration effort | 20% | 5 | 2 | 3 | 2 | 2 | 2 | 2 | 2 | 1 |
| Ops burden | 15% | 5 | 4 | 4 | 3 | 4 | 4 | 3 | 4 | 1 |
| Cost @ near-zero | 10% | 5 | 4 | 4 | 4 | 3 | 3 | 4 | 3 | 2 |
| Data-model fit | 10% | 4 | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| Push/cron/auth coverage | 10% | 5 | 4 | 5 | 5 | 4 | 4 | 4 | 3 | 4 |
| Reversibility | 5% | 4 | 3 | 4 | 5 | 4 | 4 | 5 | 4 | 3 |
| Offline/local-first fit | 5% | 5 | 5 | 4 | 4 | 4 | 4 | 4 | 3 | 4 |
| **Weighted** | | **4.60** | **3.75** | **3.95** | **3.65** | **3.55** | **3.35** | **3.40** | **3.00** | **2.55** |

### 6.2 Data/sync architecture

| Criterion | Weight | Current (fixed) | Electric+TDB | PowerSync | Zero | Convex | InstantDB | LiveStore | Supabase RT | Turso | Postgres+RPC | Firebase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Nav latency | 20% | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 2 | 4 | 3 | 3 |
| Solid 2 fit | 15% | 5 | 4 | 3 | 5 | 2 | 5 | 2 | 4 | 3 | 5 | 2 |
| Offline/local-first | 15% | 5 | 4 | 5 | 2 | 2 | 3 | 5 | 1 | 3 | 4 | 4 |
| Migration effort | 15% | 5 | 3 | 2 | 2 | 1 | 1 | 1 | 2 | 2 | 3 | 1 |
| Preserve Effect domain | 10% | 5 | 5 | 5 | 4 | 1 | 1 | 3 | 5 | 3 | 5 | 1 |
| Realtime sync | 10% | 2 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 2 | 2 | 5 |
| Schema/migrations | 5% | 5 | 4 | 5 | 3 | 3 | 3 | 4 | 5 | 4 | 5 | 2 |
| Maturity/risk | 5% | 4 | 3 | 4 | 4 | 4 | 3 | 2 | 4 | 3 | 5 | 5 |
| Lock-in | 5% | 5 | 4 | 4 | 3 | 1 | 1 | 4 | 4 | 3 | 5 | 1 |
| **Weighted** | | **4.50** | **4.15** | **4.00** | **3.40** | **2.55** | **3.05** | **3.20** | **2.90** | **2.90** | **3.75** | **2.55** |

---

## 7. Recommendation

### 7.1 Do not re-platform. Fix the four things that are actually slow.

**Phase 0 — "free latency" (1–2 days, no schema change, no vendor change).** Ordered by payoff per hour:

1. **Place the API Worker next to D1.** Add `placement: { region: "aws:eu-central-1" }` (or `mode: "smart"` if you don't know D1's region) to `Cloudflare.Worker("TaliApi", …)` in `infra/alchemy.run.ts:190`. Verify with the `cf-placement` response header (docs: [placement](https://developers.cloudflare.com/workers/configuration/placement/)). Also run `wrangler d1 info` and set `primaryLocationHint` on the database to match. *Expected: 35 × (90 ms → 2 ms) in the bad case; 5–10× on every API call.*
2. **Stop writing on every read.** Cache the principal in the session cookie (signed) or KV keyed by `tokenHash`, and renew `expires_at` at most once an hour (`apps/api/src/auth-service.ts:205-227`, `packages/sql/src/session-repo.ts:29-33`). *Expected: −1 write and −3 RTT per authenticated request; read replication becomes possible again.*
3. **Move `prune()` out of `GET /sync/pull`** (`apps/api/src/sync-service.ts:944`) into the existing nightly purge (`apps/api/src/index.ts:178-196`). *Expected: −2 writes per poll; removes the constant write stream that makes the whole DB serialise.*
4. **Batch the dashboard reads.** The five independent bucket queries (`task-service.ts:1170-1190`) become one `d1.batch()`; `today-routes.ts` reuses `context.user` instead of re-reading preferences. *Expected: 11 → ~4 statements for `/today`.*
5. **One boot request.** `GET /api/bootstrap` returning `{ session, preferences, today, syncPage }` (and drop the duplicate `PushProvider.refresh()`), so the client's first paint needs **one** authenticated RTT instead of five. *Expected: 4 sequential HTTP phases → 1; ~35 → ~10 statements.*
6. **`_headers` for immutable assets.** Add `apps/web/public/_headers`:
   ```
   /assets/*
     Cache-Control: public, max-age=31556952, immutable
   ```
   *Expected: removes a conditional request per asset on every reload; 10 minutes of work.*
7. **Kill the splash.** Replace `<Loading fallback={<Splash/>}>` with a shrink-proof inline skeleton (or remove the boundary and let routes import eagerly — the largest route chunk is 21 KB gzip), and make the nav use `<A>`/`router.preload` so the chunk is already in memory. *Expected: this alone removes the "it reloads on every tap" perception.*
8. **Paint from the cache before the network.** Boot `signedIn` from `session-cache.ts` immediately and reconcile with `/auth/me` in the background; the mirror is already per-user and the guard only needs `householdId`.
9. **Stop full-mirror scans.** Give the mirror a `byEntityType` index read that filters on the index cursor instead of `getAll` + `filter`; replace `failedCount()`'s `getAll()` with a small `failures` object store (or a count index); scope `list("note")` to pinned/visible rows for Today instead of loading every note body; debounce the screen subscriptions (one reload per animation frame, not per notify).

**Definition of done for Phase 0** (measure, don't guess): `/api/today` p50 < 120 ms warm and < 300 ms cold from the target city; boot-to-interactive < 900 ms on a mid-range Android over 4G; in-app nav < 150 ms with zero splash frames; 0 writes on a read-only poll.

**Phase 1 — "make local-first real" (1–2 weeks, still Cloudflare).**

- Replace the 3.5 s poll with **SSE or a hibernating WebSocket** (a DO per household is the natural fan-out point; `setWebSocketAutoResponse` + hibernation keeps it cheap). Copper: Cloudflare DOs support this natively and it removes ~34 requests/minute/household.
- Make the mirror the only render source: persist the last `/today` and `/week` read models in IndexedDB (keyed by ETag) so returning to a screen is a synchronous paint and the refetch is a background revalidation.
- One `RpcClient` per session instead of per call (`lib/rpc.ts:61-76`) — build the layers once, share the scope.
- Split Effect out of the critical path: the `@tali/domain` schemas are eagerly pulled into the `routing` chunk (84 KB gzip). Either move schema validation to the API boundary only (the client already trusts its mirror) or code-split the RPC module behind the first interaction. Target: <60 KB gzip before first paint.

**Phase 2 — only if Phase 0/1 misses the target, or if this grows past a household.** In order of preference:

1. **DO-per-household SQLite** (`@effect/sql-sqlite-do`), which deletes the RTT term entirely and gives you the WebSocket sync from Phase 1 for free. 3–5 weeks.
2. **Postgres somewhere sane** (Hetzner + Docker, or CF + Hyperdrive + Neon) with the Effect app unchanged. 1–3 weeks, keeps everything valuable.
3. **Electric + TanStack DB** *only* if the thing you actually want is a general sync engine and you are willing to run Postgres + the Electric service. Note this solves a problem Tali does not currently have (sync is already local-first and works); it does not fix auth round trips, the splash, or the IDB scans.

**Do not choose Convex for this app.** It would rewrite 19k lines of tested Effect services into TS functions, replace a SQL schema with a proprietary document store, drop real offline writes, and rest on an unofficial, beta Solid binding — to fix a latency problem that is 80% configuration and client plumbing.

### 7.2 Decision rule: household vs. growth

| Signal | Stay on Cloudflare + fixes | Re-platform |
| --- | --- | --- |
| Households | 1–3 | >20, or per-tenant isolation required |
| Data | <1 GB, <50k rows | >5 GB or >1M feed rows |
| Concurrency | <10 devices | >100 concurrent writers on one dataset |
| Write rate | <5 writes/s | sustained >10 writes/s on one DB (D1 serialises) |
| Query shape | point reads + small ranges | cross-household analytics, joins across tenants |
| Feature pressure | reminders, push, offline | server-side search at scale, collaborative editing, CRDT text |
| Ops appetite | zero | willing to run Postgres + a sync service |

Concretely: **if you stay under ~10 devices and ~50k rows, a fixed Cloudflare stack is the cheapest and lowest-latency option available to you.** The moment you add realtime multi-user editing or a second household per user, go to DO-SQLite (if staying) or Postgres + Electric/TanStack DB (if leaving).

### 7.3 What to preserve in any migration

- `packages/domain` (Effect Schema entities, typed errors, Jalali/Persian logic) — 100% portable, and the most valuable asset in the repo.
- `packages/rpc` (the `ApiRpcs` contract) — portable to any transport, including Convex-free HTTP.
- The **sync protocol invariants** in `docs/sync-protocol-draft.md` and the conflict lab (`packages/conflict-lab`): `clientMutationId` replay safety, tombstone-wins, per-row version CAS, feed retention. Any new engine must be tested against the same two-device regression table.
- The RTL/Persian UI and the local-first UX (mirror-first paint, outbox, offline boot).
- The backup guarantee (ADR-0009) — note that D1's export cannot handle FTS5, which is why `d1-dump.ts` exists; a Postgres move replaces this with `pg_dump` and a restore drill.

---

## 8. Measurement recipe (do this before and after Phase 0)

1. **Is the Worker actually near D1?**
   `curl -sI https://<host>/api/health | grep -i cf-placement` → `local-FRA` means no placement; `remote-AMS`/`remote-FRA` means placed. Also `wrangler d1 info <db>` for the primary location hint.
2. **Split cold from warm.** 20 sequential `curl -w '%{time_starttransfer} %{time_total}'` against `/api/health` (0 D1), `/api/auth/me` (4 D1), `/api/today` (11 D1) with a valid cookie. The slope of `time_total` vs. statement count *is* your per-statement RTT.
3. **Count statements.** Add a `Server-Timing` header (`auth;dur=…, prefs;dur=…, db;count=…`) in `apps/api/src/index.ts:141` — 10 lines, and it makes regressions visible forever.
4. **Client.** Chrome Performance → bottom-up on a `/today` load and on a `/today → /tasks → /today` cycle; `performance.getEntriesByType('resource')` for transfer sizes; the IndexedDB profiler for `getAll` durations; throttled 4× CPU to emulate the phone.
5. **Polling cost.** With `wrangler tail`, count `/sync/pull` and check `rows_read`/`rows_written` on the D1 metrics page over an idle hour. If writes > 0 while idle, #2/#3 of Phase 0 are not done.

---

## 9. Evidence index

| Claim | Citation |
| --- | --- |
| Boot calls `/auth/me` once, gates rendering | `apps/web/src/lib/auth.tsx:80-106`, `components/guard.tsx:24-46` |
| `/auth/me` = 4 statements including an UPDATE | `apps/api/src/auth-service.ts:205-227`, `packages/sql/src/session-repo.ts:29-33` |
| Every pull prunes the feed (2 DELETEs) | `apps/api/src/sync-service.ts:944`, `packages/sql/src/sync-repo.ts:317-329` |
| Dashboard = 5 sequential range queries | `apps/api/src/task-service.ts:1162-1206` |
| `/today` re-reads auth + preferences | `apps/api/src/today-routes.ts:45-101` |
| App layer rebuilt per request | `apps/api/src/index.ts:126-146`, `http-layer.ts:119-139` |
| No placement / no location hint / no read replication | `infra/alchemy.run.ts:40-42`, `190-215` |
| Assets: default `max-age=0, must-revalidate`, no `_headers` | `apps/web/public/`, [CF headers docs](https://developers.cloudflare.com/workers/static-assets/headers/) |
| Splash on every route change | `apps/web/src/App.tsx:23-26`, `components/form.tsx:123-143` |
| Nav links are plain `<a>`, no preload | `apps/web/src/components/app-header.tsx:100-104`, `158-166` |
| Full-type IndexedDB reads on every notify | `routes/today.tsx:184-228`, `local-store/store.ts:160-166`, `175-180` |
| 3.5 s poll cadence | `lib/sync-cadence.ts:24-66`, `components/sync-runner.tsx:39-56` |
| Service worker fetch handler is a no-op | `apps/web/public/sw.js:40` |
| API bundle 777 KB | `infra/.alchemy/bundles/tali-dev_ronin-TaliApi/index.js` |
| Client first-paint JS ~136 KB gzip | `apps/web/dist/client/assets/*` (gzip measured) |
| D1 serialises queries; batch reduces request count | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 read replication needs the Sessions API | [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) |
| Placement: 20–30 ms → 1–3 ms per query; DO SQLite zero-latency | [Workers placement](https://developers.cloudflare.com/workers/configuration/placement/) |
| Worker cold start single-digit ms; bundle eval is the real cost | [Eliminating cold starts](https://blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers), [part 2](https://blog.cloudflare.com/eliminating-cold-starts-2-shard-and-conquer) |
| Workers Paid $5/mo; D1 free/included quotas | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Convex: $0 / $25 per dev; no official Solid package | [pricing](https://www.convex.dev/pricing), [Convex SolidJS guide](https://www.convex.dev/typescript/ecosystems-integrations/frameworks/solidjs-typescript) |
| TanStack DB has an official Solid adapter (beta) | [TanStack DB Solid](https://tanstack.com/db/latest/docs/framework/solid/overview), [npm](https://www.npmjs.com/package/@tanstack/solid-db) |
| Electric 1.0, read-path, PAYG pricing | [Electric 1.0](https://electric.ax/blog/2025/03/17/electricsql-1.0-released), [pricing](https://electric.ax/pricing), [TanStack DB 0.6](https://electric.ax/blog/2026/03/25/tanstack-db-0.6-app-ready-with-persistence-and-includes) |
| Zero 1.0 + built-in Solid + no offline writes | [Zero Solid](https://zero.rocicorp.dev/docs/solidjs), [when to use](https://zero.rocicorp.dev/docs/when-to-use), [InfoQ](https://www.infoq.com/news/2026/06/zero-version-1) |
| LiveStore Solid is experimental; 0.4/0.5 | [LiveStore examples](https://docs.livestore.dev/examples), [Expo blog](https://expo.dev/blog/local-first-application-development-with-livestore) |
| PowerSync free 2 GB / Pro $49 | [powersync.com/pricing](https://powersync.com/pricing) |
| InstantDB official Solid SDK; $0 / $30 | [Instant Solid docs](https://www.instantdb.com/docs/start-solidjs.md), [pricing](https://www.instantdb.com/pricing) |
| Neon autosuspend after 5 min, wake ~hundreds of ms | [Neon cold starts](https://neon.com/docs/connect/connection-latency) |
| Supabase free pauses after 1 week; Pro $25 | [Supabase pricing](https://supabase.com/pricing) |
| Hetzner cloud from €5.99/mo | [hetzner.com/cloud](https://www.hetzner.com/cloud/) |
| Fly machines $2.19/mo; managed PG $38 | [Fly pricing](https://fly.io/docs/about/pricing/) |
| Railway Hobby $5 incl. $5 usage | [railway.com/pricing](https://railway.com/pricing) |
| Render $7 web + $6 Postgres | [render.com/pricing](https://render.com/pricing) |
| Vercel Pro $20/seat | [vercel.com/pricing](https://vercel.com/pricing) |

---

## 10. Appendix — before/after estimate table

Assume S1 (15 ms/statement) and a mid-range Android, 4G.

| Metric | Today (est.) | After Phase 0 | After Phase 1 |
| --- | --- | --- | --- |
| API requests to first screen | 6–7 | 1–2 | 1 |
| D1 statements to first screen | ~35 | ~8–10 | ~4–6 |
| Writes on a read | 3 | 0 | 0 |
| Requests/hour, idle tab | ~1,030 (3.5 s poll) | ~1,030 | ~0 (WS/SSE) |
| Full mirror scans/hour | ~2,060 | ~120 | ~2 |
| Boot-to-interactive (warm) | 0.9–1.4 s | 0.4–0.7 s | 0.3–0.5 s |
| Boot-to-interactive (cold isolate) | +40–80 ms | +40–80 ms | +40–80 ms |
| In-app nav (splash → content) | 300–900 ms | 80–150 ms | <50 ms |
| First-paint JS (gzip) | ~136 KB | ~136 KB | <60 KB |
| Repeat-visit asset requests | revalidate all | 0 (immutable) | 0 |

If the deployment is in the S2 regime (D1 on another continent), every "today" number above is 3–6× worse and Phase 0 item #1 alone recovers most of it — which is why it is first.
