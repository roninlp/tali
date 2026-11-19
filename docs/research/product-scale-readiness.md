# Product-scale readiness — design decisions for going from 2 users to a real product

> **Prepared:** Wed Nov 18 2026. Third in the series: `docs/research/sync-engine-review.md` (free-plan fit, alternatives) → `docs/research/selfhost-architecture.md` (leaving Cloudflare) → this one (scaling to many users as a product).
> **Question:** if Tali becomes a real product serving many users, what design decisions need to be made — and when?
> **Scope note:** "more users" here means **many 2-person households**, because that is what the domain model is (see D7 for the multi-member question). Scaling a household-partitioned app is the friendly kind of scaling: every table, feed, and filter is already scoped by `household_id`, so growth is N copies of a small, well-understood unit rather than growth of any one thing.

---

## 0. Executive summary

**The sync engine is not the thing that will block this product.** The app's shape is unusually scale-friendly: per-household data partitioning, per-user client databases, register + invite-code household joining, per-request Effect layers, and an oplog that never moves more than deltas. Verified in-repo:

- every syncable row and the whole `change_feed` are household-scoped ([0003_sync_engine.sql](../../packages/sql/migrations/0003_sync_engine.sql));
- the client mirror is already one IndexedDB **per user** (`tali.mirror.v1.<userId>`, [store.ts](../../packages/sync-client/src/local-store/store.ts)) — two accounts sharing a browser is already handled;
- auth already has register / create-household / **join-by-invite-code** ([auth-service.ts](../../apps/api/src/auth-service.ts)) — the multi-tenant account skeleton exists;
- observability is already OTLP-exported and provider-agnostic.

**The decisions split into two categories:**

