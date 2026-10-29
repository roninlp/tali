# Tali deploy latency & platform research — report (mimo)

**Scope:** Independent architecture research for the Tali repo (pnpm + Turborepo monorepo, Solid v2 SPA + Effect API on Cloudflare Workers/D1 via Alchemy). No application code was changed; no servers were run. All file references are `file:line` into the repo as of 2026-10-29. External facts (pricing, Solid support, maturity) were verified live on 2026-10-29 and are cited in §11.

---

## 1. Executive summary

**The deployed lag is mostly self-inflicted, not Cloudflare-inherent.** Tali's client is already local-first (IndexedDB mirror + outbox + cursor sync), so warm navigation should be ~0 ms of network — and mostly is. What the user perceives as "Cloudflare is slow" traces to four concrete, fixable costs:

1. **The API Worker rebuilds its entire Effect application layer on every request** (`apps/api/src/index.ts:126-146`): `makeAppLayer()` constructs ~15 services + ~15 repositories and `HttpRouter.toWebHandler` builds a fresh router, per `fetch`, then tears it down. On a 6.2 MB Worker bundle (measured: `infra/.alchemy/bundles/tali-demo-TaliApi/index.js` = 6.2 MB raw) this is the dominant warm-request CPU cost and the reason cold starts hurt: every cold isolate pays bundle fetch + V8 compile + eval (Cloudflare's hard startup budget is 1 s, and it scales with bundle size), *then* the layer graph is built again inside the request.
2. **A serialized auth round trip gates first paint.** `AuthProvider` boots to `status="checking"` and calls `/auth/me` (`apps/web/src/lib/auth.tsx:80-106`); the `Guard` renders a splash until it settles (`apps/web/src/components/guard.tsx:42-45`). `/auth/me` runs 3 SELECTs **plus a session-sliding UPDATE** (`apps/api/src/auth-service.ts:218-220`), so even a warm request is ~4 sequential D1 queries — and if the API isolate is cold (it is, after any idle period; a household app has bursts separated by hours), the user stares at a splash for the full cold start.
3. **A 3.5-second sync poll keeps the network and main thread busy** (`apps/web/src/lib/sync-cadence.ts:24`; wired in `apps/web/src/components/sync-runner.tsx:39-56`). Every pass hits `/sync/pull`, whose server path costs ~8–12 D1 queries including a `prune` DELETE (`apps/api/src/sync-service.ts:944`) and the session UPDATE. Worse, every applied pull fires the store subscriber, and the Today screen responds by re-reading the **entire** task + note mirror from IndexedDB (`apps/web/src/routes/today.tsx:195-210` → `store.list()` = `index.getAll()`, `apps/web/src/lib/local-store/store.ts:163-164`). On a phone this is recurring jank.
4. **No immutable cache headers on hashed assets and no route prefetch.** `apps/web/dist/client/` has no `_headers` file, so Cloudflare serves assets with its default caching (edge-cached, but no browser `immutable` promise). First visits to `/calendar` (79 KB), `/tasks` (50 KB) each fetch a chunk over the network at click time.

Rough cold-boot math for a household user (Iran-adjacent RTT ~40–80 ms to the nearest colo): HTML+~140 KB gz JS at the edge, then **4 API round trips** (`/auth/me` → then `/preferences`, `/today`, `/sync/pull` in parallel), each paying cold-isolate start (est. **100–350 ms** for this bundle) on the first one plus D1 latency. Total boot-to-interactive easily **0.8–2 s**, and every page reload re-pays it. That matches "feels very laggy / slow after cold starts".

**Recommendation: do not re-platform.** Apply the in-place fixes in §7.1 (≈1–3 days of work): hoist the app layer to module scope, throttle the session-sliding write, boot from the cached session optimistically, debounce/granularize mirror reads, add `_headers` immutable caching, prefetch route chunks, and consider a longer active poll (10–15 s) or an SSE/Durable-Object push channel. These attack every measured cost driver and preserve the valuable assets (Effect domain, typed RPC, custom sync protocol, RTL UI). **Convex is a poor fit** for this codebase (React-first, community-only Solid adapters, replaces the Effect stack wholesale). **ElectricSQL + TanStack DB is the one re-platform worth considering later** — it now has an official Solid adapter (`@tanstack/solid-db`), Electric's PAYG cloud is effectively free at household volume (<$5/mo waived), and it keeps your Effect server for writes while deleting the hand-rolled sync protocol. Even that is only justified if realtime cross-device updates become a core requirement (§7.4 decision rule).

---

## 2. Method and evidence

- **Repo reading:** apps/web (router, routes, providers, sync engine, local store, built `dist/client`), apps/api (entry, HTTP layer, auth/today/sync services, routes), packages/rpc, packages/sql (repos + 14 migrations), packages/config, infra/alchemy.run.ts, wrangler.test.jsonc, public/sw.js.
- **Bundle measurement:** actual built output in `apps/web/dist/client/assets` (raw `du -b` and `gzip -c | wc -c`), API Worker bundle via `infra/.alchemy/bundles/*/index.js`.
- **External verification:** Cloudflare Workers/D1/Static-Assets pricing & limits docs (developers.cloudflare.com), Electric (incl. its Cloud pricing page and the "joining Neon at Databricks" announcement), TanStack DB Solid adapter docs, Rocicorp Zero 1.0 (InfoQ, June 2026), Convex pricing/open-source pages, InstantDB Solid docs, PowerSync changelog, LiveStore docs, and hosting pricing pages (Fly, Railway, Render, Hetzner, Supabase, Neon, Turso, Vercel, Firebase). Full URL list in §11.
- **What I did not do:** no profiling against the live deployment, no load tests. Latency figures for cold starts and D1 are estimates with stated assumptions (§10). The single most valuable next step is a 10-minute measurement: `curl -w '%{time_total}'` on `/health` and `/today` from two locations, once immediately after deploy (cold) and once after an idle hour.

---

## 3. Architecture map (real request/data flow)

### 3.1 Web (Solid v2 client-only SPA)

- **Routing:** file-system routes via `filesystem-routing` (`apps/web/vite.config.ts:9-14`), assembled in `apps/web/src/router.ts:5` with `@solidjs/router` (`createRouter({ routes: fileRoutes(pageRoutes) })`). Client-only; the shell is prerendered into `dist/client/index.html` (Vite "turnkey client mode", `vite.config.ts:6-8`).
- **App shell providers** (`apps/web/src/App.tsx:12-34`): `AuthProvider → PreferencesProvider → PushProvider → LocalStoreProvider → SyncRunner + Router`. The router wraps children in `<Loading fallback={<Splash/>}>`.
- **Boot waterfall (cold, signed-in, online):**
  1. `AuthProvider` `onSettled → refresh()` → **GET `/auth/me`** (`auth.tsx:104-106`). Until it settles, `status==="checking"`; every guarded route renders `BootScreen` (`guard.tsx:27,43`). This is a hard serialization in front of all app content. A cached session is only used **on failure** (`auth.tsx:92-98`), not optimistically.
  2. Once `signedIn`: `LocalStoreProvider` opens the per-user IndexedDB mirror (`local-store/context.tsx:186-225`); `PreferencesProvider` adopts the synchronous localStorage cache, then fires **GET `/preferences`** (`preferences.tsx:139-152`).
  3. The route mounts. On Today: mirror-first render + **GET `/today`** revalidation with `If-None-Match` (`routes/today.tsx:230-259`, `lib/today/api.ts:56-70`).
  4. `SyncRunner` starts the poll loop with an **immediate pass → GET `/sync/pull`** (`sync-runner.tsx:39-56`, engine in `lib/sync-engine.ts:207-223`).

  ⇒ **4 API round trips on every full page load**, 1 of them blocking first paint.

- **Navigation (warm SPA):** no network for most screens — they render from the IndexedDB mirror (e.g., `lib/rpc.ts:80-83` notes "screens render from the local mirror"). Exceptions: Today's mount revalidation (`today.tsx:235`), and first-visit lazy chunks (calendar 79 KB / tasks 50 KB / today 38.6 KB — see §4.3). No prefetch anywhere (no `preload`/`rel=prefetch` emitted; only the four boot modules are `modulepreload`ed in `dist/client/index.html`).
- **Sync cadence:** 3.5 s active, 15 s visible-idle, 30 s hidden, 1–30 s jittered on failure (`lib/sync-cadence.ts:24-32`). A local write wakes an immediate pass (`components/sync-runner.tsx:63-73`).
- **Service worker:** registered for push only (`lib/push/service-worker.ts:32`); its `fetch` listener is deliberately empty and network-only (`public/sw.js:38-40`) — **it does not intercept or slow navigation.** Ruled out as a cause.
- **RPC client:** `api.*` wrappers each build a fresh `RpcClient` + provide layers + `Effect.scoped`, per call (`lib/rpc.ts:61-76`). Used by hydration/service paths and the sync engine's habit repair (`sync-engine.ts:192-193`), not by screen rendering.

### 3.2 API (Effect on Cloudflare Workers)

- **Entry** (`apps/api/src/index.ts:117-147`): every `fetch` computes CORS, then `makeAppLayer({vapid, devRoutes}).pipe(Layer.provide(D1Client.layer({db: env.DB,...})))` → `HttpRouter.toWebHandler(app)` → `handler(request)` → `finally { dispose() }`. **The full service graph is constructed and disposed per request.** The comment ("Builds one D1 layer per request — D1 has no connection pool, the binding is cheap", `index.ts:14-16`) justifies the D1 binding, but the code actually rebuilds *everything*: 15 service layers + 15 repo layers (`http-layer.ts:62-98`) plus the RPC server layer (`http-layer.ts:49-56`) and 10 route groups (`http-layer.ts:120-131`).
- **Auth:** `/auth/me` = sha256(token) → `sessions.findByTokenHash` → **`sessions.extend` UPDATE (sliding 30-day expiry, every call)** → `users.findById` → `memberships.findByUserId` (`auth-service.ts:205-227`). Every protected route resolves the principal this way (e.g., `today-routes.ts:45-67`, `sync.ts:85-94`).
- **`GET /today`:** principal (3–4 queries incl. the UPDATE) + `preferences.get` + `taskService.buckets` (multiple bucket SELECTs, `packages/sql/src/task-repo.ts:249-294`) + `listPinned` → **≈7–9 sequential D1 queries**, then schema encode + SHA-256 ETag (`today-routes.ts:84-96`).
- **`GET /sync/pull`:** principal (3–4 queries) + `repo.prune(cutoff)` **DELETE on every pull** (`sync-service.ts:944`) + `minSeq` + `pullFeed` + batched `findEntities` (chunked ≤5-term compound SELECTs, `packages/sql/src/sync-repo.ts:98-102,255`) ⇒ **≈8–12 D1 queries per poll, 2–3 of them writes.**
- **RPC (`POST /rpc`):** ndjson over `RpcServer.layerHttp` at `/rpc` (`http-layer.ts:49-56`); contract in `packages/rpc/src/api.ts` (~150 RPC surface references; `ApiRpcs` group at line 563).
- **Cron:** three triggers on the same Worker (`packages/config/src/index.ts:26-30`): `* * * * *` reminder sweep, `17 3 * * *` purge, `47 3 * * *` R2 backup; dispatched in `scheduled()` (`index.ts:171-235`). The per-minute sweep rebuilds the whole app layer 1,440×/day too (same per-invocation construction), and **does not warm HTTP isolates** — cron and fetch invocations are not guaranteed to share an isolate.
- **Migrations:** applied at deploy by Alchemy (`infra/alchemy.run.ts:39-41`); **no per-request migration checks** — ruled out as a cost.

### 3.3 Infra (Alchemy)

- One stack (`infra/alchemy.run.ts:192-235`): D1 (+migrations), R2 backup bucket with 30-day lifecycle, api Worker (crons, VAPID secret, `DEV_ROUTES`), and a web `StaticSite` whose `worker.ts` forwards `/api/*` to the api Worker over a **service binding** (`apps/web/worker.ts:29-41`; `runWorkerFirst: ["/api/*"]`, `alchemy.run.ts:218-221`). Service-binding hops cost no extra request fee and skip the public internet ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)), but **both isolates must be warm**, and every API request pays web-Worker → api-Worker dispatch.
- `VITE_API_URL=/api` at deploy (`alchemy.run.ts:223`); resolved at runtime against `location.origin` (`lib/config.ts:15-22`).
- **No `_headers` in `apps/web/public/`** → static assets get Cloudflare's default caching (edge automatic + tiered cache per [Static Assets docs](https://developers.cloudflare.com/workers/static-assets/); browser `Cache-Control` is whatever the asset serving default emits, with no `immutable` guarantee). `_headers` supports up to 100 rules ([limits](https://developers.cloudflare.com/workers/platform/limits/#static-assets)) — an unused lever here.

