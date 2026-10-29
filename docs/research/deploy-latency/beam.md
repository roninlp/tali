# Tali deploy latency: architecture research

**Date:** 2026-10-29 (research snapshot; facts verified via web search where noted)
**Scope:** read-only research. No application code changed.
**Repo:** `/home/ronin/Projects/tali` (pnpm + Turborepo; Solid v2 SPA + Effect RPC on Cloudflare Workers + D1).

---

## 1. Executive summary

The deployed app does **not** have a "Cloudflare is fundamentally unusable" problem. It has a **stack of small, compounding latency taxes** that are each individually cheap and together feel laggy, plus one structural one (D1 is single-region and the code does not use read replication). None of them requires re-platforming.

Top drivers, in order of likely impact:

1. **D1 round-trip amplification on the hot path.** `auth.me` (called by every `/auth/me`, every `/sync/*`, `/today`, `/preferences`) runs `sha256` + 3–4 D1 queries (`sessions.findByTokenHash`, `sessions.extend`, `users.findById`, `memberships.findByUserId`). On a deployed Worker the D1 primary is typically 40–120 ms away (Workers are edge, D1 is not), so one `auth.me` costs ~150–400 ms. `/today` chains `auth.me` + `preferences.get` + `TodayService.get` (several more queries) → commonly 400 ms–1 s. **File:** `apps/api/src/auth-service.ts:205-225`, `apps/api/src/today-routes.ts:52-78`.
2. **Per-request layer construction.** `fetch()` in `apps/api/src/index.ts:120-145` calls `makeAppLayer(...)` and `HttpRouter.toWebHandler(app)` on *every* request, rebuilding ~30 Effect layers and the whole HTTP router. That is tens of milliseconds of pure overhead per request, on top of D1.
3. **No use of D1 read replication.** The binding is the raw `D1Database`; `@effect/sql-d1` talks to the primary. Cloudflare shipped read replication (public beta) but it needs the Sessions API. **File:** `apps/api/src/index.ts:126-132`.
4. **Client boot does 4–5 sequential-ish network calls** (`/auth/me`, `/push/vapid`, `/preferences`, `/sync/pull`, plus SW registration) before the shell is fully live, and `PushProvider` fetches `/push/vapid` even when signed out. **Files:** `apps/web/src/lib/auth.tsx:95-115`, `apps/web/src/lib/push/context.tsx:238-245`, `apps/web/src/lib/preferences.tsx:95-120`.
5. **Sync polling every 3.5 s while active** turns into a continuous `/sync/pull` (each carrying `auth.me`) even for a single household; that is ~17 pulls/min/user and is the main "feels laggy while open" tax. **File:** `apps/web/src/lib/sync-cadence.ts:24`.
6. **`sync.pull` runs `repo.prune(cutoff)` on every pull** — a write to `change_feed` on every 3.5 s poll. **File:** `apps/api/src/sync-service.ts:595`.
7. **Initial JS is ~245 KB gzipped** with a 250 KB (raw) `routing` chunk modulepreloaded; route chunks load on navigation. Not catastrophic but adds ~0.5–1 s on cold mobile. **Dir:** `apps/web/dist/client/assets`.

Recommended: **do not re-platform.** Run a 2-week "Cloudflare-with-fixes" sprint (layer caching, Smart Placement, combine `/auth/me`+preferences, lazy push, slower/adaptive polling, prune throttling). Measured against the same checklist, this should cut first-paint from ~1–2 s to ~300–600 ms and idle CPU/D1 cost by ~5×. Re-platform only if D1 latency remains unacceptable after enabling read replication or moving the Worker to Smart Placement.

If the user still wants off Cloudflare after that: the best fit for *this* app is **a single small VPS (Hetzner/Railway) running the existing Effect RPC server on Node + Postgres (or Turso for SQLite continuity)**, preserving the domain model, RPC contract and Solid UI. Convex and ElectricSQL/TanStack DB score lower for this specific app (Solid 2.0 support gaps, offline-write limitations, high migration cost, lock-in) — see §6–§8.

---

## 2. Method and evidence

- Static inspection of the monorepo: routing, data loading, auth bootstrap, sync engine, local store, service worker, API entry/layers, SQL, infra, wrangler config.
- Build artifact inspection (`apps/web/dist/client`) for bundle sizes.
- Web search (2026) for pricing, availability, Solid support of candidate platforms and sync engines; URLs cited in §6–§7.
- No code executed beyond `du`/`gzip` measurements; no dev servers, no deploy.

Key file references used throughout: `path:line`.

---

## 3. Architecture map (request/data flow)

### 3.1 Web (Solid v2, client-only SPA)

