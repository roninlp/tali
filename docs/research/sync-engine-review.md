# Sync engine review — free-plan fit and alternatives

> **Prepared:** Wed Nov 18 2026.
> **Questions:** (1) Is the hand-built pull/push sync engine a good fit for the **Cloudflare free plan** the app currently runs on? (2) Are there better ways to get the same functionality — across tech stacks, platforms, and tools?
> **Reviewed:** `docs/sync-protocol-draft.md`, `apps/api/src/sync-service.ts`, `apps/api/src/sync-write.ts`, `apps/api/src/sync.ts`, `packages/sql/src/sync-repo.ts`, `packages/sql/migrations/0003_sync_engine.sql`, `packages/sync-client/src/sync-engine.ts`, `packages/sync-client/src/local-store/*`, `packages/sync-client/src/sync-cadence.ts`, `apps/web-foldkit/src/sync.ts`, `infra/alchemy.run.ts`, `infra/README.md`.
> **Method:** code review against current (Nov 2026) Cloudflare platform limits and the 2026 sync-tooling landscape, verified against primary sources (official docs, pricing pages, GitHub). Every external fact carries a URL.

---

## 0. Executive summary

**Is it good for the free plan? Yes — the engine is visibly designed *around* D1's real constraints rather than fighting them, and at two-user scale it sits comfortably inside every free-tier budget except one: the polling wake channel, which is the dominant consumer of the 100k requests/day allowance (worst case ~17% of it, realistic days ~6%).** The 2026 free plan even removes the engine's one deferred weakness: Durable Objects on the free plan are SQLite-backed and idle WebSockets hibernate *free of duration billing*, so the SSE/DO wake channel that `docs/sync-protocol-draft.md` DP-5 deferred as "hardening" now costs approximately nothing.

**Are there better ways? Not meaningfully, and the 2026 vendor graveyard is the strongest evidence.** In the 18 months to Nov 2026 the productized sync clouds consolidated violently: ElectricSQL joined Databricks (cloud winding down), InstantDB's team joined OpenAI (cloud dies Aug 2027), Replicache was archived (Jun 2026), Triplit's cloud closed, PartyKit's hosted platform shut, and cr-sqlite went unmaintained. Adopting any of them in 2024 would have meant a forced migration in 2026. The engines that survived with matching semantics — Zero, PowerSync — both require Postgres plus an always-on sync node, i.e. leaving the Cloudflare free plan and paying ~$5–10/mo for a two-person app. The closest same-semantics, same-host option (RxDB) sells back your own engine with the good storage backends behind a $99/mo paywall.

**Recommendation (details in §6): keep the engine, add a hibernating per-household Durable Object wake channel** — the one change that is $0, incremental, keeps every settled conflict rule verbatim, and closes the only user-visible gap (10–30 s cross-device latency → sub-second).

---

## 1. What you have (as built)

Two monotonic numbers, deliberately separated — the core mental model is correct and matches the classic designs:

| Number | Where | Purpose | Implementation |
| --- | --- | --- | --- |
| `seq` (global) | `change_feed` (`0003_sync_engine.sql`) | the pull cursor across all 11 entity types | append-only, per-household scoped, `(household_id, seq)` index, 90-day retention with `resetRequired` → re-bootstrap |
| `version` (per-row) | every syncable row | the conflict/CAS anchor | server-assigned on every commit incl. soft-delete |

**Pull** (`GET /sync/pull?cursor&limit` → [sync-service.ts](../../apps/api/src/sync-service.ts)): reads the feed page, hydrates latest entity state, filters `ownerId == me OR visibility == 'shared'` **after** the read, resolves inherited-visibility children against the parent's *current* visibility, and cascades removals when a list/habit goes invisible. Stale cursor (or empty feed with non-zero cursor) → `resetRequired: true`, client re-bootstraps. Bootstrap is a separate offset-paged endpoint.