### 3.4 Storage (D1/SQLite)

- 14 migrations (`packages/sql/migrations/0001…0013`), FTS5 for notes (`0009_note_search.sql`), a global-seq `change_feed` for sync (`0003_sync_engine.sql`), 90-day feed retention (`sync-service.ts:943`, `sync-repo.ts:317-326`). No interactive transactions anywhere — multi-row writes use `D1Client.batch` (`auth-service.ts:116-124`). The repo already carries D1-isms worth noting: compound SELECT capped at 5 terms (`sync-repo.ts:98-102`) — a portability tax if you ever leave SQLite.

---

## 4. Diagnosis: cost drivers, separated

### 4.1 (a) Cloudflare Worker cold start / isolate init

- **Bundle size is the cold-start lever.** Cloudflare: "Larger Worker bundles can impact startup time", with a hard 1-second startup budget ([limits: Worker size & startup time](https://developers.cloudflare.com/workers/platform/limits/)). The api Worker bundle measures **6.2 MB raw** (≈1.3–1.5 MB gzipped). Cloudflare's own history: small Workers cold-started in ~5 ms, but cold start = fetch source from storage + compile + eval, and scales with bundle size ([Eliminating cold starts 2: shard and conquer](https://blog.cloudflare.com/eliminating-cold-starts-2-shard-and-conquer/)). Realistic estimate for this bundle: **100–350 ms** on a cold isolate in the serving colo (assumption, §10).
- **Per-request layer construction multiplies this.** Even on a warm isolate, each request pays the Effect graph build + `toWebHandler` setup (`index.ts:126-140`). Cloudflare's own guidance: average Worker ≈ 2.2 ms CPU/request; heavier ones 10–20 ms ([limits: CPU time](https://developers.cloudflare.com/workers/platform/limits/)). An Effect app of this size with per-request memoized layer construction plausibly lands at **15–40 ms CPU per request** — the single biggest warm-path cost, and the reason the app cannot comfortably live on the Free plan's 10 ms/request CPU cap. (Estimate; measure with Workers Logs CPU metrics or `wrangler` CPU profiling.)
- **Two-isolate chain:** `/api/*` traverses web Worker → service binding → api Worker (`apps/web/worker.ts:37`). If the api Worker is cold, the web Worker just waits; the binding saves internet hops but not isolate startup.
- **Per-minute cron does not keep HTTP warm.** The reminder sweep fires 1,440 invocations/day (`packages/config/src/index.ts:27`), each rebuilding the layer graph (`index.ts:220-234` → `runReminderSweep(env, now)`); cron isolates are not guaranteed to be the ones serving `fetch`. Cost-wise it's inside the included 30M CPU-ms/mo, but it burns the same construction overhead for nothing measurable in latency.
- **Verdict:** Cloudflare cold starts are *not* categorically unviable — but this Worker sits near the bad end of the size/initialization curve, and the request path re-does work that should be module-scope.

### 4.2 (b) D1 latency and query patterns

- **No per-request migrations** (deploy-time only) — fine.
- **Sequential query stacks:** `/today` ≈7–9 sequential round trips to the D1 primary; `/sync/pull` ≈8–12. D1 queries are individually fast (single-digit ms, same-region; no egress charges, [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)), but they serialize: at ~3–8 ms each, a warm `/today` is ~25–70 ms of D1 alone. Not the main villain, but it amplifies the layer-build cost.
- **Write amplification on the read path:** session sliding expiry on **every** authenticated request (`auth-service.ts:218-220`) and a feed `prune` DELETE on **every** pull (`sync-service.ts:944`). For a read-heavy local-first app this is backwards: reads should not write. It also doubles D1's per-write index-maintenance cost and keeps the session/feed tables churning at the 3.5 s cadence.
- **N+1?** No egregious N+1 — `findEntities` is batched per entity type (`sync-repo.ts:131-150`), buckets are a handful of range SELECTs (`task-repo.ts:249-294`). The problem is *request count × query count*, not per-row loops.
- **Indexes:** the migrations define indexes on the hot paths (e.g., `byEntityType`-style access patterns and feed `seq`); nothing jumped out as missing for current queries. D1 bills rows-read per scan, so an unindexed scan would show up in billing, not just latency ([D1 pricing definitions](https://developers.cloudflare.com/d1/platform/pricing/#billing-metrics)).
- **Region:** D1's primary is pinned at creation; a household in Iran→nearest colo (e.g., Bahrain/Istanbul/Dubai) adds RTT to every one of those sequential queries. D1 read replication ([docs](https://developers.cloudflare.com/d1/best-practices/read-replication/), no extra charge) is a cheap lever if read latency matters.

### 4.3 (c) Client-side SPA issues

Measured first-load JS (dist/client/assets, raw / gzip):

| Chunk | Raw | Gzip | Role |
|---|---|---|---|
| `routing-D_JCpAP0.js` | 255.2 KB | 84.3 KB | Effect core (pipe/arity/`Schema` markers found) + router wiring — **modulepreloaded at boot** |
| `tokens-CygkWzAK.js` | 67.7 KB | 24.6 KB | Effect/schema runtime — modulepreloaded |
| `rpc-CvWa1vP3.js` | 44.2 KB | 14.1 KB | `RpcClient` + schemas — modulepreloaded |
| `virtual_solid-ssr-entry-client-*.js` | 42.1 KB | 14.1 KB | Solid entry/app shell |
| CSS | 4.9 KB | ~1.4 KB | base styles |
| `vazirmatn-variable.woff2` | 111.2 KB | — | self-hosted RTL font |
| **Boot total** | **≈525 KB** | **≈249 KB (≈138 KB JS)** | |

Route chunks (lazy, first click only): calendar 79.0 KB (21.4 gz), tasks 49.7 KB (14.5 gz), today 38.6 KB (11.4 gz), habits 17.7 KB, notes/list detail ~11–15 KB each.

- **The Effect runtime is ~85% of boot JS** (routing+tokens+rpc ≈ 367 KB raw / 123 KB gz). It buys typed RPC and schemas client-side; it is not free. Not the top suspect for *navigation* lag, but it is the largest parse/compile cost on low-end phones (est. 60–150 ms on a mid-range Android).
- **Auth splash gate** (§3.1): `/auth/me` blocks all guarded content. On a cold API isolate this is the "app is frozen" moment. The session cache (`lib/session-cache.ts`, used only on failure at `auth.tsx:92-98`) could paint instantly and reconcile — Preferences already does exactly that pattern (`preferences.tsx:118-152`).
- **3.5 s polling + full-mirror reloads:** every pull that applies rows fires `store.subscribe` → Today's `reload()` re-`getAll`s **all** tasks and notes (`today.tsx:195-210`; `store.ts:163-164`). With, say, 1–3k mirrored rows this is a recurring main-thread + IDB transaction every few seconds — perceptible jank on phones, and it contends with route transitions. Other screens subscribe similarly.
- **Per-call RPC runtime:** `withClient` builds and tears down an Effect client per call (`rpc.ts:61-76`). Small (ms), but free to fix (memoize one client).
- **No route prefetch.** Solid Router supports preload; none is used, so the first click on Calendar downloads 79 KB and parses it mid-interaction.
- **Service worker: innocent** (`public/sw.js:38-40` — empty fetch handler).

### 4.4 (d) Deployment / asset-serving issues

- **No `_headers`** → no `immutable, max-age=31536000` on hashed `/assets/*`, and no `no-cache` on `index.html`. Cloudflare edge-caches assets automatically with tiered caching ([Static Assets: Caching behavior](https://developers.cloudflare.com/workers/static-assets/#caching-behavior)), so repeat visits are usually cheap — but the browser cache contract is unspecified, and after any expiry/refresh the SPA revalidates assets at click time. One 8-line file fixes it.
- **SPA fallback is configured correctly** (`notFoundHandling: "single-page-application"`, `alchemy.run.ts:219`) and `/api/*` runs the Worker first (`alchemy.run.ts:220`). No misrouting found.
- **Two-Worker indirection** adds a warm-path micro-hop and a second isolate to keep warm (§3.3). Merging the API into the web Worker (it's the same runtime) would remove one isolate from the critical path — optional, listed in §7.1.

### 4.5 Quantified round trips (deployed, cold-ish, household user)

| Phase | Network round trips | Notes |
|---|---|---|
| Shell load | 1 HTML + 4 JS + 1 CSS + 1 font (edge) | ~249 KB compressed total; assets cached at the CF edge |
| Auth gate | **1 (serialized):** `/auth/me` | 3–4 D1 queries incl. 1 write; **blocks first paint**; pays cold isolate if idle |
| Post-auth fan-out | 3 (parallel): `/preferences`, `/today`, `/sync/pull` | `/today` ≈7–9 D1 queries; first `/sync/pull` ≈8–12 |
| Navigation (warm, mirror-hit) | 0 | except Today mount `/today` revalidation and first-visit chunks |
| Background (tab active) | `/sync/pull` every **3.5 s** (15 s idle / 30 s hidden) | ≈1,000–3,000 pulls per 3–8 h session; each ≈8–12 D1 queries |

Cold-boot API-side time estimate: cold isolate (100–350 ms, first request only) + 4 × (RTT 40–80 ms + 20–80 ms processing) ⇒ **≈0.5–1.5 s** of API wait before the screen is fully live; the `/auth/me` slice is fully serialized in front of content. Warm reload: ≈150–350 ms. This is exactly the "laggy until everything connects" experience described.

---

## 5. Removing Cloudflare as a deployment target

### 5.1 What Cloudflare gives this app today

- Static assets + SPA fallback + same-origin API proxy in one deploy (`alchemy.run.ts:212-226`), PWA/push sharing the origin (`worker.ts:1-18`).
- D1 (serverless SQLite — zero ops), R2 backups, three crons including a **per-minute** trigger (ADR-0005), Web Push egress with VAPID.
- Effect runs natively: the api is a plain `async fetch` module (`index.ts:117`), no framework bridge.
- Cost at household scale: **$5/mo** (Workers Paid; includes 10M req + 30M CPU-ms; D1 free allowances are huge — 5M rows-read/day on Free, and paid included volumes dwarf this app) — [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). Nothing about the *cost* or *capability* forces a move.

### 5.2 What actually hurts on Cloudflare (and follows you if unfixed)

Cold isolate + per-request layer build + auth splash + 3.5 s polling are architecture costs, not vendor costs. A Fly Machine has no cold start, but the layer rebuild, the splash gate, and the poll churn would still be there. **Fix these first; the platform decision gets easier afterward.**

### 5.3 Migration cost off Alchemy/D1 (if you did leave)

- **Off Alchemy only (stay on Cloudflare):** trivial — `wrangler.jsonc` mirrors what `alchemy.run.ts` declares (the test config `apps/api/wrangler.test.jsonc` already shows the shape). Alchemy is still pre-1.0 beta (see `docs/research/alchemy-v2-cloudflare.md`), so this is a *risk* swap, not a latency swap.
- **Off Workers to Node:** small. `apps/api/src/index.ts` is the only Worker-specific file; `makeAppLayer` + `HttpRouter.toWebHandler` are portable to `@effect/platform`'s Node server (or even the Web-standard handler behind `@effect/platform-node`). Cron → `node-cron`/system timer; R2 → filesystem/S3; VAPID/push code is plain crypto + fetch.
- **Off D1 to Postgres/libSQL:** the real work. `@effect/sql-d1` → `@effect/sql-postgres` or `@effect/sql-libsql`; port 14 migrations; replace SQLite-isms: FTS5 note search (`0009`) → `tsvector`/`pg_trgm`, `json_each` tag filtering (`task-repo.ts:177-183`) → `jsonb` operators or arrays, 5-term compound-SELECT cap disappears. Est. **3–7 days** for someone who knows the schema.
- **Push:** portable everywhere (web-push is an open protocol); no platform lock-in.
- **D1 lock-in verdict:** low-moderate. The schema is SQLite-flavored but the repositories sit behind `@effect/sql` abstractions; nothing uses D1-specific APIs beyond the binding (`auth-service.ts:116` uses `d1.batch`, which maps to any driver's batch).

---

## 6. Data/sync architectures (verified as of late 2026)

> Tali already *is* local-first: IndexedDB mirror + outbox + LWW/tombstone conflicts + cursor feed (`docs/sync-protocol-draft.md`, `lib/sync-engine.ts`). The question for each option is: does it delete this hand-rolled engine (and its ~60 KB of client code + ~55 KB of server code) with something better, and does it respect Solid 2.0 RC (Tali pins `solid-js@2.0.0-rc.14`, `apps/web/package.json:23`)?

### 6.1 Convex

Reactive TS backend (queries in the DB, live subscriptions, functions, crons, storage). **Pricing:** Free & Starter $0 (generous: ~1M function calls, 0.5 GB), Professional $25/dev/mo; April 2026 re-price moved to data-egress metering ($0.12/GB) ([convex.dev/pricing](https://www.convex.dev/pricing), [third-party summary](https://whichdevtool.com/tools/convex/)). **Open source:** the backend is open ([github.com/convex/convex-backend](https://github.com/convex/convex-backend)) and self-hostable via Docker on Fly/Neon/SQLite ([self-hosting guide](https://docs.convex.dev/self-hosting), [announcement](https://news.convex.dev/self-hosting/)) — lock-in is a real but bounded concern. **Solid support:** the reactive client is framework-agnostic (WebSocket), but the official integration story is React; Solid has *community* bindings only ([convex-solidjs](https://github.com/Frank-III/convex-solidjs), [solid-convex](https://github.com/jamwt/solid-convex)); Convex's own site hosts a Solid+TS guide page but ships no official `@convex/solid`. **Fit with Tali:** poor. Convex replaces the Effect server, the typed RPC contract, the SQL repositories, and the sync engine wholesale — the domain model (`packages/domain`), `packages/rpc`, and `packages/sql` all get rewritten as Convex schema + functions; typed errors become data returns; FTS5 note search becomes Convex search or external. Multi-step CAS/tombstone semantics (`sync-service.ts`) must be re-expressed inside Convex's transaction model. Migration: **weeks**. Latency: excellent (live queries, no polling), boot is instant-after-first-sync. Offline: client cache only; weaker than Tali's outbox (last-write-wins semantics differ from the existing conflict rules). Cron/push: crons yes; **Web Push must run on a separate Node/worker service** (Convex actions lack full crypto/subtle portability guarantees; commonly done via a small worker).

### 6.2 ElectricSQL + TanStack DB

Electric syncs *shapes* of Postgres to clients over HTTP/CDN (read path); writes go through your own backend — which maps cleanly onto Tali's Effect RPC. **Big news:** Electric is joining Neon at Databricks ([electric-sql.com](https://electric-sql.com/)); the product has pivoted toward an agents platform, but the sync engine remains Apache-2.0 and the hosted **Electric Cloud** is usage-based: **$1/1M writes, $0.10/GB-mo retention, reads/egress/fan-out free, bills under $5/mo waived** ([pricing](https://electric-sql.com/pricing)) — a family app would realistically pay **$0**. Postgres Sync service adds +$2/1M writes. **Solid support:** TanStack DB now ships an **official Solid adapter** with signal-integrated `useLiveQuery` ([docs](https://tanstack.com/db/latest/docs/framework/solid/overview)) — the strongest first-party Solid story in this space. **Fit with Tali:** the best of the re-platform options. The server stays Effect (auth, mutation RPC handlers); Postgres replaces D1 (the migrations port per §5.2); the custom `/sync/pull|push|bootstrap` protocol, the `change_feed`, and the client engine can be **deleted**, replaced by TanStack DB collections fed by Electric. Offline: TanStack DB has optimistic mutations + an offline story, though Tali's outbox semantics are more battle-tested today. Risks: Electric's strategic focus is now agents (support/priority risk for the classic shapes product); TanStack DB + adapter must be validated against Solid 2.0 RC; you must operate Postgres (Neon/Turso/Fly PG). Migration: **1–2 weeks**.

### 6.3 Rocicorp Zero

Client-side IVM (ZQL) over a `zero-cache` replica of your Postgres; queries run in the browser. **Stable 1.0 shipped June 2026** ([InfoQ](https://www.infoq.com/news/2026/06/zero-version-1/)) after ~2 years/50+ releases; MIT open source ([rocicorp/mono](https://github.com/rocicorp/mono)); works with *any* backend (writes via your API — again compatible with Effect). **Solid support: first-class** — official `@rocicorp/zero/solid` bindings + a hello-zero-solid quickstart ([install docs](https://zero.rocicorp.dev/docs/install), [quickstart](https://github.com/rocicorp/hello-zero-solid)) — **but** community reports the official bindings target Solid 1.x and don't work on `solid-js@2` RC yet ([gist](https://gist.github.com/russelgal/7a4c10d2f18eb8744281c69994df7514)). That is a direct hit for Tali's current pins. **Hosting:** self-hosted `zero-cache` (Node; Fly configs exist) — no managed tier to buy, so ops burden is yours. Offline: excellent (client cache + push via your mutations). Migration: port schema to Postgres + write a Zero schema + permissions DSL; delete the sync engine; keep Effect mutations. **1–2 weeks.** Verdict: technically excellent, but you'd be an early adopter of a Solid-2-incompatible adapter while Electric/TanStack DB offers the same shape with an official adapter.

### 6.4 LiveStore

Event-sourced reactive SQLite in the client with a built-in sync engine (0.5.x). Docs list a **Solid integration** alongside React (first-class), Vue (beta) and Svelte ([docs](https://docs.livestore.dev/framework-integrations/solid-integration/)); a parity test-suite issue is still open ([#326](https://github.com/livestorejs/livestore/issues/326)) — Solid support exists but is not first-class. Sync providers: Cloudflare Workers, ElectricSQL, PowerSync ([docs tree](https://docs.livestore.dev/)). It's **client-side architecture**, not a backend: Tali would still host the Effect API and add a sync provider. Fit: interesting as an *evolution* of the existing mirror (event log ≈ outbox), but it replaces the mirror layer wholesale and its Solid adapter is unproven on Solid 2 RC. Migration: 1–2 weeks + provider choice. Verdict: watch, don't adopt.

### 6.5 PowerSync

Hosted sync service (Postgres/MySQL/Mongo/Convex/DocumentDB sources) with client-side SQLite. **JS SDK v2.0** shipped July 2026 (cleaner API, smaller bundles; breaking but mechanical) ([changelog](https://powersync.com/blog/powersync-changelog-june-july-2026)); Sync Streams GA. **Solid:** community helpers only ([aboviq/powersync-solid](https://github.com/aboviq/powersync-solid)) — react-first ecosystem. Pricing: usage tiers with a free tier for hobby scale. Fit: viable, but weaker Solid story than TanStack DB/Zero/Instant, and it's a hosted sync layer with its own pricing meter. Migration: ~1–2 weeks.

### 6.6 InstantDB

Hosted realtime backend (its own HTAP store, not Postgres). **Official Solid SDK** (`@instantdb/solidjs`, docs: [start-solidjs](https://www.instantdb.com/docs/start-solidjs.md)) — genuinely first-party. Pricing: free tier + usage ([instantdb.com](https://www.instantdb.com/)). Fit: like Convex, it replaces the Effect/SQL/RPC stack with a proprietary data model (its own query lang, permissions rules); offline story is cache-only; the domain logic in `packages/domain` would survive but the persistence/authorization layers are rewritten. Migration: ~2 weeks. Lock-in: high (no self-host, no SQL). Verdict: best-in-class Solid support among BaaS, but a worse architectural fit than Electric/Zero because there's no Postgres underneath and no path for the Effect server.

### 6.7 Supabase (Postgres + Realtime)

Managed Postgres + Realtime + Auth + RLS + Storage. **Pricing:** Free tier (500 MB DB, 2 projects) but **free projects pause after ~1 week of inactivity** — fatal for a family app used in bursts; Pro $25/mo removes that ([supabase.com/pricing](https://supabase.com/pricing), [summary](https://www.stackrev.net/en/hostaging-platforms/supabase-pricing/)). Solid: `supabase-js` is framework-agnostic; community Solid helpers exist; realtime channels need manual signal wiring. Fit: Postgres is the right long-term database (see §6.2), and you don't need any Supabase service — plain Postgres (Neon/Fly/Hetzner) plus Electric/Zero gives more of what Tali needs. As a full BaaS it duplicates what Tali already built (auth, RLS vs your household scoping). Verdict: use the *database technology*, not the platform.

### 6.8 Turso / libSQL embedded replicas

Turso = hosted libSQL (SQLite lineage — closest to D1's engine). Free tier 5 GB; Developer from $4.99/mo ([turso.tech/pricing](https://turso.tech/pricing)); **embedded replicas** (SQLite file in your app process, streamed sync from Turso) deploy on Fly/Railway/Render ([docs](https://docs.turso.tech/features/embedded-replicas/with-fly)). Fit: excellent as the **D1 replacement in a Node port** — same SQL dialect (FTS5 included!), near-zero query latency once warm, trivial migrations from the existing files. It kills D1 latency without touching the sync design. Verdict: the cheapest latency win if you leave Cloudflare but keep SQLite.

### 6.9 PGlite

Postgres compiled to WASM, in-process ([Electric's PGlite](https://electric-sql.com/); "10 million weekly downloads" per Electric's homepage, 2026). Role: an offline/dev/sidecar Postgres — e.g., powering TanStack DB's local store. Not a server database. Verdict: an ingredient, not a target.

### 6.10 Neon (serverless Postgres)

Free plan: 1 GB/project, 20 GB total, **scale-to-zero after ~5 min**; Launch ≈ $0.106/CU-hour + $0.35/GB-mo storage post-Databricks ([neon.com/docs/introduction/plans](https://neon.com/docs/introduction/plans), [2026 breakdown](https://vela.run/articles/neon-serverless-postgres-pricing-2026/)). The natural Postgres home for Electric/Zero if you don't want to run one. Cold starts here are *compute* scale-to-zero (seconds to resume), which is fine behind a warm app server but another reason to keep an always-on API host.

### 6.11 Plain Postgres + keep Effect RPC (+ optimistic UI)

Everything §6.2 gives you, minus live reads: Node host (Fly/Hetzner) + Postgres + the existing Effect RPC + the *existing* sync protocol (it already works). Zero new frameworks. The sync protocol's main weakness — 3.5 s polling latency for remote changes — can be closed later with an SSE/WebSocket invalidation channel (a per-household broadcast of `seq` advances), keeping all merge logic client-side. Migration: the §5.2 port, **~1 week**. Verdict: the *conservative* re-platform; strictly less risk than any sync-product adoption, and it's a clean stepping stone to Electric later.

### 6.12 Firebase (Firestore)

Spark free plan (quotas; Cloud Functions need Blaze pay-as-you-go; Storage requires a billing account since Feb 2026) ([firebase.google.com/pricing](https://firebase.google.com/pricing), [plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)). Solid: community adapters; framework-agnostic core. Fit: worst on the list — NoSQL document model against a deeply relational domain (recurrence, occasions, habits, planning buckets), NoSQL security rules vs household scoping, no SQL/FTS5, and maximal lock-in with the weakest typed-Effect story. Verdict: reject.

---

## 7. Recommendation

### 7.1 Smallest fixes that remove the perceived lag WITHOUT re-platforming (do these first — ~1–3 days)

Ordered by (latency impact ÷ risk):

1. **Hoist the app layer out of the request path** (`apps/api/src/index.ts:126-146`). Build `makeAppLayer` once per isolate (module-scope lazy singleton keyed by the env it needs; keep the per-request D1 binding if desired). This is the highest-leverage change: it cuts *every* warm request's CPU (est. 15–40 ms → sub-ms setup) and shortens the cold-start tail, because a cold isolate then only pays bundle compile + a cheap handler. Also makes the per-minute cron cheap.
2. **Stop writing on every authenticated request.** In `auth-service.ts:218-220`, extend the session expiry only when less than ~10% of `SESSION_TTL_MS` remains (e.g., once/day per session). Removes one D1 write from `/auth/me`, `/today`, and every `/sync/pull`. (Optional follow-up: a 30–60 s per-isolate cache of the session→user/membership lookup; household membership rarely changes.)
3. **Boot from the cached session optimistically** (`auth.tsx:80-106`): if `readCachedSession()` returns a session, set `signedIn` immediately and reconcile with `/auth/me` in the background (the failure path already does this; mirror it for the happy path — same pattern as `preferences.tsx:118-152`). This deletes `/auth/me` from the critical paint path: **first paint no longer waits on any API round trip.**
4. **Debounce and narrow mirror reloads** (`today.tsx:195-210` and the sibling screens): coalesce `store.subscribe` notifications (e.g., 150–250 ms trailing debounce) and re-query only affected entity ids where possible instead of `getAll` of task+note on every sync pass. Eliminates the recurring jank at the 3.5 s cadence.
5. **Relax the active poll** (`sync-cadence.ts:24`): 3.5 s → 10–15 s for a two-person household (remote edits are rare; local writes already wake an immediate pass via `sync-runner.tsx:63-73`, so *your own* latency is unchanged). Halves background traffic and D1 churn. (If realtime feel matters later, do the SSE/DO channel — see 7.2 Phase 1 — before adopting any sync product.)
6. **Add `apps/web/public/_headers`**: `/assets/*` → `Cache-Control: public, max-age=31536000, immutable`; `/index.html` (and `/`) → `no-cache`. Guaranteed byte-identical reloads after the first visit; zero risk.
7. **Prefetch route chunks on intent**: Solid Router's `preload` on the nav links (`app-header.tsx`), or prefetch on pointerenter. Calendar (79 KB) and Tasks (50 KB) stop downloading at click time.
8. **Memoize one RPC client** (`rpc.ts:61-76`) instead of per-call layer construction. Small, free.
9. **Move the feed `prune` off the pull path** (`sync-service.ts:944`): run it from the nightly purge cron instead of every poll.
10. **(Optional) shrink the api Worker bundle** (~6.2 MB raw): the backup/dump machinery (`d1-backup.ts`, `d1-dump.ts`), push crypto, and dev-only code are cold-start tax for every HTTP request; splitting backups into a second Worker via service binding cuts the HTTP Worker's compile size. Also consider dropping `nodejs_compat` if truly unused (the config note at `alchemy.run.ts:166-168` suggests the default already covers it).
11. **(Optional) D1 read replication** for `/today`/`/sync/pull` if measurement shows the household is far from the D1 primary; same pricing.

**Expected result:** warm navigation already hits the mirror; after these fixes, cold *reload* to interactive drops from ~1–2 s to roughly (asset load ~200–400 ms on mobile) + (0 serialized API calls before paint) + (a background `/today` revalidation), and the idle-tab jank disappears. Re-measure before considering anything in §7.2.

### 7.2 If re-platforming is ever justified: target architecture

**Target (growth mode):** keep the monorepo and the valuable cores — `packages/domain` (Effect schemas, Jalali calendar, recurrence), `packages/rpc` (typed contract), `@tali/ui` — and change two seams:

- **Sync/read layer → Electric + TanStack DB (official Solid adapter).** Postgres becomes the database (migrations ported per §5.2; FTS5 → `pg_trgm`/`tsvector`). TanStack DB collections give instant local reads + live updates; the 60 KB hand-rolled engine, `change_feed`, `/sync/*` routes, and the 3.5 s poll disappear.
- **Write layer → unchanged Effect RPC** over the same `/rpc` contract, hosted on Node (`@effect/platform`) next to Postgres. Electric explicitly positions writes-through-your-backend as the model ([electric-sql.com](https://electric-sql.com/)), so the CAS/tombstone/`clientMutationId` logic you already trust stays exactly where it is — just pointed at Postgres instead of D1.
- **Hosting → one always-on small machine** (Fly `shared-1x` 256–512 MB ≈ $2.19–3.69/mo, or a Hetzner CX23 ≈ €5.49/mo) running API + cron + web-push; static SPA on Cloudflare/Vercel/CDN. Electric Cloud's PAYG is waived under $5/mo, so realistic total ≈ **$2–8/mo**, same ballpark as today.

**Phased migration plan (preserves value at each step):**

- **Phase 0 (now):** §7.1 fixes on Cloudflare. Re-measure. (1–3 days)
- **Phase 1 (only if remote-device latency is still a complaint):** push channel instead of polling — SSE endpoint or a Durable Object per household broadcasting `change_feed` seq advances; client keeps its merge logic and falls back to cursor pulls. Still no new frameworks. (~2–4 days)
- **Phase 2 (only if leaving Cloudflare):** port the API to Node (`index.ts` swap), SQLite via Turso embedded replicas or just a Litestream-backed file; same SQL, same tests (the vitest boundary suite already boots the app layer independently of Workers). Deploy to Fly/Hetzner. (~3–5 days)
- **Phase 3 (only if growth demands Postgres + live queries):** Postgres schema port, then Electric + TanStack DB over the read path, retiring the sync protocol. (~1–2 weeks)
- Each phase is independently shippable and reversible; the Effect domain/RPC/UI never get rewritten.

### 7.3 Decision rule

- **≤ ~10 households, one region, "good enough" realtime (seconds):** stay on Cloudflare with the §7.1 fixes. Optionally swap Alchemy for plain wrangler if the beta IaC bothers you. **Do not adopt a sync platform.**
- **You want cross-device updates in <1 s, or you're tired of polling/SSE plumbing:** Phase 1 (SSE/DO) first; Electric+TanStack DB only if you outgrow that.
- **Multi-region households, >~50 MAU, or a product ambitions shift (multi-tenant, public signup):** Phase 2→3 — always-on host + Postgres + Electric. That's also the point where Convex-class BaaS pricing ($25+/mo) starts making sense versus ~$0 sync on your own backend.
- **Leave Cloudflare** (to Fly/Hetzner) the moment measurement shows the residual pain is *not* isolate-related (e.g., you simply prefer one box you control, or D1 regionality can't be fixed); the Node port is small and removes an entire class of "cold" reasoning.

---

## 8. Pros / cons (every option compared)

### 8.1 Deployment targets

| Option | Pros | Cons |
|---|---|---|
| **Cloudflare + fixes (status quo)** | $5/mo flat; zero ops; same-origin SPA+API+push; per-minute cron; R2 backups already wired; Effect runs natively; D1 free allowances are enormous; global edge | Cold isolates + 6.2 MB bundle; per-request layer build (fixable); D1 regionality fixed at creation; no interactive transactions; Alchemy still beta |
| **Fly.io** | Always-on machines kill cold starts ($2.19–6.70/mo); Docker = any runtime incl. Node Effect; volumes/snapshots; auto-stop option; Turso/PG all supported | No free tier; you own OS/updates/TLS; single-region latency for far households; Managed Postgres is pricey ($38/mo) — use SQLite/Turso instead |
| **Railway** | Hobby $5/mo with included usage credits (some 2026 reports say $7 after a rise — verify); polished DX; Postgres add-on | Cold starts when scaled to zero; credit-overage surprises; vendor lock-in moderate |
| **Render** | Starter $7/mo always-on; free web services sleep (30–50 s cold starts — exactly the complaint); simple Git deploys | Free Postgres instances expire (90 days); slower cold starts than Fly; per-service costs add up (~$13/mo app+PG) |
| **Hetzner VPS + Docker** | Cheapest all-in (CX22/CX23 €4.35–5.49/mo *after* the June 2026 price rise); one box = API + SQLite/PG + cron + push; no cold starts ever; full control | You are the ops team (backups, security patches, IPv4 costs, downtime); no edge caching (put the SPA behind Cloudflare CDN anyway) |
| **Vercel/Netlify + managed PG** | Generous Hobby free tier (1M fn invocations, cron included); great SPA/CDN story; Fluid compute smooths function cold starts | Node Effect RPC must run as a function (fluid, but still scale-to-zero); Postgres is a separate vendor (Neon/Supabase) — two consoles; Hobby is non-commercial-only |
| **AWS (Lightsail/ECS/Fargate/Lambda)** | Everything, forever; Lightsail ~$5/mo single instance | Overkill; console/tax sprawl; Lambda cold starts + VPC/Postgres complexity; highest ops+attention cost per unit of value |

### 8.2 Data/sync architectures

| Option | Pros | Cons |
|---|---|---|
| **Convex** | Reactive queries, transactions, crons, storage in one; free tier fits household; backend open-sourced (self-host escape hatch) | **Replaces the Effect stack wholesale** (biggest migration on the list); Solid support is community-only; NoSQL-ish model vs relational domain; push needs a sidecar; per-dev pricing scales oddly for a "product" |
| **Electric + TanStack DB** | Official Solid adapter; keeps Effect server for writes; deletes the hand-rolled sync engine; Postgres underneath (FTS, JSONB, no 5-term SELECT cap); PAYG waived <$5/mo; Databricks/Neon backing | Requires Postgres ops (or Neon); Electric's strategic pivot to agents is a support-risk flag; Solid-2-RC adapter validation needed; offline story less battle-tested than Tali's outbox |
| **Rocicorp Zero** | Stable 1.0 (June 2026); MIT; any-backend (keeps Effect); first-party Solid bindings; instant local queries | Official Solid bindings lag Solid 2 RC (Tali's current pin); self-hosted zero-cache = more ops; younger ecosystem than Electric |
| **LiveStore** | Event-sourced model matches the outbox design; reactive SQLite; many platform adapters | Solid adapter exists but React is the first-class citizen; sync backend must still be chosen (Electric/PowerSync/CF); another framework in the client |
| **PowerSync** | Mature hosted sync; JS SDK 2.0 (2026); SQLite clients; many source DBs | React-first ecosystem (community Solid helpers); hosted meter; another vendor in the data path |
| **InstantDB** | **Official Solid SDK**; instant realtime; easy permissions | Proprietary data store (no Postgres, no self-host); replaces Effect/SQL layers; weaker offline than the custom engine; lock-in high |
| **Supabase (platform)** | Postgres + Realtime + Auth in one; Pro $25/mo | Free tier pauses after 1 week idle (bad for bursty family use); duplicates Tali's auth/scoping; Solid integration unofficial |
| **Turso embedded replicas** | Same SQLite engine as D1 (FTS5 survives!); sub-ms local reads; free tier 5 GB; deploys on Fly/Railway/Render | Not a sync/replatform by itself — pairs with a Node host; another hosted dependency (or self-host libSQL) |
| **PGlite** | Free, in-process Postgres; great for TanStack DB local state | Not a production server DB; complementary only |
| **Neon (plain)** | Free 1 GB + scale-to-zero; cheap Launch compute ($0.106/CU-h); Databricks-backed | Scale-to-zero wake latency if it's your only DB; needs an app server; pairs with §6.11/§6.2 |
| **Plain Postgres + Effect RPC (+SSE)** | Zero new frameworks; keeps every valuable asset; most boring/derifiable; easiest hiring/reading | You still hand-maintain sync invalidation (though a small amount); no productized live queries |
| **Firebase** | Mature push+auth+hosting bundle | NoSQL vs relational domain; security-rules vs household model; lock-in maximal; Blaze needed for functions/storage; worst Effect fit |

---

## 9. Scored comparison

Weights (household app, "remove perceived lag with least risk"): **perceived latency 25 · migration cost (lower effort = higher score) 20 · offline/local-first 15 · ops burden (lower = higher) 15 · $-cost at household scale 10 · lock-in/portability 10 · ecosystem/maturity 5.** Scores 1–5; weighted total out of 5.00.

| Option | Latency (25) | Migration (20) | Offline (15) | Ops (15) | Cost (10) | Lock-in (10) | Maturity (5) | **Weighted** |
|---|---|---|---|---|---|---|---|---|
| **A. Cloudflare + §7.1 fixes** | 4 | 5 | 5 | 5 | 5 | 4 | 4 | **4.60** |
| **B. Fly.io / Node Effect + Turso(SQLite)** | 5 | 4 | 5 | 3 | 4 | 4 | 4 | **4.25** |
| **C. Hetzner VPS + Docker (SQLite/PG)** | 5 | 4 | 5 | 2 | 5 | 5 | 4 | **4.20** |
| **D. Railway (Node + PG)** | 4 | 4 | 5 | 3 | 4 | 4 | 4 | **4.00** |
| **E. Render** | 3 | 4 | 5 | 3 | 3 | 4 | 4 | **3.70** |
| **F. Vercel + Neon Postgres** | 3 | 3 | 4 | 4 | 4 | 3 | 4 | **3.55** |
| **G. AWS (Lightsail/Lambda+RDS)** | 3 | 2 | 4 | 2 | 3 | 4 | 5 | **3.10** |
| **H. Electric + TanStack DB (keep Effect writes)** | 5 | 2 | 4 | 3 | 5 | 3 | 3 | **3.75** |
| **I. Plain Postgres + Effect RPC (+SSE)** | 4 | 3 | 4 | 3 | 5 | 5 | 5 | **4.00** |
| **J. Rocicorp Zero** | 5 | 2 | 5 | 2 | 5 | 3 | 3 | **3.70** |
| **K. Convex** | 5 | 1 | 3 | 5 | 4 | 2 | 4 | **3.45** |
| **L. LiveStore (+ own sync backend)** | 5 | 2 | 5 | 2 | 5 | 3 | 2 | **3.55** |
| **M. PowerSync** | 4 | 2 | 5 | 4 | 4 | 2 | 4 | **3.70** |
| **N. InstantDB** | 5 | 1 | 3 | 5 | 4 | 1 | 4 | **3.35** |
| **O. Supabase platform** | 3 | 2 | 3 | 4 | 3 | 2 | 4 | **3.00** |
| **P. Turso embedded (as D1 drop-in on any host)** | 5 | 4 | 5 | 3 | 4 | 3 | 4 | **4.15** |
| **Q. PGlite (client/sidecar only)** | 4 | 3 | 5 | 4 | 5 | 4 | 3 | **4.05** |
| **R. Neon plain (DB only, pairs with I)** | 3 | 3 | 2 | 4 | 4 | 4 | 4 | **3.40** |
| **S. Firebase** | 4 | 1 | 3 | 4 | 4 | 1 | 5 | **3.15** |

Reading: the top of the table is *stay-and-fix* (A) and *boring host swaps* (B, C, P) — exactly the §7 recommendation. Among re-platforms, the least-bad are I (plain PG + Effect, then add SSE) and H (Electric + TanStack DB) — the two that keep the Effect domain and RPC. Everything that replaces the backend wholesale (K, N, S) pays the migration tax it cannot win back at household scale.

---

## 10. Assumptions (stated)

1. **Cold isolate start for the 6.2 MB api Worker: 100–350 ms.** Derived from Cloudflare's stated model (fetch source + compile + eval; startup must fit in 1 s; larger bundles take longer — [limits](https://developers.cloudflare.com/workers/platform/limits/)) and its historical ~5 ms figure for *small* scripts ([blog](https://blog.cloudflare.com/eliminating-cold-starts-2-shard-and-conquer/)). Not measured on the live deployment.
2. **Per-request Effect layer build: 15–40 ms CPU.** Estimate from the size of the graph (15 services + 15 repos + RPC server + 10 route groups, `http-layer.ts:49-131`) and Cloudflare's "heavy workers use 10–20 ms" datapoint. **Must be validated** with Workers CPU metrics; if it turns out ≤5 ms, fix #1 is still correct but less dramatic.
3. **D1 query: ~2–8 ms** sequential per query (same-region primary; no egress charges). Assumes household devices are 30–100 ms RTT from the nearest Cloudflare colo (Iran-adjacent) — server-side D1 latency is RTT-independent, but each client-visible round trip adds RTT.
4. **Usage scale:** 1–3 users, a few thousand mirrored rows, tab open a few hours/day. Sync volume (~1–3k pulls/mo) is far below every included allowance; cost figures are dominated by fixed plan fees.
5. **Pricing** is as published on 2026-10-29 (URLs in §11); Railway's 2026 price change reports conflict ($5 vs $7 Hobby) — treat as $5–7. Hetzner prices reflect the 15 June 2026 adjustment.
6. **Solid 2.0 RC compatibility** of third-party adapters (Zero, LiveStore, TanStack DB Solid, community Convex/PowerSync bindings) is judged from docs/issues, not tested. Tali pins `solid-js@2.0.0-rc.14`; any adoption must be spiked against that pin.
7. No profiling data from the actual deployment was available; all ms figures are engineering estimates. The §2 closing suggestion (two curl timings, cold vs warm) is the cheapest way to replace estimates with facts.

---

## 11. Sources (URLs, retrieved 2026-10-29)

**Cloudflare**
- Workers pricing (incl. service-binding billing, static assets free): https://developers.cloudflare.com/workers/platform/pricing/
- Limits (1 s startup, bundle-size note, 2.2 ms avg CPU, static-asset `_headers` rules): https://developers.cloudflare.com/workers/platform/limits/
- D1 pricing (rows read/written, scale-to-zero, read replication): https://developers.cloudflare.com/d1/platform/pricing/
- D1 read replication: https://developers.cloudflare.com/d1/best-practices/read-replication/
- Static assets (routing, caching behavior, SPA fallback): https://developers.cloudflare.com/workers/static-assets/
- Static assets bindings (`run_worker_first`): https://developers.cloudflare.com/workers/static-assets/binding/
- Default cache behavior: https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
- Cold starts explainer ("shard and conquer"): https://blog.cloudflare.com/eliminating-cold-starts-2-shard-and-conquer/

**Sync / backend platforms**
- Electric home (Databricks/Neon announcement, PGlite downloads): https://electric-sql.com/
- Electric Cloud pricing: https://electric-sql.com/pricing
- TanStack DB Solid adapter: https://tanstack.com/db/latest/docs/framework/solid/overview
- Zero 1.0 (InfoQ, June 2026): https://www.infoq.com/news/2026/06/zero-version-1/
- Zero docs/install (first-class React + Solid): https://zero.rocicorp.dev/docs/install ; quickstart: https://github.com/rocicorp/hello-zero-solid ; repo: https://github.com/rocicorp/mono
- Zero Solid bindings vs Solid 2 RC caveat: https://gist.github.com/russelgal/7a4c10d2f18eb8744281c69994df7514
- Convex pricing: https://www.convex.dev/pricing (third-party breakdowns: https://whichdevtool.com/tools/convex/, https://toolradar.com/tools/convex/pricing)
- Convex open source / self-hosting: https://github.com/convex/convex-backend , https://docs.convex.dev/self-hosting , https://news.convex.dev/self-hosting/ , https://www.convex.dev/open-source
- Convex Solid (community): https://github.com/Frank-III/convex-solidjs , https://github.com/jamwt/solid-convex ; TS guide: https://www.convex.dev/typescript/ecosystems-integrations/frameworks/solidjs-typescript
- InstantDB Solid (official): https://www.instantdb.com/docs/start-solidjs.md , https://docs.instantdb.com/docs/start-solidjs
- PowerSync changelog (JS SDK v2.0, Jul 2026): https://powersync.com/blog/powersync-changelog-june-july-2026 ; client SDKs: https://docs.powersync.com/client-sdks/overview ; Solid helpers: https://github.com/aboviq/powersync-solid
- LiveStore docs (Solid integration, sync providers): https://docs.livestore.dev/framework-integrations/solid-integration/ , https://docs.livestore.dev/ ; parity issue: https://github.com/livestorejs/livestore/issues/326
- Supabase pricing: https://supabase.com/pricing ; free-tier pause details: https://www.stackrev.net/en/hosting-platforms/supabase-pricing
- Turso pricing: https://turso.tech/pricing ; embedded replicas on Fly: https://docs.turso.tech/features/embedded-replicas/with-fly
- Neon plans: https://neon.com/docs/introduction/plans ; 2026 breakdown: https://vela.run/articles/neon-serverless-postgres-pricing-2026/
- Firebase pricing: https://firebase.google.com/pricing , https://firebase.google.com/docs/projects/billing/firebase-pricing-plans

**Hosting**
- Fly.io pricing: https://fly.io/docs/about/pricing/
- Railway plans: https://docs.railway.com/pricing/plans ; price-change reports: https://www.getpricepulse.com/blog/railway-price-increase-2026.html , https://comparedge.com/tools/railway/pricing
- Render pricing: https://render.com/pricing ; cost snapshot: https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses ; free-tier sleep: https://costbench.com/software/developer-tools/render/
- Hetzner June 2026 price adjustment: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ ; current prices: https://trackvps.com/hetzner-cloud-pricing , https://northflank.com/blog/hetzner-cloud-server-price-increases
- Vercel pricing: https://vercel.com/pricing