- Entry: `apps/web/src/App.tsx` — provider tree `AuthProvider → PreferencesProvider → PushProvider → LocalStoreProvider`, plus `SyncRunner` and `Router`.
- Routing: `apps/web/src/router.ts` uses `@solidjs/router` `fileRoutes` from `virtual:file-routes`; code-split per route (e.g. `tasks-C2hI61C9.js`).
- Auth bootstrap: `AuthProvider` (`apps/web/src/lib/auth.tsx:48-58`) starts `status="checking"`; `onSettled` calls `refresh()` → `GET /auth/me` (`auth-api.ts:120`). Only `Unauthorized` clears; 5xx/network keeps a cached session (`session-cache.ts`) so the mirror stays usable offline.
- Preferences: `PreferencesProvider` (`preferences.tsx:95-120`) adopts localStorage cache synchronously, then `GET /preferences`.
- Push: `PushProvider` (`push/context.tsx:238-245`) registers `/sw.js` and calls `refresh()` on boot → `GET /push/vapid`, `pushManager.getSubscription()`, and (if signed in) `POST /push/register`.
- Local store: IndexedDB mirror opened per user (`local-store/context.tsx`); screens read from the mirror, not the network. `SyncRunner` runs `createSyncEngine().sync` on a 3.5 s (active) / 15 s (idle) / 30 s (hidden) poll (`sync-cadence.ts:24-26`).
- Data flow per route:
  - `/today`: `fetchToday` (`today/api.ts`) → `GET /today` with `If-None-Match` ETag; falls back to mirror aggregation (`today/model.ts`). Revalidates every 60 s (`today.tsx` `setInterval`).
  - Other routes (`/tasks`, `/habits`, `/notes`, `/calendar`) read from IndexedDB mirror; no per-navigation network call except sync poll.
- Service worker: `apps/web/public/sw.js` — push + reminder actions only; `fetch` handler is a no-op (`self.addEventListener("fetch", () => {})`), so **no app-shell caching**. Offline data lives in IndexedDB.

### 3.2 API (Effect on Cloudflare Workers)

- Entry: `apps/api/src/index.ts:118-146` `fetch()` builds `makeAppLayer(...)` + `D1Client.layer({db})` per request, then `HttpRouter.toWebHandler`.
- Routes: `/health`, `/auth/*`, `/rpc`, `/sync/*`, `/push/*`, plus `/today`, `/preferences`, `/calendar`, etc. (registered in `http-layer.ts:108-124`).
- Auth: cookie `tali_session`; `auth.me` does sha256 + session lookup + extend + user + membership (`auth-service.ts:205-225`).
- Sync: plain HTTP `/sync/pull`, `/sync/bootstrap`, `/sync/push` (`sync.ts`); server resolver in `sync-service.ts`.
- Cron: per-minute reminder sweep, nightly trash purge 03:17, nightly D1→R2 backup 03:47 (`index.ts:148-205`, `alchemy.run.ts`).

### 3.3 Infra

- `infra/alchemy.run.ts`: one stack = D1 (`TaliDatabase`) + optional R2 bucket (`TaliBackups`) + api Worker (`TaliApi`, crons) + web StaticSite (`TaliWeb`, SPA fallback, `runWorkerFirst: ["/api/*"]`).
- Web Worker (`apps/web/worker.ts`) strips `/api` and forwards over a service binding, so SPA + API share one origin in production; session cookie is same-origin.
- Deployed assets: `vite build` → `dist/client`; Cloudflare asset layer serves hashed files. No explicit cache headers in repo; relies on CF defaults.

### 3.4 SQL / D1

- `packages/sql/migrations` — 13 migrations, ~89 `CREATE INDEX` statements (reasonable coverage). D1 SQLite, no interactive transactions; multi-row writes via `D1Client.batch`.
- Repositories are `@effect/sql-d1` `SqlClient` + `SqlSchema`.

---

## 4. Diagnosis: cold-start and per-navigation cost drivers

### 4.1 (a) Cloudflare Worker cold start / isolate init

- Cloudflare Workers are V8 isolates: documented "sub-5 ms" cold starts, no per-request container boot. **So the user's "cold start" feeling is almost certainly not isolate boot.** Sources: Cloudflare Workers docs (limits/pricing), "Eliminating cold starts" blog.
- However, this app does **module-level work per cold isolate** plus **per-request work that looks like a cold start**: `fetch()` rebuilds the entire Effect application (`makeAppLayer` + `toWebHandler`) every request (`index.ts:120-145`). Even on a warm isolate this is CPU work that a Node server would do once at boot. Under load or after eviction it dominates.
- **Estimate:** layer rebuild + router construction ≈ 10–40 ms/request (Effect layer merging of ~30 layers). Not the 1–2 s the user reports, but it stacks with D1.
- **Mitigation:** build the handler once per isolate (lazy init on first `fetch`, reusing `env`). See §7.

### 4.2 (b) D1 latency and query patterns