1. **Cheap now, painful later (do these regardless, they're the graduation prerequisites):** per-household `seq` in the change feed, a wake-channel abstraction instead of polling as the primary realtime mechanism, and an email channel for account lifecycle.
2. **Genuinely open (decide at defined triggers, not today):** the database graduation (D1 → Postgres) and its timing, engine keep-vs-buy at seed scale, sharding strategy if staying on D1, and whether the household model itself generalizes.

The honest headline: with the wake channel and per-household scheduling in place, **the current architecture on Workers Paid carries comfortably to ~1,000+ households**; the real product blockers are the boring ones — password reset, email verification, account deletion, AI-feature quotas, support tooling — none of which exist yet (verified: the auth surface has no reset/verify/delete endpoints, and the api sends no email at all).

---

## 1. What already scales (verified) vs what breaks first

| Component | At 2 users | At N households | Verdict |
| --- | --- | --- | --- |
| Household partitioning (`household_id` everywhere) | ✅ | ✅ the natural shard key — each household is a small self-contained dataset | scales as-is |
| Cursor pull (`(household_id, seq)` index) | ✅ | ✅ per-client deltas only; index range scans stay O(household changes) | scales as-is |
| Outbox push + CAS + `applied_mutations` | ✅ | ✅ contention is per-row within a household; two users/household is the ceiling *by design* | scales as-is |
| Per-user IndexedDB mirror | ✅ | ✅ already one DB per user | scales as-is |
| Register / invite-code join | ✅ | ✅ account model exists; lifecycle features don't (D6) | partial |
| **Global `change_feed` AUTOINCREMENT `seq`** | ✅ | ⚠️ one serialization point shared by every household in the DB; blocks clean sharding later | **fix now (D2)** |
| **Polling wake (10/30 s)** | fine | ❌ requests scale linearly with open tabs — the first budget/cost wall; already the #1 consumer | **replace now (D3)** |
| **`* * * * *` global reminder sweep** | fine | ❌ one cron scanning on behalf of all households; the second wall; also 3 of 5 free-plan cron slots | **replace at growth (D4)** |
| Nightly trash-purge / retention | ✅ | ✅ index-driven; chunk deletes to stay under the 30 s D1 query cap as data grows | watch |
| Capture (AI dissect) | ✅ personal key | ❌ **the only per-user marginal cost in the stack** — model calls scale linearly with users | **quota now (D8)** |
| Bootstrap (offset-paged full pull) | ✅ | ✅ bounded by household size, not user count | scales as-is |

## 2. The decisions

Each is framed the way the repo's ADRs work (`docs/adr/`): context, options, recommendation, and *when to decide*. D1–D3 are the ones that shape everything else.

### D1 — The database graduation: stay SQLite-family or move to Postgres (the irreversible one)

**Context.** Every productized sync platform that matched your semantics (Zero, PowerSync, Electric) requires Postgres. Staying on D1 keeps $0-ish hosting, Cloudflare-native realtime (DOs), and zero migration; going to Postgres buys real transactions (the engine's batch-gating and bisection become simplification backlog), mature tooling, the *option* to adopt those platforms later, and easier analytics/admin. The catch from the self-host report still applies: it's the most expensive port available (15 SQLite DDL migrations + every repo statement + the Persian FTS5 search → `tsvector` rewrite).

**Recommendation.** Don't move today — but commit to **graduation triggers** so the decision is made by data, not by crisis:
- **Stay on D1** through launch and early growth. Workers Paid ($5/mo) removes the request/CPU caps; D1 Paid includes 25B rows read + 50M rows written per month ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)) — at 1,000 households × ~50 mutations/day × ~5 rows each ≈ 250k rows written/**month**, you'd use ~0.5% of the included writes. Raw load is not the trigger.
- **Move to Postgres when any of:** (a) you want Zero/PowerSync-style reactive queries or decide to externalize the engine; (b) you need cross-household analytics/admin tooling beyond what D1 queries give you; (c) you outgrow single-region (Postgres replication geography is simpler than D1's read-replica beta); (d) regulatory/data-residency demands.
- Do the two cheap pre-requisites **now** (D2, D5's platform-portable commit path) so the graduation stays a mechanical port instead of a rewrite under pressure.

### D2 — Change-feed cursor: global `seq` → per-household `seq` (do this now)

**Context.** `change_feed.seq` is a single global AUTOINCREMENT ([0003_sync_engine.sql](../../packages/sql/migrations/0003_sync_engine.sql)). Every household's feed appends share one counter row and one right-growing B-tree. Today it's harmless. Tomorrow it is the one piece of shared mutable state that (a) prevents moving a household between databases cleanly (a sharded D1 world, D1's per-DB 500 MB cap, or per-household DO storage), and (b) concentrates all write contention in one place.

**Options.** (a) Per-household counter row updated in the same batch (`seq = seq + 1 WHERE household_id = :h`, read back via the batch); (b) `MAX(seq)+1` pre-read inside the push planning phase (safe under D1 single-writer + your CAS); (c) timestamp-based cursor (`updated_at` + tiebreak) — weakest, breaks "cursor is exact resume point".

**Recommendation.** (a). Clients are household-scoped, so the client still holds one scalar cursor — the wire shape barely changes (`(household_id, seq)` replaces `seq` in the feed; pull query is the same index). Small migration + one repo method; the conflict lab tests prove it quickly. This is the top "cheap now, expensive later" item in the codebase.

### D3 — Realtime at product scale: wake channel as the primary, polling as the fallback

**Context.** Polling is request-budget-linear in users; the wake channel is O(connected clients) with negligible marginal cost on both platforms in play: a hibernating per-household Durable Object on Cloudflare (`docs/research/sync-engine-review.md` Option A), an in-process hub on a single Node server (`docs/research/selfhost-architecture.md` §3.2).

**Recommendation.** Build the wake as an **abstraction, not a platform feature**: the client transport gains a `wake` subscription (the sync engine already has the seam — transport injection); the server emits `{ _tag: "wake", seq }` after every committed batch (the protocol draft §5/DP-6 design, unchanged). The hub's backend is then a platform detail — DO today, in-process Map on a VPS, Postgres `LISTEN/NOTIFY` or Redis pub/sub if you ever run multiple API servers. Deciding the *interface* now is what makes later scaling a config change.

### D4 — Reminders and scheduled work: per-household instead of global cron

**Context.** One `* * * * *` trigger sweeping the reminders table works at 2 users; at 1,000 households it is a per-minute cross-tenant scan and you've spent 3 of 5 free-plan cron slots. The reminder sweep already runs *inside* the app layer ([http-layer.ts](../../apps/api/src/http-layer.ts)); only the tick source is platform-coupled.

**Options.** (a) **Durable Object alarms per household** (CF-native: an alarm invocation per household per due reminder — cheap, tenant-scaled, no scanning); (b) a coarser sweep but interval-scaled (e.g. `idx_reminders_fire_at`-driven batch sweep every minute stays viable to ~hundreds of households — it's an index range, not a table scan); (c) client-scheduled notifications with Web Push as the reliability backstop (the push stack already exists).

**Recommendation.** Keep the per-minute index-driven sweep through launch (it's better than it looks — measure it); move to (a) when household count makes the sweep's fixed cost visible, or on the VPS path where in-process timing makes it trivial. Either way the sweep *code* (ReminderSweepLive) doesn't change — only the tick source.

### D5 — Engine: keep custom or buy, at product scale

**Context.** The strongest argument for productized sync (Zero/PowerSync) was never features — it was "stop maintaining the intricate part." At product scale there's a second argument: someone else guarantees the sync internals under load.

**Recommendation.** Keep the custom engine through launch and growth. Reasons: (1) your conflict rules are the product's character — server-authoritative tombstone-wins / delete-with-recovery / done-wins is exactly what Zero mutators would run, so buying removes maintenance, not complexity; (2) the 2026 graveyard (see the first report, §5.1) makes vendor-reliance a *risk* argument, not just a cost one; (3) the engine's one intricate-but-load-bearing section (batch gating + bisection) shrinks on both graduation paths — real transactions on Postgres/VPS, per-entry savepoints in DO storage. Re-evaluate only at seed scale and only bundled with the reactive-queries desire (Zero + Postgres). The ADR to write: *"the sync engine is a product asset, not a liability, until measurable evidence says otherwise."*

### D6 — Account lifecycle: the actual launch blockers

**Context.** Verified: auth has register / login / household create / invite-code join, with login rate-limiting. It has **no password reset, no email verification, no account deletion or export**, and the api **sends no email at all** — `email` is just a credential column. For a product taking strangers, these are the difference between "demo" and "product": people forget passwords on day one.

**Decisions to make:**
- **Email provider** (Resend / Postmark / SES — all are plain HTTP APIs callable from a Worker; needs SPF/DKIM on the domain). This is a *prerequisite* decision for everything below.
- **Password reset flow** (token + expiry; reuses the existing session/credential infrastructure).
- **Email verification** (gating invite delivery to verified addresses keeps household-spam out).
- **Account deletion + data export** (privacy compliance and trust; the trash-purge machinery already proves hard-delete plumbing exists).
- **Session policy** at product scale (rotation on password change; the cookie session-repo is in place).

### D7 — Domain decision: is the product still couples?

**Context.** The engine hard-codes a 2-member mental model in places (visibility = `private|shared` with one partner; "only the owner can un-share"; acceptance criteria phrased as "the other user"). Generalizing to families/teams (N members, roles, per-member visibility) is a *domain modeling* change, not just an engineering one — it touches settled conflict rules and the wire schemas.

**Recommendation.** Decide this as a **product** decision before any scale work: if the product is couples (and the Persian-calendar niche suggests a deliberate audience), keep the 2-member model — it is a differentiator and a simplification, and the engine should not pay for generality nobody asked for. If multi-member households are on the roadmap, schedule the visibility generalization (memberships with roles) *before* marketing to that audience — it's the one change that ripples through the protocol, not just the backend.

### D8 — The one linear per-user cost: Capture (AI)

**Context.** Capture dissects run on `OPENCODE_API_KEY` — pay-per-use model calls. At 2 users, nothing. At N users, this is the **only marginal cost that scales linearly with usage**, and the only feature where one user can spend real money.

**Recommendation.** Before onboarding strangers: per-user daily quota (the capture rate-limiter exists and is extensible), a budget cap alert, and eventually tier gating (free tier = K dissects/day). This is also the natural first monetization surface.

### D9 — Observability, support, and trust

At 2 users you *are* the support. At N users you need: error tracking (Sentry or OTLP→Grafana/Honeycomb — the exporters already exist), alerting on `/health` and on sync-path error rates (the `SyncRejected`/rejection-marker flows give you per-user failure visibility no generic product would), a status page, and the Dec 2026 Workers Logs pricing check from the first report. None of this changes the architecture; all of it changes whether you can *keep* the architecture healthy.

### D10 — Payments (if "product" means revenue)

Merchant-of-record (Paddle / Lemon Squeezy) vs raw Stripe: MoR handles tax/VAT and is dramatically less work for a solo founder. This is orthogonal to the sync stack — but note the CF-native path makes the whole product's infra bill ~$5–15/mo at launch scale, so pricing is about value capture, not cost recovery.

## 3. Phased roadmap (what to do when)

**Phase 0 — now, regardless of product plans (all cheap, all graduation prerequisites):**
1. Per-household `seq` (D2).
2. Wake channel behind a transport abstraction (D3) — DO on CF or in-process on VPS; polling demotes to fallback.
3. Traces/logs budget check before the Dec 2026 observability change.

**Phase 1 — launch-ready (first users outside the household):**
Workers Paid ($5/mo, removes daily caps + 10 ms CPU — a product should not run on fail-closed quotas); email provider + password reset + email verification (D6); account deletion/export; Capture quota (D8); error tracking + `/health` alerting (D9); terms/privacy; decide D7 (couples vs families) as a *positioning* act.

**Phase 2 — growth (order of ~100 → 1,000 households):**
Measure, then act: reminder sweep → per-household alarms (D4); D1 sharding decision if staying D1 (household → DB routing; D1 Paid includes 100k databases at $0.10/db, so per-household or bucketed-shard D1 databases are cheap — D2 is what makes this mechanical); Postgres graduation **if and only if** a D1 trigger fired (reactive queries wanted, analytics, residency); load-test the push path under realistic offline-catch-up shapes (the conflict lab generalizes to this).

**Phase 3 — scale (1,000+ households):**
Engine keep-vs-buy re-evaluation (bundled with reactive queries, D5); multi-region only on measured need; consider the per-household DO as full write coordinator (single-writer by construction — the draft's CAS gymnastics retire).

**Explicitly premature at every phase until measured otherwise:** CRDT rewrite, microservices, multi-region, queue-everything, generalized N-member domain model, and replacing the engine before a trigger fires. The engine survived the 2026 vendor graveyard; don't volunteer it for another migration before the product demands one.

## 4. Cost picture (why infra is not the constraint)

At 1,000 households with the wake channel live: D1 writes ≈ 250k rows/mo (~0.5% of the 50M included on Paid), reads trivial (deltas), storage megabytes, Worker requests well under 10M included, DOs hibernating. **The whole platform bill is ~$10–20/mo.** The linear costs are Capture model calls (D8), email sends (D6), and your attention (D9). A real product on this stack is limited by product work, not by architecture — which is the position you want to be scaling from.

---

## Sources

In-repo: `packages/sql/migrations/0003_sync_engine.sql`, `apps/api/src/sync-service.ts`, `apps/api/src/http-layer.ts` (sweep in-app), `apps/api/src/auth-routes.ts` + `auth-service.ts` (register/invite; no reset/verify/delete), `packages/sync-client/src/local-store/store.ts` (per-user DB), `packages/sync-client/src/sync-cadence.ts`, prior reports `docs/research/sync-engine-review.md` and `docs/research/selfhost-architecture.md`.

External: [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) (Paid: 25B rows read/mo, 50M rows written/mo included; $0.10/database beyond 100k; checked Nov 2026), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) ($5/mo Paid), [Durable Objects pricing/limits](https://developers.cloudflare.com/durable-objects/platform/limits/) (alarms, hibernation) — all verified in the Nov 18 2026 research pass behind the first report.
