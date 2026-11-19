# Leaving Cloudflare — self-hosted architecture options

> **Prepared:** Wed Nov 18 2026. Companion to `docs/research/sync-engine-review.md` (free-plan fit + alternatives landscape; the vendor research there is not repeated here).
> **Question:** if Tali stops using Cloudflare entirely, what setup is most feasible and gives the best result — e.g. self-hosting on a VPS?
> **Method:** portability audit of the actual codebase (facts verified in-repo, cited below) + primary-source pricing/maintenance facts for the self-hosting pieces.

---

## 0. Executive summary

**The most feasible self-hosted setup is: one small VPS, one Node process, the app as-is with the D1 layer swapped for Node's built-in SQLite, Caddy in front, Litestream streaming backups off-site — and the sync engine untouched.** This is not a guess about portability; the repo *already proves it*: `apps/api/test/fake-d1.ts` implements D1's API over `node:sqlite` and runs the real repository SQL (compare-and-set, `last_insert_rowid()`, batch rollback) in the test suite today, the HTTP app is a standard web handler (`HttpRouter.toWebHandler`, `apps/api/src/index.ts`) rather than Worker-coupled code, and the repo requires Node ≥ 24, which ships `node:sqlite` natively.

**What self-hosting buys over the free plan — this is the interesting part:** real transactions with savepoints (the constraint-attribution bisection and `changes() = 1` gating can be *simplified away* over time), an in-process SSE wake channel with **zero new infrastructure** (the pub-sub that needs a Durable Object on Cloudflare is an event-emitter Map in a single Node process — this was the platform's only real gap), no 10 ms CPU / request / cron / 50 MB-result quotas to monitor, no Dec 2026 Observability pricing cliff, and no vendor dependency at all.

**Cost:** ~€4–7/mo for the VPS + ~$0–1/mo for off-site backup storage. **Effort:** roughly a focused week, none of it in the sync engine.

**If you would rather *stop owning the sync code* than port it:** the buy-side answer is **Zero, self-hosted** (Postgres + zero-cache on the same VPS; your conflict rules port verbatim as server mutators). That is the best *end state* if you also want reactive queries — but it costs a Postgres migration (including a Persian full-text-search rewrite) and a client rewrite, for a two-person app whose engine already works.

---

## 1. What leaving Cloudflare actually changes

| | Cloudflare free (today) | VPS self-host |
| --- | --- | --- |
| Cost | $0 | ~€4–7/mo + ~$0–1 storage |
| DB transactions | `batch()` only, atomic, no `BEGIN`/`COMMIT`; CAS + gated-ledger gymnastics | **Real `BEGIN`/`COMMIT` + SAVEPOINT** (`sql.withTransaction`, vendored Effect `sqlite-node`, with savepoint tests) |
| Realtime wake | needs a Durable Object (free but new infra) | **in-process SSE pub-sub** — a `Map<householdId, Set<controller>>`; the draft §5 wake design (nudge-only `{ _tag: "wake", seq }`) needs no DO at all |
| Scheduling | 3 cron triggers (5 max/account), count against request cap | **in-process timers** — `ReminderSweepLive` already runs *inside* the app layer; purge/backup are two more intervals |
| Limits to watch | 100k req/day, 10 ms CPU, 100 bound params, 50 queries/invocation, 500 MB DB, 7-day Time Travel, Dec 2026 logs-pricing change | none that matter at this scale; 40 GB disk |
| SPA hosting | static assets free & unlimited | Caddy serves `apps/web-foldkit/dist` from the same box (same-origin `/api/*` reverse proxy preserves the session-cookie story) |
| Backups | nightly D1→R2 dump; 7-day Time Travel | **Litestream** — continuous WAL streaming, PITR to any point (strictly better than nightly) |
| Edge/CDN | global anycast, DDoS shield, free TLS | one region near the users; you own TLS (Caddy auto), shielding (§5), uptime |
| Ops | zero | you: patching, monitoring, restore drills |
| Vendor risk | none that applies (engine is self-owned) | none at all |

The only things Cloudflare gives this app that a VPS doesn't: $0, global edge (irrelevant for one household), and someone else doing ops. Everything the *sync engine* fought on Cloudflare — no transactions, no shared isolate memory, request quotas, CPU caps — disappears.

## 2. Portability audit (verified in-repo)

What makes the VPS port unusually cheap is that the app was already structured portably:

1. **HTTP layer is runtime-agnostic.** `makeAppLayer` (apps/api/src/http-layer.ts) builds an `effect/http` `HttpRouter`; the entry (apps/api/src/index.ts) already converts it via `HttpRouter.toWebHandler` and wraps that in the Worker's `{ fetch }`. Serving the same web handler from Node's HTTP server (or Bun) is an entry-point swap, not a rewrite. CORS, cookie minting, and the `/api` same-origin design are platform-neutral.
2. **The data layer is one layer swap.** Repos talk to `SqlClient`/`D1Client` (`packages/sql/package.json` → `@effect/sql-d1`). The vendored Effect 4.1 the repo pins ships `@effect/sql-sqlite-node`, built directly on `node:sqlite` (WAL + busy-timeout configuration, backup API, `sql.withTransaction` with savepoints — `repos/effect/packages/sql/sqlite-node/src/SqliteClient.ts`, tests in the same package). The repo already requires `node: >= 24` (root `package.json`), which bundles that module.
3. **The SQL dialect stays SQLite.** All 15 migrations, the change-feed CAS statements, **and the Persian-aware FTS5 note search** (`notes_fts`, shadow-table handling in apps/api/src/d1-dump.ts) are SQLite. Staying on SQLite means a byte-compatible port; switching to Postgres would mean rewriting every migration *and* re-engineering Persian search on `tsvector` — the single most expensive port available, and it buys nothing unless you adopt Zero/Electric (§4).
4. **The engine already runs on Node SQLite.** `apps/api/test/fake-d1.ts`: "A tiny D1Database over Node's built-in SQLite for the sync-engine tests… the tests run the real repository SQL (including `last_insert_rowid()` and compare-and-set) against an in-process database, with a real transaction behind the batch so a failed commit rolls back exactly like D1." The compatibility proof-of-concept exists and runs in CI today.
5. **Scheduled work is already in-process.** The reminder sweep is a service inside the app layer (http-layer.ts provides `ReminderSweepLive`); Cloudflare's cron merely *ticks* it. A `setInterval` replaces the `* * * * *` trigger one-for-one; the nightly purge and backup become two more timers (or systemd timers if you prefer out-of-process scheduling).
6. **Observability is already provider-agnostic.** The stack exports OTLP traces/logs via `TALI_OTLP_*` URLs (infra/README.md) — on a VPS point them at Grafana Cloud's free tier or a self-hosted collector; no code changes.
7. **Web Push works from any origin** (VAPID + service worker), unchanged.
8. **One thing to verify on day one:** `node:sqlite` must be compiled with FTS5 in Node's bundled SQLite. Quick smoke test (`SELECT fts5(?1)` / create a `VIRTUAL TABLE`). If Node's build lacks FTS5, the fallbacks are the vendored `@effect/sql-sqlite-bun` (Bun bundles FTS5) or `@effect/sql-libsql` (libSQL ships FTS5) — the same `SqlClient` interface either way.

## 3. Recommended: S1 — "lift the app off the platform" (Node + SQLite on one VPS)

### 3.1 Target architecture

```
┌────────────────────── one VPS (2 vCPU / 4 GB, ~€4–7/mo) ──────────────────────┐
│                                                                               │
│  Caddy (TLS auto, HTTP/3)                                                     │
│   ├── serves apps/web-foldkit/dist as static SPA          (same origin)       │
│   └── reverse_proxy /api/* → 127.0.0.1:8787                                   │
│                                                                               │
│  Node ≥ 24 (systemd service or Docker)                                        │
│   ├── makeAppLayer(...) → HttpRouter.toWebHandler → node:http                 │
│   │     (apps/api/src/http-layer.ts — unchanged)                               │
│   ├── SqlClient: @effect/sql-sqlite-node  (node:sqlite, WAL, busy_timeout)    │
│   │     file: /var/lib/tali/tali.db  (SQLite, FTS5 incl.)                     │
│   ├── timers: reminder sweep (interval), trash purge (daily),                │
│   │           retention purge (daily)  — replaces the 3 cron triggers         │
│   └── WakeHub: Map<householdId, Set<SseController>>                           │
│         · POST-commit hook → emit { _tag: "wake", seq } to the partner        │
│         · SSE route /sync/wake  (draft §5/DP-6 design, nudge-only)            │
│         · client keeps the poll cadence as fallback — degrade gracefully      │
│                                                                               │
│  Litestream v0.5.x (separate process)                                         │
│   └── streams tali.db WAL continuously → Backblaze B2 / S3 (encrypted)         │
│         PITR restore to any point — replaces nightly D1→R2 dumps              │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 What the engine gains (the simplification runway)

- **Single-writer becomes airtight.** One process, synchronous `node:sqlite` calls, all writes serialized in-process — the two-user race analysis in the protocol draft stops being a boundary condition.
- **The exactly-once triple can keep its shape but lose its guards *gradually*.** `writeEntity + appendFeed + recordApplied` can move into one `sql.withTransaction` (with per-entry SAVEPOINT isolation on the bisection path, or per-entry savepoints replacing the 32-batch recursion). Nothing forces this — the current batch shape already works against SQLite (fake-d1 proves it) — but over time the `changes() = 1` gating, the `MAX_ISOLATION_BATCHES` budget, and the D1 micro-limit workarounds (`MAX_IN_PARAMS`, compound-SELECT chunking) can all be retired. The engine shrinks to its semantics: oplog + outbox + CAS + merge rules.
- **SSE wake replaces polling** — the design the protocol draft *settled* (§5, DP-6's nudge-only `{ _tag: "wake", seq }`) but deferred for infra. On a single process it is ~50 lines. Client side: the transport gains a `wake` method; the cadence module demotes polling to a 5-minute safety net (it already handles reconnect/backoff, so nothing is lost on process restarts or missed wakes).

### 3.3 The work list (engine untouched)

| Step | What | Size |
| --- | --- | --- |
| 1 | Node entry: `node:http` server wrapping the existing `toWebHandler`; env for VAPID/Capture secrets moves to a systemd `EnvironmentFile`/Docker secrets | ~1 day |
| 2 | DB layer swap: `sqlite-node` `SqlClient.layer({ filename })` + boot-time migration runner (the 15 migration files already apply "out-of-band"); verify FTS5 (§2.8) | ~1 day |
| 3 | Backup: Litestream unit (config: B2/S3 destination, retention) + retire `d1-backup`/`d1-dump`; update `docs/backup-restore.md` for `litestream restore` | ~½ day |
| 4 | Timers: replace the 3 cron triggers with in-process intervals; keep the dev `POST /dev/reminders/sweep` trigger as-is | ~½ day |
| 5 | WakeHub + `/sync/wake` SSE route + commit-hook emission + client transport `wake` + cadence demotion | 1–2 days (incl. boundary tests) |
| 6 | Deploy: Caddyfile, systemd unit (or Dockerfile), GH Action rsync/build+restart; uptime monitor pinging `/health` | ~1 day |

**Keep the Cloudflare bridge.** `makeAppLayer` is platform-agnostic, the migrations are shared, and the test suite already runs both runtimes (workerd boundary tests via `@cloudflare/vitest-plugin`, Node service-direct tests via fake-d1). A VPS migration does not have to burn the Workers deploy — it can stay a warm standby at $0 until you're confident.

### 3.4 Risks, honestly

- **You are the SRE.** Patching (unattended-upgrades), TLS (Caddy handles), monitoring (Uptime Kuma or a free healthchecks.io on `/health`), and **restore drills** — a backup you've never restored is a rumor. Litestream makes drills cheap (`litestream restore -o /tmp/drill.db`).
- **Single box = single failure domain.** Acceptable for a household app; the IndexedDB mirror means users keep working offline through an outage, and the outbox syncs on recovery — the app is *architecturally resilient to its server being down*, which most apps can't say.
- **No DDoS shield / edge.** A cheap VPS is an exposed IP. If it ever matters, any proxy-only CDN (bunny.net ~$1/mo, or yes, Cloudflare DNS-only proxy) sits in front without changing the app.
- **Provider/region choice:** pick a region near the users (one household — one region is enough). If the operator's billing location restricts some EU providers, Netcup/Contabo/OVH/DigitalOcean are interchangeable at this spec; the stack doesn't care.
- **node:sqlite is synchronous** (blocks the event loop per query). At household scale this is unmeasurable; it is also why the single-writer guarantee is free. If it ever mattered, the same `SqlClient` interface runs on Bun (`sqlite-bun`) or libSQL.

## 4. Alternative self-hosted stacks

### S2 — Zero, self-hosted (the "stop owning sync" path)

Same VPS, different shape: Postgres 15+ (`wal_level=logical`) + the `zero-cache` replica node (single-node docker-compose is the documented self-host shape) + your API as Zero mutators; clients swap the IndexedDB mirror for Zero's WASM-SQLite store and subscribe to typed ZQL queries.

- **Why it can win in the end:** server-authoritative mutators mean your conflict rules port *verbatim* (tombstone-wins, delete-with-recovery, done-wins, field-level LWW are just mutator code); Read Permissions express the private/shared visibility split as row-level rules; realtime reactivity is built-in; the sync internals stop being your code. GA since Mar 2026, current 1.12 (`docs/research/sync-engine-review.md` §5.2 has the sources).
- **What it costs:** the Postgres migration is the expensive half — 15 SQLite-DDL migrations rewritten, every repo statement translated, **and the Persian FTS5 search rebuilt on Postgres full-text** (the normalization work in `note-search-routes.ts` would need a `tsvector` equivalent). Plus a client rewrite onto Zero's store (React-first SDK; Foldkit integration is the risk item to prototype first), plus a second always-on process.
- **When to choose it:** if you want the query reactivity (live ZQL views in every screen) *and* to externalize the mirror/outbox code, and you accept ~$5–10/mo and a multi-week migration. For two users, this is the "best possible product" answer; S1 is the "best feasible result" answer.

### S3 — Electric reads + your writes, on Postgres

Replace only the pull half with Electric shapes into PGlite in the browser; writes keep your API. Adds a Postgres + sync-service container for zero conflict-resolution benefit (Electric's own docs: no synced local writes yet) — you'd keep the push engine *and* gain a second backend. Only sensible if a future feature wants PGlite (e.g. heavy client-side SQL). Not recommended.

### S4 — PowerSync self-host (Open Edition)

Mature, writes stay yours via `uploadData`, WebSocket realtime built-in — but it needs Postgres **plus** the PowerSync service **plus** a bucket-storage DB (Mongo or Postgres): three moving parts to replace code you already own, on a database you'd have to migrate to first. The 1-week-inactivity problem only affects their *cloud*, but self-host gains you nothing over S1 here. Not recommended for this app.

### Considered and rejected (from the prior report's research, short form)

- **Convex self-hosted OSS** — a real, actively-developed option in 2026 (docker-compose backend + dashboard, SQLite or Postgres/MySQL storage, FSL→Apache-2.0 license, [self-hosting guide](https://github.com/convex/convex-backend/blob/main/self-hosted/README.md)) — but it is a reactive *online* platform whose offline story is still "in progress": the official offline alpha ([curvilinear](https://github.com/get-convex/curvilinear)) is archived, the official object sync engine is announced-not-shipped ([Convex's own post](https://stack.convex.dev/object-sync-engine): "currently working on our own object sync engine"), and the closest community option ([convex-localfirst](https://github.com/Fanzzzd/convex-localfirst)) is a pre-1.0, single-author, ~4-month-old library (created Jun 2026, 0.4.0) whose architecture replicates Tali's engine — a validation, not a foundation. The full migration assessment: your conflict rules port (and *simplify* — Convex mutations are single serializable transactions, so the CAS-gating/bisection machinery disappears), but the SQL layer, FTS5 Persian search, Effect services, auth, and Foldkit client integration are all rewrites. Worth re-evaluating only if Convex ships its own sync engine as a stable feature. ([convex open-source](https://www.convex.dev/open-source), [Automerge+Convex](https://stack.convex.dev/automerge-and-convex))
- **Jazz 2 self-host** — Effect bindings + a CF/serverless target are coming, but alpha.67 with weekly breaking changes in Nov 2026; re-evaluate mid-2027 ([alpha.60 post](https://jazz.tools/blog/jazz-2-alpha-60)).
- **PocketBase / Supabase / CouchDB** — solve hosting, not your offline sync; you'd keep the engine anyway.
- **Turso Sync self-host** — young Rust rewrite, interval-based sync without a wake channel; a lateral move off a working engine.

## 5. Cost & ops summary

| Item | S1 (Node+SQLite) | S2 (Zero) |
| --- | --- | --- |
| VPS (2 vCPU/4 GB) | ~€4–7/mo (Hetzner CX23 ~€5.99, [pricing checked Nov 2026](https://www.hetzner.com/cloud/); DO/Vultr ~$6; Netcup/Contabo cheaper) | same box (Postgres + zero-cache + API fit comfortably) |
| Off-site backups | ~$0 (Backblaze B2 free tier 10 GB ≫ a household DB) | same for Postgres (WAL-G/pgBackRest → B2) |
| New moving parts | Caddy, Litestream, timers (all single-binary/one-config) | Postgres, zero-cache, mutator API, client store rewrite |
| Sync-engine changes | none (later: optional simplification) | full port of rules into mutators; engine deleted |
| Client changes | one transport method (`wake`) | store + queries rewritten |
| Fallback | keep the CF Workers deploy warm at $0 | migration is one-way |

Litestream facts: v0.5.18 (Nov 3, 2026), actively maintained, Apache-2.0, continuous WAL streaming to S3/B2/GCS/Azure/SFTP with LTX format and per-page restore ([releases](https://github.com/benbjohnson/litestream/releases), [litestream.io](https://litestream.io/)) — strictly stronger than the current nightly-dump regime.

## 6. Verdict

**S1 is the answer to "most feasible *and* best result":** the port is small because the codebase was written portably (the proof already runs in CI), every Cloudflare-imposed constraint the engine worked around evaporates, the deferred SSE wake channel — the one real gap in the current design — becomes ~50 lines, and the total run cost is ~$6/mo with the $0 Cloudflare deploy retained as a standby. The sync engine, conflict rules, tests, and the Persian FTS5 search all survive untouched; several engine hacks (gated ledger rows, bisection, param chunking) become *simplification backlog* rather than load-bearing code.

Choose **S2 (Zero)** only if the goal is to stop owning sync internals and you want live-query reactivity everywhere — accepting a Postgres migration (incl. rebuilding Persian search), a client-store rewrite, and a one-way migration.

Either way, the engine's design (oplog cursor pull + idempotent CAS push + server-side merge rules) is the right one; the only question is who hosts the runtime it already targets.

---

## Sources

In-repo facts (cited inline): `apps/api/src/http-layer.ts`, `apps/api/src/index.ts`, `apps/api/test/fake-d1.ts`, `packages/sql/package.json`, root `package.json` (Node ≥ 24), `packages/sql/migrations/`, `infra/README.md`, vendored `repos/effect/packages/sql/sqlite-node/` (client, `withTransaction` tests).

External: Hetzner Cloud pricing (checked Nov 2026 — note new-customer provisioning restrictions in 2026; equivalents interchangeable); Litestream releases/docs (v0.5.18, Nov 2026); Zero self-host docs and status (GA Mar 2026, 1.12); Electric/PowerSync/Jazz/Convex citations as in `docs/research/sync-engine-review.md` §5–7 and `/tmp/opencode/sync-alternatives-research.md`.