- D1 is **single-region SQLite**. Workers run at the edge near the user, but every D1 query round-trips to the primary. For a user in the Middle East/Europe to a D1 primary in `WNAM`/`ENAM`, that is typically 40–120 ms per round trip. Cloudflare's read replication (public beta, 2025-04) exists but requires the Sessions API; this codebase uses the raw binding, so **no replica is used**. Sources: D1 read replication docs/blog.
- `auth.me` (`auth-service.ts:205-225`) = sha256 (CPU) + `sessions.findByTokenHash` + `sessions.extend` (write) + `users.findById` + `memberships.findByUserId` = **3 D1 reads + 1 write per call**. At 80 ms RTT → ~240 ms + query time. It is on the path of *every* authenticated request.
- `/today` (`today-routes.ts:52-78`) = `auth.me` + `preferences.get` + `TodayService.get` (which aggregates tasks/notes/habits/events) → likely 6–12 D1 queries → 500 ms–1 s.
- `/sync/pull` = `auth.me` + `repo.prune` (write!) + `minSeq` + `pullFeed` + `findEntities` → 4+ queries, and it runs every 3.5 s while a tab is active.
- Indexes are reasonable (§3.4), so this is not an N+1-from-missing-index problem; it is a **round-trip-count × D1-distance** problem.
- **Estimate for a warm-ish request from Iran/EU to a US-primary D1:** `/auth/me` ≈ 180–320 ms; `/today` ≈ 500 ms–1.1 s; `/sync/pull` ≈ 250–450 ms.

### 4.3 (c) Client-side SPA issues

- **Boot waterfall:** `AuthProvider.refresh` (`auth.tsx`) awaits `/auth/me` before any protected route renders (Guard shows splash). Then `PreferencesProvider` fetches `/preferences`, `PushProvider` fetches `/push/vapid` + registers SW. These are not awaited in series by code, but the splash persists until `auth.me` resolves, so the user perceives "auth round trip = cold start."
- **Sync poll cadence:** 3.5 s active (`sync-cadence.ts:24`). For a household app this is aggressive; it is the dominant ongoing cost and the reason a second device sees edits quickly but the first device burns CPU/battery.
- **No route prefetch / modulepreload beyond entry:** Vite preloads `tokens`, `routing`, `rpc` only (`index.html`). Route chunks (e.g. `calendar` 78 KB) are fetched on navigation. On a cold cache that is a network round trip per first visit.
- **No app-shell caching in the service worker:** `sw.js` has an empty `fetch` handler, so every navigation re-downloads JS/CSS from the network (CF cache helps, but no instant offline shell). Intentional (data is in IndexedDB), but it means "first paint after idle" waits on asset fetch + Worker.
- **Bundle size:** ~245 KB gzipped total JS, ~800 KB raw. Initial entry ≈ tokens (67 KB raw) + routing (250 KB raw) + rpc (44 KB raw) + entry (42 KB) ≈ 150 KB gzipped. On 4G that is ~0.5–1 s; on slow mobile more.
- **Solid v2 RC:** `solid-js@2.0.0-rc.14`, `@solidjs/router@2.0.0-next.38` — not a perf issue per se, but means no stable ecosystem optimizations and possible churn.

### 4.4 (d) Deployment / asset-serving issues

- **Cache headers:** repo sets none explicitly for static assets; relies on Cloudflare's asset layer. Hashed files (`/assets/*-HASH.js`) should be immutable, but confirm `cache-control: public, max-age=31536000, immutable` is actually emitted. If not, repeat visits revalidate every asset.
- **SPA fallback:** `notFoundHandling: "single-page-application"` means unknown paths return `index.html`; okay.
- **`runWorkerFirst: ["/api/*"]`** routes API through `apps/web/worker.ts`, adding one hop (web Worker → service binding → api Worker). That hop is in-process (service binding) and cheap, but it means **two Workers run per API request** (web + api). Minor.
- **Cron per-minute** reminder sweep runs a Worker invocation every minute even with zero users. Cost is tiny ($0 on free tier) but means the api Worker is "always warm" in practice for cron — which actually *helps* cold starts for reminders, not navigation.
- **No `VITE_API_URL` baking** in production (relative `/api`) — good for portability; one extra path segment.

### 4.5 Quantified round trips per navigation (deployed, cold-ish)

| User action | Network requests (first time) | D1 queries (approx) | Perceived |
|---|---|---|---|
| Open app (signed out) | `/auth/me` (401) | 1 | splash ~100–200 ms |
| Open app (signed in, cold) | `/auth/me`, `/push/vapid`, `/preferences`, `/sync/pull` | ~12–18 | 1–2 s |
| Navigate to `/today` (first) | `/today` (+ ETag) | ~8–12 | 0.5–1.2 s |
| Navigate to `/tasks` etc. | none (mirror) + sync poll | 0 (+poll) | instant after chunk load |
| Route chunk (first visit) | `*.js` from CF cache | 0 | 0.2–0.6 s |
| Every 3.5 s (tab active) | `/sync/pull` | ~4–6 | background |