**Push transactions** (`POST /sync/push`, ≤200 entries → [sync-write.ts](../../apps/api/src/sync-write.ts)): one `D1Client.batch()` per push carrying, per entry, the CAS-gated entity write + the feed append + the `applied_mutations` ledger row, with the ledger row gated on the feed append via `changes() = 1`. Exactly-once replay through `clientMutationId`; parents ordered before children; constraint failures attributed per-entry by **bounded recursive bisection** (32-batch cap) with the remainder rejected as `AttributionLimit` rather than wedging the outbox. Server is the single conflict resolver (tombstone → delete-wins-with-recovery → done-wins → recurrence single-writer → field-level LWW on partial patches).

**Client** ([sync-engine.ts](../../packages/sync-client/src/sync-engine.ts), [store.ts](../../packages/sync-client/src/local-store/store.ts)): IndexedDB mirror is the render source; mirror writes + outbox entries land in **one IDB transaction**; outbox coalescing only folds *unsent* entries; `markSent` happens *before* the request leaves so a timed-out entry is retried byte-for-byte (never re-folded, which would hide newer fields behind an `applied_mutations` dedupe hit); `baseVersion` chains per entity off returned versions. Reconcile order is pull → push, minimizing conflicts. Rejections land as durable `syncError` markers in the same ack transaction; habit revive/restore edge cases are repaired through explicit RPC mutations rather than complicating the generic resolver.

**Wake:** cursor-wake polling — 10 s active / 30 s idle / 30 s hidden, exponential backoff 1 s→30 s with ±20% jitter ([sync-cadence.ts](../../packages/sync-client/src/sync-cadence.ts)). No SSE (DP-5 deferred it: fan-out would need a Durable Object, "new infra not yet in the settled stack").

---

## 2. What is right about this design (and why 2026 vindicates it)

1. **The architecture is the same one the surviving products use internally.** A seq-cursor append-only oplog with per-row version CAS *is* CouchDB's `_changes` replication modernized, and Replicache documented exactly this row-version strategy before archiving itself in favor of Zero, which still does it against Postgres. The research turned up no $0, D1-compatible platform that implements these semantics for you ([research C3](#7-sources)).
2. **D1's "no transactions" constraint is handled the only correct way.** As of Nov 2026 D1 still has no interactive transactions — `BEGIN`/`COMMIT` through `prepare()` are rejected, and the 2025 "Sessions API" (`withSession()`) is sequential consistency across read *replicas*, not transactions ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession)). `batch()` remains the only multi-statement atomic primitive ("batched statements are SQL transactions"; docs are ambiguous about auto-commit but a 2026 measured test confirmed real rollback — [zenn.dev test](https://zenn.dev/katsuo_dev/articles/202608-d1-batch-atomicity-test?locale=en)). Building the entity+feed+ledger triple as one gated batch is the right answer, not a workaround.
3. **The single-writer assumption is sound.** D1 is "inherently single-threaded, … backed by a single Durable Object" ([D1 concurrency](https://developers.cloudflare.com/d1/platform/limits/#concurrency-and-throughput)) — the CAS + ledger dedupe cannot be raced by the second household member in the two-user case.
4. **Idempotency is double-guarded** (`applied_mutations` for lost responses, CAS for double-fires), and the client's mark-before-send protocol makes replay byte-identical — the textbook exactly-once-on-a-lossy-request design.
5. **D1 micro-limits are already internalized in code**: the 100-bound-parameter limit (chunked `IN` lists, `MAX_IN_PARAMS = 90`), the five-term compound-SELECT limit, bounded push chunks, bounded bisection. These are the limits that bite people on the free plan, and they're already engineered around ([sync-repo.ts](../../packages/sql/src/sync-repo.ts)).
6. **Backups close the free-plan gap deliberately**: free D1 Time Travel is only 7 days (Paid: 30) ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)) — the nightly D1→R2 dump with 30-day lifecycle covers it, and R2's free tier (10 GB-month, 1M Class A ops/mo) is nowhere near pressured ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)).

---

## 3. Issues and risks found in review

Ordered by practical impact; none is a correctness bug at the current scale.

