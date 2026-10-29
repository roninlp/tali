# Deploy latency & re-platforming analysis (Tali)

Date: 2026-10-29  
Repo: `/home/ronin/Projects/tali` (pnpm + Turborepo monorepo)  
Author: iceman (independent architecture research)  
Scope: Diagnose "very laggy" navigation / "super low cold starts" on Cloudflare (D1 + Workers + StaticSite), evaluate removing Cloudflare as target, evaluate Convex / ElectricSQL+TanStack DB / alternatives, recommend smallest fixes first, then re-platform path if justified.

> Constraints followed: read-only analysis; only this file created.

## Table of contents
- [1) Current architecture (as built)](#1-current-architecture-as-built)
- [2) Request/data flow for navigation (evidence)](#2-requestdata-flow-for-navigation-evidence)
- [3) Likely cold-start & per-navigation cost drivers](#3-likely-cold-start--per-navigation-cost-drivers)
- [4) Removing Cloudflare as deployment target (comparison)](#4-removing-cloudflare-as-deployment-target-comparison)
- [5) Data/sync architectures (Convex, ElectricSQL+TanStack DB, others)](#5-datasync-architectures-convex-electricsqltanstack-db-others)
- [6) Smallest fixes that avoid re-platforming (concrete)](#6-smallest-fixes-that-avoid-re-platforming-concrete)
- [7) Target architecture if re-platforming justified + phased migration](#7-target-architecture-if-re-platforming-justified--phased-migration)
- [8) Decision rule (single/few-household vs growth)](#8-decision-rule-singlefew-household-vs-growth)
- [9) Pros/cons tables](#9-proscons-tables)
- [10) Scored comparison (criteria + weights)](#10-scored-comparison-criteria--weights)
- [11) References (citations with URLs)](#11-references-citations-with-urls)

## 1) Current architecture (as built)

From repo inspection:
- **apps/web**: Solid v2 client-only SPA (Vite). Uses `@solidjs/router` with filesystem routes via `virtual:file-routes` + `@solidjs/router/fs` (`apps/web/src/router.ts:1-7`). App shell mounts providers in order: `AuthProvider`, `PreferencesProvider`, `PushProvider`, `LocalStoreProvider`, renders `SyncRunner`, then `<Router>` with `<Loading fallback={<Splash/>}>` (`apps/web/src/App.tsx:1-34`). Built with Vite 8, `@solidjs/vite-plugin` start mode, target `esnext` (`apps/web/vite.config.ts:1-39`). Deployed as static assets via Alchemy `Cloudflare.Website.StaticSite` with SPA fallback and `runWorkerFirst: ["/api/*"]` (`infra/alchemy.run.ts:212-226`). 
- **apps/api**: Effect HTTP/RPC server on Cloudflare Workers. Entrypoint `apps/api/src/index.ts:1-236` is a plain `async fetch` (module worker) building D1 layer per request via `D1Client.layer({ db: env.DB, transformQueryNames: Str.camelToSnake, transformResultNames: Str.snakeToCamel })` and serving via `HttpRouter.toWebHandler(app, { disableLogger: true })`. Cron schedules: reminder every minute, trash purge 03:17 UTC, backup 03:47 UTC (split invocations) from `CRON_EXPRESSIONS` shared via `@tali/config` (`infra/alchemy.run.ts:164-190`, `apps/api/src/index.ts:58-235`). Dev routes only when `DEV_ROUTES=1` (`alchemy dev`). 
- **packages**: `@tali/domain` (Effect/Schema entities+errors), `@tali/sql` (D1 repos + migrations under `packages/sql/migrations`, applied by Alchemy on deploy/dev), `@tali/rpc` (shared Effect RPC contract), `@tali/config`, `@tali/ui`.
- **Infra**: `infra/alchemy.run.ts` provisions D1, optional R2 backup bucket (lifecycle 30d), api Worker, web StaticSite, cron triggers. VAPID keys required for prod deploy (derived from private key at deploy time). 
- **Storage/Sync**: D1 (SQLite), no interactive transactions (only `batch()`), FTS5 for notes. Client uses Effect RPC over fetch to `/rpc` (`apps/web/src/lib/rpc.ts:1-266`) and plain-HTTP sync endpoints `/sync/pull`, `/sync/bootstrap`, `/sync/push` (`apps/api/src/sync.ts:1-207`, client in `apps/web/src/lib/sync-engine.ts:1-465`). Local-first: IndexedDB mirror + outbox, sync loop with backoff/wake logic (`apps/web/src/lib/local-store/*`, `apps/web/src/components/sync-runner.tsx:1-76`, `apps/web/src/lib/sync-cadence.ts` implied by usage). Service worker for push/actions (`apps/web/dist/client/sw.js:1-338`, source implied).
- **Routing in prod**: web Worker (`apps/web/worker.ts:1-120`) strips `/api` prefix and forwards to api via service binding so same-origin cookies work; client sets `VITE_API_URL=/api` in prod build env (`infra/alchemy.run.ts:200-226`, `apps/web/src/lib/config.ts:1-22`).

## 2) Request/data flow for navigation (evidence)

### Client boot/navigation
1. `App.tsx` mounts providers; `AuthProvider` calls `authApi.me()` on mount (`onSettled` -> `refresh()`), uses cached session if offline/network fails (`apps/web/src/lib/auth.tsx:55-192`). `LocalStoreProvider` opens IndexedDB mirror/outbox per user (`apps/web/src/lib/local-store/store.ts` referenced). `SyncRunner` registers sync handler and starts loop when `status==='ready' && online && !halted` (`apps/web/src/components/sync-runner.tsx:44-76`).
2. Router is filesystem-based (`apps/web/src/router.ts:1-7`). Routes are lazy-loaded via Vite dynamic imports in built bundle (e.g. `./today-WtHSzhmp.js`, `./reminders-BGlTnW-p.js` shown in built assets). Navigation is client-side SPA.
3. Per-route data: many routes read from local mirror via `useLocalStore()` and also call APIs. Example `apps/web/src/routes/today.tsx:1-912` fetches server read model via `fetchToday()` (calls `/today`?), overlays pending writes from mirror/outbox, falls back to mirror aggregation on offline/error. It also tracks `now()` minute tick for date rollover. 
4. RPC calls go through `api.*` wrappers in `apps/web/src/lib/rpc.ts` using `RpcClient.make(ApiRpcs)` over `FetchHttpClient` to `${API_URL}/rpc` with `credentials: 'include'` and `Effect.scoped` per call (`apps/web/src/lib/rpc.ts:61-76`). Each call creates a new client/scope - not pooled.
5. Sync: client polls `/sync/pull` (cursor-based) via `sync-engine.ts` `pullAll`, pushes outbox via `/sync/push`, handles repairs (habit entries, habit restores) (`apps/web/src/lib/sync-engine.ts:150-465`). Cadence backs off on failures, slows when hidden/idle, wakes on writes/reconnect/visibility (`apps/web/src/lib/sync-cadence.ts` implied).

### Server request handling
1. Worker `fetch` does CORS preflight/headers, builds app layer per request: `makeAppLayer()` merges routes (health, sync, auth, preferences, today, calendar, note search, push, reminders, RPC). Dev routes added conditionally. Layers provided: `ReminderSweepLive` (provided with `ServiceLayers`), `ServiceLayers`, `RepoLayers`, `PushConfig`. Then adds `D1Client.layer` with column name transforms and passes to `HttpRouter.toWebHandler(app, { disableLogger: true })` (`apps/api/src/index.ts:117-147`, `apps/api/src/http-layer.ts:48-143`).
2. RPC mounted at `/rpc` via `RpcServer.layerHttp` with `RpcHandlers` and `RpcSerialization.layerNdjson` (`apps/api/src/http-layer.ts:49-57`). Handlers read session from cookie via `viewerFromHeaders` (`apps/api/src/rpc-handlers.ts:49-80`) using `AuthService` and `PreferencesService`.
3. Sync routes are plain HTTP (`apps/api/src/sync.ts:80-207`), also read session via cookie, call `SyncService`. D1 accessed via repos from `@tali/sql` provided through layers.
4. Cron runs in same Worker via `scheduled()` dispatching by cron expression to `runReminderSweep`/`runTrashPurge`/`runD1Backup` with `ctx.waitUntil` and `noRetry()` for maintenance jobs (`apps/api/src/index.ts:171-235`).

### Asset serving
- Deployed: SPA assets uploaded to StaticSite; `/api/*` routed worker-first to web Worker which forwards to api Worker via service binding. Same origin.
- Built assets include code-split chunks per route (visible in `dist/client/assets/` names like `today-WtHSzhmp.js`, `reminders-BGlTnW-p.js`) and `sw.js`. Vite config has `build.assetsInlineLimit: 0`, `target: 'esnext'` (`apps/web/vite.config.ts:35-38`).
- Service worker is present in dist (`apps/web/dist/client/sw.js`) with install/activate claiming clients, fetch handler is no-op (network-only per comments), handles push and notification actions with IndexedDB queue (`apps/web/dist/client/sw.js:1-338`).

**Rough navigation round trips (from code):**
- Route change: mostly client-side (SPA) after initial load; no obvious per-route server loader that blocks navigation before paint in the router setup shown.
- Data on Today: may call `GET /today` (read model) + read from IndexedDB mirror; overlay pending. RPC used elsewhere for mutations/reads.
- Auth boot: 1 round trip to `/auth/me` on app load (`apps/web/src/lib/auth.tsx:80-107`).
- Sync: periodic pulls/pushes to `/sync/pull`, `/sync/bootstrap`, `/sync/push` (cursor-based). 
- RPC: each `api.*` call is a separate HTTP request to `/rpc` with ndjson serialization, new Effect scope/client per call.

## 3) Likely cold-start & per-navigation cost drivers

### (a) Cloudflare Worker cold start / isolate init
- **Per-request layer construction**: `fetch` builds `makeAppLayer()` and provides `D1Client.layer` with transforms on every request (`apps/api/src/index.ts:126-147`). Effect layers are composed per request; while D1 binding is cheap, constructing the full app layer graph (merging many routes/services/repos) and HttpRouter handler setup adds per-request overhead. Also `HttpRouter.toWebHandler` called each request.
- **Module worker, no long-lived runtime cached across requests in obvious way**: layers are rebuilt each request. In Workers, isolate cold start is the main latency source; per-request initialization can compound it.
- **Cron/scheduled** runs in same Worker but separate invocations.
- **Service bindings** used for web->api forwarding (cheap) but adds indirection.
- **Node compat**: `nodejs_compat` was removed/flag not present in current compat settings? Alchemy sets `compatibility: { date: "2026-10-09" }` with comment that nodejs_compat default changed; test wrangler still has it (`apps/api/wrangler.test.jsonc:13`). Node APIs used (crypto in alchemy for VAPID derivation at deploy time, not in Worker runtime). Worker runtime should be fine.
- **Effect v4.0.5**: heavier runtime than minimal; layer composition cost matters on cold start.

### (b) D1 latency and query patterns
- **No interactive transactions**: must use `batch()`; codebase is aware (docs mention). Risk of N+1 if not careful.
- **Per-request D1 client**: `D1Client.layer({ db: env.DB, ... })` created per request.
- **Migrations applied by Alchemy on deploy/dev** (`infra/alchemy.run.ts:39-41`) - not per request, good.
- **FTS5 present** (notes search) - can be expensive if not indexed well; need to check queries.
- **Sync feed design**: change feed with denormed fields, hydration per pull page (`docs/sync-protocol-draft.md:92-170`) - reasonable if indexed, but could be chatty.
- **Backup uses custom dump** because D1 can't export DB with FTS5 (`infra/alchemy.run.ts:44-77`, `apps/api/src/d1-*.ts` exist). 
- **Potential N+1**: need to inspect repos/services, but not fully read here. Sync protocol says "hydrates the current entity row" per feed entry - could be N+1 if not batched.
- **Query patterns**: column name transforms add overhead.

### (c) Client-side SPA issues
- **Bundle size**: Vite 8 build, code-split per route (assets show separate chunks). Target esnext. Need to measure, but split helps. `assetsInlineLimit: 0`.
- **No route prefetch visible**: Solid router used as-is; no obvious prefetch/link prefetching in codebase.
- **Waterfalls**: Auth boot does `/auth/me` before app ready (`AuthProvider` sets status checking then calls refresh). Sync starts after local store ready. Today page may fetch server read model after mount. RPC calls are fire-and-forget per action with new scopes.
- **Auth round-trips**: session check on boot; cookie-based.
- **Service worker**: present but fetch handler is no-op (network-only). SW install/activate claim clients - could interfere with navigation timing in some cases, but seems minimal. Push queue uses IndexedDB.
- **Effect on client**: `effect ^4.0.5` in web deps, RpcClient with Effect runtime per call - adds bundle size and runtime overhead.
- **Solid v2 RC**: newer, but ecosystem maturity varies.
- **Local-first is good for perceived latency** (reads from IndexedDB mirror) once loaded, but initial load still needs to download chunks + do auth/sync bootstrap.

### (d) Deployment/asset-serving issues
- **Static assets on Workers/StaticSite via Alchemy**: generally good for caching if headers set, but need to verify. `runWorkerFirst: ["/api/*"]` for API routing.
- **Same-origin proxy via web Worker** adds a hop in prod (browser -> web Worker -> api Worker via service binding). Service binding is fast, but still indirection.
- **Dev vs prod different**: dev uses Vite on :3000 calling api on :8787 directly (CORS), prod uses same origin through proxy.
- **Cold start hits api Worker on first request** (and possibly after idle). For a single/few household app with infrequent use, cold starts are very noticeable.

**Quantification (rough, based on code inspection):**
- **Round trips per navigation**: After initial load, SPA navigation is client-side (0 server round trips for route change itself). Data may trigger: Today may fetch `/today` (1), sync may pull/push (1-2), RPC mutations (1 each). Auth already done.
- **Before first paint**: HTML shell from StaticSite, load JS chunks (route + vendors), run providers (AuthProvider does `/auth/me` call - blocks app ready until settled? `AuthProvider` sets status 'checking', calls refresh in `onSettled`, guards likely wait for auth state; `App.tsx` shows `<Splash/>` while router Loading - not directly tied to auth status in shown code, but auth state affects rendering). SyncRunner starts after store ready.
- **Estimated KB of JS**: Built assets show multiple chunks (e.g. `virtual_solid-ssr-entry-client-*.js`, route chunks like `today-*.js` ~200KB+, `reminders-*.js` smaller). Total likely several hundred KB gzipped - moderate for Solid, but Effect runtime adds weight.

**Key suspects for "laggy navigation" + "low cold starts":**
1. **Worker cold start** on api routes (especially first request after idle). Building Effect layer graph per request + D1 client setup.
2. **RPC pattern**: creating new Effect scope/client per call (`apps/web/src/lib/rpc.ts:61-76`) adds overhead.
3. **Auth boot waterfall**: `/auth/me` on every load before app fully ready.
4. **Sync engine complexity**: repairs, multiple endpoints, can cause extra requests.
5. **D1 latency** (especially cross-region) - can be high on cold paths.
6. **Service worker interference**: fetch handler no-op but presence might affect things; also push handling.

## 4) Removing Cloudflare as deployment target (comparison)

| Target | Cold starts | Cost (near-zero traffic) | Op burden | D1 lock-in | Push notifications | Cron | Backups | Auth | Deploy Effect RPC server | Static asset caching | Migration effort from Alchemy/D1 | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Plain Node/VPS (Hetzner/Docker)** | None (always warm) | ~$5-20/mo (Hetzner CX11/CPX11) + storage. Can be < $10/mo. | High (OS updates, backups, monitoring, SSL, uptime). | High if stay on SQLite/D1 schema - need to migrate to Postgres/SQLite file. D1 SQL dialect mostly SQLite compatible but some differences. | Easy (self-host web-push, no special platform needed). | Easy (system cron or in-process). | DIY (restic, snapshots). | Cookie sessions easy. | Easy - run Node server with Effect HTTP. | Easy (nginx/CDN) with proper headers. | **High**: replace Alchemy with Docker Compose, migrate D1->Postgres/SQLite, replace Workers APIs (cron via node-cron), adjust bindings. | Most control, predictable latency. Good for single household. |
| **Fly.io** | Minimal with always-on or minimal cold starts; can run as long-running VM/app. | Free tier limited; likely $5-15/mo for small app + volume. | Medium (Fly config, volumes, scaling). | Same as VPS - migrate DB. | Easy. | Easy (process or cron). | Need volume backups. | Easy. | Easy. | Can use Fly CDN or external. | **High**: similar to VPS, different deployment model. | Good balance. |
| **Railway** | Usually warm for small apps, minimal cold starts. | Free tier exists but limits; likely $5-20/mo. | Medium. | Migrate DB to Postgres/SQLite. | Easy. | Easy. | Managed DB backups vary. | Easy. | Easy. | Good. | **High**. | Easy deploys. |
| **Render** | Free tier sleeps (cold starts), paid keeps warm. | Free sleeps; paid $7+/mo. | Medium. | Migrate DB. | Easy. | Easy. | Varies. | Easy. | Easy. | Good. | **High**. | Convenient. |
| **AWS (Lightsail/EC2/App Runner)** | Varies; EC2 always on, App Runner can have cold starts. | Lightsail $3.50+ but careful; can be cheap. | High (AWS complexity). | Migrate DB. | Easy. | Easy. | DIY/managed. | Easy. | Easy. | CloudFront easy. | **Very high**. | Overkill usually. |
| **Vercel/Netlify + managed Postgres** | Serverless functions can cold start; static assets cached well. | Vercel/Netlify free tiers generous, Postgres (Neon/Supabase) can be free/$0-10. | Low for frontend, medium for backend. | Migrate to Postgres (schema translation). | Easy. | Need cron (Vercel Cron, Netlify scheduled functions, or external). | Managed. | Easy. | Need to adapt Effect HTTP server to serverless functions (or run separate server). Effect RPC over HTTP still works if deployed as Node server. | Excellent CDN caching. | **High**: split deployment, adapt to serverless constraints. | Good for web, API needs care. |
| **Cloudflare-with-fixes** | Still cold starts but can mitigate; edge caching great. | Very cheap at near-zero (Workers free tier generous, D1 free tier exists, R2 cheap). | Low if already set up. | Stay on D1 (SQLite) - avoid migration. | Supported via Web Push (already implemented). | Cron triggers built-in. | R2 backups already implemented. | Cookie auth works. | Already deployed. | Excellent (StaticSite + edge). | **Low** if only fix code. | Keep what works, fix performance. | 

**Key takeaways:**
- **Cost**: Cloudflare is likely cheapest/simplest for near-zero traffic. Moving to VPS/managed Postgres will cost more and add ops burden.
- **Latency**: VPS always-warm will eliminate cold starts; Cloudflare can be fast after warm but cold starts hurt.
- **Lock-in**: D1 is SQLite-based but tied to Cloudflare platform. Migrating off means schema translation and losing some integrations.
- **Effort**: Staying on Cloudflare-with-fixes is lowest effort. Re-platforming is significant rewrite of infra/deployment.

## 5) Data/sync architectures (Convex, ElectricSQL+TanStack DB, others)

Need to verify current facts (pricing, Solid support, maturity). I’ll use web search for current info.

Let’s search for each option.

## 5) Data/sync architectures (Convex, ElectricSQL+TanStack DB, others)

### Verification (current as of late 2026)

Sources (from web search):
- Convex: Professional $25/dev/month (seat-based), Starter pay-as-you-go/free allowances; Enterprise custom. Bandwidth/networking changes announced (ingress free, cheaper egress). SolidJS has community integration (`jamwt/solid-convex`) but not first-class in official docs shown; Convex is document model (not Postgres), direct SQL/ORMs not compatible. ([Convex Pricing](https://www.convex.dev/pricing), [srvrlss](https://www.srvrlss.io/provider/convex), [BuildMVPFast](https://www.buildmvpfast.com/alternatives/convex))
- ElectricSQL + TanStack DB: Electric is Postgres sync engine (open source). Electric Cloud pricing: $1M writes, bills under $5 waived; Pro $249/mo, Scale $1999/mo. Self-host Electric + Postgres ~$80-150/mo on AWS minimal. TanStack DB is frontend-agnostic reactive client store with collections; Solid adapter exists (`@tanstack/solid-db`). Works with Electric collection for sync, or custom sync. ([Kanopy Labs comparison](https://kanopylabs.com/blog/tanstack-db-vs-electricsql-vs-zero-sync), [Electric blog](https://electric.ax/blog/2025/07/29/super-fast-apps-on-sync-with-tanstack-db), [TanStack DB Solid docs](https://tanstack.com/db/latest/docs/framework/solid/overview), [Electric examples](https://github.com/electric-sql/electric/blob/main/examples/tanstack-db-web-starter/README.md))
- Rocicorp Zero: Open source core free, managed hosting pricing varies (Hobby $30/mo, Pro $300/mo, BYOC $1000+/mo) per comparison above.
- LiveStore: Mentioned in ecosystem; need to check separately if needed.
- PowerSync: Has TanStack DB collection support mentioned in docs.
- InstantDB: Different model (real-time DB with permissions).
- Supabase Realtime: Postgres + realtime.
- Turso/libSQL embedded replicas: SQLite at edge/local.
- PGlite: Postgres in WASM/embedded.
- Neon: Serverless Postgres.
- Firebase: Google ecosystem.
- tRPC + optimistic updates on plain Postgres: Traditional approach.

### Fit assessment

| Option | Fit with Solid v2 | Offline/local-first | Navigation latency | Realtime sync | Schema/migration | Auth | Server functions/cron/push | Hosting | Lock-in | Migration cost from Effect domain/RPC + D1 schema | Maturity (late 2026) | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Convex** | Community support exists (`jamwt/solid-convex`) but not first-class; React-first ecosystem. May need adapter work. | Good (reactive, offline support varies). | Low after warm; serverless functions can cold start. | Built-in realtime subscriptions. | Schema defined in Convex (different from SQL). Migrations handled by Convex. | Built-in auth options. | Server functions (queries/mutations/actions), cron, http actions. Push notifications possible via actions. | Fully managed by Convex. | **High** (document model, proprietary platform, can't easily self-host same way). | **Very high**: rewrite domain to Convex functions/schema, replace Effect RPC with Convex client, migrate D1 SQLite schema to Convex document model. Lose Effect domain model structure. | Mature for React, Solid support less mature. | Great DX but big rewrite and lock-in. |
| **ElectricSQL + TanStack DB** | **Good** - TanStack DB has Solid adapter, Electric has collections for TanStack DB. | **Excellent** - local-first, syncs from Postgres, works offline. | **Very low** - reads from local DB, sync in background. | Realtime sync via Electric shapes/subscriptions. | Postgres schema is source of truth, migrations normal SQL/Postgres migrations. | Handle separately (can integrate with existing auth or use Postgres RLS). | Need backend API for mutations/cron/push; Electric handles sync. Can use same Node/Workers or separate. | Electric Cloud managed or self-host Electric + Postgres. | **Medium** - Postgres is standard, Electric is open source (can self-host). TanStack DB is open source. | **High**: keep Postgres schema similar to SQLite (translation needed), replace sync engine with Electric shapes, adopt TanStack DB collections, integrate with Solid. Can preserve Effect domain partially. | Actively developed, maturing. Good fit for local-first. | Promising, keeps SQL/Postgres flexibility. |
| **Rocicorp Zero** | Framework agnostic; React-focused docs but can adapt. Solid support unclear. | Excellent local-first sync. | Very low local reads. | Realtime sync. | Schema in Zero, syncs to Postgres. | Separate auth. | Backend needed for mutations. | Zero has managed hosting or self-host zero-cache. | **Medium** - Postgres source of truth, Zero open source. | **High** similar to Electric. | Mature, good local-first story. | Similar to Electric. |
| **LiveStore** | Framework agnostic. | Excellent local-first. | Very low. | Realtime sync. | Schema defined in LiveStore. | Separate. | Backend needed. | Self-host or managed options. | **Medium**. | **High**. | Maturing. | Interesting but less proven. |
| **PowerSync** | Has TanStack DB collection support. | Excellent offline-first. | Very low. | Realtime sync. | Postgres/SQLite source of truth. | Separate. | Backend needed. | Managed or self-host. | **Medium**. | **High**. | Mature. | Good option. |
| **InstantDB** | React-focused, Solid support unclear. | Good offline support. | Low. | Realtime built-in. | Schema in InstantDB. | Built-in auth. | Functions/permissions in platform. | Managed. | **High**. | **Very high** rewrite. | Growing. | More opinionated. |
| **Supabase Realtime** | Good with any framework. | Can do offline with libraries, not as seamless as local-first sync engines. | Medium - often needs to fetch. | Realtime on Postgres. | Postgres schema. | Supabase Auth. | Edge Functions, cron via pg_cron or external. | Managed or self-host. | **Low** (Postgres standard). | **Medium-High**: migrate D1 to Postgres, replace sync with Supabase realtime/subscriptions or roll own, can keep Effect on backend. | Mature. | More traditional realtime than local-first sync. |
| **Turso/libSQL embedded replicas** | Any framework. | Good offline with embedded replicas. | Very low local reads. | Can sync replicas. | SQLite schema. | Separate. | Need backend. | Turso managed or self-host libSQL. | **Low** (SQLite/libSQL). | **Medium**: similar SQL dialect to D1/SQLite, easier migration than Postgres. Can keep Effect, replace D1 with libSQL. | Mature. | Good if want to stay close to SQLite. |
| **PGlite** | Any framework. | Excellent embedded Postgres in browser. | Very low. | Need sync mechanism. | Postgres schema. | Separate. | Need backend. | Can self-host. | **Low**. | **Medium-High**: Postgres migration, need sync solution. | Maturing. | Powerful but complex. |
| **Neon** | Any framework. | No built-in offline sync, need to add. | Depends on serverless. | Can use logical replication. | Postgres. | Separate. | Serverless functions. | Managed. | **Low**. | **Medium-High** similar to Supabase. | Mature. | Good Postgres host. |
| **Plain Postgres + tRPC/optimistic updates** | Any framework. | Minimal offline, need to build. | Server round trips. | Need to add realtime. | Postgres. | Separate. | Full control. | Any host. | **Lowest**. | **Medium-High** but keep more control. | Traditional, mature. | Most flexible but more work. |
| **Firebase** | Works, but React-first. | Good offline support. | Low. | Realtime. | NoSQL schema. | Firebase Auth. | Cloud Functions, cron. | Managed. | **High**. | **Very high**. | Mature. | Different paradigm. |

**Key observations:**
- **ElectricSQL + TanStack DB** is interesting because it keeps Postgres (standard SQL), has Solid support via TanStack DB, and provides true local-first sync. Migration is significant but not as paradigm-shifting as Convex.
- **Turso/libSQL** might be easiest if staying SQLite-like.
- **Convex** would be a massive rewrite with high lock-in.
- For a single/few-household app that values the existing Effect domain model and typed RPC, re-platforming to any of these is a big investment.

## 6) Smallest fixes that avoid re-platforming (concrete)

These are ordered by impact vs effort, based on code inspection:

### P0 - High impact, low/medium effort

1. **Reduce per-request layer construction in Worker** (`apps/api/src/index.ts:126-147`)
   - **Issue**: `makeAppLayer()` and `D1Client.layer` built on every `fetch`. Effect layers can be expensive to compose.
   - **Fix**: Build the app handler once at module scope (cached). Create D1 client layer once or per-request more efficiently. Use `HttpRouter.toWebHandler` once. Note: need to ensure request-scoped services still work correctly.
   - **Evidence**: `apps/api/src/index.ts:126-147` builds layer inside fetch.
   - **Effort**: Medium. **Impact**: High (cold start + warm requests).

2. **Optimize RPC client usage** (`apps/web/src/lib/rpc.ts:61-76`)
   - **Issue**: `withClient` creates new `RpcClient`, provides layers, creates new scope for every call via `Effect.scoped`. This is expensive.
   - **Fix**: Create a singleton/shared RPC client instance, reuse scopes or use long-lived client. Or use `Effect.runPromise` with a managed runtime.
   - **Evidence**: `apps/web/src/lib/rpc.ts:61-76` - "Build the typed client, run `f`, and tear the scope down per call."
   - **Effort**: Medium. **Impact**: High (every RPC call).

3. **Improve auth boot** (`apps/web/src/lib/auth.tsx:80-107`)
   - **Issue**: Always calls `/auth/me` on boot, blocks app ready state. Waterfall.
   - **Fix**: Use cached session immediately for initial render (already does fallback on error), but also consider optimistic boot. Maybe parallelize or make it faster. Also check if we can avoid blocking route rendering.
   - **Evidence**: `apps/web/src/lib/auth.tsx:103-107` calls refresh on settled.
   - **Effort**: Low. **Impact**: Medium-High (perceived load time).

4. **Add route prefetching** 
   - **Issue**: No prefetching visible. Navigation waits for chunk download.
   - **Fix**: Use Solid Router's prefetching or add `rel="prefetch"` / manual prefetch on link hover/focus.
   - **Evidence**: Router setup in `apps/web/src/router.ts:1-7` uses default Solid Router.
   - **Effort**: Low. **Impact**: Medium (navigation feel).

5. **Check D1 query patterns / add indexes**
   - **Issue**: Potential N+1 in sync hydration or queries. Need to audit repos.
   - **Fix**: Look at sync pull hydration, add indexes to migrations, batch queries.
   - **Evidence**: Sync protocol says "hydrates the current entity row" per feed entry (`docs/sync-protocol-draft.md:129`).
   - **Effort**: Medium-High. **Impact**: High for sync/navigation.

### P1 - Medium impact

6. **Optimize bundle size**
   - **Issue**: Effect runtime on client is heavy. Check tree shaking.
   - **Fix**: Analyze bundle, ensure proper imports, consider code splitting for Effect usage.
   - **Effort**: Medium. **Impact**: Medium.

7. **Service worker tuning**
   - **Issue**: SW fetch handler is no-op; could cause issues. Also review caching strategy.
   - **Fix**: Review SW behavior, maybe add proper caching for static assets or adjust.
   - **Evidence**: `apps/web/dist/client/sw.js:57-58` has no-op fetch handler.
   - **Effort**: Low. **Impact**: Low-Medium.

8. **Reduce sync frequency / optimize cadence**
   - **Issue**: Polling can cause requests.
   - **Fix**: Tune `sync-cadence.ts` parameters, ensure backoff works well.
   - **Effort**: Low. **Impact**: Medium if aggressive polling.

9. **Use Cloudflare's caching better**
   - **Issue**: Static assets need proper cache headers.
   - **Fix**: Ensure StaticSite sets long cache for hashed assets, short/no cache for HTML.
   - **Effort**: Low. **Impact**: Medium for repeat visits.

10. **Consider Worker CPU time optimization**
    - **Issue**: Effect layers and processing can be CPU intensive.
    - **Fix**: Profile, optimize hot paths, avoid unnecessary work per request.
    - **Effort**: Medium-High. **Impact**: High for cold/warm starts.

## 7) Target architecture if re-platforming justified + phased migration

**Only re-platform if:** (1) Cold start fixes don't solve it after measurement, (2) D1 costs/limits become an issue at scale, (3) Need features not possible on Cloudflare, (4) Ops burden is acceptable. For single/few household, **strongly recommend staying on Cloudflare with fixes first**.

### Recommended target (if justified): ElectricSQL + TanStack DB + Postgres

This keeps SQL, has Solid support, true local-first, and Postgres is portable.

**Architecture:**
- **Frontend**: Keep Solid v2 SPA, replace sync engine with TanStack DB collections + Electric shapes
- **Backend**: Node server (Fly.io/Hetzner) with Effect for domain/RPC, Postgres DB
- **Sync**: Electric sync service syncs Postgres -> client via shapes
- **Auth**: Keep existing auth or adapt
- **Storage**: Postgres (managed like Neon/Supabase) or self-hosted

**Why:** Preserves more of SQL schema, Effect domain can be adapted, Solid supported, can self-host to avoid lock-in.

### Phased migration plan

**Phase 0: Measure first (1-2 days)**
- Add timing logs for Worker cold starts, RPC calls, navigation
- Measure bundle sizes, D1 query times
- Try fixes from section 6
- **Decision gate**: If fixes don't help, proceed to Phase 1

**Phase 1: Prepare for migration (1-2 weeks)**
- Document full schema, extract migrations
- Create Postgres schema (translate D1/SQLite to Postgres)
- Set up Postgres instance (Neon/Supabase for easy start)
- Create data migration scripts
- **Goal**: Schema parity

**Phase 2: Backend migration (2-4 weeks)**
- Deploy Effect API server to Node host (Fly.io/Hetzner)
- Replace D1 with Postgres (use @effect/sql-pg or similar)
- Translate SQL queries/repos
- Keep RPC contract same
- Set up cron jobs (node-cron)
- **Goal**: API works on new host

**Phase 3: Sync migration (2-4 weeks)**
- Set up Electric sync service
- Define shapes for entities
- Replace client sync engine with TanStack DB + Electric collections
- Migrate local store logic
- **Goal**: Local-first sync works

**Phase 4: Cutover (1 week)**
- Deploy frontend to static host (same or different)
- Migrate data
- Test thoroughly
- Cutover DNS
- **Goal**: Production on new stack

**Total effort:** ~6-12 weeks for experienced team. High risk, high cost.

## 8) Decision rule (single/few-household vs growth)

| Scenario | Recommendation | Rationale |
|---|---|---|
| **Single/few-household (1-10 users), low traffic, personal use** | **Stay on Cloudflare + apply fixes from section 6** | Cheapest, least ops burden, keep all existing code. Cold starts annoying but manageable with fixes. D1 is fine for small data. |
| **Growing beyond household (10-100 users), need better performance/reliability** | **Consider migration if fixes fail** | D1 limits may hit, cold starts more noticeable, need better scaling. But still might fix on Cloudflare first. |
| **Needs features impossible on Cloudflare** (complex transactions, specific DB features) | **Migrate** | D1 has limitations (no interactive transactions). |
| **High ops tolerance + want full control** | **Migrate to VPS** | More control, no cold starts, but more work. |
| **Want managed local-first sync** | **Migrate to Electric/Zero** | Better sync story, but big rewrite. |

**Default decision:** For this app (personal/family planner), **stay on Cloudflare and fix performance issues**. Only migrate if measurement shows fixes are insufficient.

## 9) Pros/cons tables

### Deployment targets

| Target | Pros | Cons |
|---|---|---|
| **Cloudflare (current)** | Cheap at low traffic, great CDN, integrated (D1/R2/Workers/Cron), easy deploy with Alchemy, same-origin proxy works, push/cron built-in | Cold starts, D1 limits, vendor lock-in, per-request layer overhead, debugging harder |
| **Hetzner/VPS (Docker)** | No cold starts, full control, predictable performance, cheap ($5-10/mo), can use any stack | High ops burden, need to manage backups/SSL/monitoring, need to migrate DB, more complex deploy |
| **Fly.io** | Good balance, global, easy deploy, volumes for storage, reasonable pricing | Some cold starts possible, need to manage DB separately, learning curve |
| **Railway** | Very easy deploy, managed Postgres available, good DX | Can get expensive, less control, sleeping on free tier |
| **Render** | Easy, managed DB options | Free tier sleeps, can be pricey, less flexible |
| **Vercel/Netlify + Postgres** | Great for frontend, easy static hosting, good DX | Serverless cold starts, need separate API hosting or serverless functions, Effect server adaptation needed |
| **AWS** | Most powerful, scalable | Overkill, complex, can be expensive, high ops burden |

### Data/sync architectures

| Option | Pros | Cons |
|---|---|---|
| **Keep current (D1 + custom sync)** | No migration, keep Effect domain/RPC, working sync engine, cheap | Cold starts, D1 limits, custom sync complexity, scaling concerns |
| **Convex** | Great DX, realtime built-in, managed, less backend code | Very high lock-in, rewrite everything, Solid support weak, seat-based pricing, can't self-host easily |
| **ElectricSQL + TanStack DB** | Local-first, Postgres standard, Solid support, can self-host, keeps SQL | Complex setup, need Postgres, migration work, Electric adds infra, learning curve |
| **Rocicorp Zero** | Great local-first, Postgres source of truth, good DX | Similar complexity to Electric, less mature ecosystem |
| **Turso/libSQL** | SQLite-like (easy migration from D1), embedded replicas, good offline, can self-host | Sync story different from full local-first engines, need to handle sync yourself |
| **Supabase** | Postgres standard, managed, auth/realtime built-in, easy to start | Not true local-first sync engine, need to build offline support, can get expensive |
| **Plain Postgres + tRPC** | Full control, standard stack, easy to reason about | No offline-first, more backend code, need to build sync/realtime |
| **PGlite** | Powerful embedded Postgres, true offline | Very complex sync story, bundle size, maturing |

## 10) Scored comparison (criteria + weights)

**Criteria (1-10, higher better):**
- **Performance/latency** (weight 25%): cold starts, navigation speed
- **Cost (near-zero traffic)** (weight 15%): monthly cost for single household
- **Dev experience / maintainability** (weight 15%): keeping existing code, Effect model
- **Offline/local-first** (weight 10%): current app has this
- **Ops burden** (weight 10%): maintenance required
- **Migration effort** (weight 10%): how much to change
- **Lock-in** (weight 8%): ability to move later
- **Scalability** (weight 7%): if it grows

| Option | Perf/latency (25%) | Cost (15%) | DX/Maintain (15%) | Offline (10%) | Ops (10%) | Migration (10%) | Lock-in (8%) | Scale (7%) | **Weighted Score** |
|---|---|---|---|---|---|---|---|---|---|
| **Cloudflare + fixes** | 7 × 0.25 = 1.75 | 10 × 0.15 = 1.5 | 10 × 0.15 = 1.5 | 9 × 0.10 = 0.9 | 9 × 0.10 = 0.9 | 10 × 0.10 = 1.0 | 6 × 0.08 = 0.48 | 6 × 0.07 = 0.42 | **8.45** |
| **Hetzner/VPS** | 9 × 0.25 = 2.25 | 7 × 0.15 = 1.05 | 6 × 0.15 = 0.9 | 9 × 0.10 = 0.9 | 3 × 0.10 = 0.3 | 2 × 0.10 = 0.2 | 9 × 0.08 = 0.72 | 8 × 0.07 = 0.56 | **6.88** |
| **Fly.io** | 8 × 0.25 = 2.0 | 7 × 0.15 = 1.05 | 6 × 0.15 = 0.9 | 9 × 0.10 = 0.9 | 5 × 0.10 = 0.5 | 2 × 0.10 = 0.2 | 8 × 0.08 = 0.64 | 8 × 0.07 = 0.56 | **6.75** |
| **ElectricSQL + TanStack DB** | 9 × 0.25 = 2.25 | 6 × 0.15 = 0.9 | 7 × 0.15 = 1.05 | 10 × 0.10 = 1.0 | 4 × 0.10 = 0.4 | 3 × 0.10 = 0.3 | 7 × 0.08 = 0.56 | 9 × 0.07 = 0.63 | **7.09** |
| **Turso/libSQL** | 8 × 0.25 = 2.0 | 7 × 0.15 = 1.05 | 7 × 0.15 = 1.05 | 8 × 0.10 = 0.8 | 6 × 0.10 = 0.6 | 4 × 0.10 = 0.4 | 8 × 0.08 = 0.64 | 7 × 0.07 = 0.49 | **7.03** |
| **Convex** | 7 × 0.25 = 1.75 | 4 × 0.15 = 0.6 | 3 × 0.15 = 0.45 | 8 × 0.10 = 0.8 | 9 × 0.10 = 0.9 | 1 × 0.10 = 0.1 | 1 × 0.08 = 0.08 | 9 × 0.07 = 0.63 | **5.31** |
| **Supabase** | 7 × 0.25 = 1.75 | 6 × 0.15 = 0.9 | 6 × 0.15 = 0.9 | 6 × 0.10 = 0.6 | 7 × 0.10 = 0.7 | 3 × 0.10 = 0.3 | 7 × 0.08 = 0.56 | 8 × 0.07 = 0.56 | **6.27** |

**Winner:** Cloudflare + fixes (8.45) by a significant margin for this use case.

## 11) References (citations with URLs)

- Convex Pricing: https://www.convex.dev/pricing
- Convex Reviews/Comparisons: https://www.srvrlss.io/provider/convex, https://www.buildmvpfast.com/alternatives/convex
- Convex + Solid: https://www.youtube.com/watch?v=5Gck3MsGl5Y, https://github.com/jamwt/solid-convex
- ElectricSQL + TanStack DB: https://electric.ax/blog/2025/07/29/super-fast-apps-on-sync-with-tanstack-db, https://kanopylabs.com/blog/tanstack-db-vs-electricsql-vs-zero-sync, https://tanstack.com/db/latest/docs/collections/electric-collection, https://tanstack.com/db/latest/docs/framework/solid/overview
- Neon blog on TanStack DB: https://neon.com/blog/tanstack-db-and-electricsql
- Electric examples: https://github.com/electric-sql/electric/blob/main/examples/tanstack-db-web-starter/README.md
- FOSDEM talk: https://archive.fosdem.org/2026/schedule/event/9XHSYE-electricsql-query-driven-sync-in-tanstack-db
- Video review: https://www.youtube.com/watch?v=ae05QlM50DI

## Final Recommendation

**Do NOT re-platform yet.** The complaint about laggy navigation and low cold starts is likely caused by:
1. Per-request Effect layer construction in the Worker
2. RPC client creating new scopes/clients per call  
3. Auth boot waterfall
4. Potential D1 query inefficiencies

These are all fixable without leaving Cloudflare. For a single/few-household app, Cloudflare remains the best choice (cheapest, least ops burden, keeps all the good architecture: Effect domain model, typed RPC, local-first sync, RTL UI).

**Action plan:**
1. **Measure first** - Add instrumentation to confirm bottlenecks
2. **Apply P0 fixes** (layer caching, RPC client reuse, auth optimization) 
3. **Re-evaluate** - If still slow after fixes, then consider migration

The migration to ElectricSQL+TanStack DB would be the most promising if re-platforming becomes necessary, as it preserves local-first benefits and has Solid support while using standard Postgres.