Assumptions: D1 primary ~80 ms RTT from user region; asset cache hit. See §9.

---

## 5. Removing Cloudflare as a deployment target

### 5.1 What Cloudflare gives this app today

- D1 (SQLite) + migrations applied by Alchemy.
- R2 backup bucket + lifecycle.
- api Worker (Effect fetch handler) + cron triggers (3).
- web StaticSite with SPA fallback + service-binding proxy.
- Web Push works (VAPID + service worker, same origin).
- Cost: ~$0–5/mo for a household (Workers free tier 100k req/day; D1 free tier 5M reads/day, 100k writes/day; R2 free 10 GB).

### 5.2 Migration cost off Cloudflare

| Concern | Effort | Notes |
|---|---|---|
| D1 → Postgres | Medium | `@effect/sql-d1` → `@effect/sql-pg` (Effect ships it). Schema SQL needs Postgres dialect (FTS5 → `tsvector`/`pg_trgm`; `batch` → transactions). ~1–2 weeks. |
| D1 → Turso/libSQL | Low-Medium | SQLite-compatible; keep most SQL. Need a libSQL client for Effect (none first-party; use `@libsql/client` via custom SqlClient). |
| D1 → SQLite on VPS | Low | Keep SQL almost verbatim; lose managed backups/replicas. |
| Alchemy → Docker/Compose | Medium | Rewrite `infra/`; add Caddy/Traefik for TLS; ~3–5 days. |
| Cron | Low | `node-cron` or systemd timers; reminder sweep every minute. |
| Backups | Low-Medium | `pg_dump`/`.backup` to S3/R2 cron; restore drill. |
| Push | Low | `web-push` already a devDep; move VAPID secrets to env. |
| Auth | Low | Cookie-based, framework-agnostic. |
| Static assets | Low | Serve `dist/client` via Caddy/nginx/CF Pages. |
| Observability | Medium | Replace Workers logs with pino + a log sink. |

### 5.3 Target comparison (hosting)

| Target | Cold starts | Cost @ near-zero | Ops burden | D1 lock-in | Push/Cron/Backup | Verdict |
|---|---|---|---|---|---|---|
| **Cloudflare + fixes** | ~none (isolate) | $0–5/mo | Low | High (D1) | Native | **Best fit now** |
| Plain VPS (Hetzner/Docker) | None (always on) | €6–12/mo | Medium | None | DIY | **Best if leaving CF** |
| Fly.io | Sleeps unless always-on ($5–15) | $5–15/mo | Low-Med | None | DIY | Good, higher cost |
| Railway | Stays up on Hobby | $5+/mo | Low | None | DIY | Good DX |
| Render | Free tier sleeps 15 min (bad) | $0–7/mo | Low | None | DIY | Avoid free tier for this |
| Vercel/Netlify + managed PG | Serverless cold starts (100–500 ms) | $0–20/mo | Low | None | Cron limited | Poor fit (Effect server) |
| AWS (ECS/Lambda) | Lambda cold starts | $15–40/mo | High | None | DIY | Overkill |

Notes: Fly/Railway/Render pricing verified via web search (2026): Fly no free tier, ~$2–5/mo smallest machine; Railway Hobby $5/mo with $5 usage; Render free web services sleep after 15 min; Hetzner VPS from ~€6/mo after 2026 price hikes. Sources: fly.io/pricing, railway.com/pricing, render.com/pricing, hetzner.com/cloud.

**Recommendation on hosting:** If leaving Cloudflare, prefer a **single small VPS** (Hetzner CX/ CAX, or a $5 Railway/Fly machine) running Node 24 + Postgres (or Turso) under Docker Compose + Caddy. One process, no cold starts, backups via cron to R2/S3. Avoid serverless (Vercel/Lambda) for the Effect RPC server — the per-request layer construction problem gets worse, not better, and you lose cron/push ergonomics.

---

## 6. Data/sync architecture evaluation

The user's two candidates (Convex, ElectricSQL+TanStack DB) plus others. Solid 2.0 support verified via web search.

### 6.1 Convex