| # | Severity | Finding | Notes / mitigations |
| --- | --- | --- | --- |
| R1 | **Medium** | **Polling is the standing request-budget consumer.** Two tabs at the healthy 10 s cadence for 8 h ≈ 5,760 polls/day; a pathological 24/7 pair ≈ 17,280/day (17% of the 100k cap). Each poll also spends D1 reads (`minSeq` + feed page + hydration round-trips). | The DO wake channel (§6 Option A) reduces steady-state polls to ~zero and turns "a few seconds" acceptance into sub-second. Until then, the cadence table is already tuned (visibility-aware, jittered backoff); nothing to change. |
| R2 | Medium-low | **CPU exposure on the push path.** Free plan allows **10 ms CPU/invocation** ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/); average Worker uses ~2.2 ms). D1 wait time doesn't count, but a 200-entry push pays JSON parse + Schema decode + conflict rules + statement building, and the bisection worst case pays it across up to 32 sequential batches in one invocation. | Watch CPU in Observability; keep `PUSH_CHUNK = 200`; if it ever binds, Workers Paid ($5/mo) raises the ceiling to 30 s. At two-user write volume this is a monitoring item, not a blocker. |
| R3 | Low | **The engine deliberately does *not* advance the cursor from the push response** ([sync-engine.ts](../../packages/sync-client/src/sync-engine.ts), comment at the `ack` call), deviating from draft §4.3. Correct — jumping to your own write's `seq` would permanently skip a partner change committed between your pull and your push — but it costs one redundant re-pull of your own writes on the next pass. | Accept as-is; the safety/simplicity trade is right. The wire field `cursor` in `SyncPushResponse` is now dead weight — either document the deviation in the draft or drop the field. |
| R4 | Low | **Visibility filtering happens after the feed read, in service code** — the feed page limit counts invisible rows. A bulk import of 500 partner-private rows makes the other client loop through pages whose every entry is filtered out. | Harmless at household scale (the client loops `hasMore`); if it ever itches, add the `ownerId`/`visibility` predicate to the SQL itself — the columns are denormalized on the feed row precisely to allow it. |
| R5 | Low | **Cron headroom is finite**: free plan allows **5 cron triggers per account** ([limits](https://developers.cloudflare.com/workers/platform/limits/)); the Worker uses exactly 3 (reminder sweep, purge, backup). Scheduled invocations count against the 100k/day request cap — the `* * * * *` sweep is 1,440/day ≈ 1.4%, fine. | Just know that two more cron triggers are all you get on free before consolidation is forced. |
| R6 | Low | **A December 2026 pricing change is coming**: Workers Logs move to **Cloudflare Observability pricing on Dec 1, 2026** ([Workers Logs pricing](https://developers.cloudflare.com/workers/platform/pricing/#workers-logs), [Observability pricing](https://developers.cloudflare.com/observability/pricing/)). The stack already head-samples traces at 10% (`infra/README.md`) — verify the new free allowances before that date and consider whether invocation logs for ~20k polls/day are worth keeping. | Calendar item, not a code change. |
| R7 | Informational | **Two tabs of the same user share one IndexedDB**, so two engines could read the same outbox — but `markSent`'s readwrite transaction serializes across tabs (same-origin IDB transactions are atomic), so only one tab can claim an entry; the "same clientMutationId pushed twice concurrently" boundary in draft §4.2 is safer than documented. | No action; worth a sentence in the draft's MVP-boundary note. |
| R8 | Informational | **New D1 query-result limit of 50 MB (effective Nov 4, 2026)** ([changelog](https://developers.cloudflare.com/changelog/post/2026-10-30-query-result-size-limit/)). | Irrelevant at this scale; listed for completeness. |

**Explicitly checked and found correct:** mirror+outbox single-transaction discipline; fold-only-unsent; mark-before-send; `baseVersion` chaining (stored anchor authoritative only for the first un-acked entry per entity); parents-before-children batch ordering with the `recurrence:<parentId>` derived-key exemption; gated ledger rows (`changes() = 1`); delete-of-unseen-row tombstone insert staying retryable rather than rejected; the Forbidden poison-entry drain; inherited-visibility cascade removals (ADR-0011).

---

## 4. Free-plan fit — the budget

All limits from Cloudflare's own pricing/limits pages, Nov 2026 ([Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [DO](https://developers.cloudflare.com/durable-objects/platform/limits/)).

| Resource | Free allowance | Tali's usage (2 users) | Headroom |
| --- | --- | --- | --- |
| Worker requests | 100,000/day | crons 1,442 (1.4%) + polls ~2k–17k/day (cadence-dependent) + RPC/push low | ✅ 80–97% |
| Worker CPU | 10 ms/invocation | poll/auth ≪ 1 ms; push path 1–5 ms typical, bisection worst case the watch item (R2) | ✅ with monitoring |
| Cron triggers | 5/account | 3 in use | ✅ 2 spare |
| D1 rows read | 5,000,000/day | polls (minSeq + feed page + hydration, indexed) ≈ hundreds of thousands/day worst case; cron sweep reads too | ✅ large |
| D1 rows written | 100,000/day | each committed mutation writes entity + feed + ledger + index rows ≈ 3–6 rows; household writes are hundreds/day | ✅ ~3 orders |
| D1 storage | 5 GB total, 500 MB/DB | household-scale SQLite: megabytes | ✅ |
| D1 queries/invocation | 50 (batch() counts as **one**) | pull: 3–4 queries; push: pre-reads + one batch + verify reads ≈ 4–5; bisection ≤ 32 batches → within 50 | ✅ (bisection is also why the 32-batch cap matters) |
| D1 Time Travel | **7 days free** | mitigated by nightly R2 dumps (by design) | ✅ deliberate |
| R2 | 10 GB-month, 1M A / 10M B ops/mo | one dump/night | ✅ |
| Workers Logs | 200k events/day, 3-day retention; **observability pricing change Dec 1, 2026** | ~20k invocations/day × a few events | ⚠️ verify at changeover (R6) |
| Durable Objects (unused today) | SQLite-backed only on Free; 100k DO req/day; 13,000 GB-s/day; **idle hibernating DOs are not billed duration** | — | ✅ headroom for Option A |
| Static assets (SPA) | **free and unlimited requests** | the PWA shell costs nothing | ✅ |

**Verdict: the setup fits the free plan with large margins.** The design choices that could have broken the free plan — unbounded feed growth, unbounded ledger, unbounded bisection fan-out, oversized pull pages — are all explicitly bounded in code and docs (90-day retention, `MAX_ISOLATION_BATCHES`, `MAX_PULL_LIMIT`, chunk caps).

---

## 5. Alternatives — the 2026 landscape

### 5.1 The graveyard (why "buy" was riskier than "build")

- **ElectricSQL** → joined Databricks (Aug 2026); Electric Cloud winding down; open-source read-path components continue ([announcement](https://electric.ax/blog/2026/08/11/electric-joining-databricks)).
- **InstantDB** → team joined OpenAI; cloud closes to new signups, shuts down **Aug 31, 2027** ([self-hosting docs](https://www.instantdb.com/docs/self-hosting)).
- **Replicache** → archived Jun 10, 2026; users directed to Zero ([repo](https://github.com/rocicorp/replicache), [replicache.dev](https://replicache.dev)).
- **Triplit Cloud** → no new users; self-host recommended ([docs](https://www.triplit.dev/docs/triplit-cloud/self-hosted-deployments)).
- **PartyKit hosted** → shut down post-Cloudflare-acquisition; libs live on as PartyServer/PartySocket over raw DOs ([shutdown post](https://blog.partykit.io/posts/hosted-platform-shutdown/)).
- **cr-sqlite / vlcn** → effectively unmaintained ([maintenance discussion, Aug 2026](https://github.com/vlcn-io/cr-sqlite/discussions/347)).

Tali's self-owned engine avoided that entire failure class.

### 5.2 The viable candidates

**Zero (rocicorp)** — the strongest external fit. GA Mar 2026 (1.0), current 1.12 ([status](https://zero.rocicorp.dev/docs/status), [release notes](https://zero.rocicorp.dev/docs/release-notes/1.12)). Clients hold WASM-SQLite replicas of your Postgres and subscribe to typed ZQL queries; **writes are mutations in your own server code** — "all reads and writes flow through your code on your server" ([zero.rocicorp.dev](https://zero.rocicorp.dev/)) — so tombstone-wins, delete-with-recovery, done-wins, and field-level LWW port verbatim. **Read Permissions** are a first-class row-level feature ([docs](https://zero.rocicorp.dev/docs/postgres-support)), covering the private/shared split. The cost: Postgres 15+ (`wal_level=logical`) **plus an always-on zero-cache node** ([self-host](https://zero.rocicorp.dev/docs/self-host)) — i.e. leaving the Cloudflare free plan for a ~$5–10/mo VPS or Neon + host. Managed Cloud Zero Hobby is $30/mo. Known gaps: Postgres-only, no views, ~232 KB gzipped client bundle ([InfoQ review](https://www.infoq.com/news/2026/06/zero-version-1/)).

**PowerSync** — mature and active (v2 JS SDKs, Jun–Jul 2026 changelog; [docs](https://docs.powersync.com/intro/setup-guide)). Bucketed delta sync into client SQLite; writes go through your own backend's `uploadData()` ([app-backend setup](https://docs.powersync.com/configuration/app-backend/setup)), so conflict rules stay yours; Sync Streams give per-client subsets. Two killers for this app: **no D1/SQLite source** (Postgres/MongoDB/MySQL/SQL Server — you'd swap D1 for Postgres), and the free cloud **deactivates after 1 week of inactivity** ([pricing](https://powersync.com/pricing)) — hostile to a sporadically-used household app. Self-host Open Edition needs a ~$5/mo VM.

**RxDB** — the only "keep Workers+D1" replacement ([rxdb.info](https://rxdb.info/)): a client-side DB with a BYO-endpoint replication protocol and your own conflict handlers, Dexie (IndexedDB) storage free. But the good browser storages (SQLite/OPFS) are **$99/mo "Pro" plugins** ([premium](https://rxdb.info/premium)), and it's a rewrite of the Foldkit data layer around RxJS observables to get back what you already own.

**Cloudflare-native: per-household Durable Object** — the in-house upgrade (§6 Option A). DOs on the free plan are SQLite-backed with 100k requests/day and 13,000 GB-s/day ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/#durable-objects)); **WebSocket hibernation means idle DOs accrue no duration**, `setWebSocketAutoResponse()` heartbeats cost no wall time, and incoming messages bill at 20:1 against requests ([hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)). PartyServer/PartySocket remain as maintained sugar over raw DOs.

### 5.3 Considered and rejected (with reasons)

| Technology | Why not for this app |
| --- | --- |
| Firestore | Offline cache + realtime are best-in-class, but the conflict model is fixed LWW-ish — **cannot express done-wins / delete-with-recovery / field-level LWW as server policy**; total NoSQL rewrite. Free Spark: 50k reads/20k writes/day ([pricing](https://firebase.google.com/pricing)). |
| ElectricSQL alone | Read-path only — "we don't yet support local writes being synced out, or conflict resolution" ([pglite sync docs](https://pglite.dev/docs/sync)) — you'd keep your push engine anyway, plus run Postgres. |
| Convex | Excellent realtime, crons on free, now self-hostable OSS ([open-source backend](https://www.convex.dev/open-source)) — but **no offline cache for relational rows**; offline is via an Automerge side-channel ([Automerge+Convex](https://stack.convex.dev/automerge-and-convex)). |
| Supabase | Great RLS and realtime, **no first-party offline sync** ([community discussion](https://github.com/orgs/supabase/discussions/357)) — a hosting swap, not an engine. Free projects pause after 1 week idle ([pricing](https://supabase.com/pricing)). |
| Turso / libSQL | The lowest-friction *database* swap (SQLite→SQLite, schema ports ~1:1; free: 100 DBs / 5 GB / 500M reads/mo, [pricing](https://turso.tech/pricing)); 2026 "Turso Sync" adds push+pull with server-side transforms ([blog](https://turso.tech/blog/turso-sync-local-first-sqlite-with-push-and-pull)). But it replaces your engine with an interval-based one (no wake channel), adds a second vendor, and the Rust rewrite is young. |
| Jazz 2 | Fascinating — TS-first, **Effect bindings**, a Cloudflare DO target announced for post-alpha.60 ([alpha.60 post](https://jazz.tools/blog/jazz-2-alpha-60)) — but alpha.67 with weekly breaking changes in Nov 2026 ([npm](https://www.npmjs.com/package/jazz-tools)). Re-evaluate mid-2027. |
| CouchDB/PouchDB | Your design's honored ancestor (seq-cursor `_changes` replication) — but migrating trades a bespoke modern stack for a document DB on a $5–10/mo VPS, and filtered replication for visibility is famously painful. |
| Automerge / Yjs | CRDT document libraries; fixed semantics that don't express tombstone-wins or done-wins without building your rules on top, i.e. the same owned complexity plus a CRDT runtime. Right tool only for a future rich-text/canvas feature. |
| Ditto | Edge-mesh sync for fleets of devices (retail, aerospace); free 2 GB tier, enterprise sales beyond — wrong domain. |
| WatermelonDB | RN-first; web is second-class (LokiJS adapter); slow release cadence (0.28.0, Apr 2025, [npm](https://www.npmjs.com/package/@nozbe/watermelondb)). |
| Triplit / InstantDB / Replicache / cr-sqlite | Dead or dying per §5.1. |
| PocketBase | Solves hosting + realtime SSE, **explicitly not offline sync** ([maintainer](https://github.com/pocketbase/pocketbase/discussions/67)) — you'd keep the engine anyway, plus a VPS. |

Also noted for the future: **TanStack DB** is emerging as the framework-agnostic client-side transactional/query layer that pairs with Electric, PowerSync, or custom backends ([0.6 persistence post](https://tanstack.com/blog/tanstack-db-0.6-app-ready-with-persistence-and-includes)) — if the Foldkit client store is ever replaced, it's the likely chassis.

---

## 6. Options

### Option A — Keep the engine; add a hibernating per-household DO wake channel ⭐ recommended

**What:** one SQLite-backed DO class keyed by `householdId`. Clients open one WebSocket; the DO enables `setWebSocketAutoResponse()` for heartbeats. After any committed batch (sync push *or* an RPC mutation that bumps a syncable row), the Worker pokes the household DO, which broadcasts the already-designed wake payload `{ _tag: "wake", seq }` (draft §5, DP-6's nudge-only recommendation). The client's Subscription replaces the 10 s/30 s cadence with: pull on wake, immediate sync on reconnect/visibility-gain, and a slow safety poll (e.g. 5 min) for missed wakes.

**Why the free plan makes this nearly free:** idle DOs are not billed duration while hibernating; outgoing messages are free; auto-response pings cost no wall time; incoming messages bill 20:1 against a 100k/day DO request allowance you'll use a rounding error of. Two households' steady state ≈ zero duration, zero polling.

**What it buys:** sub-second cross-device updates (acceptance bar: "within a few seconds" — beaten by two orders), ~all polling requests retired, D1 read traffic from polls retired, and the DP-5 deferred "hardening" closed without changing a single conflict rule, wire shape, or the D1 source of truth.

**What it costs:** one new DO binding in `alchemy.run.ts`, one small DO class, a client socket manager, and tests. This is the draft's own §5 plan — the infra objection that deferred it ("new infra not yet in the settled stack") no longer carries weight on today's free plan. Keep the polling path as a fallback (the cadence module already degrades gracefully).

**Do not** move the store itself into the DO yet: D1-as-source-of-truth keeps your backups, Time Travel, and ad-hoc queries; the DO-as-coordinator makes each household single-writer by construction but makes those your own problem.

### Option B — Zero, self-hosted (if you ever leave the free plan)

The only external engine whose architecture matches your non-negotiables: server-authoritative mutators (conflict rules port verbatim), first-class Read Permissions (visibility split), GA-grade maturity. Costs: Postgres + an always-on zero-cache node (~$5–10/mo), a schema/mutator migration, a client-store rewrite, and saying goodbye to D1. Choose only if you also want ZQL's live query reactivity or foresee outgrowing Workers. Not worth it for two users at $0.

### Option C — RxDB chassis (if you want to stop owning client mirror code)

Keeps Workers+D1; replaces the IndexedDB mirror/outbox with RxDB collections against adapted `/sync` endpoints. $0 with Dexie storage, Apache-2.0 core, conflict handlers are yours. But: the better storages are $99/mo, the Foldkit data layer must move to RxJS observables, and you rebuild roughly the same pull/push code in RxDB's replication shape. Positive expected value only if a second app will reuse the chassis.

### Option D — Status quo, unchanged

Perfectly viable: every budget in §4 has headroom, and the cadence table already meets the acceptance bar. You keep the one visible gap (up to 10–30 s staleness in an open tab) and the polling request spend. If nothing is changed, add R2's CPU monitoring and R6's December pricing check to the calendar.

---

## 7. Recommendation

**Your setup is close to the theoretical minimum for this exact shape of app** — 2 writers, low volume, server-as-single-resolver, settled domain merge rules, $0 hosting. The productized engines that match your semantics (Zero, PowerSync) all assume Postgres plus an always-on sync node; the ones that stay on Workers/D1 (RxDB) still make you write the server half and the interesting client half. The 2026 graveyard says the build-not-buy call was right.

**Make one change: Option A.** A hibernating per-household Durable Object wake channel is $0 on the free plan, incremental (~a DO class + a client socket + one binding), preserves every settled rule and the whole wire protocol, and converts the design's only real weakness — poll-based latency and request spend — into sub-second push. Everything else in this report is a monitoring item, not a migration.

### Follow-ups (small, non-urgent)

1. Document the §3 R3 deviation (push response cursor unused by design) in `docs/sync-protocol-draft.md` §4.3, or drop the wire field.
2. Add the two-tab serialization note (R7) to the draft's MVP-boundary comment.
3. Calendar: verify Workers Logs allowances after the Dec 1, 2026 Observability pricing change (R6); watch push-path CPU (R2) in Observability.
4. Re-evaluate **Jazz 2** (Effect bindings + CF DO target) and **TanStack DB** as client chassis in mid-2027; re-evaluate **Turso Sync** if you ever want a second DB vendor.

---

## Sources

Primary sources cited inline above; the full annotated research document with per-claim URLs for all 19 alternatives and every free-plan number is preserved at `/tmp/opencode/sync-alternatives-research.md` (research agent output, Nov 18 2026). Key platform pages:

- Workers pricing/limits: <https://developers.cloudflare.com/workers/platform/pricing/>, <https://developers.cloudflare.com/workers/platform/limits/>
- D1 pricing/limits: <https://developers.cloudflare.com/d1/platform/pricing/>, <https://developers.cloudflare.com/d1/platform/limits/>
- D1 Time Travel: <https://developers.cloudflare.com/d1/reference/time-travel/>
- Durable Objects pricing/limits/hibernation: <https://developers.cloudflare.com/workers/platform/pricing/#durable-objects>, <https://developers.cloudflare.com/durable-objects/platform/limits/>, <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- Zero: <https://zero.rocicorp.dev/>, <https://zero.rocicorp.dev/docs/self-host>, <https://zero.rocicorp.dev/docs/status>
- PowerSync: <https://docs.powersync.com/intro/setup-guide>, <https://powersync.com/pricing>
- ElectricSQL/Databricks: <https://electric.ax/blog/2026/08/11/electric-joining-databricks>
- Replicache archive: <https://github.com/rocicorp/replicache>, <https://replicache.dev>
- InstantDB wind-down: <https://www.instantdb.com/docs/self-hosting>
- RxDB: <https://rxdb.info/>, <https://rxdb.info/premium>
- TanStack DB: <https://tanstack.com/db/latest/docs/overview>
