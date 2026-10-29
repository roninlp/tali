# Tali deploy latency — synthesis

Date: 2026-10-29
Scope: architecture review of the deployed app ("feels laggy, navigation is slow
after cold starts"), Cloudflare viability, and data/sync alternatives.
Inputs: four independent research runs (`iceman.md`, `beam.md`, `deepseek.md`,
`mimo.md` in this directory) plus a local measurement pass on this checkout.

**Bottom line: do not re-platform yet.** The lag is mostly self-inflicted and
survives any move: it is a fan-out of sequential D1 statements on every read
model, a database **write on every authenticated read**, a prune **write on
every 3.5 s sync poll**, a blocking auth boot, a full-screen splash behind lazy
route chunks, and no immutable asset caching. Cloudflare is a multiplier, not
the cause. The cheapest path to "fast" is 1–2 days of in-place fixes; the
cheapest path to "not Cloudflare" later is a DB seam, not a rewrite.

---

## 1. Measured evidence (this checkout, 2026-10-29)

Counted with a temporary instrumented D1 wrapper (each statement counts, the
way D1 counts a batch member), against the real routes and services:

| Route | D1 statements | Notes |
| --- | ---: | --- |
| `GET /health` | 0 | no DB |
| `GET /auth/me` | 4 | 3 reads + 1 session-expiry **write** |
| `GET /preferences` | 5 | auth (4) + 1 read |
| `GET /today` | **11** | auth 4 + preferences 1 + 5 task bucket queries + pinned notes |
| `GET /week` | **11** | auth 4 + preferences 1 + tasks 4 + events 2... |
| `GET /month` | **11** | same shape as week |
| `GET /sync/pull` | **8** | auth 4 + `prune` (2 DELETEs) + min-seq + feed + hydration |

Other measurements:

- **Calendar navigation** fetches week **and** month => ~22 statements per tap.
- **Cold boot** fans out to `/auth/me`, `/preferences`, `/today`,
  `/sync/pull`, and `/push/vapid` (the last one even when signed out, and twice
  after sign-in) => ~35 statements before the first fully-live screen.
- API Worker bundle: **760 KB** minified JS (5.4 MB with source map).
- Initial web payload: **~139 KB gzip** (entry 14 KB + router 84 KB + tokens
  25 KB + RPC 14 KB + CSS 1.5 KB); route chunks 38–79 KB raw, lazy-loaded.
- Per-request Effect layer + router construction: **~1 ms** in Node
  (`makeAppLayer` 0.002 ms, `toWebHandler` create+dispose 1.0 ms). Real, but
  **not** the seconds-long culprit that some reports assume. Hoist it anyway;
  it is free.

At a plausible 20–80 ms per Worker→D1 round trip (Worker at the user's PoP, D1
primary in another region), the read models cost **220–880 ms each**, before
cold-start and client work. That matches the perceived lag exactly.

---

## 2. Root causes, ranked

1. **Sequential D1 fan-out per read model.**
   `auth.me` (`apps/api/src/auth-service.ts:205-227`) resolves a session with
   4 statements; `TodayService.get` (`apps/api/src/today-service.ts:43-90`)
   then runs 5 independent task queries (`task-service.ts:1170-1190`) and a
   notes query, one after another. No `Effect.all({concurrency})`, no
   `db.batch()` for reads. Calendar repeats the pattern twice per navigation
   (`apps/api/src/calendar-service.ts:175-219`).

2. **Write-on-read.** `sessions.extend(...)` runs unconditionally on every
   authenticated request (`auth-service.ts:218-220`). D1 writes are the
   expensive path and serialize on the single primary. With a 3.5 s poll this
   is ~25k writes/day per open tab for no user-visible benefit.

3. **Sync poll is a write + full scan.** `GET /sync/pull` calls `repo.prune()`
   on **every** poll (`apps/api/src/sync-service.ts:944`), i.e. 2 DELETEs every
   3.5 s. After each pass the client runs `failedCount()` =
   `mirror.getAll()` (`apps/web/src/lib/local-store/store.ts:175-180`,
   `context.tsx:106-108,181`) — a full IndexedDB scan every few seconds.

4. **Blocking auth boot + splash.** The app starts `checking`, blocks every
   guarded route (`apps/web/src/components/guard.tsx:27,43`) until
   `/auth/me` settles, and only uses the cached session **on failure**
   (`auth.tsx:92-98`). Route components are lazy (`4 × lazy` in the built
   router chunk) and the global fallback is a full-screen `Splash`
   (`apps/web/src/App.tsx:26-28`), so a cold chunk fetch looks like a page
   reload on every navigation.

5. **No route prefetch / no immutable asset headers.** Nav uses
   `navigate()` (`app-header.tsx:101-103`) with no preload. Alchemy's static
   assets config supports `_headers` (`Assets.d.ts:55-58`) but none is set, so
   hashed assets have no long-lived browser cache.

6. **Two Workers per API call.** `/api/*` is proxied by the web Worker to the
   API Worker over a service binding (`apps/web/worker.ts`), so every request
   pays two invocations and can pay two cold starts. A single Worker with an
   assets binding, or route-level mapping on a custom domain, removes the hop.

7. **Cron every minute + sync polling.** Not a direct navigation cost, but the
   reminder sweep wakes the same Worker 1,440×/day and the poll loop never lets
   the isolate sleep, while each poll still does writes. Review after 1–3 are
   fixed.

---

## 3. Fix first (no re-platform), in payoff order

| # | Change | Files | Effort | Expected effect |
| --- | --- | --- | --- | --- |
| 1 | Put the API Worker next to D1 (`placement: { mode: "smart" }`), and pin D1's primary location near users/household | `infra/alchemy.run.ts` | 10 min | 20–80 ms → 1–3 ms per D1 hop; 5–10× on every read |
| 2 | Stop renewing the session on every request; renew at most hourly, and cache the principal (signed cookie or KV) | `auth-service.ts:205-227` | 0.5 day | −1 write/−3 reads per request |
| 3 | Batch the `/today`, `/week`, `/month` reads with `db.batch()` / `Effect.all(concurrency)` | today/calendar/task services | 1 day | 11 → ~4 statements; 22 → ~6 per nav |
| 4 | Move `prune()` to the nightly cron | `sync-service.ts:944` | 1 h | removes 2 writes/poll |
| 5 | Boot from the cached session optimistically; reconcile in the background | `auth.tsx`, `guard.tsx` | 0.5 day | removes the blocking RTT before first paint |
| 6 | Replace `Splash` with a route skeleton and prefetch chunks on hover/focus/idle (`<A>`/`router.preload`) | `App.tsx`, `app-header.tsx`, router | 0.5 day | navigation feels instant |
| 7 | `_headers`: `Cache-Control: public, max-age=31536000, immutable` for `/assets/*` | `infra/alchemy.run.ts` assets | 10 min | removes revalidation on repeat visits |
| 8 | Lazy push config (only on settings/reminders or after sign-in), dedupe the double `refresh()` | `push/context.tsx:238-266` | 2 h | −1–2 requests on cold boot |
| 9 | Replace `failedCount()` full scan with an index/flag; throttle poll to 10–15 s idle | local-store, sync-cadence | 0.5 day | removes recurring jank |
| 10 | Read models: cache the last body in IndexedDB keyed by ETag; paint it synchronously, revalidate in background | `today`, `calendar` screens | 1 day | nav = 0 network on repeat |

Definition of done: `/today` p50 < 120 ms warm / < 300 ms cold from the target
city; boot-to-interactive < 900 ms on a mid-range phone; in-app nav < 150 ms;
zero writes on a read-only poll.

If those numbers still miss, the next lever is **DO-SQLite per household** (one
Durable Object per household, SQLite inside, WebSocket fan-out): it deletes the
D1 RTT term and the polling entirely, while staying on Cloudflare. That is a
2–4 week change, not a rewrite.

---

## 4. Is removing Cloudflare justified?

Not to fix this lag, no. What is actually Cloudflare-coupled:

- `@effect/sql-d1` + `D1Database` bindings and the migration runner.
- R2 backup, Workers cron, the `/api` proxy Worker, Alchemy state.
- Alchemy itself is a 2.0 beta; that is a legitimate durability concern.

Everything valuable is portable: `packages/domain`, `packages/rpc`, the Effect
services, the sync protocol and its conflict lab, the Solid UI. A move to
Node + Postgres is ~1–3 weeks (SQL dialect, migrations, backup, cron, TLS,
deploy), and **it does not fix** query fan-out, write-on-read, the splash, or
the poll. Port those fixes with you.

Decision guide:

- **Single/few households, < 10 devices, < 50k rows:** Cloudflare + fixes is
  the cheapest and (after `placement`) lowest-latency option. Stay.
- **Cloudflare is filtered/throttled where the users are** (e.g. Iran): that,
  not latency, decides the host. Use a regional host (Arvan/Liara/Hamravesh) or
  a European VPS with a domain that is not filtered; keep the SPA static
  anywhere.
- **Growth, realtime collaboration, > 20 households:** consider DO-SQLite
  (stay) or Postgres + Electric/TanStack DB (leave). Convex only if you want to
  abandon SQL + Effect and accept a Solid binding that is not first-class.

---

## 5. Options, pros/cons

### 5.1 Deployment targets

| Option | Pros | Cons |
| --- | --- | --- |
| **Cloudflare + fixes** (recommended now) | Cheapest (~$0–5/mo), global static edge, zero servers, keeps every asset; `placement` + batching removes most latency | D1 is single-primary and single-threaded; beta Alchemy; Workers cold starts on 760 KB bundle; lock-in on D1/Alchemy |
| **Cloudflare + DO-SQLite per household** | No DB RTT (SQLite in the DO), native WebSocket sync, still cheap, strong consistency per household | New architecture (DO alarms/WebSocket), SQLite-in-DO limits, 2–4 weeks, harder backups/analytics |
| **Cloudflare + Hyperdrive + Postgres** | Keeps edge, managed Postgres, connection pooling | Adds a second vendor; Hyperdrive only helps from Workers; still serverless cold starts |
| **Single VPS + Postgres** (Hetzner/Railway/Render) | No cold starts, predictable p95, full control, easy backups, ~€5–10/mo, can sit near users | You own TLS/deploys/backups/uptime; single region; ~1–3 weeks migration; lose edge static (use a CDN) |
| **Fly.io (always-on 1 machine)** | Easy Docker deploy, regions, no cold start if `min_machines_running=1` | Scale-to-zero default reintroduces cold starts; volumes/backups DIY; ~$3–7/mo |
| **Vercel/Netlify + Neon/Supabase** | Great DX for the SPA | Serverless cold starts return; Neon scale-to-zero and Supabase free-tier pause are cold starts; need Postgres rewrite |
| **AWS** | Everything available | Overkill, expensive, high ops for one household |
| **Convex** | Reactive queries over WebSocket, no query cold starts, optimistic mutations, built-in cron/auth/storage, zero ops | Document store, not SQL; rewrites ~19k lines of Effect services; Solid support is community/beta; weaker durable offline writes; lock-in |
| **ElectricSQL + TanStack DB** | Postgres truth, shape-based partial sync, official TanStack DB Solid adapter, live queries + optimistic mutations, keeps your write API | More moving parts (Postgres + Electric + API), Electric is read-path sync, beta-ish maturity, migration from D1 schema + sync protocol |
| **PowerSync** | Mature offline-first sync, Postgres/MySQL/Mongo, SQLite on device, self-host or cloud, framework-agnostic JS | Another service + connector to write; Solid bindings are DIY; cost/ops |
| **Zero (Rocicorp)** | Query-driven sync, Postgres, permissions, very fast | React-first (no first-class Solid), offline writes/limits weaker, new query language |
| **Supabase** | Postgres + auth + storage + Realtime in one, good DX | Realtime is not local-first; free tier pauses; RLS/permissions rework; Solid via vanilla client |
| **Turso/libSQL** | SQLite continuity, embedded replicas, cheap | Not a reactive sync engine for browsers; you still build sync (or add TanStack DB); writes to primary |
| **PocketBase** | One binary, SQLite, realtime SSE, auth, admin UI, trivial self-host | Weaker typed schema/Effect integration; no offline sync engine; single-node |
| **Firebase** | Realtime + offline SDK, managed | No SQL, poor relational fit, lock-in, cost surprises |

### 5.2 Data/sync

| Option | Pros | Cons |
| --- | --- | --- |
| **Keep the current sync engine** | Already built and tested (conflict lab, CAS, tombstones, replay), offline outbox, no vendor | You own it; polling instead of push; needs the fixes above |
| **Convex** | Push-based reactive queries, end-to-end TS, optimistic UI, crons, no ops | Rewrite, document DB, Solid gap, offline writes, lock-in |
| **Electric + TanStack DB** | SQL truth, real partial sync, Solid adapter, optimistic mutations, incremental adoption | Ops (Postgres + Electric), read-path-only sync (writes via API), maturity, migration |
| **Zero** | Fast query sync, Postgres, permissions | React-only, new query model, offline gaps |
| **PowerSync** | Proven offline sync, SQLite local, many backends | Service + write connector, Solid DIY, cost |
| **LiveStore** | Event-sourced, SQLite, local-first, Effect-friendly ideas | Early (pre-1.0), Solid support unproven |
| **Supabase Realtime** | Simple broadcast/postgres changes | Not local-first, no offline queue, RLS work |
| **Turso + TanStack DB** | SQLite + local collections | Sync engine still yours; browser story immature |
| **Plain Postgres + TanStack Query (Solid)** | Dead simple, no sync engine | You rebuild offline/outbox; fine if offline is not required |

---

## 6. Scored view (heuristic)

Weights: latency 25, cost 15, ops 15, migration 15, Solid fit 10, offline 10,
realtime 10. Scores 1–5 (5 best); this is a decision aid, not a benchmark.

| Option | Lat | Cost | Ops | Migr | Solid | Offline | RT | **Total** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cloudflare + fixes | 4 | 5 | 5 | 5 | 5 | 5 | 2 | **4.45** |
| Cloudflare + DO-SQLite | 5 | 5 | 4 | 2 | 5 | 5 | 5 | **4.40** |
| Single VPS + Postgres | 5 | 4 | 3 | 2 | 5 | 5 | 3 | **3.90** |
| Fly.io always-on | 4 | 4 | 4 | 2 | 5 | 5 | 3 | **3.65** |
| PocketBase | 5 | 5 | 3 | 1 | 4 | 2 | 4 | **3.60** |
| Convex | 4 | 4 | 5 | 1 | 2 | 2 | 5 | **3.40** |
| Turso/libSQL | 4 | 4 | 3 | 3 | 4 | 3 | 2 | **3.40** |
| Electric + TanStack DB | 4 | 3 | 2 | 2 | 4 | 4 | 5 | **3.35** |
| PowerSync | 4 | 3 | 2 | 2 | 3 | 5 | 4 | **3.25** |
| Supabase | 3 | 3 | 4 | 2 | 4 | 2 | 4 | **3.10** |
| Firebase | 3 | 3 | 5 | 1 | 3 | 3 | 4 | **3.10** |
| Zero | 4 | 3 | 2 | 2 | 1 | 3 | 5 | **2.95** |

The two leaders are the same platform: fix what you have, and if you outgrow
it, move the SQLite closer (DO) rather than changing paradigms.

---

## 7. What the four research runs agreed on

- Unanimous: **fix in place first**; Cloudflare is viable for this scale.
- Unanimous: D1 fan-out + `auth.me` write-on-read + 3.5 s poll/prune are the
  main server costs.
- Unanimous: **Convex is a poor fit** (React-first, rewrite, weaker offline).
- Three of four: **Electric + TanStack DB** is the best fallback if
  re-platforming is ever justified; it is the only major engine with a Solid
  adapter and it keeps Postgres/SQL.
- Disagreement: impact of per-request layer construction. `iceman` rates it
  high; measured here at ~1 ms, so treat it as cleanup, not the fix.
- Disagreement: API bundle size. `mimo` reported 6.2 MB; that includes the
  source map. The shipped script is 760 KB.

Read the full reports: `iceman.md`, `beam.md`, `deepseek.md`, `mimo.md`.

---

## 8. Measure before and after

```sh
# Cold vs warm, with and without a cookie
for i in $(seq 1 20); do
  curl -s -o /dev/null -w '%{time_starttransfer} %{time_total}\n' \
    -H "cookie: tali_session=$TOKEN" https://<host>/api/today
done

curl -sI https://<host>/api/health | grep -i cf-placement   # local-FRA vs remote-*
npx wrangler d1 info <db>                                    # primary location hint
```

The slope of `time_total` against statement count is the per-statement RTT; it
tells you whether placement/batching fixed it or whether the remaining cost is
cold start. Add a `Server-Timing` header around auth, queries and serialization
to attribute the rest.