- **Solid support:** *Community only.* `convex-solidjs` (Frank-III) and Jamie Turner's 50-line demo exist; Convex's official client is React-first, with Vue/Svelte/Angular community packages. No first-party Solid package. Sources: github.com/Frank-III/convex-solidjs, Reddit r/solidjs, convex.dev docs.
- **Offline/local-first:** Convex client caches queries and retries mutations, but is **not an offline-first write queue**; mutations fail when offline and must be retried by app code. Not a fit for this app's "works offline" guarantee (tasks/habits/notes).
- **Navigation latency:** Excellent once subscribed (realtime, edge); initial load is a subscription, not a fetch.
- **Realtime sync:** First-class, automatic.
- **Schema/migrations:** Convex schema + functions; migration is a rewrite of all domain logic into Convex functions (no Effect, no SQL). High cost.
- **Auth:** Convex Auth or Better Auth component; would replace the custom cookie session.
- **Cron/push:** Scheduled functions (cron) built-in; push via web-push in an action (no native push).
- **Hosting:** Managed Convex cloud (free tier: 1M function calls, 0.5 GB; Pro $25/dev/mo) or self-host the open-source backend. Sources: convex.dev/pricing.
- **Lock-in:** High (Convex data model + functions).
- **Verdict:** Great product, wrong fit here: no first-party Solid, no offline writes, high migration, high lock-in. Score 3.4/5.

### 6.2 ElectricSQL + TanStack DB

- **Solid support:** TanStack DB has an official Solid adapter (`injectLiveQuery`); TanStack Router/Start/Query support Solid 2.0 beta. Sources: tanstack.com/db/latest/docs/framework/solid/overview, kanopylabs blog.
- **Offline/local-first:** Electric syncs Postgres → local (PGlite/SQLite) for reads; writes go through your backend API then sync back. TanStack DB supports optimistic mutations. True offline *writes* require you to queue them (as this app already does). Good read story.
- **Navigation latency:** After first sync, reads are local (instant). First sync cost depends on data size.
- **Realtime sync:** Yes (Electric streams changes).
- **Schema/migrations:** Postgres schema; Electric shapes. Migration medium-high.
- **Auth:** Your backend (keep cookie session) or Electric's auth.
- **Cron/push:** Your backend.
- **Hosting:** Electric Cloud (usage-based: $1 per 1M writes, retention $0.10/GB·mo; reads/fan-out free) or self-host Electric (open source) + Postgres. Sources: electric.ax/pricing.
- **Lock-in:** Moderate (Electric shapes + sync protocol).
- **Verdict:** Strongest of the sync engines for Solid, but cost ($50–200/mo if managed) and complexity; offline writes still your problem. Score 3.0/5.

### 6.3 Rocicorp Zero

- **Solid support:** First-party (`zero.rocicorp.dev/docs/solidjs`, `ZeroProvider`). 
- **Offline/local-first:** **No offline writes.** Zero explicitly does not support offline writes; reads continue while disconnected. Source: zero.rocicorp.dev/docs/connection. This conflicts with this app's offline-first task/habit capture.
- **Maturity:** Reached 1.0 (June 2026) after 2 years. Source: InfoQ.
- **Pricing:** Pro $30/mo (100 GB), or self-host (open source). Source: zero.rocicorp.dev.
- **DB:** Postgres only.
- **Verdict:** Excellent Solid support and latency, but the no-offline-writes limitation disqualifies it for Tali's stated offline guarantee unless that guarantee is dropped. Score 3.05/5.

### 6.4 LiveStore

- **Solid support:** Yes — dedicated Solid getting-started docs and integration. Source: docs.livestore.dev/getting-started/solid.
- **Effect alignment:** LiveStore is Effect-based and uses reactive SQLite; very close to this repo's stack. It even migrates to Effect v4.
- **Offline/local-first:** Full local-first, event-sourced (mutation log). Strongest offline story.
- **Sync:** Via Cloudflare Durable Objects, Electric, or HTTP; backend required.
- **Maturity:** Beta (0.4/0.5), breaking changes expected. Source: docs.
- **Migration cost:** High — requires converting the relational D1 model into event-sourced aggregates; big rewrite.
- **Lock-in:** High (event sourcing + sync backend).
- **Verdict:** Most philosophically aligned with Tali (Effect + Solid + local-first), but beta maturity and event-sourcing rewrite make it a "watch, don't adopt now" option. Score 3.5/5.

### 6.5 PowerSync

- **Solid support:** Community adapter `aboviq/powersync-solid` (hooks). Source: github.
- **Offline/local-first:** Strong (SQLite client, offline writes queued).
- **Pricing:** Free tier 1 GB synced / 500 MB hosted; Pro from $49/mo. Source: powersync.com/pricing.
- **Maturity:** Mature, but Solid adapter is community, not first-party.
- **Verdict:** Good offline story, but community Solid adapter and higher cost than the current stack. Score 3.6/5.

### 6.6 InstantDB

- **Status:** **Sunsetting.** Team joined OpenAI (July 2026); cloud runs until Aug 31, 2027; new signups closed. Source: instantdb.com/essays/instant_team_joins_openai. **Do not adopt.**

### 6.7 Supabase (Postgres + Realtime)

- **Solid support:** Framework-agnostic JS client; no Solid-specific hooks (community wrappers). Realtime via channels.
- **Offline/local-first:** No offline writes; realtime reads.
- **Auth:** Built-in (would replace custom auth, losing the login-key model).
- **Pricing:** Free (500 MB DB, 50k MAU); Pro $25/mo. Source: supabase.com/pricing.
- **Verdict:** Good managed Postgres + auth, but adopting it means dropping the local-first/offline guarantee and the custom auth. Score 3.3/5.

### 6.8 Turso / libSQL (embedded replicas)

- **Solid support:** DB-only; framework-agnostic.
- **Offline/local-first:** Embedded replicas give a local SQLite file that syncs; reads are local-instant. Writes go to primary. Good fit for read-heavy navigation.
- **Pricing:** Free 5 GB / 500M row reads; paid from $4.99/mo. Source: turso.tech/pricing.
- **Effect integration:** No first-party `@effect/sql-libsql`; would need a custom SqlClient wrapping `@libsql/client`. Medium effort.
- **Verdict:** Best SQLite-continuity option; keeps schema mostly intact and adds embedded-replica low latency. Score 4.05/5 but with an integration caveat.

### 6.9 PGlite (Postgres in WASM)

- **Solid support:** Framework-agnostic.
- **Offline/local-first:** Client-side Postgres; multi-user sync is not built in (you bring your own). Not a credible multi-user backend for a household app today.
- **Verdict:** Interesting for single-user offline, not for Tali. Score ~3.85/5 with caveats.

### 6.10 Firebase (Firestore)

- **Solid support:** Framework-agnostic JS SDK.
- **Offline/local-first:** Firestore has offline persistence (client cache), but data model is document/NoSQL; migration from relational D1 is large.
- **Pricing:** Free (50k reads/day, 1 GB); pay-as-you-go. Source: firebase.google.com/pricing.
- **Lock-in:** High.
- **Verdict:** Viable but high migration and lock-in; not recommended. Score 3.4/5.

### 6.11 Plain Postgres + keep Effect RPC

- Replace `@effect/sql-d1` with `@effect/sql-pg`; keep `packages/rpc`, domain, Solid UI. Hosting on any Postgres (Neon free, Supabase free, VPS).
- **Pros:** preserves everything valuable; removes D1 lock-in; standard SQL; transactions.
- **Cons:** loses edge-D1 co-location; if hosted on Neon/Supabase free tier, cold-start on DB (scale-to-zero) reintroduces latency — use a VPS Postgres or paid always-on tier.
- **Verdict:** The recommended re-platform target if leaving Cloudflare. Score ~3.5–4 depending on hosting.

---

## 7. Recommendation

### 7.1 Smallest fixes that remove perceived lag WITHOUT re-platforming (do these first)

Estimated total: 1–2 weeks. Expected first-paint: 1–2 s → 300–600 ms; idle D1 cost: ~5× reduction.

1. **Cache the API handler per isolate** (`apps/api/src/index.ts:118-145`). Build `makeAppLayer` + `toWebHandler` lazily on first request and reuse for the isolate's lifetime (capture `env` on first fetch). Saves 10–40 ms/request and removes per-request layer churn. Keep `dispose()` semantics (no-op on reuse).
2. **Enable Cloudflare Smart Placement** for the api Worker (config in `infra/alchemy.run.ts` or wrangler). For a D1-heavy app, Smart Placement moves the Worker to the region closest to the D1 primary, cutting the D1 RTT from ~80 ms to ~5–15 ms. This is likely the single biggest win and is a one-line config change. Trade-off: slightly higher latency for far users, but this is a household app.
3. **Combine `/auth/me` + preferences into one endpoint** (or extend `SessionContext` with the user's `UserPreferences`). Saves one round trip on every boot and on every `/today` (which calls `preferences.get` separately). ~50 lines.
4. **Lazy-load push config.** Don't call `loadVapidPublicKey` (`push/config.ts:23`) on boot in `PushProvider.refresh` (`push/context.tsx:138-160`); fetch it only when the user opens `/settings` or `/reminders`, or after sign-in. Saves one request on cold boot.
5. **Throttle sync polling.** Change `ACTIVE_INTERVAL_MS` from 3.5 s to 10 s (or make it adaptive: 5 s for 2 min after a write, then 15 s). Cuts `/sync/pull` traffic ~3×. Keep `wake()` on local writes and tab visibility.
6. **Stop pruning on every pull.** Move `repo.prune(cutoff)` in `sync-service.ts:595` to a probabilistic/throttled call (e.g., only if `lastPrune` > 1 h, or move to the nightly purge cron). Saves a write per pull.
7. **Verify asset cache headers.** Confirm CF emits `immutable` for `/assets/*-HASH.*`; if not, add a `_headers` file or set via Alchemy/Worker. Saves repeat-visit asset revalidation.
8. **Optional but high-value: adopt D1 read replication** via the Sessions API for read-heavy paths (`auth.me` session lookup, `/today`, `/sync/pull` feed reads). Requires a custom SqlClient; do this only if Smart Placement alone doesn't fix it. Effort: 1 week.
9. **Measure first.** Add a tiny client timing log (navigation → first meaningful paint) and a server `Server-Timing` header on `/auth/me` and `/today` to attribute D1 vs CPU. Without numbers, don't re-platform.

### 7.2 Target architecture if re-platforming is justified

Only if the above leaves D1 latency unacceptable (e.g., user in a region far from any D1 primary even with Smart Placement):

> **Node 24 + Effect RPC (keep `packages/rpc`, `packages/domain`) + Postgres (or Turso) on a single small VPS, Docker Compose, Caddy for TLS, cron via node-cron, backups via pg_dump to R2/S3, push via web-push.**

- Preserve: domain schemas, typed RPC contract, Solid v2 RTL UI, local-first mirror + sync engine (point it at the new API).
- Swap: `@effect/sql-d1` → `@effect/sql-pg` (or `@effect/sql-sqlite` + Turso); migrations to Postgres dialect; Alchemy → Compose.
- Keep the sync protocol (cursor delta) — it is sound and already built.

### 7.3 Phased migration plan (if justified)

- **Phase 0 (week 1–2):** §7.1 fixes on Cloudflare. Measure.
- **Phase 1 (week 3):** Decision gate. If p95 first-paint < 700 ms, stop. Else continue.
- **Phase 2 (week 4–5):** DB portability. Introduce a `SqlClient` indirection (Effect layer) so D1 and Postgres can be swapped by config; migrate migrations to a dialect-agnostic runner or maintain two sets.
- **Phase 3 (week 6):** Node runtime. Convert `apps/api` fetch handler to `HttpServer.serve` (Effect's Node HTTP server); dockerize; add Caddy.
- **Phase 4 (week 7):** Data migration. Dump D1 → Postgres (script using `d1-dump.ts` as template); verify counts + FTS.
- **Phase 5 (week 8):** Cutover. DNS, secrets, cron, backups, push. Keep Cloudflare as fallback for 2 weeks.

### 7.4 Decision rule

- **Single/few-household app (Tali today):** optimize for *cost near zero + offline capability + low ops*. Cloudflare-with-fixes wins (score 4.35). If latency remains unacceptable, move to a **single VPS + Postgres** (score 3.5, but zero cold starts and full control) — not to a sync-engine platform, because the offline-write requirement and Solid 2.0 support eliminate Zero (no offline writes) and weaken Convex/Electric.
- **If this grows (multi-tenant, many households, global, need realtime collaboration):** revisit **ElectricSQL + TanStack DB** (best Solid support among sync engines, local reads) or **LiveStore** (Effect-aligned, but wait for 1.0). Adopt only after they ship stable offline writes and first-party Solid 2.0 bindings. Avoid Convex until it ships first-party Solid and true offline writes. Never adopt InstantDB (sunsetting).

---

## 8. Scored comparison

Criteria and weights (sum = 1.0):

| Criterion | Weight |
|---|---|
| Cold start / navigation latency | 0.20 |
| Cost at near-zero traffic | 0.15 |
| Operational burden | 0.15 |
| Offline / local-first fit | 0.15 |
| Solid v2 support | 0.10 |
| Migration cost (from current) | 0.10 |
| Lock-in / portability | 0.05 |
| Push / cron / backup features | 0.10 |

Scores 1–5 per criterion; weighted total:

| Option | Cold | Cost | Ops | Offline | Solid | Migr | Lock-in | Push | **Total** |
|---|---|---|---|---|---|---|---|---|---|
| Cloudflare + fixes | 4 | 5 | 4 | 4 | 5 | 5 | 2 | 5 | **4.35** |
| Turso + Node | 4 | 5 | 5 | 4 | 5 | 3 | 3 | 2 | **4.05** |
| Railway + Postgres | 3 | 3 | 5 | 4 | 5 | 3 | 4 | 3 | **3.70** |
| Render + Postgres (paid) | 2 | 4 | 5 | 4 | 5 | 3 | 4 | 3 | **3.65** |
| PowerSync | 4 | 4 | 4 | 5 | 3 | 2 | 3 | 2 | **3.60** |
| Fly.io + Postgres | 3 | 3 | 4 | 4 | 5 | 3 | 4 | 3 | **3.55** |
| Vercel + managed PG | 2 | 5 | 5 | 4 | 5 | 2 | 3 | 2 | **3.55** |
| VPS + Postgres (Hetzner) | 4 | 3 | 2 | 4 | 5 | 3 | 5 | 3 | **3.50** |
| LiveStore | 4 | 4 | 3 | 5 | 4 | 2 | 2 | 2 | **3.50** |
| Convex | 4 | 5 | 5 | 2 | 2 | 1 | 1 | 4 | **3.40** |
| Firebase | 3 | 5 | 5 | 3 | 3 | 1 | 1 | 4 | **3.40** |
| Supabase | 3 | 5 | 5 | 2 | 3 | 2 | 2 | 3 | **3.30** |
| Rocicorp Zero | 4 | 3 | 3 | 2 | 5 | 2 | 3 | 2 | **3.05** |
| ElectricSQL + TanStack DB | 3 | 2 | 3 | 4 | 5 | 2 | 3 | 2 | **3.00** |
| PGlite (client) | 4 | 5 | 5 | 3 | 5 | 2 | 4 | 2 | **3.85*** |

\* PGlite score is inflated: it has no multi-user sync engine, so it is not a credible backend for a household app despite the number. Treat as "not applicable."

Pros/cons summary (one line each):

| Option | Pros | Cons |
|---|---|---|
| Cloudflare + fixes | Zero cost, native push/cron/backup, no cold starts, already built | D1 single-region latency, Alchemy lock-in, D1 write limits |
| VPS + Postgres | Full control, no cold starts, portable, transactions | You run backups/SSL/updates; one region |
| Fly/Railway/Render | Managed, low ops | Cost creep, sleeping (Render), regional |
| Vercel/Netlify | Great frontend DX, free tier | Serverless cold starts; Effect server awkward; cron limits |
| Convex | Realtime, great DX, free tier | No first-party Solid, no offline writes, high lock-in/migration |
| Electric + TanStack DB | Best Solid sync engine, local reads, Postgres | Cost, complexity, writes still your problem |
| Zero | First-party Solid, 1.0, fast | No offline writes (disqualifying here) |
| LiveStore | Effect-aligned, full offline, Solid | Beta, event-sourcing rewrite, lock-in |
| PowerSync | Strong offline, managed | Community Solid adapter, $49/mo pro |
| InstantDB | — | **Sunsetting (Aug 2027). Do not adopt.** |
| Supabase | Managed Postgres + auth + realtime | No offline writes, replaces custom auth |
| Turso | SQLite continuity, embedded replicas, cheap | No Effect integration; beta-ish regions |
| Firebase | Free tier, FCM push | NoSQL migration, high lock-in |
| PGlite | Client-side Postgres | No multi-user sync |

---

## 9. Assumptions (stated)

- User region assumed Middle East/Europe; D1 primary assumed US (`WNAM`/`ENAM`) unless Smart Placement changes placement. If the user is in the US near the D1 primary, D1 latency is 5–20 ms and the "lag" is mostly client/asset, not D1.
- Asset cache assumed warm on repeat visits (CF edge). Cold-cache first visits cost asset download.
- Network: 4G ~20 Mbps; p95 RTT to nearest CF edge ~30 ms; to D1 primary ~80 ms.
- Household scale: 1–5 users, <100k rows, <1 GB data. Free tiers sufficient.
- Prices are 2026 list prices from vendor sites; subject to change. Verified via web search (see URLs in §5.3/§6).
- Solid v2 is still RC (2.0.0-rc.14 in this repo); ecosystem maturity assumed to improve but not guaranteed.
- No measurement was taken on the deployed app; all ms figures are estimates from code inspection + platform docs. §7.1 item 9 calls for instrumentation before any re-platform decision.

---

## 10. Sources (URLs)

Hosting/pricing:
- Cloudflare Workers pricing/limits: developers.cloudflare.com/workers/platform/pricing, /limits
- Cloudflare D1 read replication: blog.cloudflare.com/d1-read-replication-beta; developers.cloudflare.com/d1/best-practices/read-replication
- Fly.io: fly.io/pricing
- Railway: railway.com/pricing
- Render: render.com/pricing; render.com/docs/free
- Hetzner: hetzner.com/cloud
- Neon: neon.com/pricing
- Supabase: supabase.com/pricing
- Turso: turso.tech/pricing
- Firebase: firebase.google.com/pricing
- Convex: convex.dev/pricing
- Electric: electric.ax/pricing
- Zero: zero.rocicorp.dev; infoq.com/news/2026/06/zero-version-1
- PowerSync: powersync.com/pricing
- InstantDB sunset: instantdb.com/essays/instant_team_joins_openai

Solid support:
- TanStack DB Solid: tanstack.com/db/latest/docs/framework/solid/overview
- Zero Solid: zero.rocicorp.dev/docs/solidjs
- LiveStore Solid: docs.livestore.dev/getting-started/solid
- Convex Solid: github.com/Frank-III/convex-solidjs; Reddit r/solidjs
- PowerSync Solid: github.com/aboviq/powersync-solid
- InstantDB Solid: instantdb.com/docs/start-solidjs (issue #107)

Internal docs referenced: `docs/sync-protocol-draft.md`, `docs/adr/0009-nightly-backup-and-trash-purge.md`, `docs/backup-restore.md`, `docs/web-push-local.md`.